/**
 * Subtitle overlay IPC concurrency (R14).
 *
 * Two concurrent `ensure()` calls must share one launch promise (one WPF process), and concurrent
 * show/hide writes must use per-call temporary files instead of one shared `${statePath}.tmp`.
 * Both spawn and filesystem are injected: nothing is written outside the temp root.
 *
 * Run: node --test test/overlay-concurrency.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { SubtitleOverlay } from '../src/host/subtitle/subtitle.js';

function fakeChild(pid) {
  return {
    pid,
    stderr: new EventEmitter(),
    once() {},
    kill() {},
  };
}

/** Minimal in-memory fs implementing the four calls `writeState`/`ensure` use. */
function fakeFs() {
  const files = new Map();
  const writes = [];
  const renames = [];
  const removed = [];
  return {
    files,
    writes,
    renames,
    removed,
    async mkdir() {},
    async writeFile(path, data) {
      writes.push({ path, data });
      files.set(path, data);
    },
    async rename(from, to) {
      if (!files.has(from)) {
        const error = new Error(`ENOENT: no such file, rename '${from}'`);
        error.code = 'ENOENT';
        throw error;
      }
      renames.push({ from, to });
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(path) {
      removed.push(path);
      files.delete(path);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT: no such file, open '${path}'`);
      return files.get(path);
    },
  };
}

test('two concurrent ensure() calls spawn the overlay exactly once', async () => {
  const io = fakeFs();
  const spawns = [];
  const overlay = new SubtitleOverlay({
    dir: join('C:', 'fake', 'overlay-start'),
    scriptPath: 'overlay.ps1',
    fsOps: io,
    spawnProcess: (...args) => {
      spawns.push(args);
      return fakeChild(9001);
    },
  });

  await Promise.all([overlay.ensure(), overlay.ensure()]);
  await overlay.ensure();

  assert.equal(spawns.length, 1, 'one launch promise shared by every concurrent caller');
  assert.equal(overlay.running, true);
  assert.equal(overlay.starting, null, 'the in-flight promise is cleared once launched');
});

test('concurrent show/hide write distinct temporary files and rename both onto state.json', async () => {
  const io = fakeFs();
  const dir = join('C:', 'fake', 'overlay-write');
  const statePath = join(dir, 'state.json');
  const overlay = new SubtitleOverlay({
    dir,
    scriptPath: 'overlay.ps1',
    fsOps: io,
    spawnProcess: () => fakeChild(9002),
  });
  // Pretend the WPF process is already up: the writes are what concurrency must isolate.
  overlay.child = fakeChild(9002);

  const region = { x: 100, y: 200, w: 320, h: 120 };
  await Promise.all([
    overlay.show('并发写入', region, { bg: '#101010', fg: '#f5f5f5' }),
    overlay.hide(),
  ]);

  const tmpWrites = io.writes.filter((write) => write.path.endsWith('.tmp'));
  assert.equal(tmpWrites.length, 2);
  assert.notEqual(tmpWrites[0].path, tmpWrites[1].path, 'each write gets its own temporary file');
  assert.ok(tmpWrites.every((write) => write.path.startsWith(`${statePath}.`)));

  assert.equal(io.renames.length, 2, 'both writes are published with a rename');
  assert.ok(io.renames.every((rename) => rename.to === statePath));
  assert.deepEqual(
    io.renames.map((rename) => rename.from).sort(),
    tmpWrites.map((write) => write.path).sort(),
  );

  assert.equal([...io.files.keys()].filter((path) => path.endsWith('.tmp')).length, 0, 'no temp file survives');
  const published = JSON.parse(io.files.get(statePath));
  assert.ok(published.mode === 'text' || published.mode === 'hidden', 'the final state is a complete write');
});
