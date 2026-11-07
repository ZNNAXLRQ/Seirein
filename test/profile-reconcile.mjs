/**
 * Profile save flow: the settings-box text is model-split into `[{text, category}]` fragments,
 * then diffed against the previous `(entryId, text)` mapping. This replaces the old line-level
 * reconcile as the save path — the model reads the whole text, the host owns the diff and scores.
 *
 * Proves:
 *  1. 「你是一名妹系美少女角色，说话方式可以带一些撒娇感」 → 2 条原订，分类「人设参考」「说话方式」，
 *     framing 词「你是一名」被去掉，新库没有任何证据；
 *  2. 只改一个词 → updated=1，rank/C/E/supports 全部不变；
 *  3. 新增一句 → added=1，C/E 取同侧原订最大值；
 *  4. 删掉一句 → removed=1，直接移除（不封禁、不碰记忆行）；
 *  5. 文本清空 → 该侧条目全删、快照清空；
 *  6. 拆分模型失败 → 库与文本都不变，事件 profile.split.failed；
 *  7. 已同步的文本框不会被周期行级核对再次拆散；
 *  8. 事件 profile.split 携带六个计数（含 modelCalls）；
 *  9. 整理结束：agent 按碎片重写成自然提示词并写回文本框（自动保存），注入改由文本框承担；
 * 10. 重写失败 → 回退确定性拼接，仍写回，并记 profile.compose.failed；
 * 11. 未同步的文本框不会被写回覆盖；
 * 12. 记忆提取口径：非人偏好 → user、角色表现 → agent，均原订，事件 profile.extract。
 *
 * Run: node --test test/profile-reconcile.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  buildComposePrompt,
  buildExtractPrompt,
  createProfileMaintainer,
  normalizeSplitEntries,
  parseSplitEntries,
  PROFILE_COMPOSE_EVENTS,
  PROFILE_EXTRACT_EVENT,
  PROFILE_PROMPT_BUDGET_TOKENS,
  PROFILE_SPLIT_EVENTS,
  PROFILE_WRITEBACK_EVENT,
  PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT,
  PROFILE_WRITEBACK_SKIPPED_EVENT,
} from '../src/host/profile/profileMaintain.js';
import { estimateProfileTokens, profilePromptOverheadTokens } from '../src/host/profile/profileRank.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const T0 = Date.parse('2026-11-06T10:00:00.000Z');

/**
 * One temp database plus an injectable clock/splitter/composer/message source. The splitter and
 * composer stand in for the model; `writePersona` records what the host persisted.
 */
