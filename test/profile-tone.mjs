/**
 * Profile tone rules: a persona is always second person 「你……」, a user profile is always third
 * person 「用户……」. The host checks every model output (split / extraction / rewrite) with a pure
 * function, repairs only the violating sentences once, and falls back deterministically when the
 * repair is still wrong. Quoted speech is always kept verbatim.
 *
 * Run: node --test test/profile-tone.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  buildToneRepairPrompt,
  checkProfileTone,
  createProfileMaintainer,
  fallbackToneText,
  parseToneRepair,
  PROFILE_TONE_EVENTS,
} from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const T0 = Date.parse('2026-11-06T10:00:00.000Z');

/**
 * One temp database plus an injectable splitter/extractor/composer/tone-repairer. The default
 * tone repairer behaves like a cooperative model (returns `fallbackToneText`), so each case can
 * override `runtime.repairImpl` to prove the repair path or force the deterministic fallback.
 */
async function fresh(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-tone-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  const profile = createProfileStore({ db });
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const runtime = {
    persona: { agent: '', user: '' },
    splitBySide: { agent: [], user: [] },
    splitCalls: [],
    repairCalls: [],
    repairImpl: null,
    composeCalls: [],
    composeImpl: null,
    messages: [],
    candidates: [],
    events: [],
    writes: [],
  };
  const addMessage = (id, text) => {
    runtime.messages.push({ id, role: 'user', text, ts: new Date(T0 - 1000).toISOString() });
  };
  const make = (extra = {}) => createProfileMaintainer({
    profile,
    now: () => new Date(T0),
    emit: (type, payload) => runtime.events.push({ type, payload }),
    split: async ({ side, text }) => {
      runtime.splitCalls.push({ side, text });
      return runtime.splitBySide[side] ?? [];
    },
    repairTone: async (input) => {
      runtime.repairCalls.push({ side: input.side, sentences: [...input.sentences] });
      if (runtime.repairImpl !== null) return runtime.repairImpl(input);
      return input.sentences.map((sentence) => fallbackToneText(sentence, input.side));
    },
    compose: async ({ side, entries }) => {
      runtime.composeCalls.push({ side, entries: entries.map((entry) => entry.text) });
      if (runtime.composeImpl !== null) return runtime.composeImpl({ side, entries });
      return `${entries.map((entry) => entry.text).join('。')}。`;
    },
    readMessages: ({ since, until, limit, after = null }) => runtime.messages
      .filter((message) => {
        if (message.ts > until) return false;
        if (after !== null && after !== undefined) {
          if (message.ts < after.ts) return false;
          if (message.ts === after.ts) {
            if (after.id === '' || after.id === null || after.id === undefined) return false;
            if (!(message.id > String(after.id))) return false;
          }
          return true;
        }
        return since === null || since === undefined || message.ts > since;
      })
      .sort((left, right) => (left.ts === right.ts
        ? left.id.localeCompare(right.id)
        : left.ts.localeCompare(right.ts)))
      .slice(0, limit)
      .map((message) => ({ ...message })),
    extract: async () => ({ candidates: runtime.candidates }),
    readPersona: () => runtime.persona,
    writePersona: (which, text) => {
      runtime.writes.push({ which, text });
      runtime.persona = { ...runtime.persona, [which]: text };
    },
    isBusy: () => false,
    ...extra,
  });
  const events = (type) => runtime.events.filter((event) => event.type === type);
  return { profile, runtime, make, events, addMessage };
}

// ---- 1. the user's own 「我」 never reaches the user profile ---------------------------------

