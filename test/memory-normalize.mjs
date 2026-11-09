/**
 * Memory write normalization (stage 2): pronoun expansion + absolute time + zone stamp.
 *
 * The list mirrors the acceptance items:
 *   1. one clear object → the pronoun becomes its name, with no parenthetical explanation;
 *   2. several candidates → no guess: original words, unresolved=1;
 *   3. reported speech → the quoted 我 is the speaker;
 *   4. a supposition is never turned into an established fact;
 *   5. 今天/明天/后天/本周X/下周X/上周X → the right absolute date;
 *   6. a 01:30 local utterance keeps ITS local date (not the 04:00 session boundary);
 *   7. a vague time → original words, unresolved=1;
 *   8. a manual write keeps the original in raw_text and stores the absolute version;
 *   9. tz_used is persisted and correct (including a non-default zone);
 *  10. normalizing twice changes nothing;
 *  11. manual remember and automatic recording go through the SAME function (injected counter);
 *  12. plain text with no pronoun and no date is untouched and reports no change;
 *  13. the correction replacement is time-normalized but never pronoun-expanded;
 *  14. demonstratives use the same unique object, while 这个方案 stays self-contained;
 *  15. the event carries kinds only, never the memory body;
 *  16. the automatic evidence lane keeps relative wording while still expanding pronouns (§6.4).
 *
 * Run: node --test test/memory-normalize.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, createAutoMemoryRecorder } from '../src/host/index.js';
import { MemoryStore } from '../src/host/memory/store.js';
import {
  normalizeForMemory,
  resolveMemoryTimeZone,
  zonedDateStamp,
} from '../src/host/memory/memory-normalize.js';

const BASE = new Date('2026-11-06T10:00:00+08:00');
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-mem-norm-'));
}

async function cleanup(root, ...stores) {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** In-memory stand-in for `data/events.jsonl`. */
function eventLog() {
  const events = [];
  return {
    events,
    async emit(type, payload) {
      events.push({ type, payload });
      return { type, payload };
    },
  };
}

/** One `user/message` feed event (the shape the Harness logs). */
function userEvent(id, text, time) {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  };
}

/** Auto recorder + store over a temp root; relative dates resolved in `timeZone`. */
function autoLane(root, timeZone = 'Asia/Shanghai') {
  const memory = new MemoryStore(root, { capacity: 2000 });
  const log = eventLog();
  const recorder = createAutoMemoryRecorder({
    memory,
    log,
    settings: { enabled: true, minChars: 1, maxChars: 400, includeReply: false },
    timeZone,
  });
  return { memory, log, recorder };
}

function rowFor(memory, messageId) {
  return memory.db
    .prepare('SELECT text, raw_text, tz_used, unresolved FROM memory_event WHERE message_id = ?')
    .get(messageId);
}

/** Mount the real plugin (same fake context as the other memory tests) + captured event handlers. */
function mountPlugin(root, extra = {}) {
  const tools = new Map();
  const handlers = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const on = (name, fn) => {
    const list = handlers.get(name) ?? [];
    list.push(fn);
    handlers.set(name, list);
    return () => {};
  };
  const ctx = {
    effect,
    on,
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
  apply(ctx, { root, enabled: true, ...extra });
  return {
    tools,
    async fire(name, ...args) {
      for (const fn of handlers.get(name) ?? []) await fn(...args);
    },
    async call(name, args = {}, exec = {}) {
      const tool = tools.get(name);
      assert.ok(tool !== undefined, `tool registered: ${name}`);
      return tool.execute(args, exec);
    },
    close() {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('1) the unique object from the previous turn replaces the pronoun, without parentheses', (t) => {
  const out = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`before: 她最近不爱吃饭 -> after: ${out.text}`);
  assert.equal(out.text, '团子最近不爱吃饭');
  assert.ok(!out.text.includes('（'), 'no parenthetical annotation');
  assert.ok(!out.text.includes('）'), 'no parenthetical annotation');
  assert.equal(out.rawText, '她最近不爱吃饭');
  assert.deepEqual(out.changes, ['pronoun']);
  assert.equal(out.unresolved, 0);
});

test('2) several candidates (or none clear) never guess: original words + unresolved=1', (t) => {
  const two = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子，还养了一只狗，叫豆豆'] },
  });
  t.diagnostic(`two candidates -> ${two.text} unresolved=${two.unresolved}`);
  assert.equal(two.text, '她最近不爱吃饭');
  assert.deepEqual(two.changes, []);
  assert.equal(two.unresolved, 1);

  const explicitTwo = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { entities: ['团子', '豆豆'] },
  });
  assert.equal(explicitTwo.text, '她最近不爱吃饭');
  assert.equal(explicitTwo.unresolved, 1);

  const explicitOne = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { entities: ['团子'] },
  });
  assert.equal(explicitOne.text, '团子最近不爱吃饭');
  assert.equal(explicitOne.unresolved, 0);
});