async function fresh(t, { persona = { agent: '', user: '' } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-split-'));
  const db = new DatabaseSync(join(root, 'profile.db'));
  db.exec('CREATE TABLE IF NOT EXISTS memory_event (id TEXT PRIMARY KEY, text TEXT NOT NULL)');
  const profile = createProfileStore({ db });
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const clock = { ms: T0 };
  const runtime = {
    persona: { ...persona },
    splitBySide: { agent: [], user: [] },
    splitImpl: null,
    splitCalls: [],
    composeImpl: null,
    composeCalls: [],
    writeCalls: [],
    messages: [],
    candidates: [],
    extractImpl: null,
    events: [],
  };
  const addMessage = (id, text, { role = 'user', at = clock.ms - 60_000 } = {}) => {
    runtime.messages.push({ id, role, text, ts: new Date(at).toISOString() });
  };
  const make = (extra = {}) => {
    const { config, ...rest } = extra;
    return createProfileMaintainer({
      profile,
      now: () => new Date(clock.ms),
      emit: (type, payload) => runtime.events.push({ type, payload }),
      split: async ({ side, text }) => {
        runtime.splitCalls.push({ side, text });
        if (runtime.splitImpl !== null) return runtime.splitImpl({ side, text });
        return runtime.splitBySide[side] ?? [];
      },
      compose: async (input) => {
        runtime.composeCalls.push({ side: input.side, entries: input.entries.length, maxChars: input.maxChars });
        if (runtime.composeImpl !== null) return runtime.composeImpl(input);
        const list = input.entries.map((entry) => entry.text).join('；');
        return `${input.side === 'user' ? '你偏好' : '你会'}：${list}。`;
      },
      // Every rewrite is verified now: without a verifier the prose falls back to source lines.
      verifyCompose: async () => ({ ok: true, issues: [] }),
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
      extract: async (args) => {
        if (runtime.extractImpl !== null) return runtime.extractImpl(args);
        return { candidates: runtime.candidates };
      },
      readPersona: () => runtime.persona,
      writePersona: (which, text) => {
        runtime.writeCalls.push({ which, text });
        runtime.persona = { ...runtime.persona, [which]: text };
      },
      isBusy: () => false,
      config: { intervalDays: 7, ...(config ?? {}) },
      ...rest,
    });
  };
  const events = (type) => runtime.events.filter((event) => event.type === type);
  const entries = (side) => profile.list(side === undefined ? {} : { side });
  const memoryRows = () => db.prepare('SELECT COUNT(*) AS c FROM memory_event').get().c;
  return { root, db, profile, clock, runtime, addMessage, make, events, entries, memoryRows };
}

const PROSE = '你是一名妹系美少女角色，说话方式可以带一些撒娇感';
const SPLIT_PROSE = [
  { text: '你是一名妹系美少女角色', category: '人设参考' },
  { text: '说话方式带一点撒娇感', category: '说话方式' },
];

test('1) 保存整段文字 → 2 条原订、分类由拆分给出、框架词被去掉', async (t) => {
  const { profile, runtime, make, events, entries } = await fresh(t);
  runtime.splitBySide.agent = SPLIT_PROSE;
  const maintainer = make();

  const result = await maintainer.split({ agent: PROSE, user: '' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.deepEqual([result.updated, result.removed, result.unchanged], [0, 0, 0]);
  assert.equal(result.modelCalls, 1, 'only the non-empty side is sent to the model');

  const agentEntries = entries('agent');
  assert.equal(agentEntries.length, 2);
  assert.ok(agentEntries.every((entry) => entry.rank === 'original'), 'split entries are original');
  assert.deepEqual(agentEntries.map((entry) => entry.text).sort(), ['妹系美少女角色', '说话方式带一点撒娇感']);
  assert.ok(agentEntries.every((entry) => !entry.text.includes('你是一名')), 'framing words are dropped');
  assert.equal(agentEntries.find((entry) => entry.text === '妹系美少女角色').category, '人设参考');
  assert.equal(agentEntries.find((entry) => entry.text === '说话方式带一点撒娇感').category, '说话方式');
  assert.deepEqual(
    agentEntries.map((entry) => [entry.clarity, entry.efficacy]),
    [[50, 50], [50, 50]],
    'no original on the side yet → neutral 50/50',
  );

  assert.equal(maintainer.snapshot().lines.length, 2, 'the snapshot mapping follows the split');
  assert.equal(runtime.persona.agent, PROSE, 'the box text is persisted exactly as saved');
  assert.deepEqual(events(PROFILE_SPLIT_EVENTS.split).at(-1).payload, {
    added: 2,
    updated: 0,
    removed: 0,
    unchanged: 0,
    ignored: 0,
    modelCalls: 1,
  });
  console.log(`1) added=${result.added} modelCalls=${result.modelCalls} entries=${agentEntries.map((entry) => `${entry.category}:${entry.text}`).join(',')} C/E=50/50`);
});

test('2) 只改一个词 → updated=1，C/E 与证据不变', async (t) => {
  const { profile, runtime, make, entries } = await fresh(t);
  runtime.splitBySide.agent = [{ text: '说话温柔', category: '语言' }];
  const maintainer = make();
  await maintainer.split({ agent: '说话温柔', user: '' });
  const entry = entries('agent')[0];
  profile.recordSupport(entry.id, { messageId: 'm1' });
  const before = profile.get(entry.id);
  const evidenceBefore = profile.evidence(entry.id).length;

  runtime.splitBySide.agent = [{ text: '说话温和', category: '语言' }];
  const result = await maintainer.split({ agent: '说话温和', user: '' });
  assert.equal(result.updated, 1);
  assert.deepEqual([result.added, result.removed, result.unchanged], [0, 0, 0]);
  const after = profile.get(entry.id);
  assert.equal(after.text, '说话温和');
  assert.equal(after.rank, 'original');
  assert.deepEqual([after.clarity, after.efficacy], [before.clarity, before.efficacy]);
  assert.equal(profile.evidence(entry.id).length, evidenceBefore, 'a text edit is not new evidence');
  assert.equal(runtime.persona.agent, '说话温和');
  console.log(`2) updated=${result.updated} text=${after.text} C/E=${after.clarity}/${after.efficacy} evidence=${evidenceBefore}`);
});

test('3) 新增一句 → added=1，C/E 取同侧原订的平均值（(60,40)+(90,80) → 75/60）', async (t) => {
  const { profile, runtime, make, entries } = await fresh(t);
  profile.upsert({ side: 'agent', category: '性格', text: '喜欢安静', clarity: 60, efficacy: 40, rank: 'original' });
  profile.upsert({ side: 'agent', category: '语言', text: '说话简洁', clarity: 90, efficacy: 80, rank: 'original' });
  const maintainer = make();
  runtime.splitBySide.agent = [
    { text: '喜欢安静', category: '性格' },
    { text: '说话简洁', category: '语言' },
  ];
  const adopted = await maintainer.split({ agent: '喜欢安静\n说话简洁', user: '' });
  assert.equal(adopted.added, 0, 'existing entries are adopted into the mapping, not duplicated');
  assert.equal(adopted.unchanged, 2);

  runtime.splitBySide.agent = [
    { text: '喜欢安静', category: '性格' },
    { text: '说话简洁', category: '语言' },
    { text: '说话温柔', category: '语言' },
  ];
  const result = await maintainer.split({ agent: '喜欢安静\n说话简洁\n说话温柔', user: '' });
  assert.equal(result.added, 1);
  const entry = entries('agent').find((item) => item.text === '说话温柔');
  assert.notEqual(entry, undefined);
  assert.equal(entry.rank, 'original');
  assert.deepEqual([entry.clarity, entry.efficacy], [75, 60], 'average C (75) and average E (60), not maxima');
  assert.equal(profile.evidence(entry.id).length, 0, 'a split line is not evidence');
  console.log(`3) added=${result.added} rank=${entry.rank} C/E=${entry.clarity}/${entry.efficacy} supports=${profile.supportCount(entry.id)}`);
});

test('4) 删掉一句 → removed=1，直接移除且不碰记忆行', async (t) => {
  const { db, runtime, make, entries, memoryRows } = await fresh(t);
  db.prepare('INSERT INTO memory_event (id, text) VALUES (?, ?)').run('mem-1', '原始对话');
  const maintainer = make();
  runtime.splitBySide.agent = [{ text: '留下的人设', category: '性格' }, { text: '删掉的人设', category: '语言' }];
  await maintainer.split({ agent: '留下的人设\n删掉的人设', user: '' });
  const doomed = entries('agent').find((entry) => entry.text === '删掉的人设');
  assert.notEqual(doomed, undefined);

  runtime.splitBySide.agent = [{ text: '留下的人设', category: '性格' }];
  const result = await maintainer.split({ agent: '留下的人设', user: '' });
  assert.equal(result.removed, 1);
  assert.equal(entries('agent').length, 1);
  assert.equal(entries('agent')[0].text, '留下的人设');
  assert.equal(memoryRows(), 1, 'the memory table is untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM profile_reject').get().c, 0, 'remove is not a permanent ban');
  console.log(`4) removed=${result.removed} kept=${entries('agent').length} memory=${memoryRows()} rejects=0`);
});

test('5) 文本清空 → 该侧条目全删、快照同步清空', async (t) => {
  const { runtime, make, entries } = await fresh(t);
  runtime.splitBySide.agent = SPLIT_PROSE;
  runtime.splitBySide.user = [{ text: '喜欢冰美式', category: '饮食' }];
  const maintainer = make();
  const first = await maintainer.split({ agent: PROSE, user: '喜欢冰美式' });
  assert.equal(first.added, 3);
  assert.equal(entries().length, 3);

  const cleared = await maintainer.split({ agent: '', user: '' });
  assert.equal(cleared.removed, 3, 'an emptied box clears the whole side');
  assert.equal(cleared.modelCalls, 0, 'nothing non-empty is sent to the model');
  assert.equal(entries().length, 0);
  const snapshot = maintainer.snapshot();
  assert.deepEqual(snapshot.lines, [], 'the mapping is cleared with the entries');
  assert.equal(snapshot.text, '', 'the compiled prompt is empty');
  assert.deepEqual(runtime.persona, { agent: '', user: '' }, 'the cleared text is persisted too');
  console.log(`5) removed=${cleared.removed} entries=${entries().length} lines=${snapshot.lines.length} text="${snapshot.text}"`);
});

test('6) 拆分模型失败 → 库与文本都不变，事件 profile.split.failed', async (t) => {
  const { profile, runtime, make, events, entries } = await fresh(t);
  runtime.splitBySide.agent = [{ text: '说话温柔', category: '语言' }];
  const maintainer = make();
  await maintainer.split({ agent: '说话温柔', user: '' });
  const before = {
    entries: profile.list(),
    persona: { ...runtime.persona },
    snapshot: maintainer.snapshot(),
    writes: runtime.writeCalls.length,
  };

  runtime.splitImpl = () => {
    throw new Error('model offline');
  };
  const result = await maintainer.split({ agent: '新的人设文本', user: '' });
  assert.equal(result.ok, false);
  assert.match(result.error, /model offline/u);
  assert.deepEqual(profile.list(), before.entries, 'the old library is kept');
  assert.deepEqual(runtime.persona, before.persona, 'the text is not overwritten');
  assert.deepEqual(maintainer.snapshot(), before.snapshot, 'the snapshot is untouched');
  assert.equal(runtime.writeCalls.length, before.writes, 'writePersona is never called on failure');
  const failed = events(PROFILE_SPLIT_EVENTS.failed);
  assert.equal(failed.length, 1);
  assert.match(failed[0].payload.error, /model offline/u);
  console.log(`6) ok=${result.ok} error="${failed[0].payload.error}" entries=${entries('agent').length} persona="${runtime.persona.agent}"`);
});

test('7) 已同步的文本框不会被周期行级核对再次拆散', async (t) => {
  const { runtime, make, entries } = await fresh(t);
  runtime.splitBySide.agent = SPLIT_PROSE;
  const maintainer = make();
  await maintainer.split({ agent: PROSE, user: '' });
  const before = entries('agent').map((entry) => entry.text);

  // The scheduled round runs the deterministic line reconcile; an already-synced side is skipped,
  // otherwise the whole prose paragraph would replace the two fragments.
  const reconciled = maintainer.reconcile({ agent: PROSE, user: '' });
  assert.equal(reconciled.skipped, 'synced');
  assert.equal(reconciled.ran, false);
  assert.deepEqual(entries('agent').map((entry) => entry.text), before);
  console.log(`7) skipped=${reconciled.skipped} entries=${entries('agent').length}`);
});

test('8) 事件 profile.split 携带六个计数；模型 JSON 文本可解析', async (t) => {
  const { runtime, make, events } = await fresh(t);
  const fenced = '```json\n{"entries":[{"text":"你是一名妹系美少女角色","category":"人设参考"},{"text":"说话方式带一点撒娇感","category":"说话方式"}]}\n```';
  const parsed = normalizeSplitEntries(parseSplitEntries(fenced), 'agent');
  assert.deepEqual(parsed.entries.map((entry) => entry.text), ['妹系美少女角色', '说话方式带一点撒娇感']);
  assert.equal(parsed.ignored, 0);

  runtime.splitImpl = () => fenced;
  const maintainer = make();
  const result = await maintainer.split({ agent: PROSE, user: '' });
  assert.equal(result.added, 2);
  assert.equal(result.modelCalls, 1);
  const payload = events(PROFILE_SPLIT_EVENTS.split).at(-1).payload;
  assert.deepEqual(Object.keys(payload).sort(), ['added', 'ignored', 'modelCalls', 'removed', 'unchanged', 'updated']);
  assert.equal(payload.modelCalls, 1);
  console.log(`8) event=${PROFILE_SPLIT_EVENTS.split} payload=${JSON.stringify(payload)}`);
});

test('9) 整理结束：agent 重写并写回文本框、自动保存，注入改由文本框承担', async (t) => {
  const { runtime, addMessage, make, events, profile } = await fresh(t);
  addMessage('m1', '我喜欢这种细腻的作品');
  addMessage('m2', '对，细腻的东西才耐看');
  runtime.candidates = [{ side: 'user', category: '娱乐', text: '喜欢细腻的作品', message_ids: ['m1', 'm2'] }];
  // One sentence, backed by the single source entry: the rewrite may not add an unbacked clause
  // (the host's length/fidelity gate rejects an expanded rewrite and writes the source instead).
  const rewritten = '你偏爱细腻、有质感的作品。';
  const composePrompt = buildComposePrompt({
    side: 'user',
    entries: [{ category: '娱乐', text: '喜欢细腻的作品' }],
    tone: '你说话简短',
  });
  assert.match(composePrompt, /不得新增或删除/u);
  assert.match(composePrompt, /喜欢细腻的作品/u);
  assert.match(composePrompt, /你说话简短/u);
  runtime.composeImpl = () => rewritten;
  const maintainer = make();

  const result = await maintainer.now({ writeBack: true });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(runtime.persona.user, rewritten, 'the agent rewrite is persisted into the box');
  assert.deepEqual(runtime.writeCalls.at(-1), { which: 'user', text: rewritten });

  const composed = events(PROFILE_COMPOSE_EVENTS.composed).at(-1).payload;
  // One composer call plus the semantic check of the changed wording (the verify channel above).
  assert.deepEqual(composed, { side: 'user', entries: 1, modelCalls: 2, fallback: false });
  const writeback = events(PROFILE_WRITEBACK_EVENT).at(-1).payload;
  assert.deepEqual(writeback, { side: 'user', chars: rewritten.length, autoSaved: true });

  // The box is authoritative now: the profile section defers to the persona section (same bytes).
  assert.equal(maintainer.boxesAuthoritative(), true);
  assert.equal(maintainer.promptSection().text, '', 'the snapshot is no longer injected over the box');
  assert.match(runtime.persona.user, /细腻/u);
  assert.equal(profile.list({ side: 'user' })[0].text, '喜欢细腻的作品');
  console.log(`9) written="${runtime.persona.user}" compose=${JSON.stringify(composed)} writeback=${JSON.stringify(writeback)}`);
});

test('10) 重写失败 → 回退确定性拼接，记 profile.compose.failed', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '我喜欢这种细腻的作品');
  addMessage('m2', '细腻的东西才耐看');
  runtime.candidates = [{ side: 'user', category: '娱乐', text: '喜欢细腻的作品', message_ids: ['m1', 'm2'] }];
  runtime.composeImpl = () => {
    throw new Error('composer offline');
  };
  const maintainer = make();
  const result = await maintainer.now({ writeBack: true });
  assert.equal(result.ok, true);
  assert.match(runtime.persona.user, /喜欢细腻的作品/u, 'the deterministic concat keeps the semantics');
  // A failed compose falls back to the source SENTENCES (plain prose), not to the compiled
  // `## 用户偏好（自动整理）` section: the boxes always read as prose, even when the model is offline.
  assert.equal(runtime.persona.user, '用户喜欢细腻的作品。', 'fallback writes the source sentence as prose');
  assert.doesNotMatch(runtime.persona.user, /^##/u, 'the fallback is not the compiled bullet section');
  const composed = events(PROFILE_COMPOSE_EVENTS.composed).at(-1).payload;
  assert.deepEqual(composed, { side: 'user', entries: 1, modelCalls: 1, fallback: true });
  const failed = events(PROFILE_COMPOSE_EVENTS.failed);
  assert.equal(failed.length, 1);
  assert.match(failed[0].payload.error, /composer offline/u);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 1, 'the fallback still writes back');
  console.log(`10) fallback=${composed.fallback} error="${failed[0].payload.error}" box="${runtime.persona.user.split('\n')[0]}"`);
});

