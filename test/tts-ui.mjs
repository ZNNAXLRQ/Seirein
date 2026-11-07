/**
 * 「语音 / GPT-SoVITS 模型」card regression: the「应用模型」row explains that the host waits up to
 * 3 s for the current sentence and only then interrupts playback, and a successful apply appends
 * that notice to the result prompt ONLY when the host really interrupted.
 *
 * The shipped `applyModels` flow and the shipped hint element are extracted from client.js and
 * evaluated with a recording `h` — no DOM, no React, no host.
 *
 * Run: node --test test/tts-ui.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** The required wording, character for character. */
const HINT = '会先等待当前句结束，最多 3 秒；超时后将打断播报。';
const INTERRUPTED = '已在等待超时后打断当前播报。';

/** Recording element factory: every node keeps its type, props and children. */
const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
const styles = new Proxy({}, { get: (_target, key) => ({ marker: String(key) }) });

/** The shipped「应用模型」flow, extracted so a fake action can drive the real code. */
const loadApplyModels = () => {
  const from = clientSource.indexOf('      const applyModels = async () => {');
  const to = clientSource.indexOf('      // 状态行优先级：', from);
  assert.ok(from > 0 && to > from, 'the shipped applyModels is found in client.js');
  const slice = clientSource.slice(from, to);
  return new Function(
    'act', 'setTtsApply', 'show',
    `${slice}\nreturn applyModels;`,
  );
};

/** Press「应用模型」with a canned action result and record every side effect. */
const pressApply = async (result) => {
  const calls = [];
  const applied = [];
  const shown = [];
  const applyModels = loadApplyModels()(
    async (body, tag) => {
      calls.push({ body, tag });
      return result;
    },
    (value) => applied.push(value),
    (text) => shown.push(text),
  );
  await applyModels();
  return { calls, applied, shown };
};

test('1. the apply-models row states the 3 s wait verbatim, in the secondary hint style', () => {
  const literal = `h('div', { style: styles.hint }, '${HINT}'),`;
  assert.equal(
    clientSource.split(literal).length - 1,
    1,
    'exactly one shipped hint line with the required wording',
  );

  const at = clientSource.indexOf(literal);
  const applyRow = clientSource.indexOf("h('span', { style: styles.value }, '应用模型')");
  assert.ok(applyRow > 0 && at > applyRow, 'the hint sits below the「应用模型」row');
  assert.ok(at < clientSource.indexOf("'官方使用说明'", at), 'and above the docs links');

  // Evaluate the shipped element itself: it is a hint-styled div whose only child is the sentence.
  const node = new Function('h', 'styles', `return ${literal.slice(0, -1)};`)(h, styles);
  assert.equal(node.type, 'div');
  assert.equal(node.props.style.marker, 'hint', 'the line uses the secondary hint style');
  assert.deepEqual(node.children, [HINT], 'the sentence is the only text');
});

test('2. an interrupted apply appends the notice to the result prompt', async () => {
  const { calls, applied, shown } = await pressApply({ ok: true, interrupted: true, interruptReason: 'apply-models' });
  assert.deepEqual(calls, [{ body: { action: 'gptSovits.applyModels' }, tag: 'tts-apply' }]);
  assert.equal(applied.length, 1, 'the raw result is kept for the status line');
  assert.equal(shown.length, 1, 'one result prompt');
  assert.equal(shown[0], `模型已加载。${INTERRUPTED}`, 'the notice is appended after 模型已加载');
  assert.ok(shown[0].includes(INTERRUPTED), 'the required sentence appears verbatim');
});

test('3. no interruption (false) and an old host (no field) keep the plain prompt', async () => {
  const noInterrupt = await pressApply({ ok: true, interrupted: false });
  assert.deepEqual(noInterrupt.shown, ['模型已加载'], 'interrupted:false shows no notice');

  const oldHost = await pressApply({ ok: true });
  assert.deepEqual(oldHost.shown, ['模型已加载'], 'a missing interrupted field shows no notice');

  const failed = await pressApply({ ok: false, error: '模型未加载' });
  assert.deepEqual(failed.shown, [], 'a failed apply shows no success prompt');
  assert.equal(failed.applied.length, 1, 'but the failure is still handed to the status line');
});