test('1) 拆条照抄「我喜欢细腻的作品」→ 画像为「用户喜欢细腻的作品」，不含「我」', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.splitBySide.user = [{ text: '我喜欢细腻的作品', category: '娱乐' }];
  runtime.repairImpl = () => ['用户喜欢细腻的作品'];

  const maintainer = make();
  const result = await maintainer.split({ user: '我喜欢细腻的作品' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);

  const entry = profile.list({ side: 'user' })[0];
  assert.equal(entry.text, '用户喜欢细腻的作品');
  assert.match(entry.text, /用户/u);
  assert.doesNotMatch(entry.text, /我/u, 'the copied first person is gone');
  assert.equal(runtime.repairCalls.length, 1);
  const repair = runtime.events.find((event) => event.type === PROFILE_TONE_EVENTS.repair);
  assert.deepEqual(repair.payload, { side: 'user', violations: ['我喜欢细腻的作品'] });
  console.log(`1) box="我喜欢细腻的作品" entry="${entry.text}" repairCalls=${runtime.repairCalls.length}`);
});

// ---- 2. a persona says 「你」, never 「用户」 --------------------------------------------------

test('2) 人设输出「用户会撒娇」→ 修复为「你会撒娇」', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.splitBySide.agent = [{ text: '用户会撒娇', category: '相处方式' }];
  runtime.repairImpl = () => ['你会撒娇'];

  const maintainer = make();
  await maintainer.split({ agent: '用户会撒娇' });
  const entry = profile.list({ side: 'agent' })[0];
  assert.equal(entry.text, '你会撒娇');
  assert.doesNotMatch(entry.text, /用户/u);
  assert.equal(runtime.repairCalls.length, 1);
  assert.deepEqual(runtime.repairCalls[0].sentences, ['用户会撒娇']);
  assert.equal(runtime.events.some((event) => event.type === PROFILE_TONE_EVENTS.fallback), false, 'a good repair needs no fallback');
  console.log(`2) entry="${entry.text}" repair="${runtime.repairCalls[0].sentences[0]}" fallback=false`);
});

// ---- 3. quoted speech is not a violation and is never rewritten -------------------------------

test('3) 引号原话「用户说过『我希望你能鼓励我』」→ 不判违规、引语原样保留', async (t) => {
  const quoted = '「用户说过『我希望你能鼓励我』」';
  const checked = checkProfileTone(quoted, 'user');
  assert.equal(checked.ok, true, 'the 「我」 inside the quote is the user\'s own words');
  assert.equal(checked.violations.length, 0);
  assert.equal(checked.quoted.length, 1, 'it is still marked as a quoted reference');
  assert.deepEqual(checked.quoted[0].tokens, ['我']);

  const { profile, runtime, make } = await fresh(t);
  runtime.splitBySide.user = [{ text: quoted, category: '相处方式' }];
  runtime.repairImpl = () => {
    throw new Error('a quoted sentence must never be sent to the repair model');
  };
  const maintainer = make();
  await maintainer.split({ user: quoted });
  const entry = profile.list({ side: 'user' })[0];
  assert.equal(entry.text, quoted, 'the quote survives byte for byte');
  assert.match(entry.text, /『我希望你能鼓励我』/u);
  assert.equal(runtime.repairCalls.length, 0);
  console.log(`3) ok=${checked.ok} quoted=${checked.quoted.length} entry="${entry.text}" repairCalls=0`);
});

// ---- 4. a failed repair falls back deterministically -----------------------------------------

test('4) 修复仍不合格 → 确定性回退，画像无「我」、人设无「用户」', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  const maintainer = make();

  runtime.splitBySide.user = [{ text: '我喜欢细腻的作品', category: '娱乐' }];
  runtime.repairImpl = () => ['我还是喜欢细腻的作品'];
  await maintainer.split({ user: '我喜欢细腻的作品' });
  const user = profile.list({ side: 'user' })[0];
  assert.equal(user.text, '用户还是喜欢细腻的作品', 'the template drops 「我」 and prefixes 「用户」');
  assert.doesNotMatch(user.text, /我/u);
  assert.deepEqual(runtime.events.find((event) => event.type === PROFILE_TONE_EVENTS.fallback)?.payload, {
    side: 'user',
    count: 1,
  });

  runtime.splitBySide.agent = [{ text: '用户会撒娇', category: '相处方式' }];
  runtime.repairImpl = () => ['用户还是会撒娇'];
  await maintainer.split({ agent: '用户会撒娇' });
  const agent = profile.list({ side: 'agent' })[0];
  assert.equal(agent.text, '你还是会撒娇', 'the template replaces 「用户」 with 「你」');
  assert.doesNotMatch(agent.text, /用户/u);
  assert.deepEqual(runtime.events.filter((event) => event.type === PROFILE_TONE_EVENTS.fallback).at(-1)?.payload, {
    side: 'agent',
    count: 1,
  });
  console.log(`4) userFallback="${user.text}" agentFallback="${agent.text}" events=${runtime.events.filter((event) => event.type === PROFILE_TONE_EVENTS.fallback).length}`);
});