test('11) 未同步的文本框不会被写回覆盖（避免吃掉用户正在改的字）', async (t) => {
  const { runtime, make } = await fresh(t);
  runtime.splitBySide = {
    agent: [{ text: '说话温柔', category: '说话方式' }],
    user: [{ text: '喜欢冰美式', category: '饮食' }],
  };
  const maintainer = make();
  await maintainer.split({ agent: '说话温柔', user: '喜欢冰美式' });

  runtime.persona = { ...runtime.persona, agent: '用户正在改、还没同步的文本' };
  runtime.composeImpl = ({ side }) => `重写：${side}`;
  const written = await maintainer.writeBack({ sections: maintainer.previewSections() });
  assert.deepEqual(written.map((item) => item.side), ['user'], 'only the synced side is written back');
  assert.equal(runtime.persona.agent, '用户正在改、还没同步的文本', 'the unsynced edit is preserved');
  // The writeback normalizes the box to plain prose: a sentence without a terminator gets 「。」.
  assert.equal(runtime.persona.user, '重写：user。');
  console.log(`11) written=${written.map((item) => item.side).join(',')} agent="${runtime.persona.agent}"`);
});

test('13) 用户把库中已有候选写进文本框 → 直接赋予原订，提示词不再为空', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  // Extractor candidates that never reached the adoption gate: rank=new, C=50, supports=0.
  const candidate = profile.upsert({
    side: 'agent', category: '语言', text: '喜欢微笑', clarity: 50, efficacy: 50,
  }).entry;
  assert.equal(candidate.rank, 'new');

  const maintainer = make();
  // Save path: the split fragment equals the existing candidate.
  runtime.splitBySide.agent = [{ text: '喜欢微笑', category: '语言' }];
  const saved = await maintainer.split({ agent: '喜欢微笑', user: '' });
  assert.equal(saved.ok, true);
  assert.equal(saved.added, 0, 'the existing candidate is adopted, not duplicated');
  const promoted = profile.get(candidate.id);
  assert.equal(promoted.rank, 'original', 'the user typing the line is explicit intent: adopt it');
  assert.ok(promoted.clarity >= 60, 'user edit baseline lifts C to the adoption line');

  // Line-level path: a second existing candidate typed into the box is promoted the same way.
  const second = profile.upsert({
    side: 'agent', category: '语言', text: '说话温和', clarity: 50, efficacy: 50,
  }).entry;
  const reconciled = maintainer.reconcile({ agent: '喜欢微笑\n说话温和', user: '' });
  assert.equal(reconciled.ok, true);
  assert.equal(profile.get(second.id).rank, 'original');
  assert.match(maintainer.snapshot().text, /说话温和/u, 'the prompt is no longer empty for that line');
  assert.deepEqual(
    maintainer.snapshot().lines.map((line) => line.text).sort(),
    ['喜欢微笑', '说话温和'].sort(),
  );
  console.log(`13) splitRank=${promoted.rank}/${promoted.clarity} reconcileRank=${profile.get(second.id).rank} snapshotHasText=${maintainer.snapshot().text.includes('说话温和')}`);
});

