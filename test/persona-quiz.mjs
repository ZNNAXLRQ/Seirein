/**
 * P-116 初始参考人设问卷：十题固定、混合输入按片段区分、只生成助手人设、草案/试用/采用分离。
 *
 * Host-side tests mount a real ProfileStore + ProfileMaintainer on a temporary SQLite file, with
 * the persona files replaced by an in-memory object and the model call injected (`generatePersona`).
 * No real model, file or chat turn is touched.
 *
 * Proves:
 *   1. ten fixed questions come from the code constant;
 *   2. all-skipped refuses before any model call (machine-readable error code);
 *   3. one answer is enough to generate;
 *   4. one answer containing both a direction and a demonstration puts BOTH segment markers in
 *      the generated prompt (per-segment, not per-question classification);
 *   5. generation only produces the agent side; the user profile is never written;
 *   6. fictional experiences inside a scenario never become user facts, memory or user entries;
 *   7. an explicit user-profile block returned by the model is stripped from the draft;
 *   8. an existing persona is not overwritten by generation; only applyTrial replaces the box;
 *   9. applyTrial replaces + persists + injects, keeps the library untouched, survives a restart;
 *  10. adopt reuses reconcile → original entries, zero evidence;
 *  11. discard restores the pre-trial text;
 *  12. a late generation (older revision) never becomes the draft;
 *  13. the draft is second-person assistant tone, with no subject 「用户」;
 *  14. neither generation, trial nor adoption writes memory_event / profile_evidence.
 *
 * Run: node --test test/persona-quiz.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';

import { createProfileStore } from '../src/host/profile/profileStore.js';
import {
  PERSONA_QUIZ_ERRORS,
  PERSONA_QUIZ_HINT,
  PERSONA_QUIZ_PROMPT_BUDGET_TOKENS,
  PERSONA_QUIZ_QUESTIONS,
  checkProfileTone,
  classifyPersonaQuizSegment,
  createProfileMaintainer,
} from '../src/host/profile/profileMaintain.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

const DEFAULT_DRAFT = '你会在对方低落时先接住情绪，再给出具体、可信的鼓励。';

/** Real store/maintainer on a temp DB; persona is an in-memory object; model output is queued. */
async function makeHarness(t, { agent = '', user = '', entries = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persona-quiz-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const db = new DatabaseSync(join(root, 'memory.db'));
  // The quiz must never write chat memory. One seed row proves the count stays put.
  db.exec("CREATE TABLE IF NOT EXISTS memory_event (id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '')");
  db.exec("INSERT INTO memory_event (id, text) VALUES ('seed', 'existing exchange')");
  const profile = createProfileStore({ db });
  for (const entry of entries) profile.upsert({ rank: 'original', ...entry });
  const persona = { agent, user };
  const prompts = [];
  const queue = [];
  const makeMaintainer = () => createProfileMaintainer({
    profile,
    db,
    readPersona: () => ({ agent: persona.agent, user: persona.user }),
    writePersona: (which, text) => {
      persona[which] = text;
    },
    generatePersona: async (input) => {
      prompts.push(input.prompt);
      const next = queue.shift();
      if (next === undefined) return DEFAULT_DRAFT;
      if (typeof next === 'function') return next(input);
      if (next instanceof Error) throw next;
      return next;
    },
    emit: () => {},
    now: () => new Date('2026-11-06T10:00:00.000Z'),
  });
  const maintainer = makeMaintainer();
  t.after(() => db.close());
  const counts = () => ({
    memory: db.prepare('SELECT COUNT(*) AS c FROM memory_event').get().c,
    evidence: db.prepare('SELECT COUNT(*) AS c FROM profile_evidence').get().c,
  });
  return { root, db, profile, persona, maintainer, makeMaintainer, prompts, queue, counts };
}

const answer = (id, text) => ({ id, text });
const allSkipped = () => PERSONA_QUIZ_QUESTIONS.map((question) => ({ id: question.id, text: '' }));

// ---- 1. fixed questions ---------------------------------------------------------------------

test('1. 十题固定且与代码常量一致；客户端接到同一份题库', async (t) => {
  const ids = PERSONA_QUIZ_QUESTIONS.map((question) => question.id);
  assert.equal(PERSONA_QUIZ_QUESTIONS.length, 10, 'exactly ten questions');
  assert.deepEqual([...new Set(ids)], ids, 'question ids are unique');
  assert.deepEqual(ids, [
    'encourage', 'celebrate', 'disagree', 'quiet', 'dissuade',
    'decide', 'recall', 'tease', 'adventure', 'chat',
  ]);
  for (const question of PERSONA_QUIZ_QUESTIONS) {
    assert.equal(typeof question.topic, 'string');
    assert.ok(question.topic.length > 0, 'every question names the dimension it covers');
    assert.ok(question.text.length > 0);
  }

  const h = await makeHarness(t);
  const started = h.maintainer.startPersonaQuiz();
  assert.equal(started.ok, true);
  assert.deepEqual(started.questions, PERSONA_QUIZ_QUESTIONS, 'the host action returns the constant');
  assert.equal(started.minAnswers, 1);
  assert.equal(started.hint, PERSONA_QUIZ_HINT);
  assert.deepEqual(h.maintainer.personaQuizDraft(), null, 'opening a new questionnaire drops the old draft');

  // The shipped client wires the questionnaire and the four trial/adopt/discard/close actions.
  assert.match(clientSource, /生成初始人设/u);
  assert.match(clientSource, /'data-profile-quiz': 'open'/u);
  for (const action of ['trial', 'adopt', 'discard', 'close']) {
    assert.match(clientSource, new RegExp(`'data-profile-quiz-action': '${action}'`, 'u'));
  }
  assert.match(clientSource, /persona\.quiz\.applyTrial/u);
  console.log(`1) questions=${PERSONA_QUIZ_QUESTIONS.length} ids=${ids.join(',')} revision=${started.revision}`);
});

// ---- 2. all skipped -------------------------------------------------------------------------

test('2. 全跳过 → 拒绝提交（错误码），且不调用模型', async (t) => {
  const h = await makeHarness(t);
  const result = await h.maintainer.generatePersonaQuiz({ answers: allSkipped() });
  assert.equal(result.ok, false);
  assert.equal(result.code, PERSONA_QUIZ_ERRORS.empty);
  assert.equal(result.answered, 0);
  assert.equal(h.prompts.length, 0, 'no model request for an empty questionnaire');
  assert.equal(h.maintainer.personaQuizDraft(), null);
  console.log(`2) code=${result.code} prompts=${h.prompts.length}`);
});

// ---- 3. one answer --------------------------------------------------------------------------

test('3. 只答一题也可以生成', async (t) => {
  const h = await makeHarness(t);
  const result = await h.maintainer.generatePersonaQuiz({
    answers: [answer('encourage', '先抱抱我，再告诉我今天已经够好了。')],
  });
  assert.equal(result.ok, true);
  assert.ok(result.draft.length > 0);
  assert.equal(result.answered, 1);
  assert.equal(result.skipped, 9);
  assert.equal(h.prompts.length, 1, 'exactly one independent model request');
  assert.equal(h.prompts[0].includes('第1题（鼓励）'), true);

  // A failed model call advances the operation number; the same dialog must still be able to
  // retry with the revision it received when it opened.
  const retry = await makeHarness(t);
  const started = retry.maintainer.startPersonaQuiz();
  retry.queue.push(new Error('model down'));
  const failed = await retry.maintainer.generatePersonaQuiz({
    answers: [answer('encourage', '先抱抱我。')],
    revision: started.revision,
  });
  assert.equal(failed.ok, false);
  const retried = await retry.maintainer.generatePersonaQuiz({
    answers: [answer('encourage', '先抱抱我。')],
    revision: started.revision,
  });
  assert.equal(retried.ok, true, 'a retry after a failure is not rejected as stale');
  console.log(`3) answered=${result.answered} skipped=${result.skipped} draftChars=${result.draft.length} retry=${retried.ok}`);
});

// ---- 4. per-segment mixed input -------------------------------------------------------------

test('4. 同题「方向 + 示范」→ 两类片段标记都进入提示词，并按片段而非整题归类', async (t) => {
  const h = await makeHarness(t);
  const mixed = '不要讲大道理，先陪着我。可以说：“今天累了也没关系，我陪你慢慢来。”';
  const result = await h.maintainer.generatePersonaQuiz({ answers: [answer('encourage', mixed)] });
  assert.equal(result.ok, true);
  const prompt = h.prompts[0];
  assert.match(prompt, /\[回答方向\] 不要讲大道理，先陪着我/u);
  assert.match(prompt, /\[示范回复\] 可以说：“今天累了也没关系，我陪你慢慢来。”/u);
  assert.match(prompt, /按片段区分/u);
  // A direction and a demonstration inside ONE segment is mixed, not silently reduced to one kind.
  assert.equal(classifyPersonaQuizSegment('先陪着我，可以说：“今天累了也没关系。”')?.kind, 'mixed');
  assert.equal(classifyPersonaQuizSegment('不要讲大道理')?.kind, 'direction');
  assert.equal(classifyPersonaQuizSegment('“今天累了也没关系。”')?.kind, 'example');
  console.log(`4) promptHasDirection=${prompt.includes('[回答方向]')} promptHasExample=${prompt.includes('[示范回复]')} mixedKind=${classifyPersonaQuizSegment('先陪着我，可以说：“今天累了也没关系。”')?.kind}`);
});

// ---- 5. agent only ---------------------------------------------------------------------------

test('5. 生成与试用只影响 agent 侧，user 侧原样', async (t) => {
  const h = await makeHarness(t, {
    agent: '旧人设',
    user: '用户喜欢冰美式',
    entries: [{ side: 'user', category: '饮食', text: '用户喜欢冰美式', clarity: 60, efficacy: 50 }],
  });
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('celebrate', '夸我，但别夸张。')] });
  assert.equal(h.persona.agent, '旧人设', 'generation never writes the persona box');
  assert.equal(h.persona.user, '用户喜欢冰美式');
  const applied = h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  assert.equal(applied.ok, true);
  assert.equal(h.persona.agent, generated.draft);
  assert.equal(h.persona.user, '用户喜欢冰美式', 'trial never touches the user profile');
  assert.equal(h.profile.list().length, 1, 'the user entry is untouched');
  assert.equal(h.profile.list({ side: 'user' })[0].text, '用户喜欢冰美式');
  console.log(`5) agentChanged=${h.persona.agent === generated.draft} user="${h.persona.user}" entries=${h.profile.list().length}`);
});

