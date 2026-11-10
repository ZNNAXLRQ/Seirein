/**
 * The companion voice preset must inherit the LIVE standard preset's native capabilities rather
 * than a frozen tool list. These tests are pure/fake: they check composition, audit semantics and
 * the actual registration payload; they never mount a real Agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_COMPACTION_PRESET,
  assessVoiceCompactionPreset,
  createVoiceCompaction,
  mergeVoicePresetWithNativeTools,
} from '../src/host/session/compaction/voice-compaction.js';

const standard = {
  id: 'standard',
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions' },
    {
      id: 'planning', group: true, config: [
        { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' },
      ],
    },
    {
      id: 'compaction', group: true, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      ],
    },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    {
      id: 'delegation', group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      ],
    },
  ],
};

test('native merge copies live tool capabilities but not coding identity/plan/duplicate compaction', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);
  assert.equal(merged.nativeTools, true);
  const ids = merged.plugins.map((row) => row.id);
  assert.ok(ids.includes('tool-todo'));
  assert.ok(ids.includes('tool-jobs'));
  assert.ok(ids.includes('tool-schedule'));
  assert.ok(ids.includes('tool-goal'));
  assert.ok(ids.includes('delegation'));
  assert.equal(ids.includes('persona'), false);
  assert.equal(ids.includes('agent-instructions'), false);
  assert.equal(ids.includes('planning'), false);
  assert.equal(ids.filter((id) => id === 'compaction').length, 1);
  assert.equal(merged.plugins.find((row) => row.id === 'delegation').isolate.workflowEngine, true);
});

test('audit accepts a marked native composition but still rejects arbitrary extra tools', () => {
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, standard);
  assert.equal(assessVoiceCompactionPreset(merged, { allowNativeTools: true }).compatible, true);
  assert.equal(assessVoiceCompactionPreset(merged).compatible, false);
  const arbitrary = {
    ...VOICE_COMPACTION_PRESET,
    plugins: [...VOICE_COMPACTION_PRESET.plugins, { id: 'x', name: '@deepseek-ai/dsh-tool-fs' }],
  };
  assert.equal(assessVoiceCompactionPreset(arbitrary).compatible, false);
});

test('registration reads the standard preset at runtime and registers the merged declaration', async () => {
  let registered = null;
  const presets = {
    definitions: new Map([['standard', { config: standard }]]),
    has(id) { return this.definitions.has(id); },
    async register(definition) {
      registered = definition;
      return () => {};
    },
  };
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? presets : undefined),
    presetDefinition: VOICE_COMPACTION_PRESET,
    now: () => 1,
  });
  const state = await engine.ensurePreset(presets);
  assert.equal(state.status, 'registered');
  assert.equal(state.nativeTools, true);
  assert.ok(Array.isArray(registered?.plugins));
  const ids = registered.plugins.map((row) => row.id);
  assert.ok(ids.includes('tool-jobs') && ids.includes('tool-todo'));
  assert.equal(ids.includes('persona'), false);
});

test('without a standard definition the compaction-only fallback still registers', async () => {
  let registered = null;
  const presets = {
    definitions: new Map(),
    has() { return false; },
    async register(definition) {
      registered = definition;
      return () => {};
    },
  };
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? presets : undefined),
    presetDefinition: VOICE_COMPACTION_PRESET,
    now: () => 1,
  });
  const state = await engine.ensurePreset(presets);
  assert.equal(state.status, 'registered');
  assert.equal(state.nativeTools, false);
  assert.deepEqual(registered.plugins.map((row) => row.id), ['compaction']);
});