test('14) 保存立即更新库/快照；自动采纳的新条目写回文本框并进入映射', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  runtime.splitBySide.user = [{ text: '喜欢冰美式', category: '饮食' }];
  const maintainer = make();

  // Half 1: the save path itself is the reconcile — library and snapshot are updated in that call.
  const saved = await maintainer.split({ agent: '', user: '喜欢冰美式' });
  assert.equal(saved.ok, true);
  assert.equal(saved.added, 1);
  assert.equal(profile.list({ side: 'user' }).length, 1);
  assert.deepEqual(maintainer.snapshot().lines.map((line) => line.text), ['喜欢冰美式']);
  assert.equal(maintainer.boxesAuthoritative(), true);
  assert.equal(maintainer.promptSection().text, '', 'the box is the single injected persona copy');

  // Half 2: an automatically adopted entry is written back AND enters the same mapping.
  addMessage('m1', '我喜欢细腻的作品');
  addMessage('m2', '细腻的东西才耐看');
  runtime.candidates = [{ side: 'user', category: '娱乐', text: '喜欢细腻的作品', message_ids: ['m1', 'm2'] }];
  const round = await maintainer.now({ writeBack: true });
  assert.equal(round.summary.adopted, 2, 'both user entries fit the budget');
  assert.match(runtime.persona.user, /细腻/u, 'the composed prompt is written back');
  const texts = maintainer.snapshot().lines.map((line) => line.text).sort();
  assert.deepEqual(texts, ['喜欢冰美式', '喜欢细腻的作品'].sort(), 'the adopted entry is in the mapping');
  const adopted = profile.list({ side: 'user' }).find((entry) => entry.text === '喜欢细腻的作品');
  assert.ok(maintainer.snapshot().lines.some((line) => line.entryId === adopted.id));
  console.log(`14) lines=${texts.join('|')} boxHasAdopted=${runtime.persona.user.includes('细腻')}`);
});
test('12) 记忆提取口径：非人偏好入 user、角色表现入 agent，均原订；事件 profile.extract', async (t) => {  const { runtime, addMessage, make, events, profile } = await fresh(t);
  const prompt = buildExtractPrompt({
    messages: [{ id: 'm1', role: 'user', text: '我喜欢这种细腻的作品' }],
    existing: [],
  });
  assert.match(prompt, /我喜欢这种细腻的作品/u, 'the non-human preference example is in the prompt');
  assert.match(prompt, /用户喜欢温婉可爱的角色/u, 'the character-behaviour example is in the prompt');
  assert.match(prompt, /用户自身的事实、习惯、经历与生活事实/u);
  assert.match(prompt, /角色\/助手该怎么表现/u);
  assert.match(prompt, /拆成两条/u);

  addMessage('m1', '我喜欢这种细腻的作品');
  addMessage('m2', '对，细腻的东西才耐看');
  addMessage('m3', '这个书里的女主角偶尔吃醋还蛮可爱的');
  addMessage('m4', '我也喜欢她偶尔吃醋的样子');
  runtime.candidates = [
    { side: 'user', category: '娱乐', text: '喜欢细腻的作品', message_ids: ['m1', 'm2'] },
    { side: 'agent', category: '相处方式', text: '偶尔吃醋会显得可爱', message_ids: ['m3', 'm4'] },
  ];
  const maintainer = make();
  await maintainer.now();

  const user = profile.list({ side: 'user' })[0];
  const agent = profile.list({ side: 'agent' })[0];
  assert.equal(user.text, '喜欢细腻的作品', 'a non-human preference goes to the user side');
  assert.equal(user.category, '娱乐');
  assert.equal(user.rank, 'original');
  assert.equal(agent.text, '偶尔吃醋会显得可爱', 'a preferred character behaviour goes to the agent side');
  assert.equal(agent.category, '相处方式');
  assert.equal(agent.rank, 'original');
  assert.deepEqual(events(PROFILE_EXTRACT_EVENT).at(-1).payload, {
    agentEntries: 1,
    userEntries: 1,
    modelCalls: 1,
  });
  console.log(`12) user=${user.category}:${user.text}(${user.rank}) agent=${agent.category}:${agent.text}(${agent.rank})`);
});

