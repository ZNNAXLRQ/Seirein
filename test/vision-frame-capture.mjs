import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createFrameAssembler, spawnFrames } from '../src/host/vision/frame-capture.js';

test('fragmented and coalesced chunks preserve frame bytes, order and retained buffers', () => {
  const frames = [];
  const assembler = createFrameAssembler(6, frame => frames.push(frame));
  assembler.push(Buffer.from('ab'));
  assert.equal(assembler.pendingBytes(), 2);
  assembler.push(Buffer.from('cdefghijklmn'));
  assert.deepEqual(frames.map(f => f.toString()), ['abcdef', 'ghijkl']);
  assert.equal(assembler.pendingBytes(), 2);
  assembler.push(Buffer.from('opqr'));
  assert.deepEqual(frames.map(f => f.toString()), ['abcdef', 'ghijkl', 'mnopqr']);
  assert.equal(assembler.pendingBytes(), 0);
  assembler.push(Buffer.from('xx'));
  assembler.clear();
  assembler.push(Buffer.from('stuvwx'));
  assert.equal(frames.at(-1).toString(), 'stuvwx');
  assert.equal(frames[0].toString(), 'abcdef');
  assert.throws(() => createFrameAssembler(0, () => {}), RangeError);
});

test('1920x1200 frames arriving in 64KiB pipe chunks copy each byte at most once', () => {
  const bytes = 1920 * 1200 * 3;
  const source = Buffer.alloc(bytes, 37);
  const chunks = [];
  for (let at = 0; at < bytes; at += 65536) chunks.push(source.subarray(at, at + 65536));
  let oldCopied = 0;
  let pending = null;
  const before = performance.now();
  for (const chunk of chunks) {
    if (pending?.length) oldCopied += pending.length + chunk.length;
    pending = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
  }
  const oldMs = performance.now() - before;
  let copied = 0;
  const copy = Buffer.prototype.copy;
  let result;
  const assembler = createFrameAssembler(bytes, frame => { result = frame; });
  const after = performance.now();
  try {
    Buffer.prototype.copy = function (target, start, from, to) {
      copied += to - from;
      return copy.call(this, target, start, from, to);
    };
    for (const chunk of chunks) assembler.push(chunk);
  } finally { Buffer.prototype.copy = copy; }
  const newMs = performance.now() - after;
  assert.deepEqual(result, source);
  assert.equal(copied, bytes);
  assert.ok(oldCopied > copied * 40);
  console.log(`[frame-capture] copyBytes ${oldCopied} -> ${copied}; sampleMs ${oldMs.toFixed(2)} -> ${newMs.toFixed(2)} (timing diagnostic only)`);
});

const run = (script, extra = {}) => spawnFrames({
  ffmpegPath: process.execPath, args: ['-e', script], width: 2, height: 1, fps: 12, ...extra,
});

test('real pipe lifecycle delivers frames and reports callback/spawn/process errors', async () => {
  const frames = [];
  const ok = run("process.stdout.write(Buffer.from('abcdefghijkl'))", { onFrame: f => frames.push(f) });
  assert.equal((await ok.done).frames, 2);
  assert.deepEqual(frames.map(f => [f.i, f.t, f.buf.toString()]), [[0, 0, 'abcdef'], [1, 1 / 12, 'ghijkl']]);
  const failure = new Error('consumer failed');
  await assert.rejects(run("process.stdout.write(Buffer.from('abcdef'));setInterval(()=>{},1000)", {
    onFrame: () => { throw failure; },
  }).done, error => error === failure);
  await assert.rejects(run("process.stderr.write('capture failed');process.exitCode=2").done, /capture failed/);
  await assert.rejects(run('', { ffmpegPath: 'seirein-missing-capture-command' }).done, /ENOENT/);
});

test('stop discards partial frame and late data, and waits for process close', async () => {
  let count = 0;
  const capture = run("process.stdout.write(Buffer.from('abc'));setInterval(()=>process.stdout.write(Buffer.from('def')),10)", {
    onFrame: () => count++,
  });
  capture.stop();
  capture.stop();
  await capture.done;
  assert.equal(count, 0);
});