// ---- 6. fictional experiences ---------------------------------------------------------------

test('6. 情景里的虚构经历（去年在东京）不进入用户画像 / 记忆 / user 条目', async (t) => {
  const h = await makeHarness(t, { agent: '旧人设', user: '用户喜欢安静' });
  const generated = await h.maintainer.generatePersonaQuiz({
    answers: [
      answer('chat', '去年我在东京认识了一个叫小林的人。我希望你听我讲，不要追问细节。'),
    ],
  });
  h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  const adopted = h.maintainer.adoptPersonaQuizTrial();
  assert.equal(adopted.ok, true);
  assert.equal(h.persona.user, '用户喜欢安静', 'user profile is never rewritten');
  assert.equal(h.profile.list({ side: 'user' }).length, 0, 'no user entry is created');
  assert.equal(h.counts().memory, 1, 'no memory event is created');
  assert.equal(h.profile.list({ side: 'agent' }).length >= 1, true, 'only assistant entries appear');
  console.log(`6) user="${h.persona.user}" userEntries=${h.profile.list({ side: 'user' }).length} memory=${h.counts().memory}`);
});

// ---- 7. no user-profile content -------------------------------------------------------------

test('7. 模型硬塞「用户画像」段落 → 草案被剥掉，user 侧零写入', async (t) => {
  const h = await makeHarness(t, { agent: '旧人设', user: '用户喜欢冰美式' });
  h.queue.push('你很会接住情绪。\n## 用户画像\n用户喜欢冰美式，用户住在东京。');
  const result = await h.maintainer.generatePersonaQuiz({ answers: [answer('quiet', '安静陪着就好。')] });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.draft, /用户画像|关于用户|用户偏好/u);
  assert.match(result.draft, /你很会接住情绪/u);
  assert.equal(h.persona.user, '用户喜欢冰美式');
  assert.equal(h.profile.list({ side: 'user' }).length, 0);
  console.log(`7) draft="${result.draft}" userEntries=${h.profile.list({ side: 'user' }).length}`);
});