test('3) reported speech resolves 我 to the speaker, then the date is absolute', (t) => {
  const out = normalizeForMemory('小王说『我明天去』', { now: BASE });
  t.diagnostic(`quote: ${out.text}`);
  assert.equal(out.text, '小王说『小王2026-11-07去』');
  assert.ok(!out.text.includes('『我'), 'the quoted 我 is the speaker');
  assert.deepEqual(out.changes, ['quote', 'time']);
  assert.equal(out.unresolved, 0);
});

test('4) a supposition is not expanded into an established fact', (t) => {
  const text = '如果我养猫，她会不会喜欢';
  const out = normalizeForMemory(text, {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`hypothetical -> ${out.text} (changes=${out.changes.join(',')})`);
  assert.equal(out.text, text, 'the original words are kept');
  assert.ok(!out.text.includes('团子'), 'no object was substituted as a fact');
  assert.equal(out.changes.length, 0);
  assert.equal(out.unresolved, 1, 'the unresolved pronoun is reported, never guessed');
});

test('5) 今天/明天/后天/本周X/下周X/上周X become the right dates (Asia/Shanghai)', (t) => {
  const cases = [
    ['今天交报告', '2026-11-06交报告'],
    ['明天交报告', '2026-11-07交报告'],
    ['后天交报告', '2026-11-08交报告'],
    ['昨天交报告', '2026-11-05交报告'],
    ['前天交报告', '2026-11-04交报告'],
    ['本周三交报告', '2026-11-04交报告'],
    ['下周三交报告', '2026-11-11交报告'],
    ['上周三交报告', '2026-10-28交报告'],
    ['下周一交报告', '2026-11-09交报告'],
    ['本周日交报告', '2026-11-08交报告'],
  ];
  for (const [text, expected] of cases) {
    const out = normalizeForMemory(text, { now: BASE });
    assert.equal(out.text, expected, `${text} -> ${expected} (got ${out.text})`);
    assert.deepEqual(out.changes, ['time']);
    assert.equal(out.unresolved, 0);
  }
  t.diagnostic(`10 relative dates at ${zonedDateStamp(BASE)} -> absolute`);
});

test('6) a 01:30 local utterance keeps its own date (not the 04:00 session boundary)', (t) => {
  const at = new Date('2026-11-04T17:30:00Z'); // 2026-11-05 01:30 Asia/Shanghai
  assert.equal(zonedDateStamp(at), '2026-11-05');
  const out = normalizeForMemory('今天要把报告发出去', { now: at });
  t.diagnostic(`01:30 local -> ${out.text}`);
  assert.equal(out.text, '2026-11-05要把报告发出去');
  assert.equal(out.unresolved, 0);
});

test('7) a vague time keeps the original wording and reports unresolved=1', (t) => {
  for (const text of ['改天一起吃饭', '找个时间把方案定了', '我们下周聊聊']) {
    const out = normalizeForMemory(text, { now: BASE });
    t.diagnostic(`${text} -> unresolved=${out.unresolved}`);
    assert.equal(out.text, text);
    assert.deepEqual(out.changes, []);
    assert.equal(out.unresolved, 1);
  }
});

test('8) the automatic lane keeps the relative wording verbatim (§6.4)', async (t) => {
  const root = await tempRoot();
  const { memory, recorder } = autoLane(root);
  t.after(() => cleanup(root, memory));

  const at = Date.parse('2026-11-06T02:00:00Z'); // 2026-11-06 10:00 Asia/Shanghai
  await recorder.handle({ id: 's1' }, userEvent('m8', '明天上午交报告', at));
  const row = rowFor(memory, 'm8');
  t.diagnostic(`text=${row.text} raw_text=${row.raw_text}`);
  assert.equal(row.text, '明天上午交报告', 'evidence wording is never rewritten');
  assert.equal(row.raw_text, null, 'an unchanged body needs no separate raw copy');
  assert.equal(row.unresolved, 0, 'keeping the wording is intentional, not unresolved');
});

test('9) tz_used is persisted and honours memory.timeZone', async (t) => {
  const shanghaiRoot = await tempRoot();
  const newYorkRoot = await tempRoot();
  const shanghai = autoLane(shanghaiRoot);
  const newYork = autoLane(newYorkRoot, 'America/New_York');
  t.after(() => cleanup(shanghaiRoot, shanghai.memory));
  t.after(() => cleanup(newYorkRoot, newYork.memory));

  // 2026-11-06T02:00Z is 10:00 in Shanghai and still 2026-11-05 21:00 in New York.
  const at = Date.parse('2026-11-06T02:00:00Z');
  await shanghai.recorder.handle({ id: 's1' }, userEvent('tz-sh', '今天交报告', at));
  await newYork.recorder.handle({ id: 's2' }, userEvent('tz-ny', '今天交报告', at));
  const sh = rowFor(shanghai.memory, 'tz-sh');
  const ny = rowFor(newYork.memory, 'tz-ny');
  t.diagnostic(`shanghai tz=${sh.tz_used} text=${sh.text}; new york tz=${ny.tz_used} text=${ny.text}`);
  assert.equal(sh.tz_used, 'Asia/Shanghai');
  assert.equal(sh.text, '今天交报告', 'the automatic lane keeps the spoken wording');
  assert.equal(ny.tz_used, 'America/New_York');
  assert.equal(ny.text, '今天交报告', 'the zone is still stamped for later derivation');
  // A broken config falls back to the default zone instead of throwing.
  assert.equal(resolveMemoryTimeZone('Not/AZone'), 'Asia/Shanghai');
});

test('10) normalizing the same text twice changes nothing', (t) => {
  const context = { previous: ['我养了一只猫，叫团子'] };
  const first = normalizeForMemory('明天她要去医院', { now: BASE, context });
  const second = normalizeForMemory(first.text, { now: BASE, context });
  t.diagnostic(`first=${first.text} second=${second.text}`);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.changes, []);
  assert.equal(second.rawText, first.text);
});

