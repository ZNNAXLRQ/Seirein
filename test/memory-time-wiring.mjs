/**
 * Manual-lane relative-time wiring (P-67 §6 / §6.4), through the real tool bodies.
 *
 * The store already absolutizes manual writes and reports `timeResolved`; this file checks the
 * two production losses:
 *   1. `assistant_remember` must pass the RAW wording separately and return the store report;
 *   2. `assistant_memory_correct` must hand the RAW replacement to the store (a normalized copy
 *      would already be absolute and the original term would be gone), and return the report.
 * Both tools return `timeResolved` as an ALWAYS-present array of `{term, date, ok, reason?,
 * note?}` (`[]` when nothing was parsed). The real registered output schemas declare that
 * structure; render adds one short line only when a date was actually resolved. It never
 * carries the memory body.
 *
 * The automatic evidence lane is the opposite: its wording stays exactly as spoken (§6.4).
 *
 * Run: node --test test/memory-time-wiring.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { createAutoMemoryRecorder } from '../src/host/memory/auto-recorder.js';
import { MemoryStore } from '../src/host/memory/store.js';

/** Monday 2026-11-09, 16:00 Asia/Shanghai (the P-67 acceptance anchor). */
const BASE = new Date('2026-11-09T16:00:00+08:00');

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-time-wiring-'));
}

/** Mount the real plugin with the same fake context the other memory tests use. */
function mount(root) {
  const tools = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register() {
            return () => {};
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  let closed = false;
  return {
    tools,
    async call(name, args = {}, exec = {}) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `tool registered: ${name}`);
      return tool.execute(args, exec);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

function rowOf(store, id) {
  return store.db
    .prepare('SELECT id, text, raw_text, tz_used, unresolved, version FROM memory_event WHERE id = ?')
    .get(id);
}

/** Model-facing text exactly as the Host would show it: the registered tool's own render. */
function renderText(app, name, value) {
  const tool = app.tools.get(name);
  assert.ok(tool !== undefined, `tool registered: ${name}`);
  return tool.output.render({}, value).map((block) => block.text).join('\n');
}

/** Open a reading handle on the same temp root after the plugin has closed. */
async function withStore(root, fn) {
  const store = new MemoryStore(root, { capacity: 2000 });
  try {
    store.open();
    return await fn(store);
  } finally {
    store.close();
  }
}

/** One `user/message` feed event (the shape the Harness logs). */
function userEvent(id, text, time) {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

test('1) assistant_remember: bracketed absolute date, raw_text verbatim, timeResolved returned', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE.getTime() });
  const root = await tempRoot();
  const app = mount(root);
  t.after(async () => {
    app.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const value = await app.call('assistant_remember', { text: '下周三去公园' });
  assert.ok(typeof value.id === 'string' && value.id.length > 0);
  assert.deepEqual(value.timeResolved, [
    { term: '下周三', date: '2026-11-18', ok: true },
  ], 'the tool returns the store report');
  // Structure only: no body and no raw wording leak through the report.
  assert.ok(!('rawText' in value));
  assert.ok(!('text' in value));
  assert.ok(!JSON.stringify(value.timeResolved).includes('公园'));
  const rendered = renderText(app, 'assistant_remember', value);
  assert.match(rendered, /时间已解析：2026-11-18（下周三）/, 'render shows the resolved date');
  assert.ok(!rendered.includes('公园'), 'render adds no body line of its own');

  app.close();
  await withStore(root, (store) => {
    const row = rowOf(store, value.id);
    assert.equal(row.text, '2026-11-18（下周三）去公园', 'absolute date keeps the original word in parentheses');
    assert.equal(row.raw_text, '下周三去公园', 'raw_text is the submitted wording');
  });
  console.log(`[1] ${value.id}: timeResolved=${JSON.stringify(value.timeResolved)}`);
});

test('2) assistant_memory_correct: raw replacement reaches the store, timeResolved returned', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE.getTime() });
  const root = await tempRoot();
  const app = mount(root);
  t.after(async () => {
    app.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const target = await app.call('assistant_remember', { text: '原定时间开会' });
  const value = await app.call('assistant_memory_correct', {
    targetId: target.id,
    expectedVersion: 1,
    expectedText: '时间',
    replacement: '明天',
  });

  assert.equal(value.ok, true, value.error);
  assert.equal(value.to, '2026-11-10（明天）', 'the replacement keeps the original word');
  assert.deepEqual(value.timeResolved, [
    { term: '明天', date: '2026-11-10', ok: true },
  ]);
  assert.match(
    renderText(app, 'assistant_memory_correct', value),
    /时间已解析：2026-11-10（明天）/,
    'correct render shows the resolved date',
  );

  app.close();
  await withStore(root, (store) => {
    const row = rowOf(store, target.id);
    assert.equal(row.text, '原定2026-11-10（明天）开会');
    assert.equal(row.version, 2);
    // The pre-correction body is the revision basis, not the new wording.
    assert.equal(row.raw_text, '原定时间开会');
  });
  console.log(`[2] replacement=${value.to} version=${value.version}`);
});

test('3) the automatic lane keeps relative wording while still expanding pronouns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE.getTime() });
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 2000 });
  const recorder = createAutoMemoryRecorder({
    memory,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: false },
    timeZone: 'Asia/Shanghai',
    contextOf: () => ({ previous: ['我养了一只猫，叫团子'] }),
  });
  t.after(async () => {
    try {
      memory.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  await recorder.handle({ id: 's-auto' }, userEvent('auto-1', '明天上午交报告', BASE.getTime()));
  const plain = memory.db
    .prepare('SELECT text, raw_text, tz_used, unresolved FROM memory_event WHERE message_id = ?')
    .get('auto-1');
  assert.equal(plain.text, '明天上午交报告', 'relative time is evidence, never rewritten');
  assert.equal(plain.raw_text, null);
  assert.equal(plain.tz_used, 'Asia/Shanghai', 'the zone is still stamped for later derivation');
  assert.equal(plain.unresolved, 0);

  await recorder.handle({ id: 's-auto' }, userEvent('auto-2', '她明天要去医院', BASE.getTime()));
  const expanded = memory.db
    .prepare('SELECT text FROM memory_event WHERE message_id = ?')
    .get('auto-2');
  assert.equal(expanded.text, '团子明天要去医院', 'stage-2 pronoun expansion still runs');
  assert.ok(!expanded.text.includes('2026-'), 'no absolute date on the automatic lane');
  console.log(`[3] auto="${plain.text}" / "${expanded.text}"`);
});

test('4) no relative expression: timeResolved is [], text unchanged; failures carry a reason', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE.getTime() });
  const root = await tempRoot();
  const app = mount(root);
  t.after(async () => {
    app.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  // No time expression at all.
  const plain = await app.call('assistant_remember', { text: '我在做记忆模块的测试' });
  assert.deepEqual(plain.timeResolved, []);
  assert.ok(!renderText(app, 'assistant_remember', plain).includes('时间已解析'), 'no empty time line');

  // A date-looking word inside a title is protected: nothing is parsed, text is unchanged.
  const title = await app.call('assistant_remember', { text: '书名叫《明天》' });
  assert.deepEqual(title.timeResolved, []);

  // A replacement without a relative expression keeps the empty contract.
  const corrected = await app.call('assistant_memory_correct', {
    targetId: plain.id,
    expectedVersion: 1,
    expectedText: '测试',
    replacement: '验证',
  });
  assert.equal(corrected.ok, true, corrected.error);
  assert.deepEqual(corrected.timeResolved, []);
  assert.ok(
    !renderText(app, 'assistant_memory_correct', corrected).includes('时间已解析'),
    'no empty time line on a correction either',
  );

  // A real but impossible date is reported as structured evidence (ok:false + reason), not
  // silently dropped and never guessed. 2026-11 (the mocked month) has no 31st.
  const invalid = await app.call('assistant_remember', { text: '这个月31号交表' });
  assert.equal(invalid.timeResolved.length, 1);
  assert.equal(invalid.timeResolved[0].ok, false);
  assert.equal(invalid.timeResolved[0].reason, 'invalid-date');
  assert.equal(invalid.timeResolved[0].date, null);

  app.close();
  await withStore(root, (store) => {
    assert.equal(rowOf(store, plain.id).text, '我在做记忆模块的验证');
    assert.equal(rowOf(store, title.id).text, '书名叫《明天》');
    assert.equal(rowOf(store, invalid.id).text, '这个月31号交表', 'an impossible date is not rewritten');
  });
  console.log(`[4] plain=${plain.timeResolved.length} title=${title.timeResolved.length} invalid=${invalid.timeResolved[0].reason}`);
});

