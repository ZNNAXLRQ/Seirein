/**
 * Contract check against the REAL DSH standard agent preset, not a hand-written tool list.
 *
 * The fixture is a read-only transcription of
 *   app.asar!dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml
 * (`config.plugins` of the `preset-standard` row), extracted and SHA-256 verified against the
 * asar integrity table. YAML `!!js` tag text is kept as `{ "$js": "..." }` because JSON cannot
 * carry the expression; the merge only has to preserve the row key, not evaluate it.
 *
 * This file never touches `src/`; it only imports the pure merge/audit functions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  VOICE_COMPACTION_PRESET,
  assessVoiceCompactionPreset,
  hasVoiceNativeTools,
  mergeVoicePresetWithNativeTools,
} from '../src/host/session/compaction/voice-compaction.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/standard-preset-plugins.json', import.meta.url),
  'utf8',
));
const standard = fixture.preset;

const nativeGroupOf = (definition) => definition.plugins.find(
  (row) => row.id === 'seirein-native-tools' && row.group === true,
);

const rowById = (rows, id) => rows.find((row) => row.id === id);

/** Every row in a tree, including groups themselves. */
const allRows = (rows) => rows.flatMap((row) => [
  row,
  ...(row.group === true && Array.isArray(row.config) ? allRows(row.config) : []),
]);

/** Leaf package names under a group (recursive). */
const leafNames = (rows) => allRows(rows)
  .filter((row) => row.group !== true && typeof row.name === 'string')
  .map((row) => row.name);

const clone = (value) => structuredClone(value);

test('fixture is the real standard declaration, complete and provenance-stamped', () => {
  assert.equal(fixture.source.entry, 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml');
  assert.match(fixture.source.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(fixture.source.size, 6858);
  assert.equal(standard.id, 'standard');
  assert.equal(standard.plugins.length, 22);

  // The excluded rows and the real groups exist in the source, so their absence below is the
  // merge's decision and not a trimmed fixture.
  const ids = standard.plugins.map((row) => row.id);
  for (const id of ['persona', 'agent-instructions', 'planning', 'compaction', 'delegation']) {
    assert.ok(ids.includes(id), `fixture keeps the real ${id} row`);
  }
  assert.deepEqual(
    rowById(standard.plugins, 'delegation').isolate,
    { workflowEngine: true },
  );
  assert.deepEqual(
    rowById(standard.plugins, 'compaction').isolate,
    { compaction: true, toolResultPruner: true },
  );
  assert.deepEqual(
    rowById(standard.plugins, 'tool-bash').disabled,
    { $js: "process.platform === 'win32'" },
  );
});

test('merge appends exactly one native group after the untouched compaction group', () => {
  const before = clone(standard);
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);

  assert.deepEqual(standard, before, 'merge must not mutate the standard declaration');
  assert.equal(hasVoiceNativeTools(merged), true);
  assert.equal(merged.plugins.length, 2);
  assert.deepEqual(
    merged.plugins.map((row) => [row.id, row.group]),
    [['compaction', true], ['seirein-native-tools', true]],
  );
  assert.equal(merged.plugins[0], VOICE_COMPACTION_PRESET.plugins[0], 'base compaction group is reused');
  assert.deepEqual(
    merged.plugins[0].isolate,
    { compaction: true, toolResultPruner: true },
    'base group isolate survives',
  );

  const native = nativeGroupOf(merged);
  assert.equal(native.name, 'cordis:group');
  assert.equal(native.isolate, undefined);
});

test('native group contains the real tool rows and excludes coding identity, plan and compaction', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);
  const native = nativeGroupOf(merged);

  // Exact top-level shape of the real standard minus persona / agent-instructions / compaction,
  // in source order. Planning is inherited so `/plan` remains a native companion capability.
  assert.deepEqual(native.config.map((row) => row.id), [
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'tool-schedule',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'planning',
    'delegation',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'tool-plugin-manager',
    'tool-plugin-market',
  ]);

  const forbiddenPackages = [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ];
  const names = new Set(leafNames(native.config));
  for (const name of forbiddenPackages) {
    assert.equal(names.has(name), false, `${name} must not enter the native group`);
  }
  for (const id of ['persona', 'agent-instructions', 'compaction']) {
    assert.equal(
      allRows(native.config).some((row) => row.id === id),
      false,
      `${id} id must not enter the native group`,
    );
  }
  assert.equal(allRows(native.config).some((row) => row.id === 'planning'), true);
  assert.equal(allRows(native.config).some((row) => row.id === 'plan-mode'), true);

  // Named capabilities the live standard really declares, with their real package names.
  assert.deepEqual(
    ['tool-todo', 'tool-jobs', 'tool-schedule', 'tool-goal', 'command-goal', 'tool-web',
      'tool-skill', 'skill-filesystem', 'tool-subagent', 'tool-workflow'].map((id) => {
      const row = allRows(native.config).find((entry) => entry.id === id);
      return [id, row?.name];
    }),
    [
      ['tool-todo', '@deepseek-ai/dsh-tool-todo'],
      ['tool-jobs', '@deepseek-ai/dsh-tool-jobs'],
      ['tool-schedule', '@deepseek-ai/dsh-tool-schedule'],
      ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
      ['command-goal', '@deepseek-ai/dsh-command-goal'],
      ['tool-web', '@deepseek-ai/dsh-tool-web'],
      ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
      ['skill-filesystem', '@deepseek-ai/dsh-skill-filesystem'],
      ['tool-subagent', '@deepseek-ai/dsh-tool-subagent'],
      ['tool-workflow', '@deepseek-ai/dsh-tool-workflow'],
    ],
  );
});