test('11) manual remember and automatic recording call the same normalizer', async (t) => {
  const root = await tempRoot();
  const calls = [];
  const counting = (text, options) => {
    calls.push({ text, options });
    return normalizeForMemory(text, options);
  };
  const app = mountPlugin(root, { memoryNormalize: counting });
  const session = { id: 's1', header: { cwd: join(root, 'workspace') } };
  try {
    await app.fire('session/event', session, userEvent('auto-11', '记得买猫粮', Date.now()));
    await wait(100);
    assert.equal(calls.length, 1, 'the auto lane went through the injected normalizer');
    assert.ok(calls[0].options.timeZone.length > 0);

    const manual = await app.call('assistant_remember', { text: '记得买猫粮' }, { agent: { session } });
    assert.ok(manual.id.length > 0);
    assert.equal(calls.length, 2, 'assistant_remember used the same function');
    assert.equal(calls[1].options.timeZone, calls[0].options.timeZone);
    t.diagnostic(`calls=${calls.length} texts=${calls.map((call) => call.text).join('|')}`);
  } finally {
    app.close();
  }
  // Both lanes stored the very same normalized body (manual: importance >= 50, no message id).
  const store = new MemoryStore(root, { capacity: 2000 });
  try {
    store.open();
    const rows = store.db.prepare('SELECT text, raw_text FROM memory_event ORDER BY ts ASC, role ASC').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.text === '记得买猫粮'));
    assert.ok(rows.every((row) => row.raw_text === null), 'an unchanged body stores no raw_text');
  } finally {
    await cleanup(root, store);
  }
});