// ---- 5. repair call count: 0 when clean, 1 when violating ------------------------------------

test('5) 修复调用次数：合格文本 0 次；不合格 1 次', async (t) => {
  const { runtime, make } = await fresh(t);
  const maintainer = make();

  runtime.splitBySide.agent = [{ text: '说话温柔', category: '语言' }];
  const clean = await maintainer.split({ agent: '说话温柔' });
  assert.equal(clean.ok, true);
  assert.equal(runtime.repairCalls.length, 0, 'clean text never calls the repairer');

  runtime.splitBySide.user = [{ text: '我喜欢细腻的作品', category: '娱乐' }];
  runtime.repairImpl = () => ['用户喜欢细腻的作品'];
  const dirty = await maintainer.split({ agent: '说话温柔', user: '我喜欢细腻的作品' });
  assert.equal(dirty.ok, true);
  assert.equal(runtime.repairCalls.length, 1, 'one batch of offending sentences = one repair call');
  assert.equal(runtime.events.filter((event) => event.type === PROFILE_TONE_EVENTS.repair).length, 1);
  console.log(`5) cleanRepairCalls=0 violatingRepairCalls=${runtime.repairCalls.length} eventRepair=${runtime.events.filter((event) => event.type === PROFILE_TONE_EVENTS.repair).length}`);
});

// ---- 6. semantics: entry count and category are unchanged ------------------------------------

test('6) 语义不变：修复前后条目数 2、分类 相处方式/说话方式 不变，只送违规句', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.splitBySide.agent = [
    { text: '用户会撒娇', category: '相处方式' },
    { text: '说话温柔', category: '说话方式' },
  ];
  runtime.repairImpl = () => ['你会撒娇'];
  const maintainer = make();
  const result = await maintainer.split({ agent: '用户会撒娇\n说话温柔' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2, 'no constraint is added or removed');

  const entries = profile.list({ side: 'agent' });
  assert.equal(entries.length, 2);
  const byCategory = Object.fromEntries(entries.map((entry) => [entry.category, entry.text]));
  assert.deepEqual(byCategory, { 相处方式: '你会撒娇', 说话方式: '说话温柔' });
  assert.deepEqual(runtime.repairCalls[0].sentences, ['用户会撒娇'], 'only the violating sentence is sent back');
  console.log(`6) entries=${entries.length} categories=${Object.keys(byCategory).join(',')} repaired="${byCategory['相处方式']}" clean="${byCategory['说话方式']}"`);
});

// ---- 7. extraction output is gated too --------------------------------------------------------

test('7) 记忆提取：候选「我早餐喝冰美式」→ 入库「用户早餐喝冰美式」', async (t) => {
  const { profile, runtime, make, addMessage, events } = await fresh(t);
  addMessage('m1', '我早餐喝冰美式');
  addMessage('m2', '每天都要一杯');
  runtime.candidates = [{
    side: 'user',
    category: '饮食',
    text: '我早餐喝冰美式',
    message_ids: ['m1', 'm2'],
  }];
  runtime.repairImpl = () => ['用户早餐喝冰美式'];
  const maintainer = make();
  const result = await maintainer.now();
  assert.equal(result.ok, true);
  const entry = profile.list({ side: 'user' })[0];
  assert.equal(entry.text, '用户早餐喝冰美式');
  assert.equal(entry.category, '饮食', 'the category is untouched');
  assert.deepEqual(runtime.repairCalls[0].sentences, ['我早餐喝冰美式']);
  assert.deepEqual(events(PROFILE_TONE_EVENTS.repair).at(-1).payload, {
    side: 'user',
    violations: ['我早餐喝冰美式'],
  });
  console.log(`7) entry="${entry.category}:${entry.text}" repairCalls=${runtime.repairCalls.length} added=${result.summary.added}`);
});

