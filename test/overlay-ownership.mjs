/**
 * Avatar-layer stale cleanup is ownership-based (R14).
 *
 * The mirror must clear the process it replaced after a plugin reload, but it must never kill a
 * `transparent.ps1` that belongs to another root/profile, and a recycled pid must be left alone.
 * These tests inject the process table so no real PowerShell process is touched.
 *
 * Run: node --test test/overlay-ownership.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AvatarLayer } from '../src/host/avatar/avatarLayer.js';

const CREATED = '2026-11-05T01:00:00.000Z';
const CREATED_LATER = '2026-11-05T01:00:07.000Z';

/** One temp root with the real `<root>/cache/avatar-layer` layout. */
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-ownership-'));
  return { root, dir: join(root, 'cache', 'avatar-layer') };
}

function mirrorCommand(stateDir) {
  return `powershell -NoProfile -STA -ExecutionPolicy Bypass -File C:\\app\\transparent.ps1 -StateDir ${stateDir}`;
}

/** Persist what the instance that launched a mirror would have written. */
async function seedOwners(dir, instances) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'owners.json'), JSON.stringify({ instances }, null, 2), 'utf8');
}

function mount({ root, dir, candidates }) {
  const killed = [];
  const events = [];
  const layer = new AvatarLayer({
    dir,
    root,
    scriptPath: 'C:\\app\\transparent.ps1',
    windowScriptPath: 'C:\\app\\window-move.ps1',
    log: { emit: async (type, payload) => events.push({ type, ...payload }) },
    processes: {
      list: async () => candidates,
      inspect: async () => null,
      terminate: async (pid) => {
        killed.push(pid);
      },
    },
  });
  return { layer, killed, events };
}

test('a candidate whose pid, creation time and root match the launch record is killed', async (t) => {
  const { root, dir } = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  await seedOwners(dir, [{ pid: 4242, createdAt: CREATED, root, stateDir: dir }]);

  const { layer, killed, events } = mount({
    root,
    dir,
    candidates: [{ pid: 4242, createdAt: CREATED, commandLine: mirrorCommand(dir) }],
  });
  const report = await layer.killStale();

  assert.deepEqual(killed, [4242], 'the owned leftover is terminated');
  assert.deepEqual(report.killed, [4242]);
  assert.equal(report.unverified, 0);
  assert.equal(events.length, 0, 'a verified kill needs no warning event');
});

test('a creation-time mismatch (recycled pid) is not killed and is reported', async (t) => {
  const { root, dir } = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  await seedOwners(dir, [{ pid: 4242, createdAt: CREATED, root, stateDir: dir }]);

  const { layer, killed, events } = mount({
    root,
    dir,
    candidates: [{ pid: 4242, createdAt: CREATED_LATER, commandLine: mirrorCommand(dir) }],
  });
  const report = await layer.killStale();

  assert.deepEqual(killed, [], 'a different creation time means a different process');
  assert.equal(report.unverified, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'avatarLayer.stale.unverified');
  assert.equal(events[0].reason, 'creation-time-mismatch');
  assert.equal(events[0].pid, 4242);
});

test('a mirror owned by another root is never killed', async (t) => {
  const { root, dir } = await tempRoot();
  const foreignRoot = join(root, 'profile-b');
  const foreignDir = join(foreignRoot, 'cache', 'avatar-layer');
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  await seedOwners(dir, [{ pid: 4242, createdAt: CREATED, root, stateDir: dir }]);

  const { layer, killed, events } = mount({
    root,
    dir,
    candidates: [{ pid: 7777, createdAt: CREATED, commandLine: mirrorCommand(foreignDir) }],
  });
  const report = await layer.killStale();

  assert.deepEqual(killed, [], 'another root runs its own legitimate mirror');
  assert.equal(report.skipped, 1);
  assert.equal(report.unverified, 0, 'a known foreign root is not an anomaly');
  assert.equal(events.length, 0);
});

test('with no launch record at all nothing is killed and an event is recorded', async (t) => {
  const { root, dir } = await tempRoot();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  await mkdir(dir, { recursive: true });

  const { layer, killed, events } = mount({
    root,
    dir,
    candidates: [{ pid: 4242, createdAt: CREATED, commandLine: mirrorCommand(dir) }],
  });
  const report = await layer.killStale();

  assert.deepEqual(killed, [], 'unverifiable processes survive');
  assert.equal(report.unverified, 1);
  assert.equal(events[0]?.type, 'avatarLayer.stale.unverified');
  assert.equal(events[0]?.reason, 'no-owner-record');
});