test('12) plain text with no pronoun and no time is completely unchanged', (t) => {
  const text = '我在做记忆模块的测试';
  const out = normalizeForMemory(text, {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`plain -> ${out.text} changes=${out.changes.length} unresolved=${out.unresolved}`);
  assert.equal(out.text, text);
  assert.equal(out.rawText, text);
  assert.deepEqual(out.changes, []);
  assert.equal(out.unresolved, 0);
});

test('13) the correction replacement is time-normalized but never pronoun-expanded', (t) => {
  const out = normalizeForMemory('她明天来', {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
    expand: false,
  });
  t.diagnostic(`correction replacement -> ${out.text}`);
  assert.equal(out.text, '她2026-11-07来', 'the pronoun is left exactly as corrected');
  assert.deepEqual(out.changes, ['time']);
});

test('14) demonstratives use the same unique object; a demonstrative+noun stays self-contained', (t) => {
  const context = { entities: ['报告.docx', '新手机'] };
  // Two candidates: nothing is guessed, even for the explicit forms.
  assert.equal(normalizeForMemory('那个文件在哪里', { now: BASE, context }).text, '那个文件在哪里');

  const file = normalizeForMemory('那个文件在哪里', { now: BASE, context: { entities: ['报告.docx'] } });
  const phone = normalizeForMemory('它坏了', { now: BASE, context: { entities: ['新手机'] } });
  t.diagnostic(`那个文件/它 -> ${file.text} / ${phone.text}`);
  assert.equal(file.text, '报告.docx在哪里');
  assert.equal(phone.text, '新手机坏了');
  const selfContained = normalizeForMemory('这个方案不行', { now: BASE, context: { entities: ['新手机'] } });
  assert.equal(selfContained.text, '这个方案不行', '这个方案 is not an anaphor');
  assert.deepEqual(selfContained.changes, []);
  assert.equal(selfContained.unresolved, 0);
});

test('15) the memory.normalize event carries kinds only, never the body', async (t) => {
  const root = await tempRoot();
  const { memory, log, recorder } = autoLane(root);
  t.after(() => cleanup(root, memory));

  const at = Date.parse('2026-11-06T02:00:00Z');
  await recorder.handle({ id: 's1' }, userEvent('m14', '明天她要去医院', at));
  const event = log.events.find((entry) => entry.type === 'memory.normalize');
  t.diagnostic(`event=${JSON.stringify(event?.payload)}`);
  assert.ok(event !== undefined, 'a normalized write emits memory.normalize');
  assert.deepEqual(Object.keys(event.payload).sort(), ['changes', 'tz', 'unresolved']);
  assert.ok(!event.payload.changes.includes('time'), 'the automatic lane never reports an absolutized date');
  assert.ok(!JSON.stringify(event.payload).includes('要去医院'), 'no memory body in the event');
});

test('16) a thing demonstrative never resolves to the only (animal) history candidate', (t) => {
  const text = '这个文件坏了';
  const out = normalizeForMemory(text, {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}; changes=${out.changes.join(',')}`);
  assert.equal(out.text, text, 'the file is not the cat');
  assert.deepEqual(out.changes, [], 'no substitution happened');
  assert.equal(out.unresolved, 1, 'the reference is reported as unresolved');
});

test('17) the same sentence names the subject first: 他 -> 小明, not the history object', (t) => {
  const text = '我朋友叫小明，他今天来看我';
  const out = normalizeForMemory(text, {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
    // A direct comparison caller states its lane; only the recorder's context-without-expand
    // shape is the evidence lane.
    resolveTime: true,
  });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '我朋友叫小明，小明2026-11-06来看我');
  assert.ok(!out.text.includes('团子'), 'the history candidate lost to the sentence subject');
  assert.deepEqual(out.changes, ['pronoun', 'time']);
  assert.equal(out.unresolved, 0);
});

test('18) 她 + the single animal candidate still resolves (regression)', (t) => {
  const out = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`before: 她最近不爱吃饭 -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '团子最近不爱吃饭');
  assert.deepEqual(out.changes, ['pronoun']);
  assert.equal(out.unresolved, 0);
});

test('19) a book title is a name: 《明天会更好》 keeps its wording', (t) => {
  const title = '《明天会更好》';
  const out = normalizeForMemory(title, { now: BASE });
  t.diagnostic(`before: ${title} -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.equal(out.text, title);
  assert.deepEqual(out.changes, []);
  assert.equal(out.unresolved, 0);

  const around = normalizeForMemory('我明天要听《明天会更好》', { now: BASE });
  t.diagnostic(`before: 我明天要听《明天会更好》 -> after: ${around.text}`);
  assert.equal(around.text, '我2026-11-07要听《明天会更好》', 'outside the title the date still resolves');

  // The same characters as an ordinary noun phrase are a date, not a title.
  const plain = normalizeForMemory('明天会更好', { now: BASE });
  t.diagnostic(`before: 明天会更好 -> after: ${plain.text}`);
  assert.equal(plain.text, '2026-11-07会更好');
});

test('20) a quoted 明天 is resolved against the SPEAKER\'s day, not the current day', (t) => {
  const text = '昨天小王说『我明天去』';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}`);
  // 小王 spoke yesterday (2026-11-05), so his 明天 is 2026-11-06 — not the current 2026-11-07.
  assert.equal(out.text, '2026-11-05小王说『小王2026-11-06去』');
  assert.deepEqual(out.changes, ['quote', 'time']);
  assert.equal(out.unresolved, 0);
});

test('21) an unknown speaker time keeps the quoted date and reports unresolved=1', (t) => {
  const text = '前段时间小王说『我明天去』';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}; changes=${out.changes.join(',')}`);
  assert.equal(out.text, '前段时间小王说『小王明天去』', 'the quoted date is not guessed');
  assert.ok(!out.text.includes('2026-'), 'no date was invented for the quotation');
  assert.ok(!out.changes.includes('time'));
  assert.equal(out.unresolved, 1);
});

test('22) compact() archives raw_text and unresolved together with the row', async (t) => {
  const root = await tempRoot();
  const memory = new MemoryStore(root, { capacity: 10 });
  memory.open();
  t.after(() => cleanup(root, memory));

  memory.insert({
    domain: 'chat', kind: 'fact', text: '2026-11-07开会', clarity: 'trace', importance: 10,
    raw_text: '明天开会', unresolved: 1, tz_used: 'Asia/Shanghai', source: 'auto',
  });
  memory.insert({
    domain: 'chat', kind: 'fact', text: '另一条较重要的记录', clarity: 'trace', importance: 90,
    source: 'auto',
  });
  const moved = memory.compact({ targetRatio: 0.1 });
  const archived = memory.db
    .prepare('SELECT text, raw_text, unresolved, tz_used FROM memory_archive WHERE text = ?')
    .get('2026-11-07开会');
  const active = memory.db
    .prepare("SELECT COUNT(*) AS c FROM memory_event WHERE text = '2026-11-07开会'")
    .get().c;
  t.diagnostic(
    `compact moved=${moved.moved}; archived raw_text=${archived?.raw_text} ` +
      `unresolved=${archived?.unresolved} tz=${archived?.tz_used}; active=${active}`,
  );
  assert.ok(archived !== undefined, 'the row reached the archive');
  assert.equal(archived.raw_text, '明天开会');
  assert.equal(archived.unresolved, 1);
  assert.equal(archived.tz_used, 'Asia/Shanghai');
  assert.equal(active, 0, 'the active copy is gone');
});

test('24) a book title is protected from pronoun expansion (《她》 stays 《她》)', (t) => {
  const context = { previous: ['我养了一只猫，叫团子'] };
  const exact = normalizeForMemory('我喜欢《她》这部电影', { now: BASE, context });
  t.diagnostic(`before: 我喜欢《她》这部电影 -> after: ${exact.text}; unresolved=${exact.unresolved}`);
  assert.equal(exact.text, '我喜欢《她》这部电影', 'the title keeps its own characters');
  assert.ok(!exact.text.includes('《团子》'), 'the pronoun expansion never enters the title');
  assert.equal(exact.unresolved, 0, 'a title character is a name, not a loose anaphor');

  // Outside the title the same pronoun still expands; it just never crosses the delimiter.
  const outside = normalizeForMemory('她喜欢《她》这部电影', { now: BASE, context });
  t.diagnostic(`outside: 她喜欢《她》这部电影 -> ${outside.text}`);
  assert.equal(outside.text, '团子喜欢《她》这部电影');
  assert.deepEqual(outside.changes, ['pronoun']);
  assert.equal(outside.unresolved, 0);
});

test('25) an absolute date in the prefix is the reported speech base (YYYY-MM-DD)', (t) => {
  const text = '2026-11-01小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.ok(out.text.includes('2026-11-02'), `quoted 明天 = 2026-11-02 (got ${out.text})`);
  assert.ok(!out.text.includes('2026-11-07'), 'not the current day');
  assert.ok(out.changes.includes('time'));
  assert.equal(out.unresolved, 0);
});

test('26) an absolute date in the prefix is the reported speech base (YYYY年M月D日)', (t) => {
  const text = '2026年11月1日小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.ok(out.text.includes('2026-11-02'), `quoted 明天 = 2026-11-02 (got ${out.text})`);
  assert.ok(!out.text.includes('2026-11-07'), 'not the current day');
  assert.equal(out.unresolved, 0);
});

test('27) the relative-day speaker base keeps its behaviour (regression: 昨天 -> 11-06)', (t) => {
  const text = '昨天小王说『我明天去』';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '2026-11-05小王说『小王2026-11-06去』');
  assert.deepEqual(out.changes, ['quote', 'time']);
  assert.equal(out.unresolved, 0);
});

test('28) no absolute prefix and no determinable context: keep the words + unresolved=1', (t) => {
  const text = '上个月小王说「明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; unresolved=${out.unresolved}; changes=${out.changes.join(',')}`);
  assert.equal(out.text, text, 'the undated quotation is not rebased to today');
  assert.ok(!out.text.includes('2026-'), 'no date was invented');
  assert.deepEqual(out.changes, []);
  assert.equal(out.unresolved, 1);

  // Reported-speech pronoun expansion still happens; only the date stays as spoken.
  const withPronoun = normalizeForMemory('上个月小王说「我明天去」', { now: BASE });
  t.diagnostic(`with 我 -> ${withPronoun.text}; unresolved=${withPronoun.unresolved}`);
  assert.equal(withPronoun.text, '上个月小王说「小王明天去」');
  assert.equal(withPronoun.unresolved, 1);
});

