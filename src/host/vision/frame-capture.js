/** Linear-time raw RGB frame assembly; partial frames never recopy their accumulated prefix. */
import { spawn } from 'node:child_process';

/**
 * Assemble arbitrary pipe chunks into immutable, fixed-size frames.
 * Holds at most one incomplete frame; completed buffers are never reused.
 */
export function createFrameAssembler(frameBytes, onFrame) {
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0) throw new RangeError('Invalid frame size');
  let partial = null;
  let filled = 0;
  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const available = chunk.length - offset;
        if (filled === 0 && available >= frameBytes) {
          onFrame(chunk.subarray(offset, offset + frameBytes));
          offset += frameBytes;
          continue;
        }
        partial ??= Buffer.allocUnsafe(frameBytes);
        const count = Math.min(frameBytes - filled, available);
        chunk.copy(partial, filled, offset, offset + count);
        filled += count;
        offset += count;
        if (filled === frameBytes) {
          const frame = partial;
          partial = null;
          filled = 0;
          onFrame(frame);
        }
      }
    },
    clear() { partial = null; filled = 0; },
    pendingBytes() { return filled; },
  };
}

/** Capture using the dependency's ffmpeg arguments, with bounded, linear-cost pipe assembly. */
export function spawnFrames({ ffmpegPath, args, width, height, fps, onFrame, onFirst, onStderr }) {
  let frames = 0;
  let stopped = false;
  let failure = null;
  let stderr = '';
  const startedAt = Date.now();
  const assembler = createFrameAssembler(width * height * 3, (buf) => {
    if (stopped) return;
    const i = frames++;
    if (i === 0) onFirst?.(Date.now() - startedAt);
    onFrame?.({ i, t: i / fps, buf });
  });
  const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    assembler.clear();
    try { child.kill('SIGKILL'); } catch { /* close/error owns completion */ }
  };
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      try { assembler.push(chunk); }
      catch (error) { failure ??= error; stop(); }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      try { onStderr?.(String(chunk)); }
      catch (error) { failure ??= error; stop(); }
    });
    child.on('error', (error) => { failure ??= error; });
    child.on('close', (code) => {
      assembler.clear();
      if (failure !== null) reject(failure);
      else if (!stopped && code !== 0) reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-300)}`));
      else resolve({ frames, ms: Date.now() - startedAt, code });
    });
  });
  return { done, stop };
}