test('5) both real registered output schemas declare a strict timeResolved field', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: BASE.getTime() });
  const root = await tempRoot();
  const app = mount(root);
  t.after(async () => {
    app.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  for (const name of ['assistant_remember', 'assistant_memory_correct']) {
    const tool = app.tools.get(name);
    assert.ok(tool !== undefined, `tool registered: ${name}`);
    const schema = tool.output.schema;
    assert.equal(schema.additionalProperties, false, `${name}: output stays strict`);
    const field = schema.properties.timeResolved;
    assert.ok(field !== undefined, `${name}: timeResolved is declared`);
    assert.equal(field.type, 'array');
    assert.equal(field.items.type, 'object');
    assert.equal(field.items.additionalProperties, false);
    assert.deepEqual(field.items.required, ['term', 'date', 'ok']);
    assert.deepEqual(
      Object.keys(field.items.properties).sort(),
      ['date', 'note', 'ok', 'reason', 'term'],
      `${name}: exactly the documented fields`,
    );
    assert.equal(field.items.properties.term.type, 'string');
    assert.deepEqual(field.items.properties.date.oneOf, [{ type: 'string' }, { type: 'null' }]);
    assert.equal(field.items.properties.ok.type, 'boolean');
    assert.equal(field.items.properties.reason.type, 'string');
    assert.equal(field.items.properties.note.type, 'string');
  }

  // The value the tool actually returns uses only declared keys; no runtime schema edit is needed.
  const value = await app.call('assistant_remember', { text: '下周三去公园' });
  const itemSchema = app.tools.get('assistant_remember').output.schema.properties.timeResolved.items;
  assert.deepEqual(value.timeResolved, [{ term: '下周三', date: '2026-11-18', ok: true }]);
  for (const key of Object.keys(value.timeResolved[0])) {
    assert.ok(key in itemSchema.properties, `schema declares the returned key ${key}`);
  }
  console.log('[5] registered schemas declare strict timeResolved; no runtime schema mutation');
});
