/**
 * R-local: the merged「透明化」card and its single-owner backend switch.
 *
 * The host switch is exercised through the shipped `createLayerBackendSwitch` (the exact helper
 * `/assistant/action` uses), with fake backends so no Electron/PowerShell process is spawned.
 * The client block is the shipped `layerSettingsBody` source slice, evaluated with an injected
 * recording `h` — no DOM and no React needed.
 *
 * Run: node --test test/layer-settings.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLayerBackendSwitch, createLayerEditController, normalizeLayerBackend } from '../src/host/index.js';
import { WPF_OFFSCREEN } from '../src/host/avatar/avatarLayer.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** In-memory settings with the same `layer.backend` shape settings.json uses. */
const memorySettings = (initial = {}) => {
  let settings = initial;
  return {
    read: () => structuredClone(settings),
    write: (patch) => {
      settings = { ...settings, ...patch };
    },
    current: () => settings,
  };
};

/** Fake backends: record the exact call order, and let a test mark one as unavailable. */
const fakeBackends = ({ probe } = {}) => {
  const calls = [];
  const state = { wpfRunning: true, spoutRunning: false };
  return {
    calls,
    state,
    probeSpout: async () => {
      calls.push('probe:spout');
      return probe ?? { ok: true };
    },
    stopWpf: async () => {
      calls.push('stop:wpf');
      state.wpfRunning = false;
      return { confirmed: true };
    },
    startWpf: async () => {
      calls.push('start:wpf');
      state.wpfRunning = true;
      return { ok: true };
    },
    stopSpout: async () => {
      calls.push('stop:spout');
      state.spoutRunning = false;
      return { confirmed: true };
    },
    startSpout: async () => {
      calls.push('start:spout');
      state.spoutRunning = true;
      return { ok: true };
    },
  };
};

const mountSwitch = ({ settings, backends }) => createLayerBackendSwitch({
  read: settings.read,
  write: settings.write,
  probeSpout: backends.probeSpout,
  stopWpf: backends.stopWpf,
  startWpf: backends.startWpf,
  stopSpout: backends.stopSpout,
  startSpout: backends.startSpout,
});

test('1. default backend is wpf when settings carry no layer.backend', () => {
  assert.equal(normalizeLayerBackend(undefined), 'wpf');
  assert.equal(normalizeLayerBackend(''), 'wpf');
  assert.equal(normalizeLayerBackend('nonsense'), 'wpf');
  const settings = memorySettings({ voiceMuted: false });
  const layerSwitch = mountSwitch({ settings, backends: fakeBackends() });
  assert.equal(layerSwitch.backend(), 'wpf', 'an absent key reads as the WPF default');
  assert.equal(settings.current().layer, undefined, 'reading the default writes nothing');
});

test('2. switching to spout stops WPF (confirmed) before starting Spout', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  const backends = fakeBackends();
  const layerSwitch = mountSwitch({ settings, backends });
  const result = await layerSwitch.set('spout');
  assert.equal(result.ok, true);
  assert.equal(result.backend, 'spout');
  assert.deepEqual(backends.calls, ['probe:spout', 'stop:wpf', 'start:spout']);
  assert.equal(backends.state.wpfRunning, false, 'WPF really stopped');
  assert.equal(backends.state.spoutRunning, true, 'Spout is the only running backend');
  assert.equal(settings.current().layer.backend, 'spout', 'the choice is persisted');
});

test('3. switching back to wpf stops Spout (confirmed) before starting WPF', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  const backends = fakeBackends();
  const layerSwitch = mountSwitch({ settings, backends });
  await layerSwitch.set('spout');
  backends.calls.length = 0;
  const result = await layerSwitch.set('wpf');
  assert.equal(result.ok, true);
  assert.equal(result.backend, 'wpf');
  assert.deepEqual(backends.calls, ['stop:spout', 'start:wpf']);
  assert.equal(backends.state.spoutRunning, false, 'Spout really stopped');
  assert.equal(settings.current().layer.backend, 'wpf');
});

test('4. an unavailable Spout returns an error and leaves WPF running', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  const backends = fakeBackends({
    probe: { ok: false, code: 'ELECTRON_EXE_UNSET', message: '未配置 Electron 路径' },
  });
  const layerSwitch = mountSwitch({ settings, backends });
  const result = await layerSwitch.set('spout');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ELECTRON_EXE_UNSET');
  assert.match(result.error, /Spout 未就绪/u);
  assert.match(result.error, /未配置 Electron 路径/u);
  assert.equal(result.backend, 'wpf', 'the stored mode did not change');
  assert.deepEqual(backends.calls, ['probe:spout'], 'nothing was stopped or started');
  assert.equal(backends.state.wpfRunning, true, 'the original backend keeps running');
  assert.equal(settings.current().layer.backend, 'wpf');

  // An unconfirmed exit is also refused: the new backend is never started alongside the old one.
  const stuck = memorySettings({ layer: { backend: 'wpf' } });
  const stuckBackends = fakeBackends();
  stuckBackends.stopWpf = async () => ({ confirmed: false });
  const stuckSwitch = mountSwitch({ settings: stuck, backends: stuckBackends });
  const refused = await stuckSwitch.set('spout');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'LAYER_STOP_UNCONFIRMED');
  assert.equal(stuckBackends.state.spoutRunning, false, 'no Spout start after an unconfirmed stop');
  assert.equal(stuck.current().layer.backend, 'wpf');
});