// ---- race / writeback / empty / budget regressions -----------------------------------------

test('15) 旧拆条迟到：B 已完成 → A 的结果被丢弃，框与库保持 B，saveSeq=2', async (t) => {
  const { db, runtime, make, events, entries } = await fresh(t);
  const maintainer = make();
  assert.equal(maintainer.saveSeq(), 0);

  let releaseA = null;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });
  runtime.splitImpl = ({ text }) => (text === '旧文本'
    ? gateA.then(() => [{ text: '旧人设', category: '语言' }])
    : [{ text: '新人设', category: '语言' }]);

  // A starts first and waits for the model; its save sequence is claimed before the await.
  const pendingA = maintainer.split({ agent: '旧文本', user: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maintainer.saveSeq(), 1, 'A claimed saveSeq=1');
  assert.equal(db.prepare('SELECT value FROM profile_maintain_state WHERE key = ?').get('saveSeq').value, '1');

  // B is a newer user operation and completes while A is still waiting.
  const b = await maintainer.split({ agent: '新文本', user: '' });
  assert.equal(b.ok, true);
  assert.equal(b.saveSeq, 2);
  assert.equal(runtime.persona.agent, '新文本');

  releaseA();
  const a = await pendingA;
  assert.equal(a.ok, false);
  assert.equal(a.aborted, true);
  assert.equal(a.reason, 'superseded');
  assert.equal(a.saveSeq, 1);
  assert.deepEqual(entries('agent').map((entry) => entry.text), ['新人设'], 'A never wrote the library');
  assert.equal(runtime.persona.agent, '新文本', 'A never overwrote the newer box');
  assert.deepEqual(maintainer.snapshot().lines.map((line) => line.text), ['新人设']);
  assert.equal(runtime.writeCalls.some((call) => call.text === '旧文本'), false, 'A never wrote the persona file');
  assert.equal(runtime.writeCalls.filter((call) => call.which === 'agent' && call.text === '新文本').length, 1);
  const aborted = events(PROFILE_SPLIT_EVENTS.aborted);
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].payload.reason, 'superseded');
  assert.equal(aborted[0].payload.current, 2);

  const restarted = make();
  assert.equal(restarted.saveSeq(), 2, 'saveSeq is persisted in profile_maintain_state');
  console.log(`15) saveSeq=${maintainer.saveSeq()} A=${a.reason} entries=${entries('agent').map((entry) => entry.text).join(',')} box="${runtime.persona.agent}"`);
});

