/**
 * The companion voice preset must inherit the LIVE standard preset's native capabilities rather
 * than a frozen tool list. These tests are pure/fake: they check composition, audit semantics and
 * the actual registration payload; they never mount a real Agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VOICE_COMPACTION_PRESET,
  VOICE_NATIVE_TOOLS_RECOVERY,
  assessVoiceCompactionPreset,
  createVoiceCompaction,
  hasVoiceNativeTools,
  isVoiceCompactionPackage,
  mergeVoicePresetWithNativeTools,
} from '../src/host/session/compaction/voice-compaction.js';

const flatten = (definition) => (Array.isArray(definition?.plugins)
  ? definition.plugins.flatMap((row) => (row?.group === true && Array.isArray(row.config) ? row.config : [row]))
  : []);

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
  assert.equal(hasVoiceNativeTools(merged), true);
  const nativeGroup = merged.plugins.find((row) => row.id === 'seirein-native-tools');
  assert.ok(nativeGroup && nativeGroup.group === true, 'native rows are wrapped in a real Cordis group');
  const ids = flatten(merged).map((row) => row.id);
  assert.ok(ids.includes('tool-todo'));
  assert.ok(ids.includes('tool-jobs'));
  assert.ok(ids.includes('tool-schedule'));
  assert.ok(ids.includes('tool-goal'));
  assert.ok(ids.includes('delegation'));
  assert.equal(ids.includes('persona'), false);
  assert.equal(ids.includes('agent-instructions'), false);
  assert.equal(ids.includes('planning'), false);
  assert.equal(merged.plugins.filter((row) => row.id === 'compaction').length, 1);
  assert.equal(flatten(merged).find((row) => row.id === 'delegation').isolate.workflowEngine, true);
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
  const tampered = {
    ...merged,
    permissions: { allow: ['*'] },
    plugins: [...merged.plugins, { id: 'other', name: '@deepseek-ai/dsh-tool-pwsh' }],
  };
  assert.equal(assessVoiceCompactionPreset(tampered, { allowNativeTools: true }).compatible, false);
});

test('recursive filter removes a persona hidden in a renamed nested group', () => {
  const nested = {
    id: 'standard', plugins: [{
      id: 'renamed-wrapper', group: true,
      config: [{
        id: 'inner', group: true,
        config: [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }],
      }, { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }],
    }],
  };
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, nested);
  assert.equal(hasVoiceNativeTools(merged), true);
  const serialized = JSON.stringify(merged);
  assert.equal(serialized.includes('dsh-persona'), false);
  assert.equal(serialized.includes('dsh-tool-todo'), true);
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
  assert.equal(hasVoiceNativeTools(registered), true);
  assert.ok(Array.isArray(registered?.plugins));
  const ids = flatten(registered).map((row) => row.id);
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

test('an existing compaction-only declaration is reported as stale instead of silently upgraded', async () => {
  const presets = {
    definitions: new Map([
      ['seirein-voice', { config: VOICE_COMPACTION_PRESET }],
      ['standard', { config: standard }],
    ]),
    has(id) { return this.definitions.has(id); },
    async register() { throw new Error('reuse must not register'); },
  };
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? presets : undefined),
    presetDefinition: VOICE_COMPACTION_PRESET,
    now: () => 1,
  });
  const state = await engine.ensurePreset(presets);
  assert.equal(state.status, 'reused');
  assert.equal(state.registered, false);
  assert.equal(state.nativeTools, false);
  assert.equal(state.nativeToolsSource, 'compaction-only');
  assert.equal(state.nativeToolsStale, true);
  assert.equal(state.nativeToolsUpgrade, 'blocked-unowned');
  assert.equal(state.nativeToolsRecovery, VOICE_NATIVE_TOOLS_RECOVERY.UNOWNED);
});

test('renamed nested groups cannot hide a second compaction service from the native merge', () => {
  const compactionNames = [
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-command-compact',
    '@deepseek-ai/dsh-compaction-tool-result-pruner',
  ];
  const hiddenOnly = {
    id: 'standard',
    plugins: [{
      id: 'wrapper', name: 'cordis:group', group: true,
      config: [{
        id: 'renamed-inner', name: 'cordis:group', group: true,
        config: compactionNames.map((name, index) => ({ id: `hidden-${String(index)}`, name })),
      }],
    }],
  };
  const onlyCompaction = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, hiddenOnly);
  assert.equal(hasVoiceNativeTools(onlyCompaction), false, 'nothing native survived, so no marker group is added');
  assert.deepEqual(onlyCompaction.plugins.map((row) => row.id), ['compaction'], 'the base group is the only group left');
  assert.equal(flatten(onlyCompaction).filter((row) => isVoiceCompactionPackage(row.name)).length, 3);
  assert.equal(assessVoiceCompactionPreset(onlyCompaction, { allowNativeTools: true }).compatible, true);

  const mixed = {
    id: 'standard',
    plugins: [{
      id: 'wrapper', name: 'cordis:group', group: true,
      config: [
        {
          id: 'renamed-inner', name: 'cordis:group', group: true,
          config: compactionNames.map((name, index) => ({ id: `hidden-${String(index)}`, name })),
        },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
      ],
    }],
  };
  const merged = mergeVoicePresetWithNativeTools(VOICE_COMPACTION_PRESET, mixed);
  assert.equal(hasVoiceNativeTools(merged), true);
  const nativeGroup = merged.plugins.find((row) => row.id === 'seirein-native-tools');
  assert.ok(nativeGroup, 'the native marker group is present');
  const groups = merged.plugins.filter((row) => row.group === true);
  assert.equal(groups.filter((row) => row.id === 'compaction').length, 1, 'exactly one top-level compaction group');
  assert.equal(groups.some((row) => row.id === 'renamed-inner'), false, 'the emptied inner wrapper is gone');
  const wrapper = nativeGroup.config.find((row) => row.id === 'wrapper');
  assert.ok(wrapper, 'a wrapper that also carried a real native tool survives inside the native group');
  assert.deepEqual(wrapper.config.map((row) => row.id), ['tool-todo']);
  const rowsDeep = (rows) => rows.flatMap((row) => (
    row?.group === true && Array.isArray(row.config) ? [row, ...rowsDeep(row.config)] : [row]
  ));
  const names = rowsDeep(merged.plugins).map((row) => row.name);
  for (const name of compactionNames) {
    assert.equal(names.filter((entry) => entry === name).length, 1, `${name} appears only in the base group`);
  }
  for (const group of rowsDeep(merged.plugins).filter((row) => row.group === true)) {
    assert.ok(Array.isArray(group.config) && group.config.length > 0, `group ${group.id} is not empty`);
  }
  const audit = assessVoiceCompactionPreset(merged, { allowNativeTools: true });
  assert.equal(audit.compatible, true, 'one compaction service, native tools allowed');
  assert.equal(audit.plugins.filter((name) => isVoiceCompactionPackage(name)).length, 3);
  assert.equal(assessVoiceCompactionPreset(merged).compatible, false);

  // Even a declaration that somehow still carries a hidden compaction leaf is rejected by the audit.
  const tampered = {
    ...merged,
    plugins: merged.plugins.map((row) => (row.id === 'seirein-native-tools'
      ? {
        ...row,
        config: [...row.config, {
          id: 'sneaky-wrapper', name: 'cordis:group', group: true,
          config: [{
            id: 'renamed', name: 'cordis:group', group: true,
            config: [{ id: 'hidden-command', name: '@deepseek-ai/dsh-command-compact' }],
          }],
        }],
      }
      : row)),
  };
  const tamperedAudit = assessVoiceCompactionPreset(tampered, { allowNativeTools: true });
  assert.equal(tamperedAudit.compatible, false, 'a compaction leaf hidden in a renamed group is still a conflict');
  assert.match(tamperedAudit.reason, /command-compact/u);
});

test('an owned compaction-only registration upgrades once the standard preset becomes readable', async () => {
  const definitions = new Map();
  const registered = [];
  let registerCalls = 0;
  const presets = {
    definitions,
    has(id) { return definitions.has(id); },
    async register(definition) {
      registerCalls += 1;
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      const record = { config: definition, ready: Promise.resolve() };
      definitions.set(definition.id, record);
      registered.push(definition);
      return async () => {
        if (definitions.get(definition.id) === record) definitions.delete(definition.id);
      };
    },
  };
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? presets : undefined),
    presetDefinition: VOICE_COMPACTION_PRESET,
    now: () => 1,
  });

  const first = await engine.ensurePreset(presets);
  assert.equal(first.status, 'registered');
  assert.equal(first.nativeTools, false, 'standard was unreadable, so the first registration is compaction-only');
  assert.equal(first.nativeToolsStale, null);
  assert.equal(registerCalls, 1);
  assert.equal(hasVoiceNativeTools(definitions.get('seirein-voice').config), false);

  // The live standard preset becomes readable after the first registration.
  definitions.set('standard', { config: standard });
  const upgraded = await engine.ensurePreset(presets);
  assert.equal(upgraded.status, 'registered');
  assert.equal(upgraded.registered, true);
  assert.equal(upgraded.nativeTools, true);
  assert.equal(upgraded.nativeToolsSource, 'standard-live');
  assert.equal(upgraded.nativeToolsStale, false);
  assert.equal(upgraded.nativeToolsUpgrade, 'applied');
  assert.equal(registerCalls, 2, 'the owned definition was released and registered again');
  assert.equal(definitions.size, 2, 'one seirein-voice definition plus the standard fixture');
  const stored = definitions.get('seirein-voice');
  assert.ok(stored, 'the upgraded declaration is the live one');
  assert.equal(hasVoiceNativeTools(stored.config), true);
  assert.equal(
    flatten(stored.config).filter((row) => isVoiceCompactionPackage(row.name)).length,
    3,
    'the upgrade still carries exactly the base compaction rows',
  );
  assert.equal(engine.presetStatus().nativeTools, true);
});

test('an unowned compaction-only declaration is never replaced or unregistered', async () => {
  const original = { config: VOICE_COMPACTION_PRESET, ready: Promise.resolve() };
  let registerCalls = 0;
  let replaceCalls = 0;
  let unregisterCalls = 0;
  const presets = {
    definitions: new Map([
      ['seirein-voice', original],
      ['standard', { config: standard }],
    ]),
    has(id) { return this.definitions.has(id); },
    async register() {
      registerCalls += 1;
      throw new Error('must not register over a same-id declaration');
    },
    // A method named replace/unregister is not proof of ownership. Calling either here would
    // overwrite or delete a declaration this instance did not create, so the plugin must not.
    async replace() {
      replaceCalls += 1;
      throw new Error('must not replace an unowned declaration');
    },
    async unregister() {
      unregisterCalls += 1;
      throw new Error('must not unregister an unowned declaration');
    },
  };
  const engine = createVoiceCompaction({
    getService: (name) => (name === 'agentPresets' ? presets : undefined),
    presetDefinition: VOICE_COMPACTION_PRESET,
    now: () => 1,
  });

  const state = await engine.ensurePreset(presets);
  assert.equal(state.status, 'reused', 'the declaration is reported as reused, never as a successful upgrade');
  assert.equal(state.registered, false);
  assert.equal(state.nativeTools, false);
  assert.equal(state.nativeToolsSource, 'compaction-only');
  assert.equal(state.nativeToolsStale, true);
  assert.equal(state.nativeToolsUpgrade, 'blocked-unowned');
  assert.match(state.nativeToolsRecovery, /seirein-voice/u);
  assert.match(state.nativeToolsRecovery, /重启/u);
  assert.equal(presets.definitions.get('seirein-voice'), original, 'the old declaration is untouched');
  assert.equal(registerCalls, 0);
  assert.equal(replaceCalls, 0);
  assert.equal(unregisterCalls, 0);
  assert.equal(engine.presetStatus().status, 'reused');
});

test('attach contains a registration rejection instead of leaving it unhandled', async () => {
  const rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  try {
    const presets = {
      definitions: new Map(),
      has() { return false; },
      async register() { throw new Error('preset registry offline'); },
    };
    const engine = createVoiceCompaction({
      getService: (name) => (name === 'agentPresets' ? presets : undefined),
      presetDefinition: VOICE_COMPACTION_PRESET,
      now: () => 1,
    });
    const ctx = {
      on() { return () => {}; },
      effect(fn) { return fn(); },
    };
    engine.attach(ctx);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const state = engine.presetStatus();
    assert.equal(state.status, 'failed');
    assert.equal(state.enabled, false);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, [], 'the fire-and-forget registration path has no unhandled rejection');
});

