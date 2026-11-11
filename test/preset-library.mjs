import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadPresetLibrary } from '../src/host/avatar/presets/library.js';
import { PRESETS } from '../src/host/avatar/presets/index.js';

const builtin = [{
  id: 'custom.head',
  family: 'attention',
  states: ['idle'],
  events: ['idle'],
  requires: ['headX'],
  operations: [{ op: 'head-turn', channels: ['headX'] }],
  timing: { onset: 'continuous', pacing: 'connected', hold: 'brief', release: 'blend' },
}];

test('first load creates an editable complete library in avatar/presets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'seirein-presets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = loadPresetLibrary({ root, builtins: PRESETS });
  assert.equal(first.created, true);
  assert.equal(first.source, 'builtin-copy');
  assert.equal(first.presets.length, PRESETS.length);
  const file = JSON.parse(await readFile(first.file, 'utf8'));
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.presets.length, PRESETS.length);
  const second = loadPresetLibrary({ root, builtins: PRESETS });
  assert.equal(second.created, false);
  assert.equal(second.source, 'user');
  assert.equal(second.presets.length, PRESETS.length);
});

test('user can remove/add rows without touching the plugin package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'seirein-presets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = loadPresetLibrary({ root, builtins: builtin });
  await writeFile(first.file, JSON.stringify({
    schemaVersion: 1,
    presets: [
      { ...builtin[0], id: 'custom.one' },
      { ...builtin[0], id: 'custom.two' },
    ],
  }), 'utf8');
  const loaded = loadPresetLibrary({ root, builtins: PRESETS });
  assert.equal(loaded.source, 'user');
  assert.deepEqual(loaded.presets.map((row) => row.id), ['custom.one', 'custom.two']);
  assert.equal(loaded.presets.length, 2, 'the file, not the packaged catalog, is the source');
});

test('invalid or empty user files fall back to built-ins with a visible error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'seirein-presets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = loadPresetLibrary({ root, builtins: builtin });
  await writeFile(first.file, '{not json', 'utf8');
  const broken = loadPresetLibrary({ root, builtins: PRESETS });
  assert.equal(broken.source, 'builtin-fallback');
  assert.equal(broken.presets.length, PRESETS.length);
  assert.match(broken.error, /unreadable/u);
  await writeFile(first.file, JSON.stringify({ schemaVersion: 1, presets: [] }), 'utf8');
  const empty = loadPresetLibrary({ root, builtins: PRESETS });
  assert.equal(empty.source, 'builtin-fallback');
  assert.match(empty.error, /no valid preset/u);
});
