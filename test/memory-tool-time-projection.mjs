/**
 * P-127 P1: the memory tools must tell the model WHAT they actually searched.
 *
 * `assistant_recall` / `assistant_memory_brief` already knew their real window (after a `上次`
 * relaxation) but the tool projection whitelisted it away, so an empty answer read as "nothing
 * exists" instead of "nothing inside this window". This suite pins:
 *
 *   1. a real time window is projected as `range: {from,to}` and rendered (`查询范围：from–to`);
 *   2. a keyword-only query projects `range: null` and renders `未限定`;
 *   3. a relaxed `上次` query projects `relaxed: true` with an unbounded lower edge;
 *   4. malformed store values never crash and never become a fake range (null/false);
 *   5. current-state evidence carries `evidenceType:'current'` and the prompt convention says a
 *      screenshot/OBS scene can only prove now, never history.
 *
 * The fixtures are REAL MemoryStore rows; the mounted tools are called exactly as the model does.
 *
 * Run: node --test test/memory-tool-time-projection.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, sightSummary } from '../src/host/index.js';
import { MemoryStore, detectTimeRange } from '../src/host/memory/store.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

/** Minimal validator for the tool-output schema subset these tools use. */
function validate(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    assert.ok(TYPE_CHECKS[schema.type](value), `${path} must be of type ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(schema.enum.includes(value), `${path} is not an enum member`);
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `"${path}.${key}" is not a declared property`);
      }
    }
  }
  if (schema.type === 'array') {
    for (const [index, item] of value.entries()) validate(schema.items ?? {}, item, `${path}[${index}]`);
  }
}

/** Mount the plugin against a fake context, as the host does. */
function mount(root, config = {}) {
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_names, callback) => callback({
      effect,
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }),
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true, ...config });
  return { tools, disposers };
}

/** Seed the active table through the real store (the mounted host opens the same file). */
function seed(root, rows) {
  const store = new MemoryStore(root, { capacity: 5000 });
  try {
    return rows.map((row) => store.addMessage(row));
  } finally {
    store.close();
  }
}

const at = (rfc3339) => new Date(rfc3339).toISOString();
const midpoint = (range) => new Date((Date.parse(range.fromIso) + Date.parse(range.toIso)) / 2).toISOString();
const renderText = (tool, value) => tool.output.render({}, value)
  .filter((block) => block.type === 'text').map((block) => block.text).join('\n');

const SOURCE = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');

test('recall with a real window projects range/relaxed and renders the exact window', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-window-'));
  const window = detectTimeRange('昨天');
  seed(root, [{
    role: 'user', sessionId: 'window', turnId: 1, messageId: 'window-1',
    ts: midpoint(window), text: '昨天去看了樱花，还拍了照片。',
  }]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '昨天 樱花' }, {});

  validate(tool.output.schema, value);
  assert.deepEqual(value.range, { from: window.fromIso, to: window.toIso },
    'range is the store window, not a re-parse of the query text');
  assert.equal(value.relaxed, false);
  assert.ok(value.hits.length >= 1, 'the seeded row is inside the requested day');

  const text = renderText(tool, value);
  assert.ok(
    text.includes(`查询范围：${window.fromIso}–${window.toIso}`),
    `render names the exact window\n${text}`,
  );
  assert.ok(text.includes('放宽：否'), 'render states it was not widened');
  assert.ok(text.includes('命中'), 'the normal hit summary is still there');
  console.log(`[window] ${window.fromIso}..${window.toIso} hits=${value.hits.length}`);
});

test('keyword-only recall projects range:null and renders 未限定', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-none-'));
  seed(root, [{
    role: 'user', sessionId: 'no-window', turnId: 1, messageId: 'no-window-1',
    ts: at('2026-11-08T12:00:00+08:00'), text: '樱花树下有一只猫。',
  }]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '樱花' }, {});

  validate(tool.output.schema, value);
  assert.equal(value.range, null, 'no time phrase means the whole active table, not a fake window');
  assert.equal(value.relaxed, false);
  const text = renderText(tool, value);
  assert.ok(text.includes('查询范围：未限定'), `render says the scope is unbounded\n${text}`);
  assert.ok(text.includes('放宽：否'));
  console.log(`[no-window] range=${JSON.stringify(value.range)} relaxed=${value.relaxed}`);
});

test('a relaxed 上次 query projects a null lower edge and relaxed:true', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-relaxed-'));
  const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
  seed(root, [{
    role: 'user', sessionId: 'relaxed', turnId: 1, messageId: 'relaxed-1',
    ts: old, text: '上次樱花讨论的部署方案是蓝绿发布。',
  }]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '上次樱花讨论' }, {});

  validate(tool.output.schema, value);
  assert.equal(value.relaxed, true, 'the store widened the 90-day window');
  assert.equal(value.range.from, null, 'the widened query has no lower bound');
  assert.equal(typeof value.range.to, 'string', 'the upper bound survives the widening');
  assert.ok(value.hits.some((hit) => hit.text.includes('蓝绿发布')), 'the old row is found');

  const text = renderText(tool, value);
  assert.ok(
    text.includes(`查询范围：不限–${value.range.to}`),
    `render shows the unbounded lower edge\n${text}`,
  );
  assert.ok(text.includes('放宽：是'), `render states the widening\n${text}`);
  console.log(`[relaxed] from=${value.range.from} to=${value.range.to} hits=${value.hits.length}`);
});

test('malformed store bounds project range:null/relaxed:false without throwing (bad value)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-bad-'));
  seed(root, [{
    role: 'user', sessionId: 'bad', turnId: 1, messageId: 'bad-1',
    ts: at('2026-11-08T12:00:00+08:00'), text: '坏值樱花仍然是一行真实记录。',
  }]);

  const original = MemoryStore.prototype.recall;
  MemoryStore.prototype.recall = function badWindowRecall(options) {
    const result = original.call(this, options);
    return { ...result, from: 'not-a-date', to: { broken: true }, relaxed: 'yes' };
  };
  t.after(() => {
    MemoryStore.prototype.recall = original;
  });

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_recall');
  const value = await tool.execute({ query: '坏值樱花' }, {});

  validate(tool.output.schema, value);
  assert.equal(value.range, null, 'a malformed bound never becomes a range');
  assert.equal(value.relaxed, false, 'a non-boolean relaxed flag projects false');
  const text = renderText(tool, value);
  assert.ok(text.includes('查询范围：未限定'), `render falls back to 未限定\n${text}`);
  console.log(`[bad-value] range=${JSON.stringify(value.range)} relaxed=${value.relaxed}`);
});

test('brief projects the same window and renders it even with zero matched records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-time-brief-'));
  const window = detectTimeRange('昨天');
  const beforeYesterday = detectTimeRange('前天');
  seed(root, [{
    role: 'user', sessionId: 'brief', turnId: 1, messageId: 'brief-1',
    ts: midpoint(window), text: '昨天去看了樱花，还拍了照片。',
  }]);

  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_memory_brief');

  const hit = await tool.execute({ query: '昨天 樱花' }, {});
  validate(tool.output.schema, hit);
  assert.deepEqual(hit.range, { from: window.fromIso, to: window.toIso },
    'brief reports the recall window, not the query wording');
  assert.equal(hit.relaxed, false);
  assert.ok(hit.matched >= 1);
  const hitText = renderText(tool, hit);
  assert.ok(hitText.includes(`查询范围：${window.fromIso}–${window.toIso}`), `hit render carries the window\n${hitText}`);

  // A bounded query whose window holds no record must still say which window it searched.
  // (A time question widens to recent originals in that window, so the empty window is the
  // day before yesterday — the seeded row sits in yesterday.)
  const empty = await tool.execute({ query: '前天 火星基地' }, {});
  validate(tool.output.schema, empty);
  assert.deepEqual(empty.range, { from: beforeYesterday.fromIso, to: beforeYesterday.toIso });
  assert.equal(empty.fixed, 0);
  assert.equal(empty.matched, 0);
  const emptyText = renderText(tool, empty);
  assert.ok(emptyText.includes('没有可注入的记忆'), emptyText);
  assert.ok(
    emptyText.includes(`查询范围：${beforeYesterday.fromIso}–${beforeYesterday.toIso}`),
    `the zero-hit render still names the window\n${emptyText}`,
  );
  console.log(`[brief] hit=${hit.matched} emptyRange=${empty.range.from}..${empty.range.to}`);
});

test('assistant_see result carries evidenceType:"current" and the render says it cannot prove the past', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-see-'));
  const { tools, disposers } = mount(root);
  t.after(() => cleanupRoot(root, disposers));

  // No attachments service is mounted, so the call refuses before touching the screen. The
  // refusal is still a current-view attempt and must carry the same evidence label.
  const tool = tools.get('assistant_see');
  const value = await tool.execute({ reason: 'evidence projection' }, {});
  assert.equal(value.evidenceType, 'current', 'the tool result labels the evidence type');
  validate(tool.output.schema, value);
  assert.ok(Object.hasOwn(tool.output.schema.properties, 'evidenceType'), 'the output schema declares it');
  assert.ok(tool.output.schema.required.includes('evidenceType'), 'the output schema requires it');

  const summary = sightSummary({
    width: 320, height: 200, bytes: 20, capturedAt: Date.now(), mode: 'desktop', current: true,
  });
  assert.match(summary, /证据类型：current/u, summary);
  assert.match(summary, /不能证明过去/u, summary);
  console.log(`[see] ok=${value.ok} evidenceType=${value.evidenceType}`);
});

test('assistant_obs current carries evidenceType:"current" and the render labels it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-obs-'));
  // Port 1 refuses immediately, so this test never depends on a real OBS.
  const { tools, disposers } = mount(root, { obsPort: 1 });
  t.after(() => cleanupRoot(root, disposers));
  const tool = tools.get('assistant_obs');
  const value = await tool.execute({ action: 'current' }, {});

  assert.equal(value.evidenceType, 'current', 'even a failed current-read is labelled current');
  validate(tool.output.schema, value);
  const text = renderText(tool, {
    ok: true, action: 'current', current: '浏览器', scenes: ['浏览器'], evidenceType: 'current',
  });
  assert.match(text, /证据类型：current/u, text);
  assert.match(text, /不能证明历史/u, text);
  console.log(`[obs] ok=${value.ok} evidenceType=${value.evidenceType}`);
});

test('the OBS environment block and memory convention state the current-only rule', () => {
  assert.ok(
    SOURCE.includes('证据类型：current（只证此刻，不能证明历史）'),
    'the OBS environment block carries the evidence label',
  );
  assert.ok(
    SOURCE.includes('截图 / 当前画面 / OBS 当前场景 / 当前配置只能作为「当前状态」证据'),
    'the prompt convention names screenshots/current state as current-only evidence',
  );
  assert.ok(
    SOURCE.includes('不得据此断言历史发生过什么，历史归因必须来自记忆或会话查询'),
    'the convention sends historical attribution to memory/session queries',
  );
  console.log('[convention] current-only rule is present in the prompt source');
});