test('29) a date word inside a book title is never replaced (outside stays replaceable)', (t) => {
  const title = '《明天》';
  const out = normalizeForMemory(title, { now: BASE });
  t.diagnostic(`before: ${title} -> after: ${out.text}; changes=${out.changes.length}`);
  assert.equal(out.text, title);
  assert.deepEqual(out.changes, []);
  assert.equal(out.unresolved, 0);

  const mixed = normalizeForMemory('《明天》和明天', { now: BASE });
  t.diagnostic(`before: 《明天》和明天 -> after: ${mixed.text}`);
  assert.equal(mixed.text, '《明天》和2026-11-07', 'inside the title untouched, outside resolved');
  assert.deepEqual(mixed.changes, ['time']);
});

test('30) a resolved pronoun names its basis record directly; no basis means no id', (t) => {
  const intro = { id: 'rec-intro', text: '我养了一只猫，叫团子' };
  const expanded = normalizeForMemory('她最近不爱吃饭', {
    now: BASE,
    context: { previous: [intro.text], records: [intro] },
  });
  t.diagnostic(`referentId=${expanded.referentId} text=${expanded.text}`);
  assert.equal(expanded.text, '团子最近不爱吃饭');
  assert.equal(expanded.referentId, 'rec-intro', 'the id comes from the same context resolution');

  // A subject taken from the same sentence needs no stored basis.
  const sameSentence = normalizeForMemory('我朋友叫小明，他今天来看我', {
    now: BASE,
    context: { previous: [intro.text], records: [intro] },
  });
  assert.equal(sameSentence.referentId, '');

  // Explicit entities and previous-only context carry no record id, so no link can be written.
  assert.equal(
    normalizeForMemory('她最近不爱吃饭', { now: BASE, context: { entities: ['团子'] } }).referentId,
    '',
  );
  assert.equal(
    normalizeForMemory('她最近不爱吃饭', { now: BASE, context: { previous: [intro.text] } }).referentId,
    '',
  );
  // The correction replacement never expands pronouns, so it never claims a basis.
  assert.equal(
    normalizeForMemory('她明天来', {
      now: BASE, context: { previous: [intro.text], records: [intro] }, expand: false,
    }).referentId,
    '',
  );
});