// ---- 8. prompt rewrite is gated; the clean sentence is preserved -------------------------------

test('8) 提示词重写：只改违规那一句，其余句子原样保留', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  profile.upsert({
    side: 'agent', category: '语言', text: '说话温柔', clarity: 60, efficacy: 50, rank: 'original',
  });
  profile.upsert({
    side: 'user', category: '娱乐', text: '喜欢细腻的作品', clarity: 60, efficacy: 50, rank: 'original',
  });
  // The composed rewrite is validated against the library: every clause it writes back must be
  // carried by an entry, so the two clean sentences exist as sources as well.
  profile.upsert({
    side: 'user', category: '娱乐', text: '也喜欢安静', clarity: 60, efficacy: 50, rank: 'original',
  });
  profile.upsert({
    side: 'user', category: '语言', text: '你说话简短', clarity: 60, efficacy: 50, rank: 'original',
  });
  runtime.composeImpl = ({ side }) => (side === 'user'
    ? '我喜欢细腻的作品，也喜欢安静。你说话简短。'
    : '你会保持温柔。');
  runtime.repairImpl = () => ['用户喜欢细腻的作品，也喜欢安静。'];
  // A real rewrite is always semantically checked now; this case tests the sentence-level tone
  // merge, so the cross-check approves the rewrite instead of exercising the no-channel fallback.
  const maintainer = make({ verifyCompose: async () => ({ ok: true, issues: [] }) });

  const written = await maintainer.writeBack({ trigger: 'manual' });
  assert.deepEqual(written.map((item) => item.side).sort(), ['agent', 'user']);
  assert.equal(runtime.persona.user, '用户喜欢细腻的作品，也喜欢安静。你说话简短。');
  assert.equal(runtime.persona.agent, '你会保持温柔。', 'a clean side is untouched');
  assert.deepEqual(runtime.repairCalls[0].sentences, ['我喜欢细腻的作品，也喜欢安静。'], 'only the offending sentence is sent');
  assert.equal(runtime.events.some((event) => event.type === PROFILE_TONE_EVENTS.fallback), false);
  console.log(`8) box="${runtime.persona.user}" repaired="${runtime.repairCalls[0].sentences[0]}" kept="你说话简短。"`);
});

// ---- 9. pure helpers: prompts, parse, deterministic fallback ---------------------------------

test('9) 纯函数：修复提示只含规则与违规句；回退保留引语', async (t) => {
  const prompt = buildToneRepairPrompt({ side: 'user', sentences: ['我喜欢安静'] });
  assert.match(prompt, /用户画像一律用第三人称「用户……」/u);
  assert.match(prompt, /不得新增或删除任何约束/u);
  assert.match(prompt, /1\. 我喜欢安静/u);
  assert.match(prompt, /引号「…」\/『…』\/“…”里的原话是引用/u);

  assert.deepEqual(parseToneRepair('["用户喜欢安静"]'), ['用户喜欢安静']);
  assert.deepEqual(parseToneRepair('```json\n{"sentences":["用户喜欢安静"]}\n```'), ['用户喜欢安静']);

  assert.equal(fallbackToneText('我喜欢细腻的作品', 'user'), '用户喜欢细腻的作品');
  assert.equal(fallbackToneText('我的猫叫小满', 'user'), '用户的猫叫小满', 'the possessive keeps 「的」');
  assert.equal(fallbackToneText('用户会撒娇', 'agent'), '你会撒娇');
  assert.equal(
    fallbackToneText('我同意「我希望你能鼓励我」', 'user'),
    '用户同意「我希望你能鼓励我」',
    'the quoted content is not deleted, only the outer first person is removed',
  );
  assert.deepEqual(checkProfileTone('用户会撒娇', 'agent').violations[0].tokens, ['用户']);
  console.log(`9) promptChars=${prompt.length} parse=ok userFallback="${fallbackToneText('我同意「我希望你能鼓励我」', 'user')}" agentFallback="${fallbackToneText('用户会撒娇', 'agent')}"`);
});