test('16) 整理重写等待中用户保存 → 写回跳过，用户文本与映射保留', async (t) => {
  const { runtime, make, events, entries } = await fresh(t);
  runtime.splitBySide.agent = [{ text: '说话温柔', category: '语言' }];
  const maintainer = make();
  await maintainer.split({ agent: '旧文本', user: '' });
  assert.equal(maintainer.pendingSides().agent, false);

  let releaseCompose = null;
  const gate = new Promise((resolve) => {
    releaseCompose = resolve;
  });
  runtime.composeImpl = () => gate.then(() => '整理器重写出的旧结果');

  const pendingWriteBack = maintainer.writeBack({ sections: maintainer.previewSections() });
  await new Promise((resolve) => setImmediate(resolve));

  // The user saves while the composer is still waiting.
  runtime.splitBySide.agent = [{ text: '新要求条目', category: '语言' }];
  const saved = await maintainer.split({ agent: '用户新文本', user: '' });
  assert.equal(saved.ok, true);
  assert.equal(saved.saveSeq, 2);

  releaseCompose();
  const written = await pendingWriteBack;
  assert.deepEqual(written, [], 'the late rewrite is not written back');
  assert.equal(runtime.persona.agent, '用户新文本', 'the newer user text is kept');
  assert.deepEqual(entries('agent').map((entry) => entry.text), ['新要求条目'], 'the mapping follows the save');
  assert.deepEqual(maintainer.snapshot().lines.map((line) => line.text), ['新要求条目']);
  assert.equal(maintainer.syncedTexts().agent, '用户新文本', 'syncedText is not clobbered by the skipped writeback');
  assert.equal(maintainer.pendingSides().agent, false);
  const skipped = events(PROFILE_WRITEBACK_SKIPPED_EVENT);
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].payload, { side: 'agent', reason: 'user-edited' });
  console.log(`16) written=${written.length} skipped=${skipped[0].payload.reason} box="${runtime.persona.agent}" lines="${maintainer.snapshot().lines.map((line) => line.text).join(',')}"`);
});

test('17) 全部条目退出采纳 → 写回空文本、注入为空，记 profile.writeback chars=0', async (t) => {
  const { runtime, addMessage, make, events, entries } = await fresh(t);
  runtime.splitBySide.user = [{ text: '喜欢冰美式', category: '饮食' }];
  const maintainer = make();
  await maintainer.split({ agent: '', user: '喜欢冰美式' });
  assert.equal(runtime.persona.user, '喜欢冰美式');

  addMessage('m1', '其实我不太喜欢冰美式了');
  addMessage('m2', '对，别再提冰美式');
  runtime.candidates = [{
    side: 'user',
    text: '冰美式',
    op: 'contradict',
    target_text: '喜欢冰美式',
    message_ids: ['m1', 'm2'],
    severity: 'sustained',
  }];
  const round = await maintainer.now({ writeBack: true });
  assert.equal(round.ok, true);
  assert.equal(round.summary.adopted, 0, 'the only entry left the adopted set');
  assert.equal(round.summary.tokens, 0);
  assert.equal(entries('user').length, 1, 'the row is retired, not forgotten');

  assert.equal(runtime.persona.user, '', 'the box is written empty');
  const writeback = events(PROFILE_WRITEBACK_EVENT).at(-1).payload;
  assert.deepEqual(writeback, { side: 'user', chars: 0, autoSaved: true });
  assert.deepEqual(maintainer.snapshot().lines, [], 'the mapping is cleared with the empty compile');
  assert.equal(maintainer.snapshot().text, '');
  assert.equal(maintainer.promptSection().text, '', 'the injection is empty, not the old text');
  console.log(`17) adopted=${round.summary.adopted} tokens=${round.summary.tokens} box="${runtime.persona.user}" writeback=${JSON.stringify(writeback)} injected="${maintainer.promptSection().text}"`);
});