test('31) an absolute date lead (YYYY-MM-DD) lets the following name own the quoted 我', (t) => {
  const text = '2026-11-01小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; changes=${out.changes.join(',')}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '2026-11-01小王说「小王2026-11-02去」');
  assert.ok(!out.text.includes('「我'), 'the quoted 我 is the speaker, not the user');
  assert.ok(out.changes.includes('quote'), 'the speaker expansion is reported');
  assert.ok(out.changes.includes('time'));
  assert.equal(out.unresolved, 0);
});

test('32) an absolute date lead (YYYY年M月D日) lets the following name own the quoted 我', (t) => {
  const text = '2026年11月1日小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; changes=${out.changes.join(',')}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '2026年11月1日小王说「小王2026-11-02去」');
  assert.ok(!out.text.includes('「我'), 'the quoted 我 is the speaker, not the user');
  assert.ok(out.changes.includes('quote'));
  assert.ok(out.changes.includes('time'));
  assert.equal(out.unresolved, 0);
});

test('33) a relative-day lead keeps its behaviour (昨天 -> 11-06)', (t) => {
  const text = '昨天小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; changes=${out.changes.join(',')}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '2026-11-05小王说「小王2026-11-06去」');
  assert.ok(!out.text.includes('「我'), 'the quoted 我 is the speaker');
  assert.deepEqual(out.changes, ['quote', 'time']);
  assert.equal(out.unresolved, 0);
});