// ---- 10. the fallback never changes meaning: object 「用户」 and in-word 「我」 are kept ---------

test('10) 口吻回退不改语义：宾语「用户」与词语内的「我」原样保留', async (t) => {
  // Persona side: only the SUBJECT 「用户」 becomes 「你」.
  const object = checkProfileTone('你应尊重用户的隐私', 'agent');
  assert.equal(object.ok, true, 'an object/attributive 用户 is not a violation');
  assert.equal(object.violations.length, 0);
  assert.equal(fallbackToneText('你应尊重用户的隐私', 'agent'), '你应尊重用户的隐私', 'the object sentence is untouched');
  assert.equal(fallbackToneText('用户的自述很可爱', 'agent'), '用户的自述很可爱', 'an attributive is untouched');
  assert.equal(fallbackToneText('用户会撒娇', 'agent'), '你会撒娇', 'a subject is still rewritten');

  // User side: a 「我」 inside a word is not a pronoun — 「自我介绍」 must not become 「自介绍」.
  const compound = checkProfileTone('用户喜欢自我介绍', 'user');
  assert.equal(compound.ok, true, 'the in-word 我 is not a first person');
  assert.equal(fallbackToneText('用户喜欢自我介绍', 'user'), '用户喜欢自我介绍');
  assert.equal(fallbackToneText('用户喜欢自我描述', 'user'), '用户喜欢自我描述');

  // End to end through the maintainer: no repair call, the entries keep their meaning.
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitBySide.agent = [{ text: '你应尊重用户的隐私', category: '相处方式' }];
  // The splitter's framing filter drops the leading 「用户」; the fragment keeps the compound word.
  runtime.splitBySide.user = [{ text: '喜欢自我介绍', category: '娱乐' }];
  runtime.repairImpl = () => {
    throw new Error('a preserved sentence must never be sent to the repairer');
  };
  const maintainer = make();
  const result = await maintainer.split({ agent: '你应尊重用户的隐私', user: '喜欢自我介绍' });
  assert.equal(result.ok, true);
  assert.equal(runtime.repairCalls.length, 0, 'nothing was sent back for repair');
  const keptAgent = profile.list({ side: 'agent' })[0].text;
  const keptUser = profile.list({ side: 'user' })[0].text;
  assert.equal(keptAgent, '你应尊重用户的隐私');
  assert.equal(keptUser, '喜欢自我介绍', '「自我介绍」 keeps its 我');
  assert.equal(events(PROFILE_TONE_EVENTS.unresolved).length, 0, 'a clear case is not reported as unresolved');

  // An ambiguous case is kept verbatim and reported, never guessed at.
  const unclear = checkProfileTone('其实用户会撒娇', 'agent');
  assert.equal(unclear.ok, true);
  assert.equal(unclear.unresolved.length, 1, 'the mid-clause 用户 is reported as unresolved');
  assert.equal(fallbackToneText('其实用户会撒娇', 'agent'), '其实用户会撒娇', 'an ambiguous case is not rewritten');
  runtime.splitBySide.agent = [{ text: '其实用户会撒娇', category: '相处方式' }];
  await maintainer.split({ agent: '其实用户会撒娇' });
  const unresolved = events(PROFILE_TONE_EVENTS.unresolved).at(-1);
  assert.deepEqual(unresolved?.payload, { side: 'agent', count: 1 }, 'profile.tone.unresolved records the kept sentence');
  assert.equal(profile.list({ side: 'agent' }).some((entry) => entry.text === '其实用户会撒娇'), true);
  console.log(`10) object kept="${keptAgent}", compound kept="${keptUser}", `
    + `unresolved=${JSON.stringify(unresolved.payload)}`);
});