test('18) 重写超预算 → 回退确定性拼接，总 token ≤600，记 over-budget', async (t) => {
  const { runtime, addMessage, make, events, profile } = await fresh(t);
  runtime.splitBySide.user = [{ text: '喜欢冰美式', category: '饮食' }];
  const maintainer = make();
  await maintainer.split({ agent: '', user: '喜欢冰美式' });

  addMessage('m1', '我喜欢这种细腻的作品');
  addMessage('m2', '对，细腻的东西才耐看');
  runtime.candidates = [{ side: 'user', category: '娱乐', text: '喜欢细腻的作品', message_ids: ['m1', 'm2'] }];
  // A long source entry makes a budget-sized rewrite length-legal (1.2× the sources), so the
  // rewrite reaches the shared-token gate instead of being rejected by the fidelity gate first.
  profile.upsert({
    side: 'user', category: '娱乐', text: '很'.repeat(500), clarity: 60, efficacy: 60, rank: 'original',
  });
  const oversized = `${'很'.repeat(599)}。`;
  runtime.composeImpl = () => oversized;

  const round = await maintainer.now({ writeBack: true });
  assert.equal(round.ok, true);
  const over = events(PROFILE_COMPOSE_EVENTS.overBudget);
  assert.equal(over.length, 1);
  assert.equal(over[0].payload.tokens, 600);
  assert.ok(maintainer.snapshot().tokens <= PROFILE_PROMPT_BUDGET_TOKENS);

  const box = runtime.persona.user;
  assert.notEqual(box, oversized, 'the oversized rewrite is discarded');
  // The compiled section is rendered as plain prose on writeback: its `## ` marker is display-only,
  // so the heading survives as the first sentence, not as a leading `## ` marker.
  assert.match(box, /^用户偏好（自动整理）。/u, 'the deterministic compiled section is written instead');
  assert.match(box, /喜欢细腻的作品/u);
  const overhead = profilePromptOverheadTokens(new Set(['user']));
  assert.ok(estimateProfileTokens(box) + overhead <= PROFILE_PROMPT_BUDGET_TOKENS, 'fallback respects the same budget');
  assert.ok(estimateProfileTokens(box) <= PROFILE_PROMPT_BUDGET_TOKENS);

  const prompt = buildComposePrompt({
    side: 'user',
    entries: [{ category: '娱乐', text: '喜欢细腻的作品' }],
    maxChars: 500,
  });
  assert.match(prompt, /不超过 500 字/u, 'the rewrite prompt states the character budget');
  console.log(`18) overBudgetTokens=${over[0].payload.tokens} boxTokens=${estimateProfileTokens(box)} overhead=${overhead} budget=${PROFILE_PROMPT_BUDGET_TOKENS} fallback="${box.split('\n')[0]}"`);
});

// ---- shared budget + per-side writeback version --------------------------------------------

test('19) 跨侧写回：人设侧已完成、偏好侧等待中用户保存 → 旧任务不覆盖映射与同步状态', async (t) => {
  const { runtime, make, events, entries } = await fresh(t);
  // The split entry carries both facts of the rewritten sentence, so the 1.2× total-length gate
  // accepts the wording the composer returns below (every clause keeps a source entry).
  runtime.splitBySide.agent = [{ text: '严肃冷静，不主动开玩笑', category: '性格' }];
  runtime.splitBySide.user = [{ text: '喜欢安静', category: '生活习惯' }];
  const maintainer = make();
  const first = await maintainer.split({ agent: '严肃冷静', user: '喜欢安静' });
  assert.equal(first.ok, true);
  assert.equal(maintainer.saveSeq(), 1);
  assert.equal(maintainer.snapshot().lines.length, 2);

  let releaseCompose = null;
  const gate = new Promise((resolve) => {
    releaseCompose = resolve;
  });
  runtime.composeImpl = ({ side }) => (side === 'agent'
    ? '你会保持严肃冷静，不主动开玩笑。'
    : gate.then(() => '你偏好安静的环境。'));
  const pendingWriteBack = maintainer.writeBack({ sections: maintainer.previewSections() });
  // Wait until the persona side has written its text and the preference side waits on the model.
  for (let i = 0; i < 40 && runtime.composeCalls.length < 2; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.composeCalls.map((call) => call.side).join(','), 'agent,user');
  assert.equal(runtime.persona.agent, '你会保持严肃冷静，不主动开玩笑。', 'the persona side already wrote back');

  // The user saves a new persona while the preference rewrite is still waiting for the model.
  runtime.splitBySide.agent = [{ text: '活泼开朗', category: '性格' }];
  const saved = await maintainer.split({ agent: '活泼开朗' });
  assert.equal(saved.ok, true);
  assert.equal(saved.saveSeq, 2);
  assert.deepEqual(entries('agent').map((entry) => entry.text), ['活泼开朗']);

  releaseCompose();
  const written = await pendingWriteBack;
  assert.deepEqual(written.map((item) => item.side), ['user'], 'only the still-owned side is written back');

  // The late persona-side result must not restore the older mapping/synced text: saveSeq moved.
  assert.deepEqual(entries('agent').map((entry) => entry.text), ['活泼开朗'], 'the library keeps the newer entry');
  assert.deepEqual(
    maintainer.snapshot().lines.map((line) => line.text).sort(),
    ['喜欢安静', '活泼开朗'].sort(),
    'the mapping keeps the newer persona line and adds the preference line',
  );
  assert.equal(maintainer.syncedTexts().agent, '活泼开朗', 'the newer save owns syncedText.agent');
  assert.equal(maintainer.syncedTexts().user, '你偏好安静的环境。');
  assert.equal(runtime.persona.agent, '活泼开朗');
  assert.equal(runtime.persona.user, '你偏好安静的环境。');
  assert.deepEqual(
    events(PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT).map((event) => event.payload),
    [{ side: 'agent', reason: 'superseded' }],
  );

  // A later persona edit diffs against the NEW mapping: no stale duplicate from the late writeback.
  runtime.splitBySide.agent = [{ text: '安静温柔', category: '性格' }];
  const next = await maintainer.split({ agent: '安静温柔' });
  assert.equal(next.ok, true);
  assert.deepEqual(entries('agent').map((entry) => entry.text), ['安静温柔'], 'the old persona line is replaced, not duplicated');
  console.log(`19) saveSeq(save)=${saved.saveSeq} current=${maintainer.saveSeq()} skipped=${events(PROFILE_WRITEBACK_MAPPING_SKIPPED_EVENT).map((event) => `${event.payload.side}:${event.payload.reason}`).join(',')} written=${written.map((item) => item.side).join(',')} lines="${maintainer.snapshot().lines.map((line) => line.text).join(',')}" agentEntries="${entries('agent').map((entry) => entry.text).join(',')}"`);
});