test('34) no prefix: 小王说「我明天去」 is unchanged in shape', (t) => {
  const text = '小王说「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; changes=${out.changes.join(',')}; unresolved=${out.unresolved}`);
  assert.equal(out.text, '小王说「小王2026-11-07去」');
  assert.ok(!out.text.includes('「我'), 'the quoted 我 is the speaker');
  assert.deepEqual(out.changes, ['quote', 'time']);
  assert.equal(out.unresolved, 0);
});

test('35) no speaker: 「我明天去」 keeps the original words and reports unresolved=1', (t) => {
  const text = '「我明天去」';
  const out = normalizeForMemory(text, { now: BASE });
  t.diagnostic(`before: ${text} -> after: ${out.text}; changes=${out.changes.length}; unresolved=${out.unresolved}`);
  assert.equal(out.text, text, 'without a speaker the quoted 我 is never guessed');
  assert.ok(!out.text.includes('2026-'), 'no date was invented either');
  assert.deepEqual(out.changes, []);
  assert.equal(out.unresolved, 1);
});

test('36) the automatic-lane call shape keeps relative time; an explicit lane still resolves it', (t) => {
  // This is the recorder's own call shape: a captured context, no `expand` decision.
  const auto = normalizeForMemory('明天交报告', {
    now: BASE, timeZone: 'Asia/Shanghai', context: {},
  });
  t.diagnostic(`auto -> ${auto.text}; changes=${auto.changes.join(',')}`);
  assert.equal(auto.text, '明天交报告');
  assert.deepEqual(auto.changes, []);
  assert.equal(auto.rawText, '明天交报告');

  // A manual/comparison caller either states `expand` or `resolveTime`; both still absolutize.
  const manual = normalizeForMemory('明天交报告', {
    now: BASE, timeZone: 'Asia/Shanghai', context: {}, expand: true,
  });
  assert.equal(manual.text, '2026-11-07交报告');
  assert.deepEqual(manual.changes, ['time']);

  const explicit = normalizeForMemory('明天交报告', {
    now: BASE, timeZone: 'Asia/Shanghai', context: {}, resolveTime: true,
  });
  assert.equal(explicit.text, '2026-11-07交报告');

  // Backward-compatible default when no context is supplied (plain library call).
  const plain = normalizeForMemory('明天交报告', { now: BASE });
  assert.equal(plain.text, '2026-11-07交报告');
  assert.deepEqual(plain.changes, ['time']);

  // An explicit false wins even for a manual-shaped call.
  const kept = normalizeForMemory('明天交报告', { now: BASE, expand: true, resolveTime: false });
  assert.equal(kept.text, '明天交报告');
  assert.deepEqual(kept.changes, []);
});

test('37) the automatic lane still expands pronouns, only the date stays as spoken', (t) => {
  const out = normalizeForMemory('她明天要去医院', {
    now: BASE,
    timeZone: 'Asia/Shanghai',
    context: { previous: ['我养了一只猫，叫团子'] },
  });
  t.diagnostic(`auto pronoun+time -> ${out.text}; changes=${out.changes.join(',')}`);
  assert.equal(out.text, '团子明天要去医院', 'stage-2 anaphora is still applied');
  assert.deepEqual(out.changes, ['pronoun']);
  assert.equal(out.unresolved, 0);
  assert.equal(out.referentId, '');
});
