import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createLayerEditController } from '../src/host/index.js';
import { createAvatarSettingsActions } from '../src/host/avatar/settings-actions.js';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// Exercise the actual feature action handler, including the component-open ordering.
const calls = [];
const ensureComponent = (id) => {
  calls.push(['ensure', id]);
  return Promise.resolve({ ok: true, enabled: true, changed: false });
};
const dispatch = (action, layerEdit, ensureComponent) =>
  createAvatarSettingsActions({ layerEdit, ensureComponent })({ action });

for (const backend of ['wpf', 'spout']) {
  test(`${backend}: actual settings action routes enter/exit through the active backend`, async () => {
    let editing = false;
    let running = true;
    let vtsVisible = false;
    let shownBounds = null;
    const finalBounds = {x: 320, y: 240, width: 587, height: 906};
    const layers = {
      [backend]: {
        editing: () => editing,
        async enter() { calls.push(['enter', backend]); running = false; vtsVisible = true; editing = true; return {ok:true}; },
        async exit() { calls.push(['exit', backend]); vtsVisible = false; shownBounds = {...finalBounds}; running = true; editing = false; return {ok:true, bounds:finalBounds}; },
      },
      [backend === 'wpf' ? 'spout' : 'wpf']: {
        editing: () => false,
        enter() { throw Error('wrong backend'); },
        exit() { throw Error('wrong backend'); },
      },
    };
    const controller = createLayerEditController({ read: () => ({layer:{backend}}), layers });
    for (const [enter, exit] of [['layer.edit.enter','layer.edit.exit'], ['avatarLayer.adjust.start','avatarLayer.adjust.finish']]) {
      calls.length = 0;
      assert.equal((await dispatch(enter, controller, ensureComponent)).ok, true);
      assert.deepEqual(calls, [['ensure', 'avatar'], ['enter', backend]]);
      assert.equal(running, false);
      assert.equal(vtsVisible, true);
      assert.equal((await dispatch(exit, controller, ensureComponent)).ok, true);
      assert.deepEqual(calls, [['ensure', 'avatar'], ['enter', backend], ['exit', backend]]);
      assert.equal(vtsVisible, false);
      assert.equal(running, true);
      assert.deepEqual(shownBounds, finalBounds);
    }
  });
}

for (const editing of [false, true]) {
  test(`settings button derives edit=${editing} from the backend, not stale AvatarLayer state`, async () => {
    const from = client.indexOf('    function layerSettingsBody(h, state, handlers) {');
    const to = client.indexOf('    function Panel() {', from);
    assert.ok(from > 0 && to > from, 'the shipped layerSettingsBody is found in client.js');
    const layerSettingsBody = new Function(
      'styles', 'line', 'MUTED', 'BORDER',
      `${client.slice(from, to)}\nreturn layerSettingsBody;`,
    )(new Proxy({}, { get: () => ({}) }), () => null, '#6b7280', '#d8dce3');

    const actions = [];
    const h = (tag, props, ...children) => ({ tag, props: props ?? {}, children });
    const tree = layerSettingsBody(h, {
      layer: { backend: 'spout', running: !editing, editMode: editing },
      spout: {},
      transparent: {},
      draft: { left: 1600, top: 300, width: 420, height: 760 },
      busy: '',
      // Contradicts layer.editMode on purpose: the button must follow the backend.
      avatarGeometry: { width: 420, height: 760, left: 1600, top: 300 },
    }, {
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
      toggleEditMode: () => actions.push({ action: editing ? 'layer.edit.exit' : 'layer.edit.enter' }),
    });

    const nodes = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    const button = nodes.find((node) => node.tag === 'button');
    assert.equal(button.children[0], editing ? '完成编辑' : '编辑模式');
    await button.props.onClick();
    assert.equal(actions[0].action, editing ? 'layer.edit.exit' : 'layer.edit.enter');

    // The shipped handler (in the transparent-layer IIFE) derives the direction from layer.editMode.
    assert.match(client, /action: lay\.editMode === true \? 'layer\.edit\.exit' : 'layer\.edit\.enter'/u,
      'the toggle sends layer.edit.exit while editing, layer.edit.enter otherwise');
  });
}