// ---- 8. existing persona is not overwritten -------------------------------------------------

test('8. 存在原人设 → 生成只出草案，原文本/库都不动；应用试用才替换', async (t) => {
  const h = await makeHarness(t, {
    agent: '旧助手人设：说话温柔。',
    entries: [{ side: 'agent', category: '语言', text: '说话温柔', clarity: 70, efficacy: 55 }],
  });
  const before = h.profile.list().length;
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('tease', '可以开玩笑，但别损我。')] });
  assert.equal(generated.ok, true);
  assert.equal(h.persona.agent, '旧助手人设：说话温柔。', 'generation never overwrites the box');
  const draftOnly = h.maintainer.personaTrialState().active === false;
  assert.equal(draftOnly, true, 'a draft is not a trial');
  assert.equal(h.profile.list().length, before, 'the library is untouched by generation');
  const applied = h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  assert.equal(applied.ok, true);
  assert.equal(h.persona.agent, generated.draft, 'only applyTrial replaces the box');
  assert.equal(h.profile.list().length, before, 'applyTrial still does not change the library');
  console.log(`8) draftOnly=${draftOnly} before=${before} after=${h.profile.list().length}`);
});

// ---- 9. trial: replace + persist + inject, library unchanged --------------------------------

test('9. 应用试用 → 人设框替换、持久化、注入生效；库条目数不变；重启保留试用标记', async (t) => {
  const h = await makeHarness(t, {
    agent: '旧助手人设',
    user: '',
    entries: [{ side: 'agent', category: '语言', text: '旧助手人设', clarity: 70, efficacy: 50 }],
  });
  const before = h.profile.list().length;
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('dissuade', '别熬夜，先睡，明天再弄。')] });
  const applied = h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  assert.equal(applied.ok, true);
  assert.equal(h.persona.agent, generated.draft, 'persisted in the persona file');
  assert.equal(h.maintainer.readBoxes().agent, generated.draft);
  assert.equal(h.maintainer.boxesAuthoritative(), true, 'the persona section is the injected copy');
  assert.equal(h.maintainer.promptSection().text, '', 'no duplicate compiled block while trialing');
  assert.equal(h.profile.list().length, before, 'trial is not split into entries');
  // Persistence alone must never turn the trial text into entries: neither the scheduled
  // reconcile nor the first-launch seed may import it.
  const auto = h.maintainer.reconcileFromSettings({ trigger: 'schedule' });
  assert.equal(auto.ran, false, 'the trial text is not a pending user edit');
  const seeded = h.maintainer.ensureSeeded();
  assert.equal(seeded.imported, 0, 'the seed step skips the trial text');
  assert.equal(h.profile.list().length, before, 'auto maintenance leaves the library untouched');

  // A fresh instance over the same DB (a restart) still reports the trial marker.
  const restarted = h.makeMaintainer();
  assert.equal(restarted.personaTrialState().active, true, 'trial marker survives a restart');
  assert.equal(restarted.personaTrialState().text, generated.draft);
  console.log(`9) trial=${restarted.personaTrialState().active} entries=${h.profile.list().length} promptSection="${h.maintainer.promptSection().text}" persona="${h.persona.agent}"`);
});