test('20) 双侧共享 600：400+400 → 组合 ≤600，超出侧回退确定性拼接', async (t) => {
  const { runtime, make, events } = await fresh(t);
  // The sources must be long enough that a budget-sized rewrite is still ≤1.2× them: the new
  // fidelity gate rejects a 400-character rewrite of a 4-character entry before the budget gate.
  // Each side is 250 characters (then rewritten to 300), so the two 300-token compositions exceed
  // the shared 600 ceiling while one side's deterministic section still fits after falling back.
  const agentLine = `严肃冷静${'人'.repeat(246)}`;
  const userLine = `喜欢安静${'好'.repeat(246)}`;
  runtime.splitBySide.agent = [{ text: agentLine, category: '性格' }];
  runtime.splitBySide.user = [{ text: userLine, category: '生活习惯' }];
  const maintainer = make();
  await maintainer.split({ agent: '严肃冷静', user: '喜欢安静' });

  const bigAgent = `严肃冷静${'人'.repeat(295)}。`;
  const bigUser = `喜欢安静${'好'.repeat(295)}。`;
  runtime.composeImpl = ({ side }) => (side === 'agent' ? bigAgent : bigUser);
  const written = await maintainer.writeBack({ sections: maintainer.previewSections() });
  assert.equal(written.length, 2, 'both sides are written back');

  // One shared ceiling: heading + newline per side, plus one separator, then the rest is split.
  const overhead = profilePromptOverheadTokens(new Set(['agent', 'user'])) + 2 + 1;
  const allocated = runtime.composeCalls.reduce((sum, call) => sum + (call.maxChars ?? 0), 0);
  assert.equal(allocated, PROFILE_PROMPT_BUDGET_TOKENS - overhead, 'the two shares consume ONE 600 budget');

  const over = events(PROFILE_COMPOSE_EVENTS.overBudget);
  assert.equal(over.length, 1);
  assert.equal(over[0].payload.side, 'agent', 'the persona side falls back first on a tie');
  assert.equal(over[0].payload.tokens, 300);
  assert.equal(over[0].payload.budget, PROFILE_PROMPT_BUDGET_TOKENS);

  const combined = [runtime.persona.agent, runtime.persona.user].filter((text) => text.length > 0).join('\n');
  const combinedTokens = estimateProfileTokens(combined);
  assert.ok(combinedTokens <= PROFILE_PROMPT_BUDGET_TOKENS, `combined ${combinedTokens} must stay ≤ 600`);
  assert.match(runtime.persona.agent, /^人设（自动整理）。/u, 'the over-budget side is the deterministic section (heading written as prose)');
  assert.match(runtime.persona.agent, /严肃冷静/u);
  assert.equal(runtime.persona.user, bigUser, 'the side that still fits keeps its rewrite whole');
  assert.deepEqual(
    maintainer.snapshot().lines.map((line) => line.text).sort(),
    [agentLine, userLine].sort(),
    'the mapping still follows both selections',
  );
  console.log(`20) allocated=${allocated} overhead=${overhead} combined=${combinedTokens} over=${over[0].payload.tokens} agentFallback=${runtime.persona.agent.startsWith('人设（自动整理）')}`);
});

test('21) 标题与分隔计入总预算：刚好 600 接受，601 回退拼接', async (t) => {
  const { runtime, make, events, profile } = await fresh(t);
  runtime.splitBySide.user = [{ text: '喜欢冰美式', category: '饮食' }];
  const maintainer = make();
  await maintainer.split({ agent: '', user: '喜欢冰美式' });
  // A long source entry makes the 588/589-character boundary rewrites length-legal (1.2× the
  // sources); with only the 5-character entry the fidelity gate would reject them first.
  profile.upsert({
    side: 'user', category: '饮食', text: '很'.repeat(500), clarity: 60, efficacy: 60, rank: 'original',
  });

  // A composed side reserves its heading plus the newline joining it to the body (no separator
  // with one side), so the accepted body is 600 − 12 = 588 tokens.
  const heading = '## 用户偏好（自动整理）\n';
  const lineBudget = PROFILE_PROMPT_BUDGET_TOKENS - estimateProfileTokens(heading);
  assert.equal(lineBudget, 588);
  const boundary = `${'很'.repeat(lineBudget - 1)}。`;
  runtime.composeImpl = () => boundary;
  await maintainer.writeBack({ sections: maintainer.previewSections() });
  assert.equal(runtime.persona.user, boundary, 'a composition landing on exactly 600 is accepted');
  assert.equal(estimateProfileTokens(heading + boundary), PROFILE_PROMPT_BUDGET_TOKENS);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.overBudget).length, 0);

  runtime.composeImpl = () => `${'很'.repeat(lineBudget)}。`;
  await maintainer.writeBack({ sections: maintainer.previewSections() });
  const over = events(PROFILE_COMPOSE_EVENTS.overBudget);
  assert.equal(over.length, 1, 'one token over the shared ceiling falls back');
  assert.equal(over[0].payload.tokens, lineBudget + 1);
  assert.match(runtime.persona.user, /^用户偏好（自动整理）。/u, 'the deterministic section replaces it (heading written as prose)');
  assert.match(runtime.persona.user, /喜欢冰美式/u);
  assert.ok(estimateProfileTokens(runtime.persona.user) <= PROFILE_PROMPT_BUDGET_TOKENS);
  console.log(`21) lineBudget=${lineBudget} boundary=${PROFILE_PROMPT_BUDGET_TOKENS} over=${over[0].payload.tokens} accepted="${boundary.length}chars" fallback="${runtime.persona.user.split('\n')[0]}"`);
});