test('real row config, group isolate and disabled values are copied verbatim', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);
  const native = nativeGroupOf(merged);

  const delegation = rowById(native.config, 'delegation');
  assert.equal(delegation.group, true);
  assert.deepEqual(delegation.isolate, { workflowEngine: true });
  assert.deepEqual(delegation.config.map((row) => row.id), [
    'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow',
  ]);
  assert.deepEqual(rowById(delegation.config, 'tool-subagent').config, {
    provider: 'spawn',
    toolName: 'subagent',
    modelSelection: true,
    modelDiscovery: true,
  });
  assert.deepEqual(rowById(delegation.config, 'tool-subagent-fork').config, {
    provider: 'fork',
    toolName: 'subagent_fork',
  });
  assert.deepEqual(rowById(native.config, 'tool-todo').config, { allowParallelInProgress: true });
  assert.deepEqual(rowById(native.config, 'tool-web').config, { fetch: true, searchTimeoutMs: 60000 });
  assert.deepEqual(rowById(native.config, 'tool-fs').config, { applyPatch: false });
  assert.deepEqual(rowById(native.config, 'tool-fs-search').config, { sampleOverCapGlobResults: false });

  for (const id of ['tool-bash', 'tool-pwsh', 'tool-plugin-manager', 'tool-plugin-market']) {
    const source = rowById(standard.plugins, id);
    const copied = rowById(native.config, id);
    assert.deepEqual(copied.disabled, source.disabled, `${id} disabled is preserved`);
  }
  assert.deepEqual(
    rowById(native.config, 'tool-plugin-market').disabled,
    true,
  );
});

test('group-level disabled is preserved too (no real standard group disables itself)', () => {
  // The real standard has no `disabled: <group>` row, so clone a real group and add the key only
  // to prove the merge forwards group keys instead of whitelisting id/name/isolate/config.
  const altered = clone(standard);
  rowById(altered.plugins, 'delegation').disabled = { $js: 'true' };

  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, altered);
  const delegation = rowById(nativeGroupOf(merged).config, 'delegation');
  assert.deepEqual(delegation.disabled, { $js: 'true' });
  assert.deepEqual(delegation.isolate, { workflowEngine: true });
});

test('audit accepts the real merged preset only with allowNativeTools', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);

  const allowed = assessVoiceCompactionPreset(merged, { allowNativeTools: true });
  assert.equal(allowed.compatible, true, allowed.reason);
  assert.deepEqual(allowed.missing, []);
  assert.deepEqual(allowed.extras, []);
  assert.deepEqual(allowed.plugins.slice().sort(), [
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ]);

  const denied = assessVoiceCompactionPreset(merged);
  assert.equal(denied.compatible, false);
  assert.ok(denied.extras.includes('native-tools-not-allowed'));
});

test('tampering with permissions, adding a top-level plugin, or hiding persona in native is rejected', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);

  const withPermissions = { ...clone(merged), permissions: { allow: ['*'] } };
  const permissionsAudit = assessVoiceCompactionPreset(withPermissions, { allowNativeTools: true });
  assert.equal(permissionsAudit.compatible, false);
  assert.ok(permissionsAudit.extras.includes('preset:permissions'));

  const withTopLevelPlugin = {
    ...clone(merged),
    plugins: [...merged.plugins, { id: 'tool-pwsh-again', name: '@deepseek-ai/dsh-tool-pwsh' }],
  };
  const topLevelAudit = assessVoiceCompactionPreset(withTopLevelPlugin, { allowNativeTools: true });
  assert.equal(topLevelAudit.compatible, false);
  assert.ok(topLevelAudit.extras.includes('插件:@deepseek-ai/dsh-tool-pwsh'));

  const withNativePersona = clone(merged);
  nativeGroupOf(withNativePersona).config.push({ id: 'persona', name: '@deepseek-ai/dsh-persona' });
  const personaAudit = assessVoiceCompactionPreset(withNativePersona, { allowNativeTools: true });
  assert.equal(personaAudit.compatible, false);
  assert.ok(personaAudit.extras.includes('native:@deepseek-ai/dsh-persona'));
});

test('a real, unmodified standard never leaks identity packages into the merged declaration', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);
  const native = nativeGroupOf(merged);
  const serialized = JSON.stringify(native);
  for (const needle of ['dsh-persona', 'dsh-agent-instructions', 'dsh-compaction-']) {
    assert.equal(serialized.includes(needle), false, `${needle} is absent from the native group`);
  }
});