// ---- 10. formal adoption --------------------------------------------------------------------

test('10. 正式采用 → 库同步为原订（rank=original）、零证据', async (t) => {
  const h = await makeHarness(t, { agent: '', user: '用户喜欢冰美式' });
  h.queue.push('你会在对方低落时先接住情绪。\n你说话简短，不堆大道理。');
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('encourage', '先接住情绪，不要讲道理。')] });
  h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  const adopted = h.maintainer.adoptPersonaQuizTrial();
  assert.equal(adopted.ok, true);
  assert.equal(adopted.trial.active, false, 'adoption ends the trial');
  assert.equal(h.maintainer.personaTrialState().active, false);
  const agentEntries = h.profile.list({ side: 'agent' });
  assert.equal(agentEntries.length, 2, 'each draft line becomes an entry');
  assert.equal(agentEntries.every((entry) => entry.rank === 'original'), true);
  assert.equal(h.counts().evidence, 0, 'a questionnaire answer is not support evidence');
  assert.equal(h.profile.list({ side: 'user' }).length, 0);
  console.log(`10) adopted=${agentEntries.length} ranks=${agentEntries.map((entry) => entry.rank).join(',')} evidence=${h.counts().evidence} added=${adopted.added}`);
});

// ---- 11. discard trial ----------------------------------------------------------------------

