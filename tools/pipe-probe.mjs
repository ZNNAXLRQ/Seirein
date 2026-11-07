/**
 * Probe: can ffplay play an MP3 fed through stdin (`-i pipe:0`)?
 * This decides whether "synthesize and play as it streams" is viable.
 *
 * Usage: node tools/pipe-probe.mjs <file.mp3> [ffplayPath]
 */
import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/pipe-probe.mjs <file.mp3> [ffplayPath]');
  process.exit(2);
}
const ffplay =
  process.argv[3] ??
  join(process.env.USERPROFILE ?? homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffplay.exe');

const bytes = statSync(file).size;
const expectedMs = Math.round((bytes * 8) / 48);
console.log(`file ${bytes} bytes, expected audio ≈ ${expectedMs} ms`);

const started = Date.now();
const child = spawn(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', 'pipe:0'], {
  windowsHide: true,
  stdio: ['pipe', 'ignore', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});
child.stdin.on('error', (error) => {
  console.log('stdin error (expected once the player exits):', error.code);
});

const source = createReadStream(file, { highWaterMark: 16 * 1024 });
source.on('data', (chunk) => {
  if (!child.stdin.destroyed) child.stdin.write(chunk);
});
source.on('end', () => {
  if (!child.stdin.destroyed) child.stdin.end();
});

const code = await new Promise((resolve) => child.on('close', resolve));
const elapsed = Date.now() - started;
console.log(`ffplay exit=${code} elapsed=${elapsed} ms (audio ${expectedMs} ms)`);
if (stderr.trim().length > 0) console.log('stderr:', stderr.trim().slice(-300));
console.log(code === 0 && elapsed >= expectedMs * 0.8 ? 'PIPE PLAYBACK OK' : 'PIPE PLAYBACK SUSPECT');