// ---- client render -----------------------------------------------------------------------

/** Minimal style/line kit so the shipped slice can run without a DOM or React. */
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });
const line = (label, value) => ({ type: 'line', props: { label, value }, children: [] });

const loadLayerSettingsBody = () => {
  const from = clientSource.indexOf('    function layerSettingsBody(h, state, handlers) {');
  const to = clientSource.indexOf('    function Panel() {', from);
  assert.ok(from > 0 && to > from, 'the shipped layerSettingsBody is found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'styles', 'line', 'MUTED', 'BORDER',
    `${slice}\nreturn layerSettingsBody;`,
  )(styles, line, '#6b7280', '#d8dce3');
};

/** The shipped 「浏览…」 flow (pick → draft → persist); extracted so a click can drive the real code. */
const loadPickSpoutPath = () => {
  const from = clientSource.indexOf('    async function pickSpoutPath(');
  const to = clientSource.indexOf('    function layerSettingsBody(', from);
  assert.ok(from > 0 && to > from, 'the shipped pickSpoutPath is found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(`${slice}\nreturn pickSpoutPath;`)();
};

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });

const walk = (node, visit) => {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

const inspect = (tree) => {
  const blocks = [];
  const modes = [];
  const texts = [];
  const modeProps = {};
  walk(tree, (node) => {
    if (typeof node.props['data-settings-block'] === 'string') blocks.push(node.props['data-settings-block']);
    if (typeof node.props['data-layer-mode'] === 'string') {
      modes.push(node.props['data-layer-mode']);
      modeProps[node.props['data-layer-mode']] = node.props;
    }
    for (const child of node.children ?? []) {
      if (typeof child === 'string') texts.push(child);
    }
  });
  return { blocks, modes, texts, modeProps };
};

const defaultHandlers = {
  switchBackend: () => {},
  setField: () => {},
  setSpoutDraft: () => {},
  pickSpout: () => {},
  saveSpoutPath: () => {},
  probeSpout: () => {},
  startSpout: () => {},
  stopSpout: () => {},
  startWpf: () => {},
  stopWpf: () => {},
};

const renderTree = (state, overrides = {}) => {
  const layerSettingsBody = loadLayerSettingsBody();
  return layerSettingsBody(h, state, { ...defaultHandlers, ...overrides });
};

const renderLayer = (state) => inspect(renderTree(state));

/** Collect every node accepted by `predicate`, in document order. */
const collect = (tree, predicate) => {
  const found = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
};
const pathInputs = (tree) => collect(tree, (node) => node.props['data-spout-path-input'] === true);
const pathButtons = (tree, action) => collect(tree, (node) => node.props['data-spout-path-action'] === action);
const pathStatus = (tree) => collect(tree, (node) => node.props['data-spout-path-status'] === true)
  .flatMap((node) => node.children)
  .filter((child) => typeof child === 'string')
  .join('');


test('5. the client renders only the selected backend settings block', () => {
  const draft = { left: 1600, top: 300, width: 420, height: 760 };
  const base = {
    spout: { running: false, electronExecutable: '' },
    transparent: { running: false, pid: 0, ...draft },
    draft,
  };

  const wpf = renderLayer({
    ...base,
    layer: { backend: 'wpf', available: { wpf: true, spout: false }, reason: { spout: '未配置 Electron 路径' } },
  });
  assert.deepEqual(wpf.blocks, ['wpf'], 'only the WPF settings block renders');
  assert.deepEqual(wpf.modes, ['wpf', 'spout'], 'both mode buttons exist');
  assert.ok(wpf.texts.includes('开启透明层'), 'WPF controls are present');
  assert.ok(!wpf.texts.includes('检测'), 'Spout controls are absent');
  assert.equal(wpf.modeProps.wpf.style.marker, 'btnActive', 'the active mode is highlighted');
  assert.equal(wpf.modeProps.spout.disabled, true, 'an unusable Spout is greyed out');
  assert.match(wpf.modeProps.spout.title, /未配置 Electron 路径/u, 'and the reason is given');

  const spout = renderLayer({
    ...base,
    layer: { backend: 'spout', available: { wpf: true, spout: true }, reason: { spout: '' } },
    spout: { running: true, pid: 4321, electronExecutable: 'C:\\electron\\electron.exe' },
  });
  assert.deepEqual(spout.blocks, ['spout'], 'only the Spout settings block renders');
  assert.ok(spout.texts.includes('检测'), 'Spout controls are present');
  assert.ok(!spout.texts.includes('开启透明层'), 'WPF controls are absent');
  assert.equal(spout.modeProps.spout.style.marker, 'btnActive');
  assert.equal(spout.modeProps.spout.disabled, false);

  const missing = renderLayer({ ...base, layer: {} });
  assert.deepEqual(missing.blocks, ['wpf'], 'a missing backend falls back to WPF');

  const switching = renderLayer({ ...base, layer: { backend: 'wpf', switching: true } });
  assert.ok(switching.texts.includes('正在切换…'), 'an in-flight switch is visible');
});

// ---- persistence -------------------------------------------------------------------------

test('6. layer.backend survives a settings.json round-trip and a restart read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-layer-settings-'));
  const file = join(root, 'settings.json');
  writeFileSync(file, `${JSON.stringify({ voiceMuted: false }, null, 2)}\n`, 'utf8');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const write = (patch) => {
    writeFileSync(file, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`, 'utf8');
  };
  const backends = fakeBackends();
  const layerSwitch = createLayerBackendSwitch({
    read,
    write,
    probeSpout: backends.probeSpout,
    stopWpf: backends.stopWpf,
    startWpf: backends.startWpf,
    stopSpout: backends.stopSpout,
    startSpout: backends.startSpout,
  });

  const result = await layerSwitch.set('spout');
  assert.equal(result.ok, true);
  const stored = read();
  assert.equal(stored.layer.backend, 'spout', 'settings.json carries the new backend');
  assert.equal(stored.voiceMuted, false, 'unrelated settings are preserved');

  // A fresh instance reading the same file behaves like a host restart.
  const restarted = createLayerBackendSwitch({ read, write });
  assert.equal(restarted.backend(), 'spout', 'the restarted host reads the choice back');

  await restarted.set('wpf');
  assert.equal(read().layer.backend, 'wpf', 'switching back persists too');
  assert.equal(createLayerBackendSwitch({ read, write }).backend(), 'wpf');
});

// ---- concurrency -------------------------------------------------------------------------

test('7. two concurrent switches: exactly one runs, the other is refused', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  const backends = fakeBackends();
  // Hold the first request inside the Spout probe — the exact await where both used to pass the
  // `busy` check and both stop/start a backend.
  let releaseProbe = null;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const probe = backends.probeSpout;
  backends.probeSpout = async () => {
    await probeGate;
    return probe();
  };
  const layerSwitch = mountSwitch({ settings, backends });

  const first = layerSwitch.set('spout');
  const second = layerSwitch.set('spout');

  assert.equal(layerSwitch.switching(), true, 'the slot is taken synchronously, before any await');
  const refused = await second;
  assert.equal(refused.ok, false, 'the second request must not report success');
  assert.equal(refused.code, 'LAYER_SWITCH_IN_PROGRESS');
  assert.equal(refused.switching, true);
  assert.deepEqual(backends.calls, [], 'the refused request probed, stopped or started nothing');

  releaseProbe();
  const accepted = await first;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.backend, 'spout');
  assert.deepEqual(
    backends.calls,
    ['probe:spout', 'stop:wpf', 'start:spout'],
    'the old backend is stopped once and the new one started once',
  );
  assert.equal(backends.state.wpfRunning, false);
  assert.equal(backends.state.spoutRunning, true);
  assert.equal(settings.current().layer.backend, 'spout');
  assert.equal(layerSwitch.switching(), false, 'the slot is released after the switch');

  // Released, so the next request is accepted again.
  const back = await layerSwitch.set('wpf');
  assert.equal(back.ok, true);
  assert.deepEqual(backends.calls.slice(-2), ['stop:spout', 'start:wpf']);
});

test('8. a refused probe or a thrown probe releases the slot for the next request', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  let probeResult = { ok: false, code: 'ELECTRON_EXE_UNSET', message: '未配置 Electron 路径' };
  const backends = fakeBackends();
  backends.probeSpout = async () => {
    backends.calls.push('probe:spout');
    if (probeResult instanceof Error) throw probeResult;
    return probeResult;
  };
  const layerSwitch = mountSwitch({ settings, backends });

  const unavailable = await layerSwitch.set('spout');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'ELECTRON_EXE_UNSET');
  assert.equal(layerSwitch.switching(), false, 'finally released the slot on the refusal path');
  assert.deepEqual(backends.calls, ['probe:spout'], 'nothing was stopped');

  probeResult = new Error('probe exploded');
  const thrown = await layerSwitch.set('spout');
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, 'SPOUT_PROBE_FAILED');
  assert.equal(layerSwitch.switching(), false, 'finally released the slot on the throw path');

  probeResult = { ok: true };
  const accepted = await layerSwitch.set('spout');
  assert.equal(accepted.ok, true, 'a released slot accepts the next switch');
  assert.equal(settings.current().layer.backend, 'spout');
});

// ---- the always-visible Spout runtime row (the chicken-and-egg fix) -----------------------

/** The shape `/assistant/status` returns for the 「透明化」card, with per-test overrides. */
const layerStatus = ({
  backend = 'wpf',
  available = { wpf: true, spout: false },
  reason = { spout: '未配置 Electron 路径' },
  electronExecutable = '',
} = {}) => ({
  layer: { backend, available, reason },
  spout: { running: false, electronExecutable },
  transparent: { running: false, pid: 0 },
});

test('9. WPF mode with no path still renders the path input and「浏览…」', () => {
  const tree = renderTree(layerStatus());
  const inputs = pathInputs(tree);
  assert.equal(inputs.length, 1, 'exactly one Spout runtime path input');
  assert.equal(inputs[0].props.value, '', 'the empty configured path is shown');
  assert.match(String(inputs[0].props.placeholder), /electron\.exe/u);
  const browse = pathButtons(tree, 'browse');
  assert.equal(browse.length, 1, 'exactly one「浏览…」button');
  assert.ok(browse[0].children.includes('浏览…'));
  assert.match(pathStatus(tree), /未配置/u, 'the row says the path is unset');
  // Rendering the row does not disturb the normal WPF-only block assertions.
  const wpf = renderLayer(layerStatus());
  assert.deepEqual(wpf.blocks, ['wpf'], 'the WPF block is still the only backend block');
  assert.equal(pathInputs(tree).length, 1);
});

test('10. in Spout mode the path input still exists exactly once', () => {
  const tree = renderTree(layerStatus({
    backend: 'spout',
    available: { wpf: true, spout: true },
    reason: { spout: '' },
    electronExecutable: 'C:\\electron\\electron.exe',
  }));
  assert.equal(pathInputs(tree).length, 1, 'the row survives the mode switch');
  assert.equal(collect(tree, (node) => node.type === 'input').length, 1, 'no duplicate input in the Spout block');
  assert.equal(pathButtons(tree, 'browse').length, 1);
  assert.match(pathStatus(tree), /就绪/u, 'a configured runtime reports ready');
});

test('11. the Spout mode button stays disabled until the path is usable', () => {
  const unset = renderLayer(layerStatus());
  assert.equal(unset.modeProps.spout.disabled, true, 'an unconfigured Spout stays greyed out');
  assert.match(unset.modeProps.spout.title, /未配置 Electron 路径/u);

  // A configured-but-broken path explains itself under the row.
  const brokenTree = renderTree(layerStatus({
    electronExecutable: 'C:\\electron\\electron.exe',
    reason: { spout: '文件不存在' },
  }));
  const broken = inspect(brokenTree);
  assert.equal(broken.modeProps.spout.disabled, true);
  assert.match(pathStatus(brokenTree), /已配置但不可用/u);
  assert.match(pathStatus(brokenTree), /文件不存在/u);

  // Once status reports the runtime available, the button is usable without a mode switch.
  const readyTree = renderTree(layerStatus({
    available: { wpf: true, spout: true },
    reason: { spout: '' },
    electronExecutable: 'C:\\electron\\electron.exe',
  }));
  const ready = inspect(readyTree);
  assert.equal(ready.modeProps.spout.disabled, false);
  assert.match(pathStatus(readyTree), /就绪/u);
});

test('12. clicking「浏览…」calls pick.file, persists the path and fills the draft', async () => {
  const picked = 'C:\\Program Files\\Electron44\\electron.exe';
  const calls = [];
  const drafts = [];
  const pickSpoutPath = loadPickSpoutPath();
  const tree = renderTree(layerStatus(), {
    pickSpout: () => pickSpoutPath(async (body, tag) => {
      calls.push({ body, tag });
      return body.action === 'pick.file'
        ? { ok: true, path: picked }
        : { ok: true, probe: { ok: true, version: '44.0.0' }, electronExecutable: picked };
    }, (value) => drafts.push(value)),
  });
  const [browse] = pathButtons(tree, 'browse');
  assert.equal(browse.props.disabled, false, 'the row is usable even while WPF is the backend');
  await browse.props.onClick();
  assert.deepEqual(calls.map((call) => call.body.action), ['pick.file', 'spoutLayer.status']);
  assert.equal(calls[0].body.kind, 'exe', 'the exe picker is used');
  assert.equal(calls[1].body.electronExecutable, picked, 'the picked path is persisted through the status action');
  assert.deepEqual(drafts, [picked], 'the picked path is filled into the draft');
});

// ---- switch ordering: exit edit → stop → align VTS → write → start ------------------------

test('13. the switch aligns VTS and persists layer.backend BEFORE it starts the new backend', async () => {
  const settings = memorySettings({ layer: { backend: 'spout' } });
  const calls = [];
  const backendAtStart = [];
  const layerSwitch = createLayerBackendSwitch({
    read: settings.read,
    write: (patch) => {
      calls.push('write:backend');
      settings.write(patch);
    },
    stopEdit: async (which) => {
      calls.push(`exit-edit:${which}`);
      return { confirmed: true, skipped: true };
    },
    stopSpout: async () => {
      calls.push('stop:spout');
      return { confirmed: true };
    },
    stopWpf: async () => {
      calls.push('stop:wpf');
      return { confirmed: true };
    },
    startWpf: async () => {
      calls.push('start:wpf');
      backendAtStart.push(settings.current().layer.backend);
      return { ok: true };
    },
    startSpout: async () => {
      calls.push('start:spout');
      backendAtStart.push(settings.current().layer.backend);
      return { ok: true };
    },
    vts: {
      move: async (rect) => {
        calls.push(`move:${rect.x},${rect.y},${rect.width}x${rect.height}`);
        return { ok: true, bounds: rect };
      },
    },
  });

  const result = await layerSwitch.set('wpf');

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'exit-edit:spout',
    'stop:spout',
    'move:-2200,-1400,900x1200',
    'write:backend',
    'start:wpf',
  ], 'the stored choice is written after the move and before the start');
  assert.deepEqual(result.vts, { ok: true, bounds: WPF_OFFSCREEN });
  assert.deepEqual(backendAtStart, ['wpf'], 'the new backend is already persisted when it starts');
});

test('14. a non-edit switch stops the old display and leaves exactly one new display', async () => {
  const settings = memorySettings({ layer: { backend: 'wpf' } });
  const state = { wpf: true, spout: false };
  const calls = [];
  const layerSwitch = createLayerBackendSwitch({
    read: settings.read,
    write: settings.write,
    probeSpout: async () => {
      calls.push('probe:spout');
      return { ok: true };
    },
    // The switch may run in a non-edit state: this reports a skipped session, not a failure.
    stopEdit: async (which) => {
      calls.push(`exit-edit:${which}`);
      return { confirmed: true, skipped: true };
    },
    stopWpf: async () => {
      calls.push('stop:wpf');
      state.wpf = false;
      return { confirmed: true };
    },
    startWpf: async () => {
      calls.push('start:wpf');
      state.wpf = true;
      return { ok: true };
    },
    stopSpout: async () => {
      calls.push('stop:spout');
      state.spout = false;
      return { confirmed: true };
    },
    startSpout: async () => {
      calls.push('start:spout');
      state.spout = true;
      return { ok: true };
    },
  });

  const result = await layerSwitch.set('spout');

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['probe:spout', 'exit-edit:wpf', 'stop:wpf', 'start:spout']);
  assert.deepEqual(state, { wpf: false, spout: true }, 'no two display processes ever coexist');
  assert.equal(settings.current().layer.backend, 'spout');
});

// ---- edit mode is a user-view state and survives a backend switch -------------------------

/**
 * Host-shaped harness for the cross-backend switch: the shipped edit controller over recording
 * backends (each enter/exit follows that backend's real semantics - the display stops while VTS
 * is the editable surface) and the shipped switch wired exactly like the host, including the edit
 * handover and the common display rectangle.
 */
const DISPLAY_RECT = { x: 400, y: 200, width: 500, height: 700 };

const mountCrossBackend = ({ backend = 'wpf', editing = false, enterFails = '', handoffFails = '', stopFails = '', startFails = '' } = {}) => {
  const settings = memorySettings({ layer: { backend } });
  const calls = [];
  const rect = { x: 120, y: 80, width: 900, height: 1200 };
  const state = {
    wpf: {
      running: backend === 'wpf' && editing !== true,
      editing: backend === 'wpf' && editing === true,
      clickThrough: false,
      bounds: null,
      starts: 0, stops: 0, enters: 0, exits: 0, handoffs: 0,
    },
    spout: {
      running: backend === 'spout' && editing !== true,
      editing: backend === 'spout' && editing === true,
      clickThrough: false,
      bounds: null,
      starts: 0, stops: 0, enters: 0, exits: 0, handoffs: 0,
    },
    /** Where the real VTS window is: 'onscreen' while editing, otherwise parked by the layer. */
    vts: editing === true ? 'onscreen' : 'parked',
    /** Every rectangle passed to a start, per backend (the "common position" evidence). */
    startBounds: { wpf: [], spout: [] },
    /** The keepVts flag each old-session exit received (edit -> edit handover). */
    keepVts: [],
    /** Highest number of display processes observed at once (the switch must never exceed 1). */
    maxRunning: 0,
  };
  const runningCount = () => (state.wpf.running ? 1 : 0) + (state.spout.running ? 1 : 0);
  const noteRunning = () => {
    state.maxRunning = Math.max(state.maxRunning, runningCount());
  };
  noteRunning();

  const edit = createLayerEditController({
    read: settings.read,
    write: settings.write,
    layers: {
      wpf: {
        editing: () => state.wpf.editing === true,
        enter: async () => {
          calls.push('enter:wpf');
          state.wpf.enters += 1;
          // WPF edit semantics: the transparent layer stops, VTS becomes the editable surface.
          if (state.wpf.running === true) state.wpf.stops += 1;
          state.wpf.running = false;
          noteRunning();
          if (enterFails === 'wpf') return { ok: false, code: 'WPF_STOP_UNCONFIRMED', error: '透明层未能确认退出' };
          state.wpf.editing = true;
          state.vts = 'onscreen';
          return { ok: true, editMode: true, bounds: { ...rect } };
        },
        exit: async (options = {}) => {
          calls.push('exit:wpf');
          state.wpf.exits += 1;
          state.wpf.editing = false;
          state.keepVts.push(options?.keepVts === true);
          return { ok: true, editMode: false, bounds: { ...rect } };
        },
      },
      spout: {
        editing: () => state.spout.editing === true,
        enter: async () => {
          calls.push('enter:spout');
          state.spout.enters += 1;
          // Spout edit semantics: the display process stops and VTS is restored on screen.
          if (state.spout.running === true) state.spout.stops += 1;
          state.spout.running = false;
          noteRunning();
          if (enterFails === 'spout') return { ok: false, code: 'EDIT_TIMEOUT', error: '编辑确认超时' };
          state.spout.editing = true;
          state.vts = 'onscreen';
          return { ok: true, editMode: true, bounds: { ...rect } };
        },
        exit: async (options = {}) => {
          calls.push('exit:spout');
          state.spout.exits += 1;
          state.spout.editing = false;
          state.keepVts.push(options?.keepVts === true);
          // A real Spout exit parks VTS; the handover exit keeps it visible for the target backend.
          if (options?.keepVts !== true) {
            calls.push('hide:vts');
            state.vts = 'hidden';
          }
          return { ok: true, editMode: false, bounds: { ...rect } };
        },
      },
    },
  });

  /** edit -> edit handover: adopt the open session with VTS already visible; start nothing. */
  const handoff = (which, bounds) => {
    calls.push(`handoff:${which}`);
    state[which].handoffs += 1;
    state[which].running = false;
    state[which].editing = false;
    noteRunning();
    if (handoffFails === which) return { ok: false, code: 'EDIT_HANDOFF_FAILED', error: '会话交接失败' };
    state[which].editing = true;
    state[which].clickThrough = false;
    state.vts = 'onscreen';
    return { ok: true, editMode: true, handedOff: true, bounds: { ...(bounds ?? rect) } };
  };

  /** Settled display start: records the rectangle it was asked to occupy. */
  const start = (which, options = {}) => {
    calls.push(`start:${which}`);
    state[which].starts += 1;
    state[which].editing = false;
    state[which].bounds = options?.bounds ?? { ...DISPLAY_RECT };
    state.startBounds[which].push(options?.bounds ?? null);
    if (startFails === which) {
      state[which].running = false;
      state[which].clickThrough = false;
      noteRunning();
      return { ok: false, code: 'LAYER_START_FAILED', error: '启动失败' };
    }
    state[which].running = true;
    state[which].clickThrough = true;
    noteRunning();
    return { ok: true, bounds: state[which].bounds };
  };

  const layerSwitch = createLayerBackendSwitch({
    read: settings.read,
    write: settings.write,
    probeSpout: async () => {
      calls.push('probe:spout');
      return { ok: true };
    },
    isEditing: () => edit.status().editMode,
    enterEdit: () => edit.enter(),
    handoffEdit: (which, bounds) => handoff(which, bounds),
    boundsOf: (which) => ({ ...(state[which].bounds ?? DISPLAY_RECT) }),
    stopEdit: (which, options = {}) => {
      calls.push(`exit-edit:${which}`);
      if (edit.status().editBackend !== which) return { ok: true, skipped: true };
      return edit.exit({ keepVts: options?.keepVts === true });
    },
    stopWpf: async () => {
      calls.push('stop:wpf');
      state.wpf.stops += 1;
      state.wpf.running = false;
      state.wpf.editing = false;
      state.wpf.clickThrough = false;
      noteRunning();
      if (stopFails === 'wpf') return { confirmed: false };
      return { confirmed: true };
    },
    startWpf: async (options) => start('wpf', options),
    stopSpout: async () => {
      calls.push('stop:spout');
      state.spout.stops += 1;
      state.spout.running = false;
      state.spout.editing = false;
      state.spout.clickThrough = false;
      noteRunning();
      if (stopFails === 'spout') return { confirmed: false };
      return { confirmed: true };
    },
    startSpout: async (options) => start('spout', options),
    vts: {
      move: async (r) => {
        calls.push(`move:${r.x}`);
        state.vts = 'parked';
        return { ok: true, bounds: { ...r } };
      },
      hide: async () => {
        calls.push('hide:vts');
        state.vts = 'hidden';
        return { ok: true };
      },
    },
  });

  return { settings, calls, state, edit, layerSwitch };
};

const displayCounts = (state) => `wpf start/stop=${state.wpf.starts}/${state.wpf.stops} · spout start/stop=${state.spout.starts}/${state.spout.stops}`;

test('15. 编辑↔编辑 Spout→WPF: the session is handed over; no display starts and VTS does not move', async (t) => {
  const h = mountCrossBackend({ backend: 'spout', editing: true });

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, true);
  assert.equal(result.code, undefined);
  assert.equal(result.editMode, true, 'the switch reports the handed-over edit session');
  assert.equal(result.editBackend, 'wpf');
  assert.equal(result.handedOff, true);
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'wpf' });
  assert.deepEqual(h.calls, [
    'exit-edit:spout',
    'exit:spout',
    'stop:spout',
    'handoff:wpf',
  ], 'old session closes (VTS kept visible), then the target adopts it — no start, no move');
  assert.deepEqual(h.state.keepVts, [true], 'the old exit was told to keep VTS visible');
  assert.equal(h.state.wpf.starts, 0, 'no mirror window is started for an edit handover');
  assert.equal(h.state.spout.starts, 0);
  assert.equal(h.state.wpf.handoffs, 1, 'WPF adopted the open session exactly once');
  assert.equal(h.state.wpf.enters, 0, 'a handover is not a stop/start enter');
  assert.equal(h.state.wpf.editing, true);
  assert.equal(h.state.wpf.running, false, 'WPF edit keeps the mirror stopped');
  assert.equal(h.state.vts, 'onscreen', 'VTS stays the editable surface');
  assert.equal(h.state.maxRunning, 0, 'no display process runs while editing');
  t.diagnostic(`editMode=${result.editMode} editBackend=${result.editBackend} handedOff=${result.handedOff} · ${displayCounts(h.state)} · starts=0 handoffs=${h.state.wpf.handoffs} · VTS=${h.state.vts} · maxRunning=${h.state.maxRunning} · order=${h.calls.join(' > ')}`);
});

test('16. 沉底↔沉底 Spout→WPF: the mirror starts at the rectangle the display occupied', async (t) => {
  const h = mountCrossBackend({ backend: 'spout', editing: false });

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, true);
  assert.equal(h.state.wpf.enters, 0, 'not editing before the switch: no enter call');
  assert.deepEqual(h.edit.status(), { editMode: false, editBackend: null });
  assert.equal(result.editMode, false);
  assert.equal(result.editBackend, null);
  assert.deepEqual(h.calls, [
    'exit-edit:spout',
    'stop:spout',
    'move:-2200',
    'start:wpf',
  ]);
  assert.deepEqual(h.state.startBounds.wpf, [{ ...DISPLAY_RECT }], 'the target starts at the common position');
  assert.deepEqual(result.bounds, DISPLAY_RECT);
  assert.equal(h.state.wpf.clickThrough, true, 'a settled display stays click-through');
  assert.equal(h.state.wpf.running, true, 'WPF settled (mirror running)');
  assert.equal(h.state.wpf.starts, 1);
  assert.equal(h.state.wpf.stops, 0);
  assert.equal(h.state.spout.starts, 0);
  assert.equal(h.state.spout.stops, 1);
  assert.equal(h.state.maxRunning, 1);
  t.diagnostic(`editMode=${result.editMode} editBackend=${result.editBackend} · ${displayCounts(h.state)} · start bounds=${JSON.stringify(h.state.startBounds.wpf)} clickThrough=${h.state.wpf.clickThrough} · running=${h.state.wpf.running} · maxRunning=${h.state.maxRunning}`);
});

test('17. 编辑↔编辑 WPF→Spout: Spout adopts the session; no display starts and VTS stays visible', async (t) => {
  const h = mountCrossBackend({ backend: 'wpf', editing: true });

  const result = await h.layerSwitch.set('spout');

  assert.equal(result.ok, true);
  assert.equal(result.editMode, true);
  assert.equal(result.editBackend, 'spout');
  assert.equal(result.handedOff, true);
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'spout' });
  assert.deepEqual(h.calls, [
    'probe:spout',
    'exit-edit:wpf',
    'exit:wpf',
    'stop:wpf',
    'handoff:spout',
  ], 'no hide, no start: the editable window is handed to Spout where it is');
  assert.deepEqual(h.state.keepVts, [true]);
  assert.equal(h.state.spout.handoffs, 1);
  assert.equal(h.state.spout.enters, 0, 'a handover is not a stop/start enter');
  assert.equal(h.state.spout.starts, 0, 'the display process is not started just to be stopped');
  assert.equal(h.state.spout.running, false, 'Spout edit stops the display process');
  assert.equal(h.state.vts, 'onscreen', 'VTS is not parked during the handover');
  assert.equal(h.state.wpf.starts, 0);
  assert.equal(h.state.wpf.stops, 1);
  assert.equal(h.state.maxRunning, 0);
  t.diagnostic(`editMode=${result.editMode} editBackend=${result.editBackend} handedOff=${result.handedOff} · ${displayCounts(h.state)} · handoffs=${h.state.spout.handoffs} running=${h.state.spout.running} · VTS=${h.state.vts} · maxRunning=${h.state.maxRunning}`);
});

test('18. 沉底↔沉底 WPF→Spout: the display starts at the rectangle the mirror occupied', async (t) => {
  const h = mountCrossBackend({ backend: 'wpf', editing: false });

  const result = await h.layerSwitch.set('spout');

  assert.equal(result.ok, true);
  assert.equal(h.state.spout.enters, 0, 'not editing before the switch: no enter call');
  assert.deepEqual(h.edit.status(), { editMode: false, editBackend: null });
  assert.equal(result.editMode, false);
  assert.equal(result.editBackend, null);
  assert.deepEqual(h.calls, [
    'probe:spout',
    'exit-edit:wpf',
    'stop:wpf',
    'hide:vts',
    'start:spout',
  ]);
  assert.deepEqual(h.state.startBounds.spout, [{ ...DISPLAY_RECT }], 'the target starts at the common position');
  assert.deepEqual(result.bounds, DISPLAY_RECT);
  assert.equal(h.state.spout.clickThrough, true, 'a settled display stays click-through');
  assert.equal(h.state.spout.running, true, 'Spout settled (display running)');
  assert.equal(h.state.spout.starts, 1);
  assert.equal(h.state.spout.stops, 0);
  assert.equal(h.state.wpf.starts, 0);
  assert.equal(h.state.wpf.stops, 1);
  assert.equal(h.state.maxRunning, 1);
  t.diagnostic(`editMode=${result.editMode} editBackend=${result.editBackend} · ${displayCounts(h.state)} · start bounds=${JSON.stringify(h.state.startBounds.spout)} clickThrough=${h.state.spout.clickThrough} · running=${h.state.spout.running} · maxRunning=${h.state.maxRunning}`);
});

test('19. a failed handover restores the ORIGINAL backend and its edit session', async (t) => {
  const h = mountCrossBackend({ backend: 'spout', editing: true, handoffFails: 'wpf' });

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAYER_EDIT_HANDOFF_FAILED');
  assert.match(result.error, /未能把编辑会话交给/u);
  assert.equal(result.backend, 'spout', 'the original backend comes back');
  assert.equal(result.editMode, true, 'the original edit session is restored, not settled');
  assert.equal(result.restored, true);
  assert.equal(h.settings.current().layer.backend, 'spout', 'the stored choice is rolled back');
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'spout' }, 'status reports the real restored session');
  assert.deepEqual(h.calls, [
    'exit-edit:spout',
    'exit:spout',
    'stop:spout',
    'handoff:wpf',
    'handoff:spout',
  ], 'the failure is undone by handing the session back to the original backend');
  assert.equal(h.state.wpf.starts, 0);
  assert.equal(h.state.spout.starts, 0);
  assert.equal(h.state.spout.editing, true, 'Spout still owns the edit session');
  assert.equal(h.state.maxRunning, 0);
  t.diagnostic(`code=${result.code} backend=${result.backend} editMode=${result.editMode} restored=${result.restored} · ${displayCounts(h.state)} · maxRunning=${h.state.maxRunning} · order=${h.calls.join(' > ')}`);
});

test('19b. an unconfirmed old-display stop restores the original edit session', async (t) => {
  const h = mountCrossBackend({ backend: 'spout', editing: true, stopFails: 'spout' });

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAYER_STOP_UNCONFIRMED');
  assert.equal(result.backend, 'spout', 'nothing switched');
  assert.equal(result.editMode, true, 'the original edit session is restored');
  assert.equal(result.restored, true);
  assert.equal(h.settings.current().layer.backend, 'spout');
  assert.deepEqual(h.edit.status(), { editMode: true, editBackend: 'spout' });
  assert.equal(h.state.wpf.starts, 0, 'no new backend was started');
  t.diagnostic(`code=${result.code} backend=${result.backend} editMode=${result.editMode} restored=${result.restored} · order=${h.calls.join(' > ')}`);
});

test('19c. a failed settled start restores the original backend (never "always settle")', async (t) => {
  const h = mountCrossBackend({ backend: 'spout', editing: false, startFails: 'wpf' });

  const result = await h.layerSwitch.set('wpf');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAYER_START_FAILED');
  assert.equal(result.backend, 'spout', 'the original backend comes back');
  assert.equal(result.editMode, false);
  assert.equal(result.restored, true, 'the original settled display was restarted');
  assert.equal(h.settings.current().layer.backend, 'spout');
  assert.deepEqual(h.calls, [
    'exit-edit:spout',
    'stop:spout',
    'move:-2200',
    'start:wpf',
    'start:spout',
  ]);
  assert.equal(h.state.spout.running, true, 'the old backend still presents the model');
  assert.equal(h.state.maxRunning, 1);
  t.diagnostic(`code=${result.code} backend=${result.backend} editMode=${result.editMode} restored=${result.restored} · ${displayCounts(h.state)} · maxRunning=${h.state.maxRunning}`);
});

test('20. every direction keeps at most one display process and preserves the user state', async (t) => {
  const cases = [
    { name: 'spout-edit->wpf', options: { backend: 'spout', editing: true }, target: 'wpf' },
    { name: 'spout-settled->wpf', options: { backend: 'spout', editing: false }, target: 'wpf' },
    { name: 'wpf-edit->spout', options: { backend: 'wpf', editing: true }, target: 'spout' },
    { name: 'wpf-settled->spout', options: { backend: 'wpf', editing: false }, target: 'spout' },
    { name: 'spout-edit->wpf-handoff-fails', options: { backend: 'spout', editing: true, handoffFails: 'wpf' }, target: 'wpf' },
  ];
  const observed = [];
  for (const item of cases) {
    const h = mountCrossBackend(item.options);
    const result = await h.layerSwitch.set(item.target);
    assert.ok(h.state.maxRunning <= 1, `${item.name}: two display processes ran together`);
    if (item.options.editing === true) {
      assert.equal(h.state.wpf.running || h.state.spout.running, false, `${item.name}: editing means no display runs`);
    }
    observed.push(`${item.name}: maxRunning=${h.state.maxRunning} ok=${result.ok === true} editMode=${h.edit.status().editMode}`);
  }
  assert.deepEqual(observed, [
    'spout-edit->wpf: maxRunning=0 ok=true editMode=true',
    'spout-settled->wpf: maxRunning=1 ok=true editMode=false',
    'wpf-edit->spout: maxRunning=0 ok=true editMode=true',
    'wpf-settled->spout: maxRunning=1 ok=true editMode=false',
    'spout-edit->wpf-handoff-fails: maxRunning=0 ok=false editMode=true',
  ]);
  t.diagnostic(observed.join(' · '));
});