test('11. 放弃试用 → 恢复试用前的文本，库仍不变', async (t) => {
  const h = await makeHarness(t, { agent: '旧人设第一行\n旧人设第二行' });
  h.queue.push('新草案第一行\n新草案第二行');
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('adventure', '先听我说完，再一起判断。')] });
  h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  assert.notEqual(h.persona.agent, '旧人设第一行\n旧人设第二行');
  const discarded = h.maintainer.discardPersonaQuizTrial();
  assert.equal(discarded.ok, true);
  assert.equal(discarded.restored, true);
  assert.equal(h.persona.agent, '旧人设第一行\n旧人设第二行', 'the pre-trial text is restored');
  assert.equal(h.maintainer.personaTrialState().active, false);
  assert.equal(h.profile.list().length, 0, 'discard never writes the library');
  console.log(`11) restored="${h.persona.agent}" trial=${h.maintainer.personaTrialState().active} entries=${h.profile.list().length}`);
});

// ---- 12. late generation --------------------------------------------------------------------

test('12. 迟到生成（版本不符）→ 不覆盖较新操作，草案为空', async (t) => {
  const h = await makeHarness(t, { agent: '旧人设' });
  let release = null;
  h.queue.push(() => new Promise((resolve) => {
    release = resolve;
  }));
  const pending = h.maintainer.generatePersonaQuiz({ answers: [answer('quiet', '安静陪着。')] });
  assert.equal(typeof release, 'function', 'the slow generation reached the model');
  // A newer user operation (here: reopening the questionnaire) invalidates the in-flight result.
  const newer = h.maintainer.startPersonaQuiz();
  release('迟到的草案');
  const late = await pending;
  assert.equal(late.ok, false);
  assert.equal(late.code, PERSONA_QUIZ_ERRORS.stale);
  assert.equal(late.stale, true);
  assert.equal(h.maintainer.personaQuizDraft(), null, 'the late draft is never stored');
  assert.equal(h.maintainer.personaQuizRevision(), newer.revision);
  assert.equal(h.persona.agent, '旧人设');
  console.log(`12) code=${late.code} draft=${h.maintainer.personaQuizDraft()} revision=${h.maintainer.personaQuizRevision()}`);
});

// ---- 13. persona tone -----------------------------------------------------------------------

test('13. 口吻：生成结果是人设第二人称「你」，没有主语「用户」', async (t) => {
  const h = await makeHarness(t);
  h.queue.push('用户难过时，用户希望被安慰。');
  const result = await h.maintainer.generatePersonaQuiz({ answers: [answer('encourage', '先安慰我。')] });
  assert.equal(result.ok, true);
  assert.equal(result.draft.includes('用户'), false, 'host rewrites subject 「用户」 to 「你」');
  assert.match(result.draft, /你/u);
  assert.equal(checkProfileTone(result.draft, 'agent').ok, true);
  console.log(`13) draft="${result.draft}" toneOk=${checkProfileTone(result.draft, 'agent').ok}`);
});

// ---- 14. no memory / evidence writes --------------------------------------------------------

test('14. 不写 memory_event / profile_evidence：生成、试用、采用后表计数不变', async (t) => {
  const h = await makeHarness(t, { agent: '旧人设' });
  const before = h.counts();
  const generated = await h.maintainer.generatePersonaQuiz({ answers: [answer('decide', '帮我列两个选项，再让我自己选。')] });
  h.maintainer.applyPersonaQuizTrial({ text: generated.draft, revision: generated.revision });
  h.maintainer.adoptPersonaQuizTrial();
  const after = h.counts();
  assert.deepEqual(after, before, 'questionnaire material never becomes memory or evidence');
  assert.equal(before.memory, 1);
  assert.equal(before.evidence, 0);
  console.log(`14) memory ${before.memory}->${after.memory} evidence ${before.evidence}->${after.evidence} budget=${PERSONA_QUIZ_PROMPT_BUDGET_TOKENS}`);
});
