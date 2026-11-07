import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
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
    const marker = client.indexOf('const backendLayer = status.layer ?? {}');
    const start = client.lastIndexOf('(() => {', marker);
    const end = client.indexOf('})(),', marker) + 4;
    const actions = [];
    const tree = vm.runInNewContext(client.slice(start, end), {
      status: {layer:{backend:'spout', running:!editing, editMode:editing}, avatarLayer:{adjusting:!editing}},
      h: (tag, props, ...children) => ({tag, props, children}),
      line: () => null, styles:{}, busy:'', act: async body => actions.push(body),
    });
    const nodes = [];
    const visit = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children ?? []) visit(child); };
    visit(tree);
    const button = nodes.find(node => node.tag === 'button');
    assert.equal(button.children[0], editing ? '完成编辑' : '编辑模式');
    await button.props.onClick();
    assert.equal(actions[0].action, editing ? 'layer.edit.exit' : 'layer.edit.enter');
  });
}
