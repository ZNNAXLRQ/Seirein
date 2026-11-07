/**
 * ProfileStore step 3: incremental maintenance, 7-day schedule and the manual "organize now"
 * entry. Every dependency is injected (clock, message source, extractor, busy probe, event sink),
 * so no test calls a real model.
 *
 * Run: node --test test/profile-maintain.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import {
  buildComposePrompt,
  buildSplitPrompt,
  classifyProfileEntrySide,
  composeAntonymVerdict,
  composeFactVerdict,
  composeFallbackText,
  composeFidelityVerdict,
  composeKeywords,
  composeReworded,
  composeSameFact,
  composeSimilarity,
  createProfileMaintainBusyTracker,
  createProfileMaintainer,
  dedupeComposeEntries,
  ensurePlainProse,
  isExplicitLongTermRequest,
  isMisplacedAgentRule,
  isUserSelfDescription,
  noiseReason,
  PROFILE_CATEGORY_EVENTS,
  PROFILE_CLEANUP_EVENT,
  PROFILE_CLEANUP_SOURCE,
  PROFILE_COMPOSE_EVENTS,
  PROFILE_ENTRY_DELETE_SOURCE,
  PROFILE_ENTRY_EDIT_SOURCE,
  PROFILE_ENTRY_EVENTS,
  PROFILE_EVIDENCE_DELETED_EVENT,
  PROFILE_EXTRACT_EVENT,
  PROFILE_EXTRACT_MISMATCH_EVENT,
  PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS,
  PROFILE_MAINTAIN_EVENTS,
  PROFILE_MAINTAIN_TURN_STALE_MS,
  PROFILE_MODEL_EVENTS,
  PROFILE_RECLASSIFY_EVENTS,
  PROFILE_SPLIT_EVENTS,
  PROFILE_WRITEBACK_EVENT,
  PROFILE_WRITEBACK_FAILED_EVENT,
  PROFILE_WRITEBACK_SKIPPED_EVENT,
  readPendingSides,
  restoreUserStatement,
  validateComposeText,
} from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * One temp database plus an injectable clock/message/extractor harness. `make()` can be called
 * twice on the same database to simulate a restart (the cursor/period live in SQLite).
 */
async function fresh(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-maintain-'));
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

  const clock = { ms: T0 };
  const runtime = {
    messages: [],
    candidates: [],
    extractImpl: null,
    extractCalls: 0,
    lastExtract: null,
    busy: false,
    voiceBusy: false,
    pendingVoice: 0,
    fastPath: false,
    events: [],
    // The two settings boxes, only wired when a test asks for them (`make({ boxes: true })`).
    persona: { agent: '', user: '' },
    splitImpl: null,
    splitCalls: [],
    composeImpl: null,
    composeCalls: [],
    // Semantic rewrite verification: every real wording change must pass this check. The default
    // fake approves; a test can override with `verifyCompose` or `runtime.verifyImpl`.
    verifyCalls: [],
    verifyImpl: null,
    writeCalls: [],
  };
  const addMessage = (id, text, { role = 'user', at = clock.ms - 60_000, sessionId, turn } = {}) => {
    const message = { id, role, text, ts: new Date(at).toISOString() };
    if (sessionId !== undefined) message.sessionId = sessionId;
    if (turn !== undefined) message.turn = turn;
    runtime.messages.push(message);
  };
  const make = (extra = {}) => {
    const { config, boxes = false, ...rest } = extra;
    return createProfileMaintainer({
      profile,
      now: () => new Date(clock.ms),
      emit: (type, payload) => runtime.events.push({ type, payload }),
      ...(boxes
        ? {
          // The settings-box source plus the two model steps; a failing split writes nothing.
          readPersona: () => runtime.persona,
          writePersona: (which, text) => {
            runtime.writeCalls.push({ which, text });
            runtime.persona = { ...runtime.persona, [which]: text };
          },
          split: async ({ agent, user, side, text }) => {
            runtime.splitCalls.push({ agent, user, side, text });
            if (runtime.splitImpl !== null) return runtime.splitImpl({ agent, user, side, text });
            // Default fake: one fragment per box, routed by the box it was typed in.
            const boxes = side === 'agent' || side === 'user'
              ? [{ side, text }]
              : [{ side: 'agent', text: agent ?? '' }, { side: 'user', text: user ?? '' }];
            return boxes
              .filter((box) => String(box.text ?? '').trim().length > 0)
              .map((box) => ({
                text: String(box.text).trim(),
                side: box.side,
                from: box.side,
                category: '说话方式',
              }));
          },
          compose: async (input) => {
            runtime.composeCalls.push({ side: input.side, entries: input.entries.length });
            if (runtime.composeImpl !== null) return runtime.composeImpl(input);
            return input.entries.map((entry) => entry.text).join('；');
          },
          // Every real rewrite is semantically checked now: the fake approves by default, so the
          // existing writeback/formatting tests still exercise the model result instead of the
          // "no lightweight channel" fallback.
          verifyCompose: async (input) => {
            runtime.verifyCalls.push({ side: input.side, text: input.text, entries: input.entries.length });
            if (runtime.verifyImpl !== null) return runtime.verifyImpl(input);
            return { ok: true, issues: [] };
          },
        }
        : {}),
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
        // Stable `(ts, id)` order, exactly like the host's SQLite reader.
        .sort((left, right) => (left.ts === right.ts
          ? left.id.localeCompare(right.id)
          : left.ts.localeCompare(right.ts)))
        .slice(0, limit)
        .map((message) => ({ ...message })),
      extract: async (args) => {
        runtime.extractCalls += 1;
        runtime.lastExtract = args;
        if (runtime.extractImpl !== null) return runtime.extractImpl(args);
        return { candidates: runtime.candidates };
      },
      isBusy: () => runtime.busy,
      // Structured state: an assistant turn, playback/queue and fast-path are distinct reasons.
      busySnapshot: () => ({
        activeChatTurns: runtime.busy
          ? [{ sessionId: 'assistant-session', turnId: 1, startedAt: clock.ms, workspace: 'test-workspace' }]
          : [],
        playback: runtime.voiceBusy ? { token: 1, startedAt: clock.ms } : null,
        pendingVoice: runtime.pendingVoice,
        fastPath: runtime.fastPath === true,
      }),
      isVoiceBusy: () => runtime.voiceBusy,
      config: { intervalDays: 7, queuePollMs: 20, ...(config ?? {}) },
      ...rest,
    });
  };
  const events = (type) => runtime.events.filter((event) => event.type === type);
  return { root, db, profile, clock, runtime, addMessage, make, events };
}

/**
 * A fake Harness llm stream: each entry in `replies` is the frame list for one call. `calls`
 * records the exact request (system/maxTokens) so retry behavior can be asserted.
 */
function scriptedModel(replies) {
  const calls = [];
  const service = { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) };
  const llm = {
    stream: (input) => {
      const index = calls.length;
      calls.push(input);
      const frames = replies[index];
      if (frames === undefined) throw new Error(`unexpected model call #${index + 1}`);
      return (async function* streamFrames() {
        for (const frame of frames) yield frame;
      }());
    },
  };
  return { calls, service, llm };
}

test('1) 首次运行：提取→评分→编译→快照写入，summary 计数正确', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '我更喜欢你说话简短一点');
  addMessage('m2', '对，短一点好');
  addMessage('m3', '我早餐喝冰美式');
  addMessage('m4', '每天都要一杯冰美式');
  runtime.candidates = [
    { side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1', 'm2'] },
    { side: 'user', category: '饮食', text: '喜欢冰美式', message_ids: ['m3', 'm4'] },
  ];

  const maintainer = make();
  const result = await maintainer.now();
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.summary.added, 2);
  assert.equal(result.summary.updated, 0);
  assert.equal(result.summary.adopted, 2);
  assert.equal(result.summary.dropped, 0);
  assert.equal(result.summary.forgotten, 0);
  assert.ok(result.summary.tokens > 0);

  const snapshot = maintainer.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.tokens, result.summary.tokens);
  assert.match(snapshot.text, /说话简短/u);
  assert.match(snapshot.text, /喜欢冰美式/u);
  assert.equal(profile.list().length, 2);
  assert.equal(profile.list({ side: 'agent' })[0].clarity, 70, 'two independent supports add C+10 each');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.started).length, 1);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.summary).length, 1);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.progress).length, 2);
  console.log(`1) added=${result.summary.added} adopted=${result.summary.adopted} tokens=${snapshot.tokens} snapshotV=${snapshot.version}`);
});

test('2) 7 天未到 → 不执行，skipped not-due', async (t) => {
  const { clock, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  const before = maintainer.snapshot();
  runtime.extractCalls = 0;
  runtime.candidates = [];

  clock.ms += 6 * DAY;
  const result = await maintainer.tick();
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'not-due');
  assert.equal(runtime.extractCalls, 0);
  assert.deepEqual(maintainer.snapshot(), before);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).at(-1).payload.reason, 'not-due');
  console.log(`2) reason=${result.reason} extractCalls=${runtime.extractCalls} snapshotV=${before.version}`);
});

test('3) 错过周期 → 启动后补做一次，且只补一次', async (t) => {
  const { clock, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const first = make();
  await first.now();
  assert.equal(first.snapshot().version, 1);

  clock.ms += 21 * DAY;
  addMessage('m2', '三周后的一条', { at: clock.ms - 60_000 });
  runtime.candidates = [{ side: 'agent', text: '倾向二', message_ids: ['m2'] }];
  runtime.extractCalls = 0;
  // A new instance simulates the next process launch: the missed period is read from SQLite.
  const restarted = make();
  const run = await restarted.tick();
  assert.equal(run.ran, true);
  assert.equal(run.summary.added, 1);
  assert.equal(runtime.extractCalls, 1, 'a 21-day absence runs one catch-up round');
  assert.equal(restarted.status().lastRunAt, new Date(clock.ms).toISOString());
  assert.equal(restarted.snapshot().version, 2, 'only one snapshot was written for the catch-up');

  clock.ms += 60_000;
  const second = await restarted.tick();
  assert.equal(second.reason, 'not-due', 'the catch-up is not replayed on the next wake-up');
  assert.equal(runtime.extractCalls, 1);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.summary).length, 2);
  console.log(`3) catchupRuns=${runtime.extractCalls} second=${second.reason} lastRunAt=${restarted.status().lastRunAt}`);
});

test('4) 没有新增内容 → 跳过并记录 no-new-content', async (t) => {
  const { runtime, make, events } = await fresh(t);
  const maintainer = make();
  const result = await maintainer.tick();
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no-new-content');
  assert.equal(runtime.extractCalls, 0, 'no messages = no model call');
  assert.equal(maintainer.snapshot(), null);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).at(-1).payload.reason, 'no-new-content');
  console.log(`4) reason=${result.reason} extractCalls=${runtime.extractCalls} snapshot=${maintainer.snapshot()}`);
});

test('5) 忙 → 周期延期；运行中第二次手动点击排队（可取消）', async (t) => {
  const { clock, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();

  runtime.busy = true;
  const deferred = await maintainer.tick();
  assert.equal(deferred.reason, 'active-turn', 'the reason names the concrete blocker');
  assert.equal(deferred.deferred, true, 'a deferred round is distinguishable from an executed one');
  assert.equal(deferred.busy.activeChatTurns.length, 1);
  assert.equal(runtime.extractCalls, 0);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.busy).at(-1).payload.reason, 'active-turn');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.busy).at(-1).payload.snapshot.activeChatTurns.length, 1);
  runtime.busy = false;
  const caughtUp = await maintainer.tick();
  assert.equal(caughtUp.ran, true, 'the deferred round runs once the turn is over');

  clock.ms += 7 * DAY;
  addMessage('m2', '第二条', { at: clock.ms - 60_000 });
  let release = null;
  let announce = null;
  const started = new Promise((resolveStarted) => {
    announce = resolveStarted;
  });
  runtime.extractImpl = () => {
    announce();
    return new Promise((resolveExtract) => {
      release = resolveExtract;
    });
  };
  const firstRun = maintainer.now();
  await started;
  const overlapping = await maintainer.now();
  assert.equal(overlapping.ok, true);
  assert.equal(overlapping.status, 'queued', 'a second click waits in the single queue slot');
  assert.equal(overlapping.reason, 'organizing');
  assert.equal(maintainer.cancel(overlapping.taskId).status, 'cancelled');
  release({ candidates: [{ side: 'agent', text: '倾向二', message_ids: ['m2'] }] });
  const completed = await firstRun;
  await maintainer.waitForIdle();
  assert.equal(completed.ran, true);
  console.log(`5) deferred=${deferred.reason} catchup=${caughtUp.ran} overlap=${overlapping.status}/${overlapping.reason} cancelled=${overlapping.taskId !== undefined}`);
});

test('6) 候选缺 message_id → 被丢弃并计数', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '有效证据');
  runtime.candidates = [
    { side: 'agent', category: '性格', text: '有效倾向', message_ids: ['m1'] },
    { side: 'agent', category: '性格', text: '无证据倾向' },
  ];
  const result = await make().now();
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.dropped, 1);
  assert.equal(profile.list().some((entry) => entry.text === '无证据倾向'), false);
  console.log(`6) added=${result.summary.added} dropped=${result.summary.dropped} entries=${profile.list().map((entry) => entry.text).join(',')}`);
});

test('7) 重复消息 → 证据去重，不重复加分', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '证据一');
  addMessage('m2', '证据二');
  addMessage('m3', '证据三');
  runtime.candidates = [
    { side: 'agent', category: '性格', text: '同一倾向', message_ids: ['m1', 'm2'] },
    { side: 'agent', category: '性格', text: '同一倾向 ', message_ids: ['m1', 'm3'] },
  ];
  const result = await make().now();
  const entries = profile.list();
  assert.equal(result.summary.added, 1);
  assert.equal(entries.length, 1, 'same-tendency candidates merge into one entry');
  assert.equal(profile.evidence(entries[0].id).length, 3, 'm1 is stored once, not twice');
  assert.equal(profile.supportCount(entries[0].id), 3);
  assert.equal(entries[0].clarity, 80, '50 + 3×10, never 50 + 4×10');
  console.log(`7) entries=${entries.length} evidence=${profile.evidence(entries[0].id).length} supports=${profile.supportCount(entries[0].id)} clarity=${entries[0].clarity}`);
});

test('8) 用户手改后 → 版本校验失败 → 本轮放弃、快照不变', async (t) => {
  const { profile, clock, runtime, addMessage, make, events } = await fresh(t);
  const seeded = profile.upsert({ side: 'agent', category: '性格', text: '旧条目' }).entry;
  addMessage('m1', '第一次新增');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  const before = maintainer.snapshot();
  assert.equal(profile.get(seeded.id).version, 1);

  clock.ms += 7 * DAY;
  addMessage('m2', '第二次新增', { at: clock.ms - 60_000 });
  runtime.extractImpl = async () => {
    profile.edit(seeded.id, { text: '旧条目（用户手改）' });
    return { candidates: [{ side: 'agent', text: '新倾向', message_ids: ['m2'] }] };
  };
  const result = await maintainer.now();
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'user-edited');
  assert.deepEqual(maintainer.snapshot(), before, 'the previous compiled snapshot is untouched');
  assert.equal(profile.list().some((entry) => entry.text === '新倾向'), false);
  assert.equal(profile.get(seeded.id).text, '旧条目（用户手改）');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.aborted).at(-1).payload.reason, 'user-edited');
  console.log(`8) aborted=${result.reason} snapshotV=${maintainer.snapshot().version} seededV=${profile.get(seeded.id).version}`);
});

test('9) 锁定条目 C<10 → 不删除（未锁定条目照常遗忘）', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const locked = profile.upsert({ side: 'agent', text: '锁定低分条目', clarity: 9, efficacy: 80 }).entry;
  profile.lock(locked.id, true);
  const doomed = profile.upsert({ side: 'agent', text: '未锁定低分条目', clarity: 9, efficacy: 80 }).entry;
  addMessage('m1', '正常新增');
  runtime.candidates = [{ side: 'agent', text: '正常条目', message_ids: ['m1'] }];
  const result = await make().now();
  assert.equal(result.summary.forgotten, 1);
  assert.notEqual(profile.get(locked.id), null, 'locked C=9 survives the fifth stage');
  assert.equal(profile.get(doomed.id), null, 'unlocked C=9 is still forgotten');
  console.log(`9) forgotten=${result.summary.forgotten} lockedExists=${profile.get(locked.id) !== null} doomedExists=${profile.get(doomed.id) !== null}`);
});

test('10) 模型抛错 → 快照不变、事件 failed', async (t) => {
  const { clock, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一次');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  const before = maintainer.snapshot();
  const lastRunAt = maintainer.status().lastRunAt;

  clock.ms += 7 * DAY;
  addMessage('m2', '第二次', { at: clock.ms - 60_000 });
  runtime.extractImpl = async () => {
    throw new Error('model down');
  };
  const result = await maintainer.now();
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.error, 'model down');
  assert.deepEqual(maintainer.snapshot(), before);
  assert.equal(maintainer.status().lastRunAt, lastRunAt, 'a failed round does not advance the cursor');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.failed).at(-1).payload.error, 'model down');
  console.log(`10) failed=${result.error} snapshotV=${maintainer.snapshot().version} lastRunAt=${maintainer.status().lastRunAt}`);
});

test('11) maintain.now 立即执行，不等待周期', async (t) => {
  const { clock, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();

  clock.ms += 60_000;
  addMessage('m2', '刚说完的一条', { at: clock.ms - 30_000 });
  runtime.candidates = [{ side: 'agent', text: '倾向二', message_ids: ['m2'] }];
  assert.equal(maintainer.isDue(), false, 'the 7-day period has not elapsed');
  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ran, true);
  assert.equal(result.summary.added, 1);
  assert.equal(maintainer.snapshot().version, 2);
  console.log(`11) ran=${result.ran} dueBefore=false added=${result.summary.added} snapshotV=${maintainer.snapshot().version}`);
});

test('12) 同义合并 + 矛盾判定：同一消息只加一次分，contradict 扣分', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const target = profile.upsert({ side: 'agent', category: '性格', text: '喜欢安静' }).entry;
  addMessage('m1', '你说过喜欢安静');
  addMessage('m2', '安静一点挺好');
  addMessage('m3', '其实你太安静了，吵一点也行');
  runtime.candidates = [
    { side: 'agent', category: '性格', text: ' 喜欢安静 ', message_ids: ['m1', 'm2'] },
    { side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['m2'] },
    { side: 'agent', text: '安静', op: 'contradict', target_text: '喜欢安静', message_ids: ['m3'], severity: 'sustained' },
  ];
  const result = await make().now();
  const entry = profile.get(target.id);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.dropped, 0);
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'synonym candidates merge into the existing entry');
  assert.equal(entry.clarity, 60, '50 + 2×10 − 10');
  assert.equal(entry.efficacy, 51, '50 + 2×3 − 5');
  assert.equal(profile.supportCount(entry.id), 2);
  assert.equal(profile.evidence(entry.id).filter((row) => row.kind === 'contra').length, 1);
  console.log(`12) added=${result.summary.added} updated=${result.summary.updated} clarity=${entry.clarity} efficacy=${entry.efficacy} supports=${profile.supportCount(entry.id)}`);
});

test('13) 分页 + 稳定 (ts,id) 游标：上限 2、3 条消息 → 先 2 条，再第 3 条', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  // Distinct milliseconds: the cursor must depend on (ts, id), not on a page boundary.
  addMessage('m1', '第一条', { at: T0 - 3000 });
  addMessage('m2', '第二条', { at: T0 - 2000 });
  addMessage('m3', '第三条', { at: T0 - 1000 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '倾向一', message_ids: ['m1', 'm2'] }];

  const maintainer = make({ config: { maxMessages: 2 } });
  const first = await maintainer.now();
  assert.equal(first.ran, true);
  assert.deepEqual(runtime.lastExtract.messages.map((message) => message.id), ['m1', 'm2']);
  const cursor = JSON.parse(maintainer.status().cursor);
  assert.deepEqual(cursor, { ts: new Date(T0 - 2000).toISOString(), id: 'm2' }, 'the cursor is the stable key of the last processed row');

  runtime.candidates = [{ side: 'agent', category: '性格', text: '倾向二', message_ids: ['m3'] }];
  const second = await maintainer.now();
  assert.equal(second.ran, true);
  assert.deepEqual(runtime.lastExtract.messages.map((message) => message.id), ['m3'], 'the 401st case: nothing past the limit is lost');
  assert.equal(profile.list().some((entry) => entry.text === '倾向二'), true);
  assert.deepEqual(JSON.parse(maintainer.status().cursor), { ts: new Date(T0 - 1000).toISOString(), id: 'm3' });
  console.log(`13) first=${first.summary.added} second=${second.summary.added} cursor=${maintainer.status().cursor}`);
});

test('14) 角色过滤：assistant 回复不算独立支持，只有 user 消息计证据', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('u1', '我希望你聊天时简短一点', { at: T0 - 3000 });
  addMessage('a1', '好的，我会简短回复', { role: 'assistant', at: T0 - 2000 });
  runtime.candidates = [
    { side: 'agent', category: '语言', text: '说话简短', message_ids: ['u1', 'a1'] },
    { side: 'agent', category: '语言', text: '只有助手回复', message_ids: ['a1'] },
  ];
  const result = await make().now();
  const entry = profile.list().find((item) => item.text === '说话简短');
  assert.notEqual(entry, undefined);
  assert.equal(result.summary.dropped, 1, 'a candidate citing only an assistant message has no evidence');
  assert.equal(profile.evidence(entry.id).length, 1, 'the same exchange (user + assistant) counts once');
  assert.equal(profile.supportCount(entry.id), 1);
  assert.equal(entry.clarity, 60, 'one user support: C=50+10, not 70');
  assert.notEqual(entry.rank, 'original', 'one support cannot reach the adoption gate');
  assert.equal(result.summary.adopted, 0);
  assert.equal(profile.list().some((item) => item.text === '只有助手回复'), false);
  console.log(`14) supports=${profile.supportCount(entry.id)} C=${entry.clarity} rank=${entry.rank} dropped=${result.summary.dropped}`);
});

test('15) 选中豁免衰退：原订 C=60 本轮无证据且被选中 → C 仍 60（采纳≠强化）', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const adopted = profile.upsert({
    side: 'agent', category: '性格', text: '一直保留的安静', clarity: 60, efficacy: 50, rank: 'original',
  }).entry;
  addMessage('m1', '今天聊点别的');
  runtime.candidates = [{ side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m1'] }];
  const result = await make().now();

  const after = profile.get(adopted.id);
  assert.deepEqual([after.clarity, after.efficacy, after.rank], [60, 50, 'original'], 'being selected neither decays nor strengthens');
  assert.equal(profile.supportCount(adopted.id), 0, 'selection adds no evidence');
  assert.equal(profile.evidence(adopted.id).length, 0);
  assert.equal(result.summary.decayed, 0);
  console.log(`15) selectedC=${after.clarity} rank=${after.rank} supports=${profile.supportCount(adopted.id)} decayed=${result.summary.decayed}`);
});

test('16) 落选自然衰退：C=60 未选中 → C=58，E 不变', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const dropped = profile.upsert({
    side: 'agent', category: '性格', text: '挤不进预算的条目', clarity: 60, efficacy: 50,
  }).entry;
  profile.addEvidence(dropped.id, { messageId: 'old-1', kind: 'support' });
  profile.addEvidence(dropped.id, { messageId: 'old-2', kind: 'support' });
  addMessage('m1', '来点新东西');
  runtime.candidates = [{ side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m1'] }];

  const result = await make({ config: { profileRank: { totalBudget: 1, categoryBudget: 1 } } }).now();
  const after = profile.get(dropped.id);
  assert.deepEqual([after.clarity, after.efficacy, after.rank], [58, 50, 'new']);
  assert.equal(result.summary.decayed, 1);
  console.log(`16) C=${after.clarity} E=${after.efficacy} rank=${after.rank} decayed=${result.summary.decayed}`);
});

test('17) 本轮没有新增交流 → 不调用衰退，所有条目不变', async (t) => {
  const { profile, clock, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  const before = profile.list().map((entry) => ({ id: entry.id, clarity: entry.clarity, efficacy: entry.efficacy, rank: entry.rank }));
  const calls = runtime.extractCalls;

  clock.ms += 7 * DAY;
  const result = await maintainer.tick();
  assert.equal(result.reason, 'no-new-content');
  assert.equal(runtime.extractCalls, calls, 'no exchange = no extractor call');
  assert.deepEqual(
    profile.list().map((entry) => ({ id: entry.id, clarity: entry.clarity, efficacy: entry.efficacy, rank: entry.rank })),
    before,
  );
  assert.equal(maintainer.status().lastSummary.decayed, 0);
  console.log(`17) reason=${result.reason} entries=${before.length} decayed=${maintainer.status().lastSummary.decayed}`);
});

test('18) 锁定全豁免：矛盾后 C 不变、仍原订，并记 profile.locked.exempt', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  const locked = profile.upsert({
    side: 'agent', category: '性格', text: '被锁定的安静', clarity: 45, efficacy: 50, rank: 'original',
  }).entry;
  profile.lock(locked.id, true);
  addMessage('m1', '其实你现在太安静了');
  runtime.candidates = [{
    side: 'agent', text: '安静', op: 'contradict', target_text: '被锁定的安静',
    message_ids: ['m1'], severity: 'sustained',
  }];

  const result = await make().now();
  const after = profile.get(locked.id);
  assert.deepEqual([after.clarity, after.efficacy, after.rank], [45, 50, 'original'], 'locked: no C/E change, no retirement');
  assert.equal(result.summary.adopted, 1, 'a locked original stays compiled');
  const exempt = events('profile.locked.exempt');
  assert.equal(exempt.length, 1);
  assert.deepEqual(exempt[0].payload, { entryId: locked.id, event: 'contradiction' });
  console.log(`18) C=${after.clarity} rank=${after.rank} exempt=${exempt.length}`);
});

test('19) 取消：提取完成后 dispose → 不提交、快照与游标不变', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '这条不该被整理');
  let maintainer = null;
  runtime.extractImpl = async () => {
    maintainer.dispose();
    return { candidates: [{ side: 'agent', text: '取消后的倾向', message_ids: ['m1'] }] };
  };
  maintainer = make();

  const result = await maintainer.now();
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(maintainer.snapshot(), null, 'no snapshot is written');
  assert.equal(profile.list().length, 0, 'no entry is written');
  assert.equal(maintainer.status().lastRunAt, null, 'no bookkeeping is written');
  assert.equal(maintainer.status().cursor, null);
  console.log(`19) reason=${result.reason} entries=${profile.list().length} snapshot=${maintainer.snapshot()}`);
});

test('20) 矛盾降级不可被选中抵消：C 45→35，预算宽裕也不在原订集合', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const target = profile.upsert({
    side: 'agent', category: '性格', text: '曾经喜欢安静', clarity: 45, efficacy: 50, rank: 'original',
  }).entry;
  addMessage('m1', '你最近太吵了');
  runtime.candidates = [{
    side: 'agent', text: '安静', op: 'contradict', target_text: '曾经喜欢安静',
    message_ids: ['m1'], severity: 'sustained',
  }];

  const maintainer = make();
  const result = await maintainer.now();
  const after = profile.get(target.id);
  assert.equal(after.clarity, 35, 'the sustained contradiction is final: 45-10, never restored to 45');
  assert.equal(after.rank, 'new', 'C<40 retires an original even though the budget is wide open');
  assert.equal(result.summary.adopted, 0);
  assert.equal(String(maintainer.snapshot().text).includes('曾经喜欢安静'), false);
  console.log(`20) C=${after.clarity} rank=${after.rank} adopted=${result.summary.adopted}`);
});

test('21) 删除后旧证据不能立刻重建，但新的明确支持可以', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('old-1', '我喜欢安静', { at: T0 - 5000 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['old-1'] }];
  const maintainer = make();
  await maintainer.now();
  const entry = profile.list()[0];
  assert.equal(profile.supportCount(entry.id), 1);
  assert.equal(profile.remove(entry.id), true);
  assert.equal(profile.list().length, 0, 'remove is a direct delete, no fingerprint ban');

  // The removed entry's old message is outside this increment: citing it cannot rebuild the entry.
  addMessage('new-1', '随便聊点别的', { at: T0 - 1000 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['old-1'] }];
  const blocked = await maintainer.now();
  assert.equal(blocked.summary.dropped, 1, 'old evidence never re-enters through an unrelated round');
  assert.equal(profile.list().length, 0);

  // A genuinely new, explicit support may build the tendency again.
  addMessage('new-2', '对，我确实喜欢安静', { at: T0 - 500 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['new-2'] }];
  const rebuilt = await maintainer.now();
  assert.equal(rebuilt.summary.added, 1);
  assert.equal(profile.list()[0].text, '喜欢安静');
  assert.equal(profile.supportCount(profile.list()[0].id), 1, 'only the new message supports it');
  console.log(`21) removed=true blockedDropped=${blocked.summary.dropped} rebuilt=${rebuilt.summary.added}`);
});

test('22) 证据身份含 sessionId：同会话同轮两条 → 1 份；合并候选后仍 1 份', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  // One turn can contain more than one user row (e.g. a correction/continuation). They are one
  // support, and merging two same-tendency candidates must not turn them into two.
  addMessage('m1', '我希望你说话简短', { sessionId: 's1', turn: 1, at: T0 - 3000 });
  addMessage('m2', '对，简短一点', { sessionId: 's1', turn: 1, at: T0 - 2000 });
  runtime.candidates = [
    { side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] },
    { side: 'agent', category: '语言', text: '说话简短 ', message_ids: ['m2'] },
  ];
  const result = await make().now();
  const entry = profile.list()[0];
  assert.equal(result.summary.added, 1, 'same-tendency candidates merge');
  assert.equal(profile.supportCount(entry.id), 1, 'one (session, turn) = one support, even after merge');
  assert.equal(profile.evidence(entry.id).length, 1);
  assert.equal(entry.clarity, 60, 'C=50+10 only once');
  console.log(`22) supports=${profile.supportCount(entry.id)} evidence=${profile.evidence(entry.id).length} C=${entry.clarity}`);
});

test('23) 两个会话的同号 turn 是两份独立证据（旧实现只按 turn 会压成一份）', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('s1-m1', '我希望你说话简短', { sessionId: 'session-a', turn: 1, at: T0 - 3000 });
  addMessage('s2-m1', '我也想让你说话简短', { sessionId: 'session-b', turn: 1, at: T0 - 2000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['s1-m1', 's2-m1'] }];
  await make().now();
  const entry = profile.list()[0];
  assert.equal(profile.supportCount(entry.id), 2, '(sessionId, turn, role) keeps the two sessions apart');
  assert.equal(entry.clarity, 70, '50 + 2×10');
  console.log(`23) supports=${profile.supportCount(entry.id)} C=${entry.clarity} sessions=session-a,session-b turn=1`);
});

test('24) 删除边界：删除前的积压消息不重建，删除后的新消息可以重建', async (t) => {
  const { clock, profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '我确实喜欢安静', { at: T0 - 5000 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  const entry = profile.list()[0];

  // A message that predates the delete is still unread (the cursor sits on m1). If the boundary
  // were not recorded, the next round would read m2 and rebuild the just-deleted tendency.
  addMessage('m2', '我还是喜欢安静', { at: T0 - 1000 });
  assert.equal(maintainer.removeEntry(entry.id), true);
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['m2'] }];
  const blocked = await maintainer.now();
  assert.equal(blocked.summary.dropped, 1, 'the backlog evidence is behind the delete boundary');
  assert.equal(profile.list().length, 0, 'the deleted tendency is not rebuilt');

  // A message created after the delete is new evidence: it may build the tendency again.
  clock.ms += 60_000;
  addMessage('m3', '对，我就是喜欢安静', { at: clock.ms - 1000 });
  runtime.candidates = [{ side: 'agent', category: '性格', text: '喜欢安静', message_ids: ['m3'] }];
  const rebuilt = await maintainer.now();
  assert.equal(rebuilt.summary.added, 1);
  assert.equal(profile.list()[0].text, '喜欢安静');
  assert.equal(profile.supportCount(profile.list()[0].id), 1, 'only the post-delete message supports it');
  console.log(`24) blockedDropped=${blocked.summary.dropped} rebuilt=${rebuilt.summary.added} boundary=${maintainer.state.deletions !== undefined}`);
});

test('25) 同会话同轮分两批处理 → 跨批次证据去重，supports 只 +1', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  // An adopted original: it stays selected in both rounds, so no natural decay can hide the
  // evidence difference behind a score change.
  const entry = profile.upsert({
    side: 'agent', category: '语言', text: '说话简短', clarity: 50, efficacy: 50, rank: 'original',
  }).entry;
  addMessage('m1', '我希望你说话简短', { sessionId: 's1', turn: 7, at: T0 - 3000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  const maintainer = make();

  const first = await maintainer.now();
  assert.equal(first.ran, true);
  assert.equal(profile.supportCount(entry.id), 1);
  assert.equal(profile.get(entry.id).clarity, 60, 'C=50+10 once');
  const seen = JSON.parse(maintainer.state.seenExchanges ?? '[]');
  assert.equal(seen.length, 1, 'the (entry, exchange) identity is persisted');

  // The second batch delivers another user row of the SAME session/turn. A new message id must
  // not become a second independent support.
  addMessage('m2', '对，简短一点', { sessionId: 's1', turn: 7, at: T0 - 2000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m2'] }];
  const second = await maintainer.now();
  assert.equal(second.ran, true);
  assert.equal(second.summary.updated, 0, 'the replayed exchange touches no entry');
  assert.equal(profile.supportCount(entry.id), 1, 'supports stayed at 1 across the batches');
  assert.equal(profile.get(entry.id).clarity, 60, 'no second C+10');
  assert.equal(profile.evidence(entry.id).length, 1);
  console.log(`25) supports=${profile.supportCount(entry.id)} C=${profile.get(entry.id).clarity} evidence=${profile.evidence(entry.id).length} seenExchanges=${JSON.parse(maintainer.state.seenExchanges ?? '[]').length}`);
});

test('26) 手动 + 活跃对话 + 无语音 → 立即执行，不再被对话阻塞', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '我更喜欢你说话简短一点');
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  runtime.busy = true; // an active chat turn: the old code deferred the click here
  const maintainer = make();

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true, 'the explicit click executes during a conversation');
  assert.equal(result.deferred, undefined, 'an executed round is not reported as deferred');
  assert.equal(result.summary.added, 1);
  assert.equal(runtime.extractCalls, 1);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.started).length, 1);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).length, 0);
  console.log(`26) ran=${result.ran} deferred=${result.deferred} reason=${result.reason ?? '(none)'} added=${result.summary.added} extractCalls=${runtime.extractCalls}`);
});

test('27) 手动 + 语音播放中 → 进入队列并返回具体原因', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '这条先不整理');
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  runtime.busy = true;
  runtime.voiceBusy = true;
  const maintainer = make();

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'queued', 'the click is accepted, not dropped');
  assert.equal(result.ran, false);
  assert.equal(result.deferred, true, 'a queued round is explicit');
  assert.equal(result.reason, 'playing');
  assert.equal(runtime.extractCalls, 0, 'no model call while the speaker owns the round');
  const busy = events(PROFILE_MAINTAIN_EVENTS.busy).at(-1).payload;
  assert.equal(busy.trigger, 'settings');
  assert.equal(busy.reason, 'playing');
  assert.equal(busy.snapshot.playback.token, 1);
  assert.equal(maintainer.cancel(result.taskId).status, 'cancelled');
  console.log(`27) status=${result.status} ran=${result.ran} deferred=${result.deferred} reason=${result.reason} extractCalls=${runtime.extractCalls}`);
});

test('28) 周期 + 活跃对话 → 仍延后（原 busy 语义）', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  runtime.busy = true;
  const maintainer = make();

  const deferred = await maintainer.tick();
  assert.equal(deferred.ok, true);
  assert.equal(deferred.ran, false);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.reason, 'active-turn', 'the schedule still waits for the conversation to end');
  assert.equal(runtime.extractCalls, 0);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.busy).at(-1).payload.reason, 'active-turn');

  runtime.busy = false;
  const caughtUp = await maintainer.tick();
  assert.equal(caughtUp.ran, true, 'the deferred schedule round runs once the turn is over');
  console.log(`28) deferred=${deferred.reason}/${deferred.deferred} extractCalls=${runtime.extractCalls} catchup=${caughtUp.ran}`);
});

test('29) 周期 + 无对话无语音 → 正常执行', async (t) => {
  const { runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  const maintainer = make();

  const result = await maintainer.tick();
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.deferred, undefined);
  assert.equal(result.summary.added, 1);
  assert.equal(runtime.extractCalls, 1);
  console.log(`29) ran=${result.ran} deferred=${result.deferred} reason=${result.reason ?? '(none)'} added=${result.summary.added} extractCalls=${runtime.extractCalls}`);
});

/** One assistant turn tracked by the host probe; the scope predicate is what index.js wires. */
function busyHarness() {
  const clock = { ms: T0 };
  const tracker = createProfileMaintainBusyTracker({
    isAssistantSession: (session) => /assistant-workspace$/u.test(String(session?.header?.cwd ?? '')),
    workspaceOf: (session) => session?.header?.cwd ?? '',
    now: () => clock.ms,
  });
  const session = (id, cwd) => ({ id, header: { cwd } });
  return { clock, tracker, session };
}

test('30) 非助手会话 turn/start → 不算忙（误判复现）', async () => {
  const { tracker, session } = busyHarness();
  const coding = session('coding-session', 'D:/code/project');
  const added = tracker.noteTurnStart(coding, { type: 'turn/start', data: { turn: 4 } });
  assert.equal(added, false);
  assert.equal(tracker.isBusy(), false, 'a coding-agent turn never blocks the companion');
  assert.equal(tracker.reason(), null);
  assert.deepEqual(tracker.snapshot().activeChatTurns, []);
  console.log(`30) added=${added} busy=${tracker.isBusy()} turns=${tracker.snapshot().activeChatTurns.length}`);
});

test('31) 助手会话 turn/start → 忙，reason=active-turn 且快照含归属', async () => {
  const { clock, tracker, session } = busyHarness();
  const assistant = session('assistant-session', 'C:/Seirein/assistant-workspace');
  assert.equal(tracker.noteTurnStart(assistant, { type: 'turn/start', data: { turn: 7 } }), true);
  assert.equal(tracker.isBusy(), true);
  assert.equal(tracker.reason(), 'active-turn');
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.activeChatTurns.length, 1);
  assert.deepEqual(snapshot.activeChatTurns[0], {
    sessionId: 'assistant-session',
    turnId: 7,
    startedAt: clock.ms,
    workspace: 'C:/Seirein/assistant-workspace',
  });
  console.log(`31) reason=${tracker.reason()} session=${snapshot.activeChatTurns[0].sessionId} turn=${snapshot.activeChatTurns[0].turnId} workspace=${snapshot.activeChatTurns[0].workspace}`);
});

test('32) turn/end 归零；旧轮次的迟到 end 不删除新轮次', async () => {
  const { tracker, session } = busyHarness();
  const assistant = session('assistant-session', 'C:/Seirein/assistant-workspace');
  tracker.noteTurnStart(assistant, { data: { turn: 1 } });
  tracker.noteTurnStart(assistant, { data: { turn: 2 } });
  assert.equal(tracker.noteTurnEnd(assistant, { data: { turn: 1 } }), false, 'late end of turn 1 is ignored');
  assert.equal(tracker.isBusy(), true, 'turn 2 is still active');

  assert.equal(tracker.noteTurnEnd(assistant, { data: { turn: 2 } }), true);
  assert.equal(tracker.isBusy(), false);
  assert.deepEqual(tracker.snapshot().activeChatTurns, []);
  console.log(`32) lateEndIgnored=true busyAfterEnd=${tracker.isBusy()} turns=${tracker.snapshot().activeChatTurns.length}`);
});

test('33) 超时残留自动清理：turn/start 后超过阈值不再算忙', async () => {
  const { clock, tracker, session } = busyHarness();
  const assistant = session('assistant-session', 'C:/Seirein/assistant-workspace');
  tracker.noteTurnStart(assistant, { data: { turn: 1 } });
  assert.equal(tracker.isBusy(), true);
  clock.ms += PROFILE_MAINTAIN_TURN_STALE_MS + 1;
  assert.equal(tracker.isBusy(), false, 'stale bookkeeping expires instead of blocking forever');
  assert.deepEqual(tracker.snapshot().activeChatTurns, []);
  console.log(`33) staleAfterMs=${PROFILE_MAINTAIN_TURN_STALE_MS + 1} busy=${tracker.isBusy()} turns=${tracker.snapshot().activeChatTurns.length}`);
});

test('34) 播放 / 待播队列 / fast-path 分别命中原因；已取消任务不算忙', async () => {
  const { tracker } = busyHarness();
  assert.equal(tracker.reason({ playback: { token: 9, startedAt: T0 } }), 'playing');
  assert.equal(tracker.reason({ pendingVoice: [{ text: '待播' }] }), 'pending-voice');
  assert.equal(tracker.reason({ fastPath: true }), 'fast-path');
  const cancelledOnly = tracker.snapshot({ pendingVoice: [{ text: '已取消', cancelled: true }] });
  assert.deepEqual(cancelledOnly.pendingVoice, { size: 0, cancelledOnly: true });
  assert.equal(tracker.reason({ pendingVoice: [{ text: '已取消', cancelled: true }] }), null);
  console.log(`34) playback=${tracker.reason({ playback: { token: 9, startedAt: T0 } })} pending=${tracker.reason({ pendingVoice: [{ text: '待播' }] })} cancelledOnly=${JSON.stringify(cancelledOnly.pendingVoice)}`);
});

test('35) 周期整理分别记录 playing / pending-voice，清空后正常执行', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  runtime.voiceBusy = true;
  const maintainer = make();

  const playing = await maintainer.tick();
  assert.equal(playing.reason, 'playing');
  assert.equal(playing.deferred, true);
  assert.equal(playing.busy.playback.token, 1);
  assert.equal(runtime.extractCalls, 0);

  runtime.voiceBusy = false;
  runtime.pendingVoice = 2;
  const pending = await maintainer.tick();
  assert.equal(pending.reason, 'pending-voice');
  assert.equal(pending.busy.pendingVoice.size, 2);
  assert.equal(runtime.extractCalls, 0);

  runtime.pendingVoice = 0;
  const ran = await maintainer.tick();
  assert.equal(ran.ran, true);
  assert.equal(runtime.extractCalls, 1);
  const reasons = events(PROFILE_MAINTAIN_EVENTS.busy).map((event) => event.payload.reason);
  assert.deepEqual(reasons, ['playing', 'pending-voice']);
  console.log(`35) playing=${playing.reason} pending=${pending.reason} ran=${ran.ran} extractCalls=${runtime.extractCalls} events=${reasons.join(',')}`);
});

test('36) 手动排队：单任务限制、取消、放行后自动执行', async (t) => {
  const { runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '第一条');
  runtime.candidates = [{ side: 'agent', text: '倾向一', message_ids: ['m1'] }];
  runtime.voiceBusy = true;
  const maintainer = make();

  const queued = await maintainer.now({ trigger: 'settings' });
  assert.equal(queued.ok, true);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.reason, 'playing');
  assert.equal(typeof queued.taskId, 'string');
  assert.equal(maintainer.status().queued, true);

  const rejected = await maintainer.now({ trigger: 'settings' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'queue-full', 'only one request may wait');
  assert.equal(rejected.queuedTaskId, queued.taskId);

  const cancelled = maintainer.cancel(queued.taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(maintainer.status().queued, false);
  runtime.voiceBusy = false;
  await maintainer.drainQueue();
  assert.equal(runtime.extractCalls, 0, 'a cancelled request never runs');

  runtime.voiceBusy = true;
  const accepted = await maintainer.now({ trigger: 'settings' });
  assert.equal(accepted.status, 'queued');
  runtime.voiceBusy = false;
  await maintainer.drainQueue();
  await maintainer.waitForIdle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.extractCalls, 1, 'the queued request runs once the speaker is free');
  assert.equal(maintainer.status().lastTask.taskId, accepted.taskId);
  assert.equal(maintainer.status().lastTask.status, 'completed');
  assert.equal(maintainer.snapshot().version, 1);
  console.log(`36) queued=${queued.status}/${queued.reason} rejected=${rejected.reason} cancelled=${cancelled.status} last=${maintainer.status().lastTask.status} extractCalls=${runtime.extractCalls}`);
});

test('37) 运行中的手动任务可取消：abort 后不提交、不写快照', async (t) => {
  const { runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '这条不该被整理');
  let release = null;
  let announce = null;
  const started = new Promise((resolveStarted) => {
    announce = resolveStarted;
  });
  runtime.extractImpl = () => {
    announce();
    return new Promise((resolveExtract) => {
      release = resolveExtract;
    });
  };
  const maintainer = make();
  const running = maintainer.now({ trigger: 'settings' });
  await started;
  const taskId = maintainer.status().taskId;
  assert.equal(typeof taskId, 'string');
  assert.equal(maintainer.status().running, true);

  const cancelled = maintainer.cancel(taskId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.running, true);
  release({ candidates: [{ side: 'agent', text: '不应入库', message_ids: ['m1'] }] });
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(maintainer.snapshot(), null, 'a cancelled run writes no snapshot');
  console.log(`37) task=${taskId} cancel=${cancelled.status} run=${result.reason} snapshot=${maintainer.snapshot()}`);
});

// ---- 「立刻整理」 with an unsynced settings box ----------------------------------------------
// A manual round must process a box edit even when no new exchange exists: the agent splits the
// changed side (update library → compile → rewrite → write back). The schedule keeps its old
// semantics: an unsynced box is imported line by line, never re-split and never rewritten.

/**
 * One fragment per non-empty line, labelled with the box it was typed in. The model is free to
 * route a fragment to the other side (a cross-box move); this echo never does.
 */
const splitEcho = ({ agent, user, side, text } = {}) => {
  const boxes = side === 'agent' || side === 'user'
    ? [{ side, text }]
    : [{ side: 'agent', text: agent ?? '' }, { side: 'user', text: user ?? '' }];
  const entries = [];
  for (const box of boxes) {
    for (const line of String(box.text ?? '').split(/\r?\n/u)) {
      const body = line.trim();
      if (body.length === 0) continue;
      entries.push({
        text: body,
        side: box.side,
        from: box.side,
        category: box.side === 'user' ? '生活习惯' : '说话方式',
      });
    }
  }
  return entries;
};

test('38) 手动：框内改一个词、无新交流 → 拆分→更新库→重写→写回，reason=box-changed', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你说话更温柔一点，慢慢说。';
  const maintainer = make({ boxes: true });
  assert.equal((await maintainer.split({ agent: '说话温柔', user: '' })).ok, true);
  const entryId = profile.list({ side: 'agent' })[0].id;
  const writesBefore = runtime.writeCalls.length;

  // One word edited in the box; there is no new chat message at all.
  runtime.persona = { ...runtime.persona, agent: '说话更温柔' };
  assert.equal(maintainer.pendingSides().agent, true);
  assert.equal(runtime.extractCalls, 0);

  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'box-changed');
  assert.equal(runtime.splitCalls.length, 2, 'the changed box is re-split by the agent');
  assert.deepEqual(
    { agent: runtime.splitCalls.at(-1).agent, user: runtime.splitCalls.at(-1).user },
    { agent: '说话更温柔', user: '' },
    'one split call carries both boxes',
  );
  assert.equal(runtime.extractCalls, 0, 'no new exchange = no extractor call');
  assert.equal(profile.get(entryId).text, '说话更温柔', 'the existing entry is updated, not duplicated');
  assert.equal(profile.list({ side: 'agent' }).length, 1);
  assert.deepEqual(maintainer.snapshot().lines.map((line) => line.text), ['说话更温柔']);
  assert.ok(runtime.writeCalls.length > writesBefore, 'the rewritten prompt is written back');
  assert.equal(runtime.persona.agent, '你说话更温柔一点，慢慢说。');
  assert.equal(events(PROFILE_WRITEBACK_EVENT).at(-1).payload.side, 'agent');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).length, 0, 'an executed round is not reported as skipped');
  const phaseOne = {
    ran: result.ran,
    reason: result.reason,
    entry: profile.get(entryId).text,
    splitCalls: runtime.splitCalls.length,
    box: runtime.persona.agent,
  };

  // A failing rewrite still falls back to the deterministic concat and still writes back.
  runtime.persona = { ...runtime.persona, agent: '说话更温柔些' };
  runtime.composeImpl = () => {
    throw new Error('composer offline');
  };
  const fallback = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.reason, 'box-changed');
  assert.match(runtime.persona.agent, /说话更温柔些/u);
  assert.equal(/## /u.test(runtime.persona.agent), false, 'a failed rewrite writes prose, not a compiled section');
  assert.equal(/^[-*·]/mu.test(runtime.persona.agent), false, 'no list marker reaches the box');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.failed).length, 1);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 2);
  console.log(`38) ran=${phaseOne.ran} reason=${phaseOne.reason} splitCalls=${phaseOne.splitCalls} entry="${phaseOne.entry}" box="${phaseOne.box}" fallback=(ran:${fallback.ran}, ${fallback.reason}) box="${runtime.persona.agent.split('\n')[0]}"`);
});

test('39) 手动：框内未变、无新交流 → 跳过 no-new-content，不拆分不写回', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.splitImpl = splitEcho;
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });
  const splitCalls = runtime.splitCalls.length;
  const writes = runtime.writeCalls.length;
  const before = maintainer.snapshot();

  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no-new-content');
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(runtime.splitCalls.length, splitCalls, 'an unchanged box is never re-split');
  assert.equal(runtime.writeCalls.length, writes, 'an unchanged box is never rewritten');
  assert.deepEqual(maintainer.snapshot(), before);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).at(-1).payload.reason, 'no-new-content');
  console.log(`39) ran=${result.ran} reason=${result.reason} splitCalls=${runtime.splitCalls.length} writeCalls=${runtime.writeCalls.length} snapshotV=${before.version}`);
});

test('40) 手动：框内未变、有新交流 → ran=true，reason=new-content', async (t) => {
  const { runtime, addMessage, make } = await fresh(t);
  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你会温柔地说话。';
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });

  addMessage('m1', '你说话再温柔一点');
  runtime.candidates = [{ side: 'agent', category: '说话方式', text: '说话更温柔', message_ids: ['m1'] }];
  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'new-content');
  assert.equal(result.summary.added, 1);
  assert.equal(runtime.splitCalls.length, 1, 'an already-synced box is not re-split');
  console.log(`40) ran=${result.ran} reason=${result.reason} added=${result.summary.added} splitCalls=${runtime.splitCalls.length}`);
});

test('41) 手动：框内和新交流都变 → reason=both', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你会温柔地说话，也会记住新的偏好。';
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });

  runtime.persona = { ...runtime.persona, agent: '说话很温柔' };
  addMessage('m1', '你说话再温柔一点');
  runtime.candidates = [{ side: 'agent', category: '说话方式', text: '说话更温柔', message_ids: ['m1'] }];
  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'both');
  assert.equal(runtime.splitCalls.length, 2, 'the changed box is split as well');
  assert.deepEqual(
    { agent: runtime.splitCalls.at(-1).agent, user: runtime.splitCalls.at(-1).user },
    { agent: '说话很温柔', user: '' },
    'one split call carries both boxes',
  );
  assert.deepEqual(
    profile.list({ side: 'agent' }).map((entry) => entry.text).sort(),
    ['说话很温柔', '说话更温柔'].sort(),
  );
  console.log(`41) ran=${result.ran} reason=${result.reason} splitCalls=${runtime.splitCalls.length} entries="${profile.list({ side: 'agent' }).map((entry) => entry.text).join(',')}"`);
});

test('42) 手动：拆分失败 → 库与框都不变、返回 split-failed', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = splitEcho;
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });
  const before = {
    entries: profile.list(),
    snapshot: maintainer.snapshot(),
    writes: runtime.writeCalls.length,
  };

  runtime.persona = { ...runtime.persona, agent: '说话非常温柔' };
  const beforePersona = { ...runtime.persona };
  runtime.splitImpl = () => {
    throw new Error('model offline');
  };
  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'split-failed');
  assert.match(result.error, /model offline/u);
  assert.deepEqual(profile.list(), before.entries, 'the library is untouched');
  assert.deepEqual(maintainer.snapshot(), before.snapshot, 'the snapshot is untouched');
  assert.deepEqual(runtime.persona, beforePersona, 'the box edit is kept verbatim for a retry');
  assert.equal(runtime.writeCalls.length, before.writes, 'nothing is written back');
  assert.equal(maintainer.pendingSides().agent, true, 'the edit is still pending');
  assert.equal(events(PROFILE_SPLIT_EVENTS.failed).length, 1);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0);
  console.log(`42) ok=${result.ok} ran=${result.ran} reason=${result.reason} error="${result.error}" entries=${profile.list().length} box="${runtime.persona.agent}"`);
});

test('43) 周期：框内未同步 + 无新交流 → 仍跳过 no-new-content，不因 pending 自动入库', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = splitEcho;
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });
  const splitCalls = runtime.splitCalls.length;
  const writes = runtime.writeCalls.length;
  const entriesBefore = profile.list({ side: 'agent' }).map((entry) => entry.text);

  // An unsynced box edit alone must not turn the scheduled round into a manual one. The box stays
  // pending and the library stays untouched until the user explicitly organizes.
  runtime.persona = { ...runtime.persona, agent: '说话温柔\n说话简洁' };
  assert.equal(maintainer.pendingSides().agent, true);
  const result = await maintainer.tick();
  assert.equal(result.ok, true);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'no-new-content');
  assert.equal(runtime.splitCalls.length, splitCalls, 'the schedule never calls the agent split');
  assert.equal(runtime.writeCalls.length, writes, 'the schedule never rewrites the box');
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0);
  assert.deepEqual(profile.list({ side: 'agent' }).map((entry) => entry.text), entriesBefore, 'pending text is not imported');
  assert.equal(maintainer.pendingSides().agent, true, 'the edit is still pending');
  console.log(`43) ran=${result.ran} reason=${result.reason} splitCalls=${runtime.splitCalls.length} pending=${maintainer.pendingSides().agent} entries="${profile.list({ side: 'agent' }).map((entry) => entry.text).join(',')}"`);
});

// ---- save vs organize: "保存只写框，整理才入库" ------------------------------------------------

test('44) 保存只写文本框：库条目数不变、不调用拆分、pending=true', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  const maintainer = make({ boxes: true });
  const result = await maintainer.save({ agent: '说话温柔' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.saved, ['agent']);
  assert.deepEqual(result.pending, { agent: true, user: false });
  assert.equal(runtime.persona.agent, '说话温柔', 'the text box is persisted');
  assert.equal(profile.list().length, 0, 'the library is untouched');
  assert.equal(runtime.splitCalls.length, 0, 'save never calls the splitter');
  assert.equal(runtime.composeCalls.length, 0, 'save never rewrites');
  assert.equal(runtime.extractCalls, 0);
  assert.equal(maintainer.pendingSides().agent, true);
  assert.equal(maintainer.status().pending.agent, true, 'pending is exposed per side');
  assert.equal(events('profile.save').length, 1);
  console.log(`44) saved=${result.saved.join(',')} entries=${profile.list().length} splitCalls=${runtime.splitCalls.length} pending=${JSON.stringify(maintainer.status().pending)} box="${runtime.persona.agent}"`);
});

test('45) 保存后注入立即使用框内文本（试用生效，不进库）', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  const maintainer = make({ boxes: true });
  await maintainer.save({ agent: '全新的试用人设', user: '用户喜欢热茶' });

  assert.equal(maintainer.readBoxes().agent, '全新的试用人设');
  assert.equal(maintainer.boxesAuthoritative(), true, 'the persona section is the injected copy');
  assert.equal(maintainer.promptSection().text, '', 'no compiled duplicate is injected over the box');
  assert.equal(profile.list().length, 0, 'the trial text is not in the library');
  console.log(`45) box="${runtime.persona.agent}" entries=${profile.list().length} profileSection="${maintainer.promptSection().text}" authoritative=${maintainer.boxesAuthoritative()}`);
});

test('46) 整理完整流程：拆分一次→入库→重写一次→写回、pending=false', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const maintainer = make({ boxes: true });
  await maintainer.save({ agent: '说话温柔', user: '' });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'box-changed');
  assert.equal(runtime.splitCalls.length, 1, 'exactly one split call');
  assert.equal(runtime.composeCalls.length, 1, 'exactly one rewrite call');
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the fragment entered the library');
  assert.equal(profile.list({ side: 'agent' })[0].text, '说话温柔');
  assert.equal(runtime.persona.agent, '你说话温柔，会慢慢接话。', 'the rewrite is written back and saved');
  assert.equal(maintainer.pendingSides().agent, false, 'the side is no longer pending');
  assert.equal(maintainer.status().pending.agent, false);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.composed).length, 1);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).at(-1).payload.side, 'agent');
  console.log(`46) splitCalls=${runtime.splitCalls.length} composeCalls=${runtime.composeCalls.length} entries=${profile.list().length} pending=${maintainer.status().pending.agent} box="${runtime.persona.agent}"`);
});

test('47) 重写失败 → 回退确定性拼接并仍写回，pending=false（不算失败）', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  runtime.composeImpl = () => {
    throw new Error('composer offline');
  };
  const maintainer = make({ boxes: true });
  await maintainer.save({ agent: '说话温柔', user: '' });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the library update still stands');
  assert.match(runtime.persona.agent, /说话温柔/u, 'the source sentence is written back');
  assert.equal(/## /u.test(runtime.persona.agent), false, 'the failed rewrite writes prose, not a compiled section');
  assert.equal(/^[-*·]/mu.test(runtime.persona.agent), false, 'no list marker reaches the box');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.failed).length, 1);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.fallback).length, 1, 'the fallback event is recorded');
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 1, 'the fallback still writes back');
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(maintainer.status().pending.agent, false);
  console.log(`47) ok=${result.ok} fallback=${runtime.persona.agent.split('\n')[0]} entries=${profile.list().length} pending=${maintainer.status().pending.agent} composeFailed=${events(PROFILE_COMPOSE_EVENTS.failed).length}`);
});

test('48) 拆分抛错 → 库与框均不变、pending=true、返回错误', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });
  const entriesBefore = profile.list();
  const snapshotBefore = maintainer.snapshot();
  runtime.splitImpl = () => {
    throw new Error('split model offline');
  };
  // The user pressed 保存 first: the box holds the new text and is pending.
  await maintainer.save({ agent: '说话非常温柔', user: '' });
  const boxBefore = runtime.persona.agent;
  const writesBefore = runtime.writeCalls.length;

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'split-failed');
  assert.match(result.error, /split model offline/u);
  assert.deepEqual(profile.list(), entriesBefore, 'the library is untouched');
  assert.deepEqual(maintainer.snapshot(), snapshotBefore, 'the snapshot is untouched');
  assert.equal(runtime.persona.agent, boxBefore, 'the saved box text is kept verbatim for a retry');
  assert.equal(runtime.writeCalls.length, writesBefore, 'nothing is written back');
  assert.equal(maintainer.pendingSides().agent, true, 'the edit is still pending');
  assert.equal(maintainer.status().pending.agent, true);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0);
  console.log(`48) ok=${result.ok} reason=${result.reason} error="${result.error}" entries=${profile.list().length} box="${runtime.persona.agent}" pending=${maintainer.status().pending.agent}`);
});

test('49) 入库事务抛错 → 库、框、快照都不变、pending=true', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '说话温柔', user: '' });
  const entriesBefore = profile.list();
  const snapshotBefore = maintainer.snapshot();
  await maintainer.save({ agent: '说话非常温柔', user: '' });
  const boxBefore = runtime.persona.agent;
  maintainer.commitSplit = () => {
    throw new Error('db write failed');
  };

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'commit-failed');
  assert.match(result.error, /db write failed/u);
  assert.deepEqual(profile.list(), entriesBefore, 'the library rolled back / is untouched');
  assert.deepEqual(maintainer.snapshot(), snapshotBefore, 'the snapshot is untouched');
  assert.equal(runtime.persona.agent, boxBefore, 'the box keeps the saved pending text');
  assert.equal(maintainer.pendingSides().agent, true);
  console.log(`49) ok=${result.ok} reason=${result.reason} entries=${profile.list().length} snapshotV=${maintainer.snapshot().version} pending=${maintainer.pendingSides().agent}`);
});

test('50) 周期整理仍按增量交流：pending 框不入库，新交流照常提取/写回', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  runtime.composeImpl = ({ side }) => (side === 'agent' ? '你会温柔地说话。' : '用户喜欢热茶。');
  const maintainer = make({ boxes: true });
  await maintainer.save({ agent: '说话温柔', user: '' });
  addMessage('m1', '我更喜欢热茶');
  runtime.candidates = [{ side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m1'] }];

  const result = await maintainer.tick();
  assert.equal(result.ran, true);
  assert.equal(result.reason, 'new-content');
  assert.equal(runtime.splitCalls.length, 0, 'the schedule never splits the pending box');
  assert.equal(profile.list({ side: 'agent' }).length, 0, 'the pending persona text is not imported');
  assert.equal(profile.list({ side: 'user' }).length, 1, 'the new exchange still enters the library');
  assert.equal(maintainer.pendingSides().agent, true, 'the pending box stays pending');
  assert.equal(runtime.persona.agent, '说话温柔', 'the pending box is not overwritten');
  console.log(`50) ran=${result.ran} reason=${result.reason} splitCalls=${runtime.splitCalls.length} agentEntries=${profile.list({ side: 'agent' }).length} userEntries=${profile.list({ side: 'user' }).length} pending=${maintainer.pendingSides().agent}`);
});

// ---- first manual organize: the seeded box is unorganized content, not a synced box -----------

test('51) 首次手动整理：空库 + 框内有内容 + 无交流 → 拆分→入库→重写→写回，不报 no-new-content', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  runtime.composeImpl = ({ side }) => (side === 'agent' ? '你说话温柔，会慢慢接话。' : '');
  // The user's existing persona box on a fresh database: the library is still empty and nothing
  // was saved/organized before, so this click is the round that creates the first entries.
  runtime.persona = { agent: '说话温柔', user: '' };
  const maintainer = make({ boxes: true });
  assert.equal(profile.list().length, 0);
  assert.equal(maintainer.pendingFlags().agent, false, 'a never-saved box has no explicit pending flag');

  const result = await maintainer.now({ trigger: 'settings', writeBack: true });

  assert.equal(result.ok, true);
  assert.equal(result.ran, true, 'the click really organizes');
  assert.equal(result.reason, 'initial', 'the seeded box is reported as the first organize');
  assert.equal(runtime.splitCalls.length, 1, 'the seeded box is split exactly once');
  assert.equal(runtime.composeCalls.length, 1, 'the rewritten prompt is composed exactly once');
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the imported line is the organized entry, not a duplicate');
  assert.equal(profile.list({ side: 'agent' })[0].text, '说话温柔');
  assert.equal(runtime.persona.agent, '你说话温柔，会慢慢接话。', 'the box is rewritten and written back');
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(maintainer.pendingSides().user, false);
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).length, 0, 'an executed round is not reported as skipped');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.composed).length, 1);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).at(-1).payload.side, 'agent');
  console.log(`51) ran=${result.ran} reason=${result.reason} import=${result.import} splitCalls=${runtime.splitCalls.length} composeCalls=${runtime.composeCalls.length} entries=${profile.list().length} pending=${maintainer.pendingSides().agent} box="${runtime.persona.agent}"`);
});

test('52) 首次 + 保存：保存仍只写框、不入库；那次保存也不会被首次整理吞掉', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => [{ text: '说话温柔', category: '说话方式' }];
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const maintainer = make({ boxes: true });

  // 「保存」 on the fresh database writes the box only: no model call, no library row.
  const saved = await maintainer.save({ agent: '说话温柔', user: '' });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.pending, { agent: true, user: false });
  assert.equal(runtime.persona.agent, '说话温柔', 'the box is persisted');
  assert.equal(profile.list().length, 0, 'save never imports the text');
  assert.equal(runtime.splitCalls.length, 0, 'save never calls the splitter');
  assert.equal(runtime.composeCalls.length, 0, 'save never rewrites');
  assert.equal(maintainer.pendingSides().agent, true);
  assert.equal(events(PROFILE_SPLIT_EVENTS.split).length, 0);

  // The save above is the newest user operation: organizing must still import it (box-changed, not
  // a silent no-new-content and not the seed path that would bypass the save's pending flag).
  const organized = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(organized.ok, true);
  assert.equal(organized.ran, true);
  assert.equal(organized.reason, 'box-changed');
  assert.equal(profile.list({ side: 'agent' }).length, 1);
  assert.equal(runtime.persona.agent, '你说话温柔，会慢慢接话。');
  assert.equal(maintainer.pendingSides().agent, false);
  console.log(`52) saved="${'说话温柔'}" entriesAfterSave=0 → ran=${organized.ran} reason=${organized.reason} splitCalls=${runtime.splitCalls.length} composeCalls=${runtime.composeCalls.length} entries=${profile.list().length} pending=${maintainer.pendingSides().agent} box="${runtime.persona.agent}"`);
});

// ---- first organize failure: the seed must stay unorganized for a retry ------------------------

test('53) 首次整理拆分失败 → 返回错误、pending 与 seededButUnorganized 标记都保留', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '说话温柔', user: '' };
  runtime.splitImpl = () => {
    throw new Error('split model offline');
  };
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'split-failed');
  assert.match(result.error, /split model offline/u);
  assert.equal(runtime.splitCalls.length, 1, 'the first organize really attempted the split');
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the seed imported the line before the split');
  assert.equal(runtime.persona.agent, '说话温柔', 'the box is kept verbatim for a retry');
  assert.equal(maintainer.pendingFlags().agent, false, 'the seed writes no explicit save flag');
  assert.equal(maintainer.seededButUnorganizedFlags().agent, true, 'seeded but not organized');
  assert.equal(maintainer.pendingSides().agent, true, 'the unorganized seed stays pending');
  assert.equal(maintainer.status().pending.agent, true);
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0);
  console.log(`53) ok=${result.ok} reason=${result.reason} entries=${profile.list().length} pendingFlags=${maintainer.pendingFlags().agent} seededButUnorganized=${maintainer.seededButUnorganizedFlags().agent} pending=${maintainer.pendingSides().agent}`);
});

test('54) 首次失败后重试（模型恢复）→ 继续拆分/重写/写回，成功后标记与 pending 清零', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '说话温柔', user: '' };
  runtime.splitImpl = () => {
    throw new Error('split model offline');
  };
  const maintainer = make({ boxes: true });
  const failed = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(failed.reason, 'split-failed');
  assert.equal(maintainer.seededButUnorganizedFlags().agent, true);

  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const retried = await maintainer.now({ trigger: 'settings', writeBack: true });

  assert.equal(retried.ok, true);
  assert.equal(retried.ran, true);
  assert.equal(retried.reason, 'initial', 'the retry still reports the first organize');
  assert.equal(runtime.splitCalls.length, 2, 'the retry splits the kept box once');
  assert.equal(runtime.composeCalls.length, 1, 'the retry rewrites the prompt once');
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the seeded line is updated, not duplicated');
  assert.equal(profile.list({ side: 'agent' })[0].text, '说话温柔');
  assert.equal(runtime.persona.agent, '你说话温柔，会慢慢接话。', 'the rewrite is written back');
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(maintainer.pendingFlags().agent, false);
  assert.equal(maintainer.seededButUnorganizedFlags().agent, false);
  console.log(`54) retry.ran=${retried.ran} reason=${retried.reason} splitCalls=${runtime.splitCalls.length} composeCalls=${runtime.composeCalls.length} entries=${profile.list().length} pending=${maintainer.pendingSides().agent} seededButUnorganized=${maintainer.seededButUnorganizedFlags().agent} box="${runtime.persona.agent}"`);
});

test('55) 重启后仍识别“seed 过但未整理”→ 新实例可重试并清除标记', async (t) => {
  const { db, profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '说话温柔', user: '' };
  runtime.splitImpl = () => {
    throw new Error('split model offline');
  };
  const first = make({ boxes: true });
  assert.equal((await first.now({ trigger: 'settings', writeBack: true })).reason, 'split-failed');
  assert.equal(profile.list({ side: 'agent' }).length, 1);

  // A fresh instance over the same database, exactly like an app restart.
  const restarted = make({ boxes: true });
  assert.equal(restarted.seededButUnorganizedFlags().agent, true, 'the marker reloads from state');
  assert.equal(restarted.pendingSides().agent, true);
  assert.equal(restarted.pendingFlags().agent, false, 'no save flag is needed to remember it');
  assert.equal(readPendingSides(db, runtime.persona).agent, true, 'the read-only restart probe sees it too');

  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const retried = await restarted.now({ trigger: 'settings', writeBack: true });
  assert.equal(retried.ran, true);
  assert.equal(retried.reason, 'initial');
  assert.equal(restarted.seededButUnorganizedFlags().agent, false);
  assert.equal(restarted.pendingSides().agent, false);
  assert.equal(readPendingSides(db, runtime.persona).agent, false);
  console.log(`55) restart.marker=${true} retry.ran=${retried.ran} reason=${retried.reason} markerAfter=${restarted.seededButUnorganizedFlags().agent} pending=${restarted.pendingSides().agent} entries=${profile.list().length}`);
});

test('56) 首次整理成功 → 标记清除；再整理无变化 → no-new-content', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '说话温柔', user: '' };
  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const maintainer = make({ boxes: true });

  const first = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(first.ok, true);
  assert.equal(first.ran, true);
  assert.equal(first.reason, 'initial');
  assert.equal(maintainer.seededButUnorganizedFlags().agent, false, 'a successful writeback clears the marker');
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(profile.list({ side: 'agent' }).length, 1);
  const splitCalls = runtime.splitCalls.length;
  const composeCalls = runtime.composeCalls.length;
  const writes = runtime.writeCalls.length;

  const second = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(second.ok, true);
  assert.equal(second.ran, false);
  assert.equal(second.reason, 'no-new-content');
  assert.equal(maintainer.seededButUnorganizedFlags().agent, false);
  assert.equal(maintainer.pendingSides().agent, false);
  assert.equal(runtime.splitCalls.length, splitCalls, 'an unchanged organized box is never re-split');
  assert.equal(runtime.composeCalls.length, composeCalls, 'an unchanged organized box is never rewritten');
  assert.equal(runtime.writeCalls.length, writes, 'an unchanged organized box is never written back');
  assert.equal(events(PROFILE_MAINTAIN_EVENTS.skipped).at(-1).payload.reason, 'no-new-content');
  console.log(`56) first=(ran:${first.ran}, ${first.reason}) marker=${maintainer.seededButUnorganizedFlags().agent} second=(ran:${second.ran}, ${second.reason}) splitCalls=${runtime.splitCalls.length} composeCalls=${runtime.composeCalls.length} pending=${maintainer.pendingSides().agent}`);
});

test('57) 反例：仅 reasoning 无正文 → 重试一次仍空 → EMPTY_TEXT，事件带现场', async (t) => {
  const { profile, make, events } = await fresh(t);
  const reasoning = 'TOP-SECRET-REASONING';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'stop' }],
    [{ type: 'reasoning-delta', text: reasoning }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  await assert.rejects(
    () => maintainer.splitWithModel({ side: 'agent', text: '说话温柔' }),
    (error) => {
      assert.equal(error.code, 'EMPTY_TEXT');
      assert.match(error.message, /EMPTY_TEXT/u);
      assert.deepEqual(error.details, {
        finish: 'stop',
        chunks: 2,
        textChars: 0,
        reasoningChars: reasoning.length,
        model: 'test-model',
        provider: 'test-provider',
      });
      assert.ok(!error.message.includes(reasoning), 'the error never carries reasoning/body text');
      return true;
    },
  );
  assert.equal(profile.list().length, 0, 'an empty split writes nothing');
  assert.equal(model.calls.length, 2, 'one retry, exactly');
  assert.equal(model.calls[0].maxTokens, 4096, 'the default budget is 4096');
  assert.equal(model.calls[1].maxTokens, 8192, 'the retry raises the ceiling (doubled)');
  assert.match(model.calls[1].system, /严格模式/u);
  assert.match(model.calls[1].system, /不要解释/u);

  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 2, 'each empty attempt reports its own scene');
  for (const event of empty) {
    assert.deepEqual(event.payload, {
      phase: 'split',
      finish: 'stop',
      textChars: 0,
      reasoningChars: reasoning.length,
    });
    assert.ok(!JSON.stringify(event).includes(reasoning), 'the event carries no body text');
  }
  console.log(`57) code=EMPTY_TEXT finish=${empty.at(-1).payload.finish} textChars=${empty.at(-1).payload.textChars} reasoningChars=${empty.at(-1).payload.reasoningChars} calls=${model.calls.length} retries=${model.calls.length - 1} emptyEvents=${empty.length}`);
});

test('58) 空文本重试成功（第二次合法 JSON）→ 正常入库', async (t) => {
  const { profile, make, events } = await fresh(t);
  const json = '{"entries":[{"text":"你说话温柔一点","category":"说话方式"}]}';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: '想了很多但没有输出' }, { type: 'finish', reason: 'stop' }],
    [{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const result = await maintainer.split({ agent: '说话温柔' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  const entries = profile.list({ side: 'agent' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '你说话温柔一点');
  assert.equal(model.calls.length, 2, 'the retried answer is accepted without a third call');
  assert.ok(model.calls[1].maxTokens > model.calls[0].maxTokens);
  assert.match(model.calls[1].system, /只输出 JSON，不要解释、不要推理过程/u);
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 1, 'only the first attempt was empty');
  console.log(`58) added=${result.added} text="${entries[0].text}" calls=${model.calls.length} retries=${model.calls.length - 1} maxTokens1=${model.calls[0].maxTokens} maxTokens2=${model.calls[1].maxTokens} emptyEvents=${empty.length}`);
});

test('59) 正文在 delta 字段 → 正确收集（不漏文本）', async (t) => {
  const { profile, make } = await fresh(t);
  const model = scriptedModel([[
    { type: 'text-delta', delta: '{"entries":[{"text":"你说话' },
    { type: 'text-delta', delta: '温柔一点","category":"说话方式"}]}' },
    { type: 'finish', reason: 'stop' },
  ]]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const result = await maintainer.split({ agent: '说话温柔' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  const entries = profile.list({ side: 'agent' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '你说话温柔一点');
  assert.equal(model.calls.length, 1, 'a delta answer needs no retry');
  console.log(`59) text="${entries[0].text}" calls=${model.calls.length} added=${result.added}`);
});

test('60) 正常一次成功 → 不重试', async (t) => {
  const { profile, make, events } = await fresh(t);
  const json = '{"entries":[{"text":"你说话慢一点","category":"说话方式"}]}';
  // Split across two different body fields: a content block, then a text delta.
  const model = scriptedModel([[
    { type: 'content-delta', content: [{ type: 'text', text: json.slice(0, 18) }] },
    { type: 'text-delta', text: json.slice(18) },
    { type: 'finish', reason: 'stop' },
  ]]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const result = await maintainer.split({ agent: '说话慢一点' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(profile.list({ side: 'agent' })[0].text, '你说话慢一点');
  assert.equal(model.calls.length, 1);
  assert.equal(events(PROFILE_MODEL_EVENTS.empty).length, 0);
  console.log(`60) added=${result.added} calls=${model.calls.length} retries=0 emptyEvents=0`);
});

test('61) 事件字段正确（无正文内容）', async (t) => {
  const { make, events } = await fresh(t);
  const reasoning = 'HIDDEN-COMPOSE-REASONING';
  const model = scriptedModel([
    [{ type: 'reasoning', content: reasoning }, { type: 'finish', finishReason: 'stop' }],
    [{ type: 'reasoning', content: reasoning }, { type: 'finish', finishReason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  await assert.rejects(
    () => maintainer.composeWithModel({
      side: 'agent',
      entries: [{ text: '你说话温柔', category: '说话方式' }],
      tone: '',
      maxChars: 600,
    }),
    (error) => {
      assert.equal(error.code, 'EMPTY_TEXT');
      assert.equal(error.details.finish, 'stop');
      assert.equal(error.details.textChars, 0);
      assert.equal(error.details.reasoningChars, reasoning.length);
      assert.ok(!error.message.includes(reasoning));
      return true;
    },
  );
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 2);
  for (const event of empty) {
    assert.deepEqual(Object.keys(event.payload).sort(), ['finish', 'phase', 'reasoningChars', 'textChars']);
    assert.deepEqual(event.payload, {
      phase: 'compose',
      finish: 'stop',
      textChars: 0,
      reasoningChars: reasoning.length,
    });
    assert.ok(!JSON.stringify(event).includes(reasoning), 'no body text is written to the event');
  }
  assert.match(model.calls[1].system, /只输出最终正文/u);
  console.log(`61) phase=${empty[0].payload.phase} finish=${empty[0].payload.finish} textChars=${empty[0].payload.textChars} reasoningChars=${empty[0].payload.reasoningChars} keys=${Object.keys(empty[0].payload).join(',')} calls=${model.calls.length}`);
});

test('62) 其它失败路径：split.failed 也带 finish 与字符数', async (t) => {
  const { make, events } = await fresh(t);
  const reasoning = 'ONLY-REASONING';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'stop' }],
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const result = await maintainer.split({ agent: '说话温柔' });
  assert.equal(result.ok, false);
  assert.match(result.error, /EMPTY_TEXT/u);
  const failed = events(PROFILE_SPLIT_EVENTS.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.finish, 'stop');
  assert.equal(failed[0].payload.textChars, 0);
  assert.equal(failed[0].payload.reasoningChars, reasoning.length);
  assert.ok(!JSON.stringify(failed[0]).includes(reasoning));
  console.log(`62) ok=${result.ok} failedEvent.finish=${failed[0].payload.finish} textChars=${failed[0].payload.textChars} reasoningChars=${failed[0].payload.reasoningChars}`);
});

test('63) persona 问卷首次空回答 → 重试收到正文规则（不是 JSON）→ 成功返回人设正文', async (t) => {
  const { make, events } = await fresh(t);
  const draft = '你会在对方低落时先接住情绪，再给出具体、可信的鼓励。';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: '只推理没输出' }, { type: 'finish', reason: 'stop' }],
    [{ type: 'text-delta', text: draft }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({
    boxes: true,
    getSelection: () => model.service,
    getLlm: () => model.llm,
  });

  const result = await maintainer.generatePersonaQuiz({ answers: [{ id: 'encourage', text: '先抱抱我。' }] });
  assert.equal(result.ok, true, 'the retried answer is accepted');
  assert.equal(result.draft, draft, 'the plain persona body is the draft, not JSON');
  assert.equal(model.calls.length, 2, 'exactly one retry');
  assert.equal(model.calls[0].system.includes('严格模式'), false, 'the first attempt carries no strict rule');
  assert.match(model.calls[1].system, /只输出最终正文/u);
  assert.doesNotMatch(model.calls[1].system, /只输出 JSON/u);
  assert.ok(model.calls[1].maxTokens > model.calls[0].maxTokens);
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 1, 'only the first attempt was empty');
  assert.equal(empty[0].payload.phase, 'persona');
  console.log(`63) ok=${result.ok} draftChars=${result.draft.length} calls=${model.calls.length} retryHasBodyRule=${/只输出最终正文/u.test(model.calls[1].system)} retryHasJsonRule=${/只输出 JSON/u.test(model.calls[1].system)} emptyPhase=${empty[0].payload.phase}`);
});

test('64) compose 首次空 → 重试仍为正文规则（回归）', async (t) => {
  const { make } = await fresh(t);
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: '想了很多但没有输出' }, { type: 'finish', reason: 'stop' }],
    [{ type: 'text-delta', text: '你会先听我说完，再给建议。' }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const text = await maintainer.composeWithModel({
    side: 'agent',
    entries: [{ text: '先听完再说', category: '相处方式' }],
    tone: '',
    maxChars: 600,
  });
  assert.equal(text, '你会先听我说完，再给建议。');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].system, /只输出最终正文/u);
  assert.doesNotMatch(model.calls[1].system, /只输出 JSON/u);
  console.log(`64) text="${text}" calls=${model.calls.length} retryHasBodyRule=${/只输出最终正文/u.test(model.calls[1].system)}`);
});

test('65) split（JSON 类）首次空 → 重试仍要求 JSON（回归）', async (t) => {
  const { make } = await fresh(t);
  const json = '{"entries":[{"text":"你说话温柔一点","category":"说话方式"}]}';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: '想了很多但没有输出' }, { type: 'finish', reason: 'stop' }],
    [{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const entries = await maintainer.splitWithModel({ side: 'agent', text: '说话温柔' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '你说话温柔一点');
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].system, /只输出 JSON/u);
  assert.doesNotMatch(model.calls[1].system, /只输出最终正文/u);
  console.log(`65) entries=${entries.length} text="${entries[0].text}" calls=${model.calls.length} retryHasJsonRule=${/只输出 JSON/u.test(model.calls[1].system)} retryHasBodyRule=${/只输出最终正文/u.test(model.calls[1].system)}`);
});

test('66) 重试仍空 → EMPTY_TEXT + 事件（persona 侧，回归）', async (t) => {
  const { make, events } = await fresh(t);
  const reasoning = 'HIDDEN-PERSONA-REASONING';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'stop' }],
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({
    boxes: true,
    getSelection: () => model.service,
    getLlm: () => model.llm,
  });

  const result = await maintainer.generatePersonaQuiz({ answers: [{ id: 'quiet', text: '安静陪着就好。' }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /EMPTY_TEXT/u);
  assert.ok(!String(result.error).includes(reasoning), 'the error never carries reasoning text');
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 2, 'each empty attempt reports its own scene');
  for (const event of empty) {
    assert.equal(event.payload.phase, 'persona');
    assert.equal(event.payload.textChars, 0);
    assert.equal(event.payload.reasoningChars, reasoning.length);
    assert.ok(!JSON.stringify(event).includes(reasoning));
  }
  assert.equal(maintainer.personaQuizDraft(), null, 'an empty answer never stores a draft');
  console.log(`66) ok=${result.ok} error=EMPTY_TEXT calls=${model.calls.length} emptyEvents=${empty.length} emptyPhase=${empty[0].payload.phase}`);
});

test('67) 反例：首次 max-tokens 截断（只有 reasoning）→ 重试预算 ≥8192、要求直接给结果 → 第二次成功', async (t) => {
  const { make, events } = await fresh(t);
  // The exact scene the user reported: the whole budget went into reasoning, no body at all.
  const reasoning = 'R'.repeat(11064);
  const json = '{"entries":[{"text":"你说话温柔一点","category":"说话方式"}]}';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'max-tokens' }],
    [{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const entries = await maintainer.splitWithModel({ side: 'agent', text: '说话温柔' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '你说话温柔一点');
  assert.equal(model.calls.length, 2, 'exactly one retry, never a third call');
  assert.equal(model.calls[0].maxTokens, PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS, 'the first attempt uses the default 4096');
  assert.ok(model.calls[1].maxTokens >= 8192, 'the truncated retry raises the budget significantly');
  assert.ok(model.calls[1].maxTokens > model.calls[0].maxTokens);
  assert.match(model.calls[1].system, /直接给出结果/u);
  assert.match(model.calls[1].system, /不要输出推理过程/u);
  assert.match(model.calls[1].system, /只输出 JSON/u, 'a JSON phase still asks for JSON');
  assert.doesNotMatch(model.calls[1].system, /只输出最终正文/u);
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 1, 'only the first attempt was empty');
  assert.equal(empty[0].payload.finish, 'max-tokens');
  assert.equal(empty[0].payload.reasoningChars, reasoning.length);
  console.log(`67) added=${entries.length} text="${entries[0].text}" calls=${model.calls.length} maxTokens1=${model.calls[0].maxTokens} maxTokens2=${model.calls[1].maxTokens} retryHasDirect=${/直接给出结果/u.test(model.calls[1].system)} retryHasNoReasoning=${/不要输出推理过程/u.test(model.calls[1].system)} emptyEvents=${empty.length}`);
});

test('68) 回归：首次正常返回 → 不重试，maxTokens 保持默认/配置值', async (t) => {
  const { profile, make, events } = await fresh(t);
  const json = '{"entries":[{"text":"你说话慢一点","category":"说话方式"}]}';
  const model = scriptedModel([[{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }]]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  await maintainer.split({ agent: '说话慢一点' });
  assert.equal(model.calls.length, 1, 'a normal answer is never retried');
  assert.equal(model.calls[0].maxTokens, 4096);
  assert.equal(PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS, 4096);
  assert.equal(events(PROFILE_MODEL_EVENTS.empty).length, 0);
  assert.equal(events(PROFILE_MODEL_EVENTS.retry).length, 0);

  // Still configurable: an explicit budget wins over the default and is not raised on success.
  const custom = scriptedModel([[{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }]]);
  const customMaintainer = make({
    config: { maxTokens: 2048 },
    getSelection: () => custom.service,
    getLlm: () => custom.llm,
  });
  await customMaintainer.split({ agent: '说话慢一点' });
  assert.equal(custom.calls.length, 1);
  assert.equal(custom.calls[0].maxTokens, 2048, 'the configured budget is respected');
  assert.equal(profile.list().length, 1, 'the same line is not duplicated');
  console.log(`68) defaultMaxTokens=${PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS} maxTokens=${model.calls[0].maxTokens} calls=${model.calls.length} retries=0 configured=${custom.calls[0].maxTokens}`);
});

test('69) 回归：重试仍 max-tokens 且正文为空 → EMPTY_TEXT + details，最多一次重试', async (t) => {
  const { make, events } = await fresh(t);
  const reasoning = 'S'.repeat(11064);
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'max-tokens' }],
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'max-tokens' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  await assert.rejects(
    () => maintainer.splitWithModel({ side: 'agent', text: '说话温柔' }),
    (error) => {
      assert.equal(error.code, 'EMPTY_TEXT');
      assert.match(error.message, /EMPTY_TEXT/u);
      assert.deepEqual(error.details, {
        finish: 'max-tokens',
        chunks: 2,
        textChars: 0,
        reasoningChars: reasoning.length,
        model: 'test-model',
        provider: 'test-provider',
      });
      assert.ok(!error.message.includes(reasoning), 'the error never carries reasoning text');
      return true;
    },
  );
  assert.equal(model.calls.length, 2, 'one retry only, no third attempt');
  assert.equal(model.calls[1].maxTokens, 16384);
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 2, 'each empty attempt reports its own scene');
  assert.equal(empty[1].payload.finish, 'max-tokens');
  assert.equal(empty[1].payload.textChars, 0);
  assert.equal(empty[1].payload.reasoningChars, reasoning.length);
  for (const event of empty) assert.ok(!JSON.stringify(event).includes(reasoning));
  console.log(`69) code=EMPTY_TEXT finish=${empty[1].payload.finish} textChars=${empty[1].payload.textChars} reasoningChars=${empty[1].payload.reasoningChars} calls=${model.calls.length} maxTokens2=${model.calls[1].maxTokens}`);
});

test('70) profile.model.retry 事件字段正确（max-tokens 场景，正文阶段仍走正文规则）', async (t) => {
  const { make, events } = await fresh(t);
  const reasoning = 'HIDDEN-TRUNCATED-REASONING';
  const model = scriptedModel([
    [{ type: 'reasoning-delta', delta: reasoning }, { type: 'finish', reason: 'max-tokens' }],
    [{ type: 'text-delta', text: '你会先听我说完，再给建议。' }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ getSelection: () => model.service, getLlm: () => model.llm });

  const text = await maintainer.composeWithModel({
    side: 'agent',
    entries: [{ text: '先听完再说', category: '相处方式' }],
    tone: '',
    maxChars: 600,
  });
  assert.equal(text, '你会先听我说完，再给建议。');
  const retry = events(PROFILE_MODEL_EVENTS.retry);
  assert.equal(retry.length, 1, 'the retry is logged exactly once');
  assert.deepEqual(retry[0].payload, {
    phase: 'compose',
    reason: 'max-tokens',
    from: 4096,
    to: 16384,
  });
  assert.ok(!JSON.stringify(retry[0]).includes(reasoning), 'the event carries no body text');
  assert.match(model.calls[1].system, /只输出最终正文/u, 'BODY_PHASES keeps the body rule');
  assert.doesNotMatch(model.calls[1].system, /只输出 JSON/u);
  assert.match(model.calls[1].system, /不要输出推理过程/u);
  assert.equal(events(PROFILE_MODEL_EVENTS.empty).length, 1);
  console.log(`70) retryEvent=${JSON.stringify(retry[0].payload)} bodyRule=${/只输出最终正文/u.test(model.calls[1].system)} calls=${model.calls.length}`);
});

// ---- 分侧按语义，不按输入框 ---------------------------------------------------------------
// The organizer reads BOTH boxes in one request and the model decides every fragment's side:
// 「用户喜欢某个角色的表现方式」 is persona material (agent/人设参考), while 「用户自己的喜好、习惯、
// 经历」 is user material. A fragment routed to the other side is MOVED — removed from the source
// box and written into the target box — never kept on both sides.

test('71) 拆分 prompt：一次读两个框、按语义定 side、带上分类栈', () => {
  const prompt = buildSplitPrompt({
    agent: '你说话温柔',
    user: '用户喜欢温婉可爱的角色',
    categories: [{ name: '人设参考', parent: 'agent', description: '可借鉴的角色设定' }],
  });
  assert.match(prompt, /助手人设框：\n你说话温柔/u, 'the persona box is in the same request');
  assert.match(prompt, /用户画像框：\n用户喜欢温婉可爱的角色/u, 'the profile box is in the same request');
  assert.match(prompt, /「用户喜欢温婉可爱的角色」→ side=agent/u, 'the semantic routing rule is explicit');
  assert.match(prompt, /用户自身的事实、习惯、经历/u);
  assert.match(prompt, /不得改写成「你不要…」这类助手规则/u, 'a self-description is never turned into a rule');
  assert.match(prompt, /不得两侧重复保留/u);
  assert.match(prompt, /\[agent\] 人设参考：可借鉴的角色设定/u, 'the category stack is offered for reuse');
  assert.match(prompt, /"side":"agent\|user"/u);
  assert.match(prompt, /不要输出分数/u);
  console.log(`71) promptChars=${prompt.length} hasAgentBox=${/助手人设框/u.test(prompt)} hasUserBox=${/用户画像框/u.test(prompt)} hasCategoryStack=${/\[agent\] 人设参考/u.test(prompt)}`);
});

test('72) 画像里的「用户喜欢温婉可爱的角色」→ 人设侧·人设参考，画像框不再保留', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢温婉可爱的角色' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢温婉可爱的角色', side: 'agent', from: 'user', category: '人设参考' }],
  });
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  const agentEntries = profile.list({ side: 'agent' });
  assert.equal(agentEntries.length, 1, 'the fragment is on the agent side');
  assert.equal(agentEntries[0].side, 'agent');
  assert.equal(agentEntries[0].category, '人设参考', 'category = 人设参考');
  assert.match(agentEntries[0].text, /^你/u, '口吻「你……」');
  assert.equal(profile.list({ side: 'user' }).length, 0, 'not kept on the user side too');
  assert.equal(runtime.persona.user.includes('温婉'), false, 'the 画像 box no longer contains it');
  assert.match(runtime.persona.agent, /你喜欢温婉可爱的角色/u, 'the 人设 box carries it in the persona voice');
  console.log(`72) agent="${agentEntries[0].text}" category=${agentEntries[0].category} userEntries=${profile.list({ side: 'user' }).length} userBox="${runtime.persona.user}" agentBox="${runtime.persona.agent}"`);
});

test('73) 画像里的「用户喜欢喝无糖茶」→ 仍在 user 侧、分类 饮食', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  // The compose step is what writes the box in the side's voice: 「用户……」 for the profile.
  runtime.composeImpl = ({ side, entries }) => (side === 'user'
    ? `用户${entries.map((entry) => entry.text).join('，')}。`
    : '');
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const userEntries = profile.list({ side: 'user' });
  assert.equal(userEntries.length, 1);
  assert.equal(userEntries[0].side, 'user');
  assert.equal(userEntries[0].category, '饮食');
  assert.equal(profile.list({ side: 'agent' }).length, 0, 'nothing moved to the persona side');
  assert.doesNotMatch(userEntries[0].text, /[我咱们]/u, 'no first person on the user side');
  assert.match(runtime.persona.user, /^用户喜欢喝无糖茶。$/u, 'the 画像 box keeps the 「用户……」 voice');
  console.log(`73) user="${userEntries[0].text}" category=${userEntries[0].category} agentEntries=${profile.list({ side: 'agent' }).length} userBox="${runtime.persona.user}"`);
});

test('74) 人设框里的「不要一下子说太多」→ 仍在 agent 侧（相处方式）', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '不要一下子说太多', user: '' };
  runtime.splitImpl = () => ({
    entries: [{ text: '不要一下子说太多', side: 'agent', from: 'agent', category: '相处方式' }],
  });
  const maintainer = make({ boxes: true });

  await maintainer.now({ trigger: 'settings' });
  const agentEntries = profile.list({ side: 'agent' });
  assert.equal(agentEntries.length, 1);
  assert.equal(agentEntries[0].side, 'agent');
  assert.equal(agentEntries[0].category, '相处方式');
  assert.equal(profile.list({ side: 'user' }).length, 0);
  assert.equal(runtime.persona.agent, '不要一下子说太多。', 'the single source sentence is completed, never left as a fragment');
  console.log(`74) agent="${agentEntries[0].text}" category=${agentEntries[0].category} userEntries=${profile.list({ side: 'user' }).length} box="${runtime.persona.agent}"`);
});

test('75) 两侧混合多条 → 各自归位、互不重复、口吻正确', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = {
    agent: '你说话温柔\n不要一下子说太多',
    user: '用户喜欢喝无糖茶\n用户喜欢温婉可爱的角色',
  };
  runtime.splitImpl = () => ({
    entries: [
      { text: '你说话温柔', side: 'agent', from: 'agent', category: '说话方式' },
      { text: '不要一下子说太多', side: 'agent', from: 'agent', category: '相处方式' },
      { text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' },
      { text: '用户喜欢温婉可爱的角色', side: 'agent', from: 'user', category: '人设参考' },
    ],
  });
  runtime.composeImpl = ({ side, entries }) => (side === 'user'
    ? `用户${entries.map((entry) => entry.text).join('，')}。`
    : entries.map((entry) => entry.text).join('；'));
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const agentTexts = profile.list({ side: 'agent' }).map((entry) => entry.text).sort();
  const userTexts = profile.list({ side: 'user' }).map((entry) => entry.text).sort();
  assert.deepEqual(agentTexts, ['你喜欢温婉可爱的角色', '不要一下子说太多', '你说话温柔'].sort());
  assert.deepEqual(userTexts, ['喜欢喝无糖茶']);
  for (const text of agentTexts) assert.equal(userTexts.includes(text), false, 'no fragment is kept on both sides');
  assert.doesNotMatch(userTexts[0], /[我咱们]/u, 'the profile side keeps no first person');
  assert.match(runtime.persona.agent, /你喜欢温婉可爱的角色/u);
  assert.equal(runtime.persona.user.includes('温婉'), false, 'the moved line left the 画像 box');
  assert.match(runtime.persona.user, /^用户喜欢喝无糖茶。$/u, 'the 画像 box keeps the 「用户……」 voice');
  assert.match(runtime.persona.agent, /^你/u, 'the 人设 box keeps the 「你……」 voice');
  assert.equal(result.split.moves.length, 1, 'exactly one cross-side move');
  console.log(`75) agent=[${agentTexts.join(' | ')}] user=[${userTexts.join(' | ')}] moves=${result.split.moves.length} agentBox="${runtime.persona.agent}" userBox="${runtime.persona.user}"`);
});

test('76) 修订记录：moved/fromSide/toSide 可追溯', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢温婉可爱的角色' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢温婉可爱的角色', side: 'agent', from: 'user', category: '人设参考' }],
  });
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  const expected = {
    text: '你喜欢温婉可爱的角色',
    category: '人设参考',
    fromSide: 'user',
    toSide: 'agent',
    moved: true,
  };
  assert.deepEqual(result.split.moves, [expected]);
  const moved = events(PROFILE_SPLIT_EVENTS.moved);
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].payload, expected, 'the move is written to the revision log');
  console.log(`76) moved=${JSON.stringify(moved[0].payload)} event=${PROFILE_SPLIT_EVENTS.moved}`);
});

test('77) 拆分失败 → 两个框、条目、快照、分类栈都不变（不留半成品）', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  const maintainer = make({ boxes: true });
  assert.equal((await maintainer.now({ trigger: 'settings' })).ok, true);
  const before = {
    entries: profile.list(),
    snapshot: maintainer.snapshot(),
    categories: maintainer.categories(),
    writes: runtime.writeCalls.length,
  };

  runtime.persona = { ...runtime.persona, user: '用户喜欢温婉可爱的角色' };
  const edited = { ...runtime.persona };
  runtime.splitImpl = () => {
    throw new Error('split model offline');
  };
  const result = await maintainer.now({ trigger: 'settings' });

  assert.equal(result.ok, false);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'split-failed');
  assert.deepEqual(profile.list(), before.entries, 'the library is untouched');
  assert.deepEqual(maintainer.snapshot(), before.snapshot, 'the snapshot is untouched');
  assert.deepEqual(runtime.persona, edited, 'both boxes keep the user edit verbatim');
  assert.deepEqual(maintainer.categories(), before.categories, 'no half-applied category change');
  assert.equal(runtime.writeCalls.length, before.writes, 'nothing is written back');
  assert.equal(maintainer.pendingSides().user, true, 'the edit is still pending for a retry');
  console.log(`77) ok=${result.ok} reason=${result.reason} entries=${profile.list().length} categories=${maintainer.categories().length} userBox="${runtime.persona.user}" pending=${maintainer.pendingSides().user}`);
});

// ---- 分类栈：模型可增删改，宿主校验 --------------------------------------------------------

test('78) 分类栈·复用：匹配现有分类 → 分类总数不变', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '说话方式' }],
    categories: [],
  });
  const maintainer = make({ boxes: true });
  const before = maintainer.categories().length;
  const result = await maintainer.split({ agent: '你说话温柔' });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(maintainer.categories().length, before, 'no new category is created');
  assert.equal(profile.list()[0].category, '说话方式');
  assert.equal(events(PROFILE_CATEGORY_EVENTS.added).length, 0);
  console.log(`78) categories=${maintainer.categories().length} entryCategory=${profile.list()[0].category} addedEvents=${events(PROFILE_CATEGORY_EVENTS.added).length}`);
});

test('79) 分类栈·新增：没有合适分类 → 新增 1 个（parent 正确、source=model）', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你偶尔会戴眼镜', side: 'agent', from: 'agent', category: '外观细节' }],
    categories: [{ op: 'add', name: '外观细节', parent: 'agent', description: '助手的外在细节' }],
  });
  const maintainer = make({ boxes: true });
  const before = maintainer.categories().length;
  const result = await maintainer.split({ agent: '你偶尔会戴眼镜' });

  assert.equal(result.ok, true);
  const after = maintainer.categories();
  assert.equal(after.length, before + 1, 'exactly one category was added');
  const added = after.find((row) => row.name === '外观细节');
  assert.equal(added.parent, 'agent');
  assert.equal(added.source, 'model');
  assert.equal(profile.list()[0].category, '外观细节', 'the entry lands on the new category');
  const event = events(PROFILE_CATEGORY_EVENTS.added).at(-1);
  assert.deepEqual(event.payload, { name: '外观细节', parent: 'agent', source: 'model' });
  console.log(`79) before=${before} after=${after.length} added=${added.name}/${added.parent}/${added.source} entryCategory=${profile.list()[0].category} event=${JSON.stringify(event.payload)}`);
});

test('80) 分类栈·拒绝：重名/非法 parent/超长 → 记事件，条目回退到现有分类且不丢', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '不存在的分类' }],
    categories: [
      { op: 'add', name: '说话方式', parent: 'agent' },
      { op: 'add', name: '怪分类', parent: 'mid' },
      { op: 'add', name: '一个特别特别特别特别长的分类名称超过二十字', parent: 'agent' },
    ],
  });
  const maintainer = make({ boxes: true });
  const before = maintainer.categories().length;
  const result = await maintainer.split({ agent: '你说话温柔' });

  assert.equal(result.ok, true);
  assert.equal(result.added, 1, 'the entry is never dropped');
  assert.equal(maintainer.categories().length, before, 'no invalid category is written');
  const entry = profile.list()[0];
  const names = maintainer.categories().map((row) => row.name);
  assert.ok(names.includes(entry.category), 'the entry still lands on an existing category');
  const reasons = events(PROFILE_CATEGORY_EVENTS.rejected).map((event) => event.payload.reason);
  for (const reason of ['duplicate', 'invalid-parent', 'invalid-name', 'category-fallback']) {
    assert.ok(reasons.includes(reason), `rejected: ${reason}`);
  }
  console.log(`80) entries=${profile.list().length} entryCategory=${entry.category} reasons=${reasons.join(',')} categories=${maintainer.categories().length}`);
});

test('81) 分类栈·删除仍有引用的分类 → 拒绝并记事件', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  profile.upsert({ side: 'agent', category: '人设参考', text: '妹系美少女角色' });
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '说话方式' }],
    categories: [{ op: 'delete', name: '人设参考' }],
  });
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '你说话温柔' });

  assert.ok(maintainer.categories().some((row) => row.name === '人设参考'), 'a referenced category is kept');
  const rejected = events(PROFILE_CATEGORY_EVENTS.rejected).map((event) => event.payload);
  assert.ok(rejected.some((payload) => payload.reason === 'in-use' && payload.name === '人设参考'));
  console.log(`81) kept=${maintainer.categories().some((row) => row.name === '人设参考')} rejected=${JSON.stringify(rejected.find((payload) => payload.reason === 'in-use'))}`);
});

test('82) 分类栈·删除无引用的分类 → 成功', async (t) => {
  const { runtime, make, events } = await fresh(t);
  assert.ok(make({ boxes: true }).categories().some((row) => row.name === '形象'));
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '说话方式' }],
    categories: [{ op: 'delete', name: '形象' }],
  });
  const maintainer = make({ boxes: true });
  const result = await maintainer.split({ agent: '你说话温柔' });

  assert.equal(result.ok, true);
  assert.equal(maintainer.categories().some((row) => row.name === '形象'), false, 'the unused category is gone');
  const updated = events(PROFILE_CATEGORY_EVENTS.updated).at(-1);
  assert.deepEqual(updated.payload, { name: '形象', op: 'delete' });
  console.log(`82) 形象Exists=${maintainer.categories().some((row) => row.name === '形象')} event=${JSON.stringify(updated.payload)}`);
});

test('83) 分类栈·大小写/空格差异视为同一分类', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '说话 方式' }],
    categories: [{ op: 'add', name: ' 说话方式 ', parent: 'agent' }],
  });
  const maintainer = make({ boxes: true });
  const before = maintainer.categories().length;
  await maintainer.split({ agent: '你说话温柔' });

  assert.equal(maintainer.categories().length, before, 'no duplicate category');
  assert.equal(profile.list()[0].category, '说话方式', 'the stored spelling is reused');
  assert.ok(events(PROFILE_CATEGORY_EVENTS.rejected).some((event) => event.payload.reason === 'duplicate'));
  console.log(`83) categories=${maintainer.categories().length} entryCategory=${profile.list()[0].category} duplicateRejected=${events(PROFILE_CATEGORY_EVENTS.rejected).some((event) => event.payload.reason === 'duplicate')}`);
});

test('84) 分类栈·重启后保留（含模型新增的分类）', async (t) => {
  const { runtime, make } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你偶尔会戴眼镜', side: 'agent', from: 'agent', category: '外观细节' }],
    categories: [{ op: 'add', name: '外观细节', parent: 'agent', description: '助手的外在细节' }],
  });
  const first = make({ boxes: true });
  await first.split({ agent: '你偶尔会戴眼镜' });
  const before = first.categories().map((row) => `${row.name}:${row.parent}:${row.source}`);

  const restarted = make({ boxes: true });
  const after = restarted.categories().map((row) => `${row.name}:${row.parent}:${row.source}`);
  assert.deepEqual(after, before, 'the stack survives a restart');
  const added = restarted.categories().find((row) => row.name === '外观细节');
  assert.equal(added.source, 'model');
  console.log(`84) categories=${after.length} restored=${after.includes('外观细节:agent:model')} source=${added.source}`);
});

test('85) 状态暴露分类栈：status().categories = [{name, parent, count}]', async (t) => {
  const { runtime, make } = await fresh(t);
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔', side: 'agent', from: 'agent', category: '说话方式' }],
  });
  const maintainer = make({ boxes: true });
  await maintainer.split({ agent: '你说话温柔' });

  const status = maintainer.status();
  assert.ok(Array.isArray(status.categories));
  assert.equal(status.categories.length, 8, 'the presets are all there');
  const speaking = status.categories.find((row) => row.name === '说话方式');
  assert.deepEqual(speaking, { name: '说话方式', parent: 'agent', count: 1 });
  const diet = status.categories.find((row) => row.name === '饮食');
  assert.deepEqual(diet, { name: '饮食', parent: 'user', count: 0 });
  console.log(`85) categories=${status.categories.length} 说话方式=${JSON.stringify(speaking)} 饮食=${JSON.stringify(diet)}`);
});

test('86) 写回只重写发生变化的侧：未变的人设框保持原文、不再调用重写', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '你说话温柔', user: '' };
  runtime.splitImpl = splitEcho;
  const maintainer = make({ boxes: true });
  assert.equal((await maintainer.now({ trigger: 'settings' })).ok, true);
  const agentBox = runtime.persona.agent;
  const agentComposeCalls = runtime.composeCalls.filter((call) => call.side === 'agent').length;
  const writebacks = events(PROFILE_WRITEBACK_EVENT).length;
  assert.equal(profile.list({ side: 'agent' }).length, 1);

  // Only the profile box changes: the persona box is not pending and no fragment moved into it.
  runtime.persona = { ...runtime.persona, user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  const result = await maintainer.now({ trigger: 'settings' });

  assert.equal(result.ok, true);
  assert.equal(runtime.persona.agent, agentBox, 'the unchanged 人设 box keeps its original text');
  assert.equal(
    runtime.composeCalls.filter((call) => call.side === 'agent').length,
    agentComposeCalls,
    'the unchanged side is never rewritten',
  );
  const writtenSides = events(PROFILE_WRITEBACK_EVENT).slice(writebacks).map((event) => event.payload.side);
  assert.deepEqual(writtenSides, ['user'], 'only the changed side is written back');
  assert.equal(profile.list({ side: 'agent' }).length, 1, 'the persona side keeps its entry');
  console.log(`86) writtenSides=${writtenSides.join(',')} agentBox="${runtime.persona.agent}" agentComposeCalls=${agentComposeCalls} userBox="${runtime.persona.user}"`);
});

// ---- 先判完成状态，再判正文：半截正文不是成功 ---------------------------------------------
// The reported counterexample: 「你会保持温柔，但遇到」 with finish=max-tokens was returned as
// success because only the body was checked. Completion status must be checked FIRST.

test('87) 反例：正文非空 + finish max-tokens → 未完成并重试；重试 stop → 正常返回', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  const partial = '你会保持温柔，但遇到';
  const full = '你会保持温柔，但遇到分歧时会先听完再表达。';
  const model = scriptedModel([
    [{ type: 'text-delta', text: partial }, { type: 'finish', reason: 'max-tokens' }],
    [{ type: 'text-delta', text: full }, { type: 'finish', reason: 'stop' }],
  ]);
  const maintainer = make({ boxes: true, getSelection: () => model.service, getLlm: () => model.llm });

  const text = await maintainer.composeWithModel({
    side: 'agent',
    entries: [{ text: '先听完再表达', category: '相处方式' }],
    tone: '',
    maxChars: 600,
  });
  assert.equal(text, full, 'only the completed retry body is returned');
  assert.equal(model.calls.length, 2, 'a non-empty truncated answer triggers exactly one retry');
  assert.equal(model.calls[0].maxTokens, PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS);
  assert.ok(model.calls[1].maxTokens >= 8192, 'the truncated retry raises the budget');
  assert.ok(model.calls[1].maxTokens > model.calls[0].maxTokens);
  assert.match(model.calls[1].system, /直接给出结果/u);
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 1, 'the half body is reported as a rejected attempt');
  assert.deepEqual(empty[0].payload, {
    phase: 'compose',
    finish: 'max-tokens',
    textChars: partial.length,
    reasoningChars: 0,
  });
  const retry = events(PROFILE_MODEL_EVENTS.retry);
  assert.equal(retry.length, 1);
  assert.deepEqual(retry[0].payload, {
    phase: 'compose',
    reason: 'max-tokens',
    from: PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS,
    to: 16384,
  });
  assert.equal(profile.list().length, 0, 'the half body never reaches the library');
  assert.equal(runtime.writeCalls.length, 0, 'the half body never reaches a box');
  console.log(`87) returned="${text}" calls=${model.calls.length} maxTokens1=${model.calls[0].maxTokens} maxTokens2=${model.calls[1].maxTokens} partialChars=${partial.length} retryReason=${retry[0].payload.reason}`);
});

test('88) 重试仍截断（正文非空）→ 未完成错误，库与框不变，最多一次重试', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  const partial1 = '你会保持温柔，但遇到';
  const partial2 = '你会保持温柔，但遇到分歧时';
  profile.upsert({ side: 'agent', category: '相处方式', text: '旧人设条目' });
  runtime.persona = { agent: '旧人设正文', user: '' };
  const model = scriptedModel([
    [{ type: 'text-delta', text: partial1 }, { type: 'finish', reason: 'max-tokens' }],
    [{ type: 'text-delta', text: partial2 }, { type: 'finish', reason: 'length' }],
  ]);
  const maintainer = make({ boxes: true, getSelection: () => model.service, getLlm: () => model.llm });

  const result = await maintainer.generatePersonaQuiz({ answers: [{ id: 'encourage', text: '先抱抱我。' }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /MODEL_INCOMPLETE/u, 'a non-empty truncated retry is an unfinished answer');
  assert.match(result.error, /"finish":"length"/u);
  assert.match(result.error, /"textChars":\d+/u);
  assert.ok(!String(result.error).includes(partial2), 'the error never carries the half body');
  assert.equal(model.calls.length, 2, 'one retry only, no third call');
  assert.equal(model.calls[1].maxTokens, 16384, 'the truncated retry budget is the raised ceiling');
  const empty = events(PROFILE_MODEL_EVENTS.empty);
  assert.equal(empty.length, 2, 'each rejected attempt reports its own scene');
  assert.deepEqual(empty[0].payload, {
    phase: 'persona',
    finish: 'max-tokens',
    textChars: partial1.length,
    reasoningChars: 0,
  });
  assert.deepEqual(empty[1].payload, {
    phase: 'persona',
    finish: 'length',
    textChars: partial2.length,
    reasoningChars: 0,
  });
  assert.equal(maintainer.personaQuizDraft(), null, 'no truncated draft is stored');
  assert.equal(profile.list().length, 1, 'the library is unchanged');
  assert.equal(profile.list()[0].text, '旧人设条目');
  assert.equal(runtime.persona.agent, '旧人设正文', 'the persona box is unchanged');
  assert.equal(runtime.writeCalls.length, 0, 'nothing is written back');
  console.log(`88) ok=${result.ok} code=MODEL_INCOMPLETE calls=${model.calls.length} maxTokens2=${model.calls[1].maxTokens} draft=${maintainer.personaQuizDraft()} library=${profile.list().length} box="${runtime.persona.agent}" writes=${runtime.writeCalls.length}`);
});

test('89) 回归：正文非空 + finish stop/completed → 直接成功、不重试', async (t) => {
  const { runtime, make, events } = await fresh(t);
  const text = '你会先听我说完，再给建议。';
  for (const finish of ['stop', 'completed']) {
    const model = scriptedModel([[{ type: 'text-delta', text }, { type: 'finish', reason: finish }]]);
    const maintainer = make({ boxes: true, getSelection: () => model.service, getLlm: () => model.llm });
    const composed = await maintainer.composeWithModel({
      side: 'agent',
      entries: [{ text: '先听完再说', category: '相处方式' }],
      tone: '',
      maxChars: 600,
    });
    assert.equal(composed, text);
    assert.equal(model.calls.length, 1, `finish ${finish} needs no retry`);
    assert.equal(model.calls[0].maxTokens, PROFILE_MAINTAIN_DEFAULT_MAX_TOKENS);
  }
  assert.equal(events(PROFILE_MODEL_EVENTS.empty).length, 0);
  assert.equal(events(PROFILE_MODEL_EVENTS.retry).length, 0);
  assert.equal(runtime.writeCalls.length, 0);
  console.log(`89) finishes=stop,completed callsPerFinish=1 retries=0 emptyEvents=0`);
});

test('90) 其它未完成（finish error）且正文非空 → 直接失败、不重试，库与框不变', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  const partial = '你会保持温柔，但遇到';
  const reasoning = '只想了半句';
  profile.upsert({ side: 'agent', category: '相处方式', text: '旧人设条目' });
  runtime.persona = { agent: '旧人设正文', user: '' };
  const model = scriptedModel([[
    { type: 'reasoning-delta', delta: reasoning },
    { type: 'text-delta', text: partial },
    { type: 'finish', reason: 'error' },
  ]]);
  const maintainer = make({ boxes: true, getSelection: () => model.service, getLlm: () => model.llm });

  await assert.rejects(
    () => maintainer.composeWithModel({
      side: 'agent',
      entries: [{ text: '先听完再表达', category: '相处方式' }],
      tone: '',
      maxChars: 600,
    }),
    (error) => {
      assert.equal(error.code, 'MODEL_INCOMPLETE');
      assert.equal(error.details.finish, 'error');
      assert.equal(error.details.textChars, partial.length);
      assert.equal(error.details.reasoningChars, reasoning.length);
      assert.ok(!error.message.includes(partial), 'the error never carries the half body');
      return true;
    },
  );
  assert.equal(model.calls.length, 1, 'a failed finish is not retried');
  assert.equal(profile.list().length, 1, 'the library is unchanged');
  assert.equal(profile.list()[0].text, '旧人设条目');
  assert.equal(runtime.persona.agent, '旧人设正文', 'the persona box is unchanged');
  assert.equal(runtime.writeCalls.length, 0, 'nothing is written back');
  console.log(`90) code=MODEL_INCOMPLETE finish=error textChars=${partial.length} reasoningChars=${reasoning.length} calls=${model.calls.length} library=${profile.list().length} writes=${runtime.writeCalls.length}`);
});

/** Entry fields the reclassify path must never touch, plus the score/evidence readouts. */
function reclassifySnapshot(profile, id) {
  const entry = profile.get(id);
  return {
    side: entry.side,
    category: entry.category,
    text: entry.text,
    clarity: entry.clarity,
    efficacy: entry.efficacy,
    rank: entry.rank,
    supportCount: profile.supportCount(id),
    evidence: profile.evidence(id).length,
  };
}

test('91) 重分类预览：3 条中只有 2 条变更，原库不变', async (t) => {
  const { profile, make } = await fresh(t);
  const correct = profile.upsert({ side: 'agent', category: '相处方式', text: '你会先听完再给建议' }).entry;
  const wrongCategory = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢看悬疑电影' }).entry;
  const wrongSide = profile.upsert({ side: 'user', category: '说话方式', text: '用户会先安静地听完' }).entry;
  let received = null;
  const maintainer = make({
    reclassify: async (input) => {
      received = input;
      return {
        changes: [
          // The first suggestion is already satisfied: it must not appear in the preview.
          { entryId: correct.id, side: 'agent', category: '相处方式' },
          { entryId: wrongCategory.id, side: 'user', category: '娱乐', reason: '作品偏好属娱乐' },
          { entryId: wrongSide.id, side: 'agent', category: '说话方式', reason: '是助手的说话方式' },
        ],
      };
    },
  });

  const plan = await maintainer.planReclassify();
  assert.equal(plan.ok, true);
  assert.equal(plan.changes.length, 2, 'only the two real changes are previewed');
  assert.deepEqual(
    plan.changes.map((change) => change.entryId).sort(),
    [wrongCategory.id, wrongSide.id].sort(),
  );
  const categoryChange = plan.changes.find((change) => change.entryId === wrongCategory.id);
  assert.deepEqual(categoryChange.from, { side: 'user', category: '饮食' });
  assert.deepEqual(categoryChange.to, { side: 'user', category: '娱乐' });
  const sideChange = plan.changes.find((change) => change.entryId === wrongSide.id);
  assert.deepEqual(sideChange.from, { side: 'user', category: '说话方式' });
  assert.deepEqual(sideChange.to, { side: 'agent', category: '说话方式' });
  assert.equal(received.entries.length, 3, 'the model sees every live entry');
  assert.ok(received.categories.length >= 8, 'the model sees the category stack');
  assert.ok(!Object.prototype.hasOwnProperty.call(plan, 'clarity'), 'no score is returned');
  // read-only: every entry is exactly as it was before the preview
  assert.deepEqual(reclassifySnapshot(profile, correct.id), {
    side: 'agent', category: '相处方式', text: '你会先听完再给建议',
    clarity: 50, efficacy: 50, rank: 'new', supportCount: 0, evidence: 0,
  });
  assert.deepEqual(reclassifySnapshot(profile, wrongCategory.id), {
    side: 'user', category: '饮食', text: '用户喜欢看悬疑电影',
    clarity: 50, efficacy: 50, rank: 'new', supportCount: 0, evidence: 0,
  });
  assert.deepEqual(reclassifySnapshot(profile, wrongSide.id), {
    side: 'user', category: '说话方式', text: '用户会先安静地听完',
    clarity: 50, efficacy: 50, rank: 'new', supportCount: 0, evidence: 0,
  });
  assert.equal(profile.revision(wrongCategory.id).length, 0, 'preview writes no revision');
  console.log(`91) entries=${received.entries.length} changes=${plan.changes.length} ids=${plan.changes.map((change) => change.entryId.length).join(',')} libraryUnchanged=true`);
});

test('92) 重分类应用：只改 side/category，C/E、supports、rank、evidence 全部不变', async (t) => {
  const { profile, make, events } = await fresh(t);
  const categoryTarget = profile.upsert({
    side: 'user', category: '饮食', text: '用户喜欢看悬疑电影',
    clarity: 72, efficacy: 41, rank: 'candidate',
  }).entry;
  const sideTarget = profile.upsert({
    side: 'user', category: '说话方式', text: '用户会先安静地听完',
    clarity: 66, efficacy: 38, rank: 'new',
  }).entry;
  profile.addEvidence(categoryTarget.id, { messageId: 'm-1' });
  profile.addEvidence(categoryTarget.id, { messageId: 'm-2' });
  profile.addEvidence(sideTarget.id, { messageId: 'm-3' });
  const before = {
    category: reclassifySnapshot(profile, categoryTarget.id),
    side: reclassifySnapshot(profile, sideTarget.id),
  };
  const maintainer = make({
    reclassify: async () => ({
      changes: [
        { entryId: categoryTarget.id, side: 'user', category: '娱乐' },
        { entryId: sideTarget.id, side: 'agent', category: '说话方式' },
      ],
    }),
  });
  const plan = await maintainer.planReclassify();
  const result = await maintainer.applyReclassify(plan, { expectedVersion: plan.version });

  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  assert.equal(events(PROFILE_RECLASSIFY_EVENTS.applied).length, 1);
  assert.deepEqual(events(PROFILE_RECLASSIFY_EVENTS.applied)[0].payload, { moved: 2, deleted: 0 });

  // side/category moved...
  assert.equal(profile.get(categoryTarget.id).category, '娱乐');
  assert.equal(profile.get(categoryTarget.id).side, 'user');
  assert.equal(profile.get(sideTarget.id).side, 'agent');
  assert.equal(profile.get(sideTarget.id).category, '说话方式');
  // ...and every score/evidence field is byte-identical to the pre-apply readout.
  for (const id of [categoryTarget.id, sideTarget.id]) {
    const original = id === categoryTarget.id ? before.category : before.side;
    const now = reclassifySnapshot(profile, id);
    assert.equal(now.clarity, original.clarity, 'clarity unchanged');
    assert.equal(now.efficacy, original.efficacy, 'efficacy unchanged');
    assert.equal(now.rank, original.rank, 'rank unchanged');
    assert.equal(now.supportCount, original.supportCount, 'support count unchanged');
    assert.equal(now.evidence, original.evidence, 'evidence rows unchanged');
  }
  // revision author + fields: only side/category (plus the normalized text when one changed).
  const categoryRevision = profile.revision(categoryTarget.id)[0];
  assert.equal(categoryRevision.source, 'reclassify');
  assert.deepEqual(categoryRevision.after, { side: 'user', category: '娱乐' });
  assert.deepEqual(categoryRevision.before, { side: 'user', category: '饮食' });
  const sideRevision = profile.revision(sideTarget.id)[0];
  assert.equal(sideRevision.source, 'reclassify');
  assert.deepEqual(sideRevision.after, { side: 'agent', category: '说话方式', text: '你会先安静地听完' });
  console.log(`92) applied=${result.applied} clarity=${profile.get(categoryTarget.id).clarity}/${profile.get(sideTarget.id).clarity} efficacy=${profile.get(categoryTarget.id).efficacy}/${profile.get(sideTarget.id).efficacy} supports=${profile.supportCount(categoryTarget.id)}/${profile.supportCount(sideTarget.id)} evidence=${profile.evidence(categoryTarget.id).length}/${profile.evidence(sideTarget.id).length} eventCount=${events(PROFILE_RECLASSIFY_EVENTS.applied).length}`);
});

test('93) 跨侧移动：人设侧「你……」、画像侧「用户……」的代词前缀被规范化', async (t) => {
  const { profile, make } = await fresh(t);
  const toAgent = profile.upsert({ side: 'user', category: '说话方式', text: '用户会先安静地听完' }).entry;
  const toUser = profile.upsert({ side: 'agent', category: '饮食', text: '你喜欢喝无糖茶' }).entry;
  const maintainer = make({
    reclassify: async () => ({
      changes: [
        { entryId: toAgent.id, side: 'agent', category: '说话方式' },
        { entryId: toUser.id, side: 'user', category: '饮食' },
      ],
    }),
  });
  const plan = await maintainer.planReclassify();
  const result = await maintainer.applyReclassify(plan, { expectedVersion: plan.version });
  assert.equal(result.applied, 2);
  const agentText = profile.get(toAgent.id).text;
  const userText = profile.get(toUser.id).text;
  assert.ok(agentText.startsWith('你'), `agent text starts with 你: ${agentText}`);
  assert.ok(!agentText.includes('用户'), `agent text has no subject 用户: ${agentText}`);
  assert.ok(userText.startsWith('用户'), `user text starts with 用户: ${userText}`);
  assert.ok(!userText.startsWith('你'), 'the leading 你 was rewritten');
  console.log(`93) toAgent="${agentText}" toUser="${userText}"`);
});

test('94) 版本冲突：预览后手工改条目 → 应用 aborted，库不变', async (t) => {
  const { profile, make, events } = await fresh(t);
  const target = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢看悬疑电影' }).entry;
  const maintainer = make({
    reclassify: async () => ({ changes: [{ entryId: target.id, side: 'user', category: '娱乐' }] }),
  });
  const plan = await maintainer.planReclassify();
  assert.equal(plan.changes.length, 1);
  // A user edit lands while the plan waits for confirmation.
  profile.edit(target.id, { category: '运动' });
  const before = profile.list().map((entry) => ({ ...entry }));
  const result = await maintainer.applyReclassify(plan, { expectedVersion: plan.version });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'version-conflict');
  assert.equal(result.applied, 0);
  assert.equal(profile.get(target.id).category, '运动', 'the manual edit is kept');
  assert.equal(profile.revision(target.id).length, 1, 'only the manual edit revision exists');
  assert.equal(profile.revision(target.id)[0].source, 'user');
  assert.deepEqual(profile.list().map((entry) => ({ ...entry })), before, 'the aborted apply wrote nothing');
  assert.equal(events(PROFILE_RECLASSIFY_EVENTS.applied).length, 0, 'no applied event on abort');
  console.log(`94) aborted=${result.aborted} reason=${result.reason} applied=${result.applied} category=${profile.get(target.id).category} revisionSource=${profile.revision(target.id)[0].source}`);
});

test('95) 幂等：同一 plan 应用两次，第二次 0 变更', async (t) => {
  const { profile, make, events } = await fresh(t);
  const target = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢看悬疑电影' }).entry;
  const maintainer = make({
    reclassify: async () => ({ changes: [{ entryId: target.id, side: 'user', category: '娱乐' }] }),
  });
  const plan = await maintainer.planReclassify();
  const first = await maintainer.applyReclassify(plan, { expectedVersion: plan.version });
  assert.equal(first.applied, 1);
  const afterFirst = profile.list().map((entry) => ({ ...entry }));
  const second = await maintainer.applyReclassify(plan, { expectedVersion: plan.version });
  assert.equal(second.ok, true);
  assert.equal(second.applied, 0);
  assert.equal(second.idempotent, true);
  assert.equal(second.aborted, undefined);
  assert.deepEqual(profile.list().map((entry) => ({ ...entry })), afterFirst, 'second apply writes nothing');
  assert.equal(profile.revision(target.id).length, 1, 'no second revision');
  assert.equal(events(PROFILE_RECLASSIFY_EVENTS.applied).length, 1, 'only the first apply emits');
  console.log(`95) first=${first.applied} second=${second.applied} idempotent=${second.idempotent} revisions=${profile.revision(target.id).length} events=${events(PROFILE_RECLASSIFY_EVENTS.applied).length}`);
});

test('96) 模型失败：预览返回错误、无任何变更', async (t) => {
  const { profile, make, events } = await fresh(t);
  const target = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢看悬疑电影' }).entry;
  const before = profile.list().map((entry) => ({ ...entry }));
  const maintainer = make({
    reclassify: async () => { throw new Error('model offline'); },
  });
  const plan = await maintainer.planReclassify();
  assert.equal(plan.ok, false);
  assert.match(plan.error, /model offline/u);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(profile.list().map((entry) => ({ ...entry })), before, 'the library is untouched');
  assert.equal(profile.revision(target.id).length, 0);
  assert.equal(events(PROFILE_RECLASSIFY_EVENTS.applied).length, 0);
  console.log(`96) ok=${plan.ok} error="${plan.error}" changes=${plan.changes.length} libraryUnchanged=true`);
});

test('97) 二次分侧：画像里的「用户偏好温婉可爱的角色形象」→ agent/人设参考，画像不再保留', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = {
    agent: '',
    user: '用户偏好温婉可爱的角色形象\n用户喜欢喝无糖茶',
  };
  // The first split misroutes the persona sentence to the user box (the bug reproduced).
  runtime.splitImpl = () => ({
    entries: [
      { text: '用户偏好温婉可爱的角色形象', side: 'user', from: 'user', category: '人设参考' },
      { text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' },
    ],
  });
  // The rewrite still echoes the moved sentence into the user box: the cross-side gate must reject
  // that text and write the user's own entries instead.
  runtime.composeImpl = ({ side, entries }) => (side === 'user'
    ? '用户偏好温婉可爱的角色形象。用户喜欢喝无糖茶。'
    : entries.map((entry) => entry.text).join('；'));
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const agentEntries = profile.list({ side: 'agent' });
  const userEntries = profile.list({ side: 'user' });
  assert.equal(agentEntries.length, 1, 'the sentence is moved to the agent side');
  assert.equal(userEntries.length, 1, 'the user side keeps only its own fact');
  assert.equal(agentEntries[0].side, 'agent');
  assert.equal(agentEntries[0].category, '人设参考');
  assert.match(agentEntries[0].text, /温婉可爱的角色形象/u);
  assert.match(agentEntries[0].text, /^你/u, 'the persona move uses the 你…… voice');
  assert.equal(userEntries[0].category, '饮食');
  assert.equal(runtime.persona.user.includes('温婉'), false, 'the 画像 box no longer contains the sentence');
  assert.match(runtime.persona.user, /无糖茶/u, 'the user fact is still written');
  assert.match(runtime.persona.agent, /温婉可爱的角色形象/u, 'the 人设 box carries it');
  const moves = events(PROFILE_SPLIT_EVENTS.moved);
  assert.equal(moves.length, 1, 'one cross-side move is reported');
  assert.equal(moves[0].payload.fromSide, 'user');
  assert.equal(moves[0].payload.toSide, 'agent');
  assert.equal(moves[0].payload.moved, true);
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected);
  assert.ok(rejected.some((event) => event.payload.reason === 'cross-side'), 'the leaked sentence is rejected');
  const revision = profile.revision(agentEntries[0].id).find((row) => row.after.moved === true);
  assert.ok(revision, 'the cross-side move has a revision');
  assert.equal(revision.after.moved, true);
  assert.equal(revision.after.fromSide, 'user');
  assert.equal(revision.after.toSide, 'agent');
  console.log(`97) agent="${agentEntries[0].text}" category=${agentEntries[0].category} userEntries=${userEntries.length} userBox="${runtime.persona.user}" agentBox="${runtime.persona.agent}" moved=${moves.length}`);
});

test('98) 去重：重写输出重复同一事实 → 只保留一次（条数与文本断言）', async (t) => {
  const { runtime, make } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  // Two clauses carry the same fact; the quality gate must keep exactly one.
  runtime.composeImpl = () => '用户喜欢喝无糖茶。用户喜欢喝无糖茶！';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const text = runtime.persona.user;
  const count = (text.match(/无糖茶/gu) ?? []).length;
  assert.equal(count, 1, `the fact appears exactly once: ${text}`);
  assert.equal(text, '用户喜欢喝无糖茶。');
  console.log(`98) userBox="${text}" factCount=${count}`);
});

test('99) 长度：重写条目超过原始输入 1.5 倍 → 回退原文，最终长度受控', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  // Same fact padded with an evaluation/expansion: clearly over the 1.5× budget.
  runtime.composeImpl = () => '用户喜欢喝无糖茶，用户喜欢喝无糖茶而且每天都要喝。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const text = runtime.persona.user;
  assert.ok([...text].length <= 16, `the fallback stays within the source budget: "${text}"`);
  assert.equal(text.includes('每天都要喝'), false, 'the padded rewrite is not written');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected).length, 1);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected)[0].payload.reason, 'length');
  console.log(`99) userBox="${text}" length=${[...text].length} rejected=${events(PROFILE_COMPOSE_EVENTS.rejected)[0].payload.reason}`);
});

test('100) 填充过滤：评价性/回声短句（也亲近这种口吻、期待比较明显）不进入最终文本', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  runtime.composeImpl = () => '用户喜欢喝无糖茶，也亲近这种口吻，对完整度的期待比较明显，一定程度地期待。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const text = runtime.persona.user;
  assert.match(text, /无糖茶/u, 'the real fact survives');
  assert.equal(text.includes('也亲近这种口吻'), false);
  assert.equal(text.includes('期待比较明显'), false);
  assert.equal(text.includes('一定程度'), false);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected)[0].payload.reason, 'filler');
  console.log(`100) userBox="${text}" droppedEcho=${text.includes('也亲近')} droppedMeta=${text.includes('期待比较明显')}`);
});

test('101) 二次分侧不误伤：饮食/生活习惯等用户偏好仍留在画像', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = {
    agent: '',
    user: '用户偏好温婉可爱的角色形象\n用户喜欢喝无糖茶\n用户习惯早睡',
  };
  runtime.splitImpl = () => ({
    entries: [
      { text: '用户偏好温婉可爱的角色形象', side: 'user', from: 'user', category: '人设参考' },
      { text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' },
      { text: '用户习惯早睡', side: 'user', from: 'user', category: '生活习惯' },
    ],
  });
  runtime.composeImpl = ({ side, entries }) => (side === 'user'
    ? `用户${entries.map((entry) => entry.text).join('，')}。`
    : entries.map((entry) => entry.text).join('；'));
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const agent = profile.list({ side: 'agent' });
  const user = profile.list({ side: 'user' });
  assert.equal(agent.length, 1, 'only the persona-reference preference moved');
  assert.ok(agent.every((entry) => entry.category === '人设参考'));
  assert.equal(user.length, 2, 'food and habit preferences stay on the user side');
  assert.deepEqual(user.map((entry) => entry.category).sort(), ['生活习惯', '饮食'].sort());
  assert.match(runtime.persona.user, /无糖茶/u);
  assert.match(runtime.persona.user, /早睡/u);
  assert.equal(runtime.persona.user.includes('温婉'), false);
  assert.equal(events(PROFILE_SPLIT_EVENTS.moved).length, 1, 'exactly one move');
  console.log(`101) agent=${agent.length} user=${user.length} userCategories=[${user.map((entry) => entry.category).join(' | ')}] userBox="${runtime.persona.user}"`);
});

test('102) 归属：用户喜欢温婉可爱的角色 → agent/人设参考（不要求“希望助手这样表现”）', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢温婉可爱的角色' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢温婉可爱的角色', side: 'user', from: 'user', category: '人设参考' }],
  });
  runtime.composeImpl = ({ entries }) => entries.map((entry) => entry.text).join('；');
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const agent = profile.list({ side: 'agent' });
  assert.equal(agent.length, 1);
  assert.equal(agent[0].side, 'agent');
  assert.equal(agent[0].category, '人设参考');
  assert.match(agent[0].text, /温婉可爱的角色/u);
  assert.equal(profile.list({ side: 'user' }).length, 0);
  assert.equal(runtime.persona.user.includes('温婉'), false);
  console.log(`102) agent="${agent[0].text}" category=${agent[0].category} userEntries=${profile.list({ side: 'user' }).length} userBox="${runtime.persona.user}"`);
});

test('103) 归属：生活偏好「用户喜欢喝无糖茶」→ user/饮食，不迁移', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢喝无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  runtime.composeImpl = ({ entries }) => `用户${entries.map((entry) => entry.text).join('，')}。`;
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const user = profile.list({ side: 'user' });
  assert.equal(user.length, 1);
  assert.equal(user[0].side, 'user');
  assert.equal(user[0].category, '饮食');
  assert.equal(profile.list({ side: 'agent' }).length, 0);
  assert.equal(events(PROFILE_SPLIT_EVENTS.moved).length, 0);
  console.log(`103) user="${user[0].text}" category=${user[0].category} agentEntries=${profile.list({ side: 'agent' }).length} moved=${events(PROFILE_SPLIT_EVENTS.moved).length}`);
});

test('104) 迁移保留来源/证据/数值：supports、evidence、C/E、rank 不变，且不新增支持', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢温婉可爱的角色' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢温婉可爱的角色', side: 'user', from: 'user', category: '人设参考' }],
  });
  const maintainer = make({ boxes: true });
  // Organize once so the entry owns a snapshot mapping, then give it evidence/scores.
  assert.equal((await maintainer.split({ agent: '', user: '用户喜欢温婉可爱的角色' })).ok, true);
  const entry = profile.list({ side: 'user' })[0];
  assert.equal(profile.recordSupport(entry.id, { messageId: 'seed-1' }).applied, true);
  profile.writeRankScores(entry.id, 72, 41);
  profile.lock(entry.id, true); // exempt from the round's decay; the move itself still applies
  const before = profile.get(entry.id);
  const supportsBefore = profile.supportCount(entry.id);
  const evidenceBefore = profile.evidence(entry.id).length;
  const revisionsBefore = profile.revision(entry.id).length;

  addMessage('m1', '今天天气不错');
  runtime.candidates = [];
  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);

  const after = profile.get(entry.id);
  assert.equal(after.side, 'agent');
  assert.equal(after.category, '人设参考');
  assert.equal(after.clarity, before.clarity, 'clarity is unchanged');
  assert.equal(after.efficacy, before.efficacy, 'efficacy is unchanged');
  assert.equal(after.rank, before.rank, 'rank/source is unchanged (no adopt)');
  assert.equal(profile.supportCount(entry.id), supportsBefore, 'no new support is added');
  assert.equal(profile.evidence(entry.id).length, evidenceBefore, 'no evidence row is added');
  assert.equal(profile.revision(entry.id).length, revisionsBefore + 1, 'exactly one move revision');
  const moveRevision = profile.revision(entry.id)[0];
  assert.equal(moveRevision.after.moved, true);
  assert.equal(moveRevision.after.fromSide, 'user');
  assert.equal(moveRevision.after.toSide, 'agent');
  assert.equal(events(PROFILE_SPLIT_EVENTS.moved).length, 1);
  console.log(`104) side=${after.side} category=${after.category} supports=${supportsBefore}->${profile.supportCount(entry.id)} evidence=${evidenceBefore}->${profile.evidence(entry.id).length} C/E=${after.clarity}/${after.efficacy} (before ${before.clarity}/${before.efficacy}) rank=${after.rank} revisions+${profile.revision(entry.id).length - revisionsBefore}`);
});

test('105) 3-gram 反例：喜欢主动提醒 / 不喜欢主动提醒 高度相似但绝不合并', () => {
  const positive = '喜欢主动提醒';
  const negative = '不喜欢主动提醒';
  assert.ok(composeSimilarity(positive, negative) >= 0.8, 'the pair is a suspected duplicate');
  const result = validateComposeText({
    side: 'user',
    text: '喜欢主动提醒。不喜欢主动提醒。',
    entries: [{ text: positive }, { text: negative }],
  });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes(positive));
  assert.ok(result.text.includes(negative), 'the opposite tendency must survive');
  assert.equal((result.text.match(/不喜欢主动提醒/gu) ?? []).length, 1);
  console.log(`105) similarity=${composeSimilarity(positive, negative).toFixed(2)} text="${result.text}" dropped=${result.dropped.length}`);
});

test('106) 重复强化诊断：同一 message_id 重放 7 次，新增证据/支持/采纳都不增长', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const maintainer = make();
  addMessage('m1', '你说话再温柔一点');
  const candidates = [{ side: 'agent', category: '说话方式', text: '说话温柔', message_ids: ['m1'] }];
  const messages = runtime.messages.map((message) => ({ ...message, session: '', turn: '' }));
  const commitOnce = () => maintainer.commit({
    candidates,
    messages,
    until: new Date(T0).toISOString(),
    trigger: 'test',
    signature: maintainer.librarySignature(),
  });

  const first = await commitOnce();
  const entry = profile.list()[0];
  const baseline = {
    added: first.summary.added,
    evidence: profile.evidence(entry.id).length,
    supports: profile.supportCount(entry.id),
    rank: profile.get(entry.id).rank,
    adopted: first.summary.adopted,
  };
  const repeats = [];
  for (let index = 0; index < 6; index += 1) {
    const round = await commitOnce();
    repeats.push({
      added: round.summary.added,
      adopted: round.summary.adopted,
      evidence: profile.evidence(entry.id).length,
      supports: profile.supportCount(entry.id),
      rank: profile.get(entry.id).rank,
    });
  }
  assert.ok(repeats.every((round) => round.added === 0), 'a replayed exchange adds no entry');
  assert.ok(repeats.every((round) => round.evidence === baseline.evidence), 'no evidence row is added');
  assert.ok(repeats.every((round) => round.supports === baseline.supports), 'support count never grows');
  assert.ok(repeats.every((round) => round.rank === baseline.rank), 'adoption/rank never changes');
  console.log(`106) baseline added=${baseline.added} evidence=${baseline.evidence} supports=${baseline.supports} rank=${baseline.rank} adopted=${baseline.adopted} | 6 replays evidence=${repeats.map((r) => r.evidence).join(',')} supports=${repeats.map((r) => r.supports).join(',')} added=${repeats.map((r) => r.added).join(',')} rank=${repeats.map((r) => r.rank).join(',')} adopted=${repeats.map((r) => r.adopted).join(',')}`);
});

test('107) 新交流写回：文本框未改，对话新增的条目也写进画像框', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '我喜欢安静的音乐');
  addMessage('m2', '对，安静一点的好');
  runtime.candidates = [
    { side: 'user', category: '娱乐', text: '喜欢安静的音乐', message_ids: ['m1', 'm2'] },
  ];
  runtime.composeImpl = ({ side, entries }) => (side === 'user'
    ? `用户${entries.map((entry) => entry.text).join('，')}。`
    : entries.map((entry) => entry.text).join('；'));
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const entry = profile.list({ side: 'user' }).find((row) => row.text.includes('安静的音乐'));
  assert.ok(entry, 'the new exchange produced a library entry');
  assert.equal(result.reason, 'new-content');
  assert.ok((result.writeback ?? []).some((item) => item.side === 'user'), 'the user side is written back');
  assert.match(runtime.persona.user, /安静的音乐/u, 'the 画像 box now shows the new fact');
  assert.equal(runtime.persona.agent, '', 'the unchanged agent box is not rewritten');
  const writeSides = runtime.writeCalls.map((call) => call.which);
  assert.ok(writeSides.includes('user'), 'the changed side is rewritten');
  assert.equal(writeSides.includes('agent'), false, 'the unchanged side keeps its text verbatim');
  console.log(`107) reason=${result.reason} entry="${entry.text}" userBox="${runtime.persona.user}" agentBox="${runtime.persona.agent}" writeSides=[${writeSides.join(',')}]`);
});

test('108) 条件不同不合并：白天/晚上、工作时/周末各保留一条；同句仍合并', () => {
  // These pairs are ≥0.8 similar (a suspected duplicate) and differ only in the condition word.
  const day = '用户喜欢在白天的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const night = '用户喜欢在晚上的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const work = '用户喜欢在工作的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const weekend = '用户喜欢在周末的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const ifWork = '用户如果在工作的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const ifRest = '用户如果在休息的时候一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  assert.ok(composeSimilarity(day, night) >= 0.8, 'day/night is a suspected duplicate');
  assert.ok(composeSimilarity(work, weekend) >= 0.8, 'work/weekend is a suspected duplicate');
  assert.ok(composeSimilarity(ifWork, ifRest) >= 0.8, 'if-work/if-rest is a suspected duplicate');
  assert.equal(composeSameFact(day, night), false, 'a different time condition blocks the merge');
  assert.equal(composeSameFact(work, weekend), false, 'a different scene condition blocks the merge');
  assert.equal(composeSameFact(ifWork, ifRest), false, 'a different premise after 如果 blocks the merge');
  assert.equal(composeSameFact('白天喜欢快歌', '晚上喜欢慢歌'), false);
  assert.equal(composeSameFact('喜欢快歌', '喜欢快歌'), true);
  assert.equal(dedupeComposeEntries([{ text: day }, { text: night }]).entries.length, 2);
  assert.equal(dedupeComposeEntries([{ text: work }, { text: weekend }]).entries.length, 2);
  assert.equal(dedupeComposeEntries([{ text: ifWork }, { text: ifRest }]).entries.length, 2);
  assert.equal(dedupeComposeEntries([{ text: '白天喜欢快歌' }, { text: '晚上喜欢慢歌' }]).entries.length, 2);
  const same = dedupeComposeEntries([{ text: '喜欢快歌' }, { text: '喜欢快歌' }]);
  assert.equal(same.entries.length, 1, 'an identical fact still merges');
  console.log(`108) day/night similarity=${composeSimilarity(day, night).toFixed(3)} sameFact=${composeSameFact(day, night)} | work/weekend similarity=${composeSimilarity(work, weekend).toFixed(3)} sameFact=${composeSameFact(work, weekend)} | if-premise similarity=${composeSimilarity(ifWork, ifRest).toFixed(3)} sameFact=${composeSameFact(ifWork, ifRest)} | kept=${dedupeComposeEntries([{ text: day }, { text: night }]).entries.length}/${dedupeComposeEntries([{ text: work }, { text: weekend }]).entries.length}/${dedupeComposeEntries([{ text: ifWork }, { text: ifRest }]).entries.length} identical=${same.entries.length}`);
});

test('109) 新候选分侧：对话里的说话方式偏好直接进 agent/语言模式', async (t) => {
  const { db, profile, runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '用户说她喜欢温柔一点的说话方式');
  runtime.candidates = [{
    side: 'user',
    category: '语言模式',
    text: '用户喜欢温柔一点的说话方式',
    message_ids: ['m1'],
  }];
  const maintainer = make({ boxes: true });
  // The real stack may carry a dedicated 语言模式 category; classification must preserve it.
  const at = new Date(T0).toISOString();
  db.prepare(`INSERT INTO profile_category (id, name, parent, description, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'preset', ?, ?)`)
    .run('cat-language-mode', '语言模式', 'agent', '语气与表达方式', at, at);

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const agent = profile.list({ side: 'agent' });
  const user = profile.list({ side: 'user' });
  assert.equal(agent.length, 1, 'the new candidate is filed on the agent side directly');
  assert.equal(agent[0].side, 'agent');
  assert.equal(agent[0].category, '语言模式');
  assert.match(agent[0].text, /^你/u, 'the agent side uses the 你…… voice');
  assert.match(agent[0].text, /说话方式/u);
  assert.equal(user.length, 0, 'nothing stays on the extracted side');
  assert.equal(events(PROFILE_SPLIT_EVENTS.moved).length, 0, 'the candidate is classified before insertion, not migrated after it');
  console.log(`109) agent="${agent[0].text}" category=${agent[0].category} userEntries=${user.length} moves=${events(PROFILE_SPLIT_EVENTS.moved).length}`);
});

test('110) 原反例：学习的时候 / 工作的时候 条件短语不同，长句相似度≥0.8 也不合并', () => {
  const shortA = '用户学习的时候喜欢安静';
  const shortB = '用户工作的时候喜欢安静';
  const longA = '用户学习的时候喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const longB = '用户工作的时候喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const verdict = composeFactVerdict(longA, longB);
  assert.ok(composeSimilarity(longA, longB) >= 0.8, 'the reported long pair is a suspected duplicate');
  assert.equal(composeSameFact(longA, longB), false, '「学习」/「工作」 are different condition phrases');
  assert.equal(verdict.reason, 'condition');
  assert.equal(composeSameFact(shortA, shortB), false);
  const kept = dedupeComposeEntries([{ text: shortA }, { text: shortB }]);
  const keptLong = dedupeComposeEntries([{ text: longA }, { text: longB }]);
  assert.equal(kept.entries.length, 2);
  assert.equal(keptLong.entries.length, 2);
  assert.equal(keptLong.merges.length, 0);
  console.log(`110) short similarity=${composeSimilarity(shortA, shortB).toFixed(3)} | long similarity=${composeSimilarity(longA, longB).toFixed(3)} sameFact=${composeSameFact(longA, longB)} reason=${verdict.reason} kept=${kept.entries.length}/${keptLong.entries.length}`);
});

test('111) 条件短语不同不合并：如果下雨 / 如果下雪（短句与长句都保留）', () => {
  const shortA = '如果下雨就不出门';
  const shortB = '如果下雪就不出门';
  const longA = '用户如果下雨天就不出门，喜欢一个人安静地待在房间里听一些节奏比较轻快的歌曲';
  const longB = '用户如果下雪天就不出门，喜欢一个人安静地待在房间里听一些节奏比较轻快的歌曲';
  const verdict = composeFactVerdict(longA, longB);
  assert.equal(composeSameFact(shortA, shortB), false);
  assert.ok(composeSimilarity(longA, longB) >= 0.8, 'if-rain/if-snow is a suspected duplicate');
  assert.equal(verdict.same, false);
  assert.equal(verdict.reason, 'condition');
  assert.equal(dedupeComposeEntries([{ text: shortA }, { text: shortB }]).entries.length, 2);
  assert.equal(dedupeComposeEntries([{ text: longA }, { text: longB }]).entries.length, 2);
  console.log(`111) short similarity=${composeSimilarity(shortA, shortB).toFixed(3)} kept=2 | long similarity=${composeSimilarity(longA, longB).toFixed(3)} sameFact=${verdict.same} reason=${verdict.reason} kept=2`);
});

test('112) 无条件的完全相同仍合并：喜欢快歌', () => {
  const verdict = composeFactVerdict('喜欢快歌', '喜欢快歌');
  assert.equal(verdict.same, true);
  assert.equal(verdict.reason, 'no-condition');
  const result = dedupeComposeEntries([{ text: '喜欢快歌' }, { text: '喜欢快歌' }]);
  assert.equal(result.entries.length, 1, 'an identical fact still merges');
  assert.deepEqual(result.merges, [{ left: '喜欢快歌', right: '喜欢快歌', reason: 'no-condition' }]);
  console.log(`112) sameFact=${verdict.same} reason=${verdict.reason} kept=${result.entries.length} merges=${JSON.stringify(result.merges)}`);
});

test('113) 条件短语相同才合并：学习的时候喜欢安静', () => {
  const verdict = composeFactVerdict('学习的时候喜欢安静', '学习的时候喜欢安静');
  assert.equal(verdict.same, true);
  assert.equal(verdict.reason, 'same-condition');
  const result = dedupeComposeEntries([{ text: '学习的时候喜欢安静' }, { text: '学习的时候喜欢安静' }]);
  assert.equal(result.entries.length, 1, 'the same condition phrase merges');
  assert.deepEqual(result.merges, [{ left: '学习的时候喜欢安静', right: '学习的时候喜欢安静', reason: 'same-condition' }]);
  console.log(`113) sameFact=${verdict.same} reason=${verdict.reason} kept=${result.entries.length}`);
});

test('114) 相似但无法提取条件的长句：无法确认就保留两条', () => {
  const rain = '用户在下雨天喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const snow = '用户在下雪天喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const verdict = composeFactVerdict(rain, snow);
  assert.ok(composeSimilarity(rain, snow) >= 0.8, 'the pair is a suspected duplicate');
  assert.equal(verdict.same, false);
  assert.equal(verdict.reason, 'object', 'no condition phrase is extractable, so the differing fact keeps them apart');
  assert.equal(dedupeComposeEntries([{ text: rain }, { text: snow }]).entries.length, 2);
  console.log(`114) similarity=${composeSimilarity(rain, snow).toFixed(3)} sameFact=${verdict.same} reason=${verdict.reason} kept=2`);
});

test('115) 合并记录 profile.compose.merge {left,right,reason}：debug 级、节流', async (t) => {
  const { runtime, addMessage, make, events } = await fresh(t);
  addMessage('m1', '我喜欢快歌');
  addMessage('m2', '对，快歌好听');
  runtime.candidates = [{ side: 'user', category: '娱乐', text: '喜欢快歌', message_ids: ['m1', 'm2'] }];
  runtime.composeImpl = ({ entries }) => `用户${entries[0].text}。用户${entries[0].text}。`;
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const merges = events(PROFILE_COMPOSE_EVENTS.merge);
  assert.equal(merges.length, 1, 'the merged duplicate is recorded once');
  const [row] = merges;
  assert.equal(row.payload.level, 'debug');
  assert.equal(row.payload.side, 'user');
  assert.equal(row.payload.reason, 'no-condition');
  assert.match(row.payload.left, /喜欢快歌/u);
  assert.match(row.payload.right, /喜欢快歌/u);
  // The same window throttles a second batch at the same instant.
  await maintainer.logComposeMerges('user', [{ left: 'a', right: 'b', reason: 'same-condition' }]);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.merge).length, 1, 'a second batch inside the window is throttled');
  console.log(`115) mergeEvents=${merges.length} payload=${JSON.stringify(row.payload)} throttledAt=${events(PROFILE_COMPOSE_EVENTS.merge).length}`);
});

// ---- presentation: the two boxes read as sentences/paragraphs, never as a per-item list ----------

/** Presentation counters of one box text: list markers, inline markdown, paragraphs, headings. */
function presentation(text) {
  const value = String(text ?? '');
  return {
    bullets: (value.match(/^\s*(?:[-*+·•●○◦▪‣]|\d+[.)、]|\(\d+\)|（\d+）)\s*/gmu) ?? []).length,
    inline: (value.match(/\*\*|`+|~~/gu) ?? []).length,
    headings: (value.match(/^\s*#{1,6}\s*/gmu) ?? []).length,
    paragraphs: value.split('\n').filter((line) => line.trim().length > 0).length,
  };
}

/** Content characters only (letters/digits), the unit the length gates measure. */
const contentChars = (text) => (String(text ?? '').match(/[\p{L}\p{N}]/gu) ?? []).length;

/** The three source fragments and the prose paragraph a faithful rewrite would produce. */
const PROSE_SOURCES = Object.freeze([
  Object.freeze({ text: '你说话温柔自然，略带撒娇感', category: '说话方式' }),
  Object.freeze({ text: '你解释问题时会耐心说明', category: '说话方式' }),
  Object.freeze({ text: '你一次不会说太多', category: '相处方式' }),
]);
const PROSE_PARAGRAPH = '你说话温柔自然，略带撒娇感；解释问题时会耐心说明；一次也不会说太多。';

test('116) 三条目 → 段落呈现：无 -/*/编号、无「一行一条」，提示词要求自然段', async (t) => {
  const { runtime, make } = await fresh(t);
  runtime.persona = { agent: PROSE_SOURCES.map((entry) => entry.text).join('\n'), user: '' };
  runtime.splitImpl = () => PROSE_SOURCES.map((entry) => ({
    text: entry.text, side: 'agent', from: 'agent', category: entry.category,
  }));
  runtime.composeImpl = () => PROSE_PARAGRAPH;
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const box = runtime.persona.agent;
  const shown = presentation(box);
  assert.equal(shown.bullets, 0, 'no bullet / number marker at any line start');
  assert.equal(shown.inline, 0, 'no inline markdown marker');
  assert.equal(shown.headings, 0, 'no heading');
  assert.ok(shown.paragraphs <= 3, `at most 3 paragraphs, got ${shown.paragraphs}`);
  assert.equal(box, PROSE_PARAGRAPH, 'the paragraph is written back as-is');
  // The compose prompt itself asks for prose paragraphs and forbids a list.
  const prompt = buildComposePrompt({ side: 'agent', entries: PROSE_SOURCES });
  assert.match(prompt, /自然段/u);
  assert.match(prompt, /禁止列表/u);
  assert.match(prompt, /一行一条/u);
  console.log(`116) paragraphs=${shown.paragraphs} bullets=${shown.bullets} inlineMarkers=${shown.inline} boxChars=${[...box].length} box="${box}"`);
});

test('117) 关键信息保留：每条至少一个关键词出现；长度 ≤ 原拼接 ×1.2', () => {
  const entries = PROSE_SOURCES.map((entry) => ({ ...entry }));
  const checked = validateComposeText({ side: 'agent', text: PROSE_PARAGRAPH, entries });
  assert.equal(checked.ok, true, 'a faithful prose paragraph passes the gate');
  const plain = PROSE_PARAGRAPH.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
  const coverage = entries.map((entry) => {
    const keywords = composeKeywords(entry.text);
    return { text: entry.text, keywords, hit: keywords.some((keyword) => plain.includes(keyword)) };
  });
  assert.ok(coverage.every((row) => row.hit), 'every source keeps at least one keyword');
  assert.equal(checked.omitted.length, 0, 'no entry is reported as an omission risk');
  const sourceChars = contentChars(entries.map((entry) => entry.text).join(''));
  const producedChars = contentChars(PROSE_PARAGRAPH);
  const sourceLength = entries.map((entry) => entry.text).join('').length;
  assert.ok(producedChars <= Math.ceil(sourceChars * 1.2), `content ${producedChars} ≤ ${Math.ceil(sourceChars * 1.2)}`);
  assert.ok(PROSE_PARAGRAPH.length <= Math.ceil(sourceLength * 1.2), `chars ${PROSE_PARAGRAPH.length} ≤ ${Math.ceil(sourceLength * 1.2)}`);
  console.log(`117) keywords=[${coverage.map((row) => row.keywords.join('/')).join(' | ')}] coverage=${coverage.filter((row) => row.hit).length}/${coverage.length} content=${producedChars}/${sourceChars} ratio=${(PROSE_PARAGRAPH.length / sourceLength).toFixed(2)} omitted=${checked.omitted.length}`);
});

test('118) 模型返回列表格式 → 确定性回退为完整句段落，信息不丢', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: PROSE_SOURCES.map((entry) => entry.text).join('\n'), user: '' };
  runtime.splitImpl = () => PROSE_SOURCES.map((entry) => ({
    text: entry.text, side: 'agent', from: 'agent', category: entry.category,
  }));
  // The model ignores the prose rule and hands back a per-item list.
  runtime.composeImpl = () => PROSE_SOURCES.map((entry) => `- ${entry.text}`).join('\n');
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const box = runtime.persona.agent;
  const shown = presentation(box);
  assert.equal(shown.bullets, 0, 'the list never reaches the box');
  assert.equal(shown.inline, 0);
  assert.ok(shown.paragraphs <= 3);
  // The fallback keeps every source sentence (complete, grouped by category).
  for (const entry of PROSE_SOURCES) {
    assert.ok(box.includes(`${entry.text}。`), `the fallback keeps "${entry.text}" as a complete sentence`);
  }
  assert.equal(box.includes('- '), false);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected).at(-1).payload.reason, 'list');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.fallback).at(-1).payload.reason, 'compose-rejected');
  const plain = box.replace(/[\s\p{P}\p{S}]+/gu, '');
  assert.ok(PROSE_SOURCES.every((entry) => composeKeywords(entry.text).some((keyword) => plain.includes(keyword))));
  console.log(`118) rejected=${events(PROFILE_COMPOSE_EVENTS.rejected).at(-1).payload.reason} paragraphs=${shown.paragraphs} bullets=${shown.bullets} box="${box.replace(/\n/gu, ' ⏎ ')}"`);
});

test('119) 单条目 → 输出为一句完整句子', async (t) => {
  const { runtime, make } = await fresh(t);
  const source = '你耐心听完再回应';
  runtime.persona = { agent: source, user: '' };
  runtime.splitImpl = () => [{ text: source, side: 'agent', from: 'agent', category: '相处方式' }];
  runtime.composeImpl = () => '你会耐心听完再回应。';
  const maintainer = make({ boxes: true });

  await maintainer.now({ trigger: 'settings' });
  const box = runtime.persona.agent;
  assert.equal(box, '你会耐心听完再回应。');
  assert.equal(presentation(box).paragraphs, 1, 'exactly one paragraph');
  assert.equal(presentation(box).bullets, 0);
  assert.match(box, /。$/u, 'the sentence is complete');
  assert.equal((box.match(/[。！？!?]/gu) ?? []).length, 1, 'exactly one sentence');
  const keywords = composeKeywords(source);
  assert.ok(keywords.some((keyword) => box.includes(keyword)), 'the key information survives');
  console.log(`119) sentences=1 endsWithPeriod=${/。$/u.test(box)} keywordsHit=${keywords.filter((keyword) => box.includes(keyword)).join('/')} box="${box}"`);
});

test('120) 旧文本含「- 」Markdown 列表 → 写回后无任何列表标记，关键信息仍在', async (t) => {
  const { runtime, make } = await fresh(t);
  // The legacy box the user already has: one Markdown item per line.
  runtime.persona = { agent: '- 说话温柔\n- 喜欢安静', user: '' };
  runtime.splitImpl = ({ agent }) => String(agent ?? '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*+·]\s*/u, '').trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, side: 'agent', from: 'agent', category: '说话方式' }));
  runtime.composeImpl = () => '你说话温柔，也会喜欢安静。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  const box = runtime.persona.agent;
  const shown = presentation(box);
  assert.equal(shown.bullets, 0, 'the legacy marker is never written back');
  assert.equal(shown.inline, 0);
  assert.equal(box.includes('- '), false);
  assert.equal(box.includes('*'), false);
  assert.match(box, /说话温柔/u);
  assert.match(box, /安静/u);
  // A compiled-style legacy section is turned into plain sentences too, content kept.
  const legacy = '## 人设（自动整理）\n- [语言] 说话温柔（C=70, E=50）\n- [性格] 喜欢安静';
  const plain = ensurePlainProse(legacy);
  assert.equal(/^\s*(?:#|[-*+·]|\d+[.)、])/mu.test(plain), false, 'no heading/bullet/number at line start');
  assert.equal(/[*`]/u.test(plain), false, 'no inline markdown marker');
  assert.match(plain, /说话温柔/u, 'the content behind the marker is kept');
  assert.match(plain, /喜欢安静/u);
  assert.equal(plain.includes('（C=70'), false, 'the compiled score decoration is dropped');
  console.log(`120) legacyBoxBullets=${shown.bullets} box="${box}" | ensurePlain="${plain.replace(/\n/gu, ' ⏎ ')}"`);
});

test('121) 语义核对：关键词风险触发一次模型核对；否决 → 源句，通过 → 保留改写', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '你说话温柔自然', user: '' };
  const sources = [
    { text: '你说话温柔自然', category: '说话方式' },
    { text: '你解释问题时会耐心说明', category: '说话方式' },
  ];
  runtime.splitImpl = () => sources.map((entry) => ({
    text: entry.text, side: 'agent', from: 'agent', category: entry.category,
  }));
  // The rewrite silently drops the second entry: the keyword gate can only flag the risk.
  runtime.composeImpl = () => '你说话温柔自然。';
  let verdict = { ok: false, issues: ['漏掉了「你解释问题时会耐心说明」'] };
  const calls = [];
  const maintainer = make({
    boxes: true,
    verifyCompose: async (input) => {
      calls.push({ side: input.side, text: input.text, entries: input.entries.length });
      return verdict;
    },
  });

  const rejected = await maintainer.now({ trigger: 'settings' });
  assert.equal(rejected.ok, true);
  assert.equal(calls.length, 1, 'exactly one semantic cross-check');
  assert.equal(calls[0].entries, 2, 'the check sees the source entries');
  const first = runtime.persona.agent;
  assert.match(first, /你说话温柔自然/u);
  assert.match(first, /你解释问题时会耐心说明/u, 'the rejected rewrite falls back to the source sentences');
  assert.equal(presentation(first).bullets, 0);
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected).at(-1).payload.reason, 'semantic');

  // A second round: the rewrite keeps both facts and the check approves it.
  verdict = { ok: true, issues: [] };
  runtime.composeImpl = () => '你说话温柔自然；解释问题时会耐心说明。';
  runtime.persona = { ...runtime.persona, agent: '你说话温柔自然\n你解释问题时会耐心说明' };
  const approved = await maintainer.now({ trigger: 'settings' });
  assert.equal(approved.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(runtime.persona.agent, '你说话温柔自然；解释问题时会耐心说明。');
  console.log(`121) calls=${calls.length} rejectedReason=${events(PROFILE_COMPOSE_EVENTS.rejected).at(-1).payload.reason} afterReject="${first}" afterApprove="${runtime.persona.agent}"`);
});

test('122) 保护字段：数字/否定/条件被改写 → 判失败（并非讨厌 ≠ 喜欢，反向同样）', () => {
  const bad = (text, entry) => validateComposeText({ side: 'user', text, entries: [{ text: entry }] });
  const number = bad('用户每天早上喝一杯冰美式。', '用户每天早上7点喝一杯冰美式');
  assert.equal(number.ok, false, 'a dropped literal number fails');
  assert.equal(number.reason, 'fidelity');
  assert.equal(number.detail, 'number');
  const negation = bad('用户喜欢安静地听轻音乐。', '用户并非讨厌安静地听轻音乐');
  assert.equal(negation.ok, false, '「并非讨厌」 rewritten as 「喜欢」 fails');
  assert.equal(negation.detail, 'polarity');
  const flipped = bad('用户并非讨厌安静。', '用户喜欢安静');
  assert.equal(flipped.ok, false, 'the opposite direction fails too');
  assert.ok(['polarity', 'dropped', 'new-fact'].includes(flipped.detail));
  const condition = bad('用户如果下雨天不出门。', '用户如果下雨天就不出门');
  assert.equal(condition.ok, false, 'a conditional fact may not lose its condition');
  assert.equal(condition.detail, 'condition');
  const faithful = bad('用户每天早上7点喝一杯冰美式。', '用户每天早上7点喝一杯冰美式');
  assert.equal(faithful.ok, true, 'the same facts pass');
  console.log(`122) number=${number.detail} negation=${negation.detail} flipped=${flipped.detail} condition=${condition.detail} faithful=${faithful.ok}`);
});

test('123) 确定性回退用完整句：按类别成段，不以分号拼接短语', () => {
  const text = composeFallbackText([
    { text: '说话温柔', category: '说话方式' },
    { text: '喜欢安静', category: '相处方式' },
  ], 'agent');
  assert.equal(text, '你喜欢安静。\n你说话温柔。', 'category order, one complete sentence per source');
  for (const line of text.split('\n')) assert.match(line, /。$/u, 'every paragraph is a complete sentence');
  assert.equal(text.includes('；'), false, 'phrases are not joined with semicolons');
  assert.equal(/^[-*·]/mu.test(text), false);
  const fidelity = composeFidelityVerdict({ text, entries: [{ text: '说话温柔' }, { text: '喜欢安静' }] });
  assert.equal(fidelity.ok, true);
  console.log(`123) fallback="${text.replace(/\n/gu, ' ⏎ ')}" sentences=${text.split(/[。]/u).filter(Boolean).length}`);
});

test('124) 写回失败不静默：报错并记录 profile.writeback.failed，库与框不假装一致', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  profile.upsert({ side: 'agent', category: '说话方式', text: '说话温柔', clarity: 70, efficacy: 50, rank: 'original' });
  addMessage('m1', '你说话再温柔一点');
  runtime.candidates = [{ side: 'agent', category: '说话方式', text: '说话更温柔', message_ids: ['m1'] }];
  runtime.composeImpl = () => '你说话温柔。';
  const maintainer = make({
    boxes: true,
    writePersona: () => {
      throw new Error('settings file is read-only');
    },
  });

  const result = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(result.ok, false, 'the round fails instead of reporting a writeback it did not do');
  assert.match(String(result.error), /box write failed|read-only/u);
  const failure = events(PROFILE_WRITEBACK_FAILED_EVENT).at(-1);
  assert.equal(failure.payload.side, 'agent');
  assert.equal(failure.payload.stage, 'box-write');
  assert.match(String(failure.payload.error), /read-only/u);
  assert.equal(runtime.persona.agent, '', 'the box still holds the old text');
  assert.equal(events(PROFILE_WRITEBACK_EVENT).length, 0, 'no writeback is reported as done');
  console.log(`124) ok=${result.ok} error="${result.error}" failedEvent=${failure.payload.side}/${failure.payload.stage} box="${runtime.persona.agent}" writebackEvents=${events(PROFILE_WRITEBACK_EVENT).length}`);
});

test('125) 用户文本优先：保存后整理可写回；只有整理期间的新编辑才阻止旧结果覆盖', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.splitImpl = splitEcho;
  runtime.composeImpl = () => '你说话温柔，会慢慢接话。';
  const maintainer = make({ boxes: true });

  // A save BEFORE the round is imported, and the organize may rewrite the box (not blocked).
  const saved = await maintainer.save({ agent: '说话温柔' });
  assert.equal(saved.ok, true);
  const first = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(first.ok, true);
  assert.equal(runtime.persona.agent, '你说话温柔，会慢慢接话。', 'a saved box is synchronized and may be rewritten');

  // The user edits the box WHILE the round is composing: that newer edit wins over the old round.
  runtime.persona = { ...runtime.persona, agent: '说话温和' };
  assert.equal(maintainer.pendingSides().agent, true);
  runtime.composeImpl = () => {
    runtime.persona = { ...runtime.persona, agent: '说话更温柔' };
    return '你说话温柔，会慢慢接话。';
  };
  const second = await maintainer.now({ trigger: 'settings', writeBack: true });
  assert.equal(second.ok, true);
  assert.equal(runtime.persona.agent, '说话更温柔', 'the newer edit is never overwritten by the old rewrite');
  assert.equal(events(PROFILE_WRITEBACK_SKIPPED_EVENT).at(-1).payload.reason, 'user-edited');
  console.log(`125) saved→box="${'你说话温柔，会慢慢接话。'}" | during-round edit kept="${runtime.persona.agent}" skip=${events(PROFILE_WRITEBACK_SKIPPED_EVENT).at(-1).payload.reason}`);
});

test('126) 用户自述/澄清 → user 侧，仍是「用户在陈述」，不含「你不要…」', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const statement = '用户说某角色可爱只是观剧时的即时反应，不代表对现实人物或自身偏好的表态';
  addMessage('m1', statement);
  runtime.candidates = [{ side: 'user', category: '娱乐', text: statement, message_ids: ['m1'] }];
  const maintainer = make();
  const result = await maintainer.now();
  assert.equal(result.ok, true);
  const user = profile.list({ side: 'user' });
  assert.equal(user.length, 1);
  assert.equal(profile.list({ side: 'agent' }).length, 0, 'no rule is created on the persona side');
  assert.equal(user[0].side, 'user');
  assert.equal(user[0].text, statement, 'the user sentence is kept as written');
  assert.ok(user[0].text.startsWith('用户'), 'it still reads as the user stating a fact');
  assert.equal(user[0].text.includes('你不要'), false);
  assert.equal(isUserSelfDescription(statement), true);
  const restored = restoreUserStatement('你不要仅凭用户对动画角色的即时评价推断其喜好');
  assert.ok(restored.startsWith('用户'));
  assert.equal(restored.includes('你不要'), false);
  assert.match(restored, /不代表/u);
  assert.equal(
    classifyProfileEntrySide({ text: statement, side: 'user', category: '娱乐' }, [
      { name: '娱乐', parent: 'user' },
      { name: '人设参考', parent: 'agent' },
    ]),
    null,
    'a clarification never migrates to the persona side',
  );
  console.log(`126) side=${user[0].side} category=${user[0].category} text="${user[0].text}" hasRule=${user[0].text.includes('你不要')} selfDescription=${isUserSelfDescription(statement)}`);
});

test('127) 明确长期要求「以后说话都温柔点」→ agent 侧', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '以后说话都温柔点');
  runtime.candidates = [{ side: 'user', category: '说话方式', text: '以后说话都温柔点', message_ids: ['m1'] }];
  const result = await make().now();
  assert.equal(result.ok, true);
  const agent = profile.list({ side: 'agent' });
  assert.equal(agent.length, 1, 'an explicit lasting request becomes a persona entry');
  assert.equal(profile.list({ side: 'user' }).length, 0);
  assert.equal(agent[0].side, 'agent');
  assert.equal(agent[0].category, '说话方式');
  assert.match(agent[0].text, /以后说话都温柔点/u);
  assert.match(agent[0].text, /^你/u, 'the persona entry uses 你……');
  assert.equal(isExplicitLongTermRequest('以后说话都温柔点'), true);
  console.log(`127) side=${agent[0].side} category=${agent[0].category} text="${agent[0].text}" longTerm=${isExplicitLongTermRequest('以后说话都温柔点')}`);
});

test('128) 当次指令「这次简短点」→ 不新增 agent 条目', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '这次简短点');
  runtime.candidates = [{ side: 'agent', category: '说话方式', text: '这次简短点', message_ids: ['m1'] }];
  const result = await make().now();
  assert.equal(result.ok, true);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.dropped, 1, 'the one-off instruction is dropped, not filed');
  assert.equal(profile.list({ side: 'agent' }).length, 0);
  assert.equal(profile.list().length, 0, 'no bogus user entry is invented either');
  console.log(`128) added=${result.summary.added} dropped=${result.summary.dropped} agent=${profile.list({ side: 'agent' }).length} user=${profile.list({ side: 'user' }).length}`);
});

test('129) 归属不明 → 侧别不变（不迁移、不强化）', async (t) => {
  const { make } = await fresh(t);
  make();
  const categories = [
    { name: '人设参考', parent: 'agent' },
    { name: '说话方式', parent: 'agent' },
    { name: '娱乐', parent: 'user' },
    { name: '饮食', parent: 'user' },
  ];
  const ambiguous = '用户对那个角色有点在意';
  assert.equal(classifyProfileEntrySide({ text: ambiguous, side: 'user', category: '娱乐' }, categories), null);
  assert.equal(classifyProfileEntrySide({ text: ambiguous, side: 'agent', category: '人设参考' }, categories), null);
  assert.equal(isUserSelfDescription(ambiguous), false);
  // The clear persona preference still migrates (the earlier rule is not lost).
  const clear = classifyProfileEntrySide({ text: '用户喜欢温婉可爱的角色', side: 'user', category: '娱乐' }, categories);
  assert.equal(clear.side, 'agent');
  assert.equal(clear.category, '人设参考');
  console.log(`129) ambiguousSideKept=user|agent clearSide=${clear.side}/${clear.category}`);
});

test('130) 噪声预览 + 显式 removeNoise：临时测试条目消失，revision 记 cleanup', async (t) => {
  const { profile, make, events } = await fresh(t);
  const noisyTest = profile.upsert({ side: 'user', category: '生活习惯', text: '用户会频繁测试功能' }).entry;
  const noisyTts = profile.upsert({ side: 'agent', category: '说话方式', text: '让助手多说几句' }).entry;
  const real = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const maintainer = make();

  const preview = maintainer.previewNoise();
  const ids = preview.candidates.map((candidate) => candidate.entryId);
  assert.equal(preview.ok, true);
  assert.deepEqual(ids.sort(), [noisyTest.id, noisyTts.id].sort());
  assert.equal(preview.candidates.every((candidate) => candidate.reason === 'test-behavior'), true);
  assert.equal(noiseReason('用户会频繁测试功能'), 'test-behavior');
  assert.equal(noiseReason('用户喜欢喝无糖茶'), null);
  assert.equal(profile.list().length, 3, 'preview writes nothing');

  const refused = maintainer.removeNoise([noisyTest.id], { confirm: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'confirmation-required');
  assert.ok(profile.get(noisyTest.id), 'without confirmation the row is untouched');

  const removed = maintainer.removeNoise(ids);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 2);
  assert.equal(profile.get(noisyTest.id), null);
  assert.equal(profile.get(noisyTts.id), null);
  assert.ok(profile.get(real.id), 'a real preference is never touched');
  assert.deepEqual(profile.list().map((entry) => entry.id), [real.id]);
  const cleanupRevision = profile.revision(noisyTest.id)[0];
  assert.equal(cleanupRevision.source, PROFILE_CLEANUP_SOURCE);
  assert.equal(cleanupRevision.source, 'cleanup');
  assert.equal(cleanupRevision.after.removed, true);
  assert.equal(cleanupRevision.before.text, '用户会频繁测试功能');
  assert.equal(events(PROFILE_CLEANUP_EVENT).length, 2);
  console.log(`130) candidates=${ids.length} reasons=${preview.candidates.map((candidate) => candidate.reason).join(',')} removed=${removed.removed} remaining=${profile.list().length} revisionSource=${cleanupRevision.source} confirmationRequired=${refused.error}`);
});

test('131) 防御：agent 侧「你不要…」的 user 自述 → 自动移回 user 并记事件', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  const rule = '你不要仅凭用户对动画角色的即时评价推断其喜好';
  runtime.persona = { agent: rule, user: '' };
  runtime.splitImpl = () => [{ text: rule, side: 'agent', from: 'agent', category: '人设参考' }];
  runtime.composeImpl = ({ side, entries }) => (entries.length === 0
    ? ''
    : side === 'user'
      ? `${entries.map((entry) => entry.text).join('；')}`
      : entries.map((entry) => entry.text).join('；'));
  const maintainer = make({ boxes: true });
  assert.equal((await maintainer.split({ agent: rule, user: '' })).ok, true);
  const seeded = profile.list({ side: 'agent' })[0];
  assert.ok(seeded, 'the misplaced rule exists on the agent side');
  assert.equal(isMisplacedAgentRule(rule), true);

  addMessage('m1', '今天天气不错');
  runtime.candidates = [];
  const result = await maintainer.now();
  assert.equal(result.ok, true);
  const fixed = profile.get(seeded.id);
  assert.equal(fixed.side, 'user');
  assert.ok(fixed.text.startsWith('用户'), `the user voice is restored: ${fixed.text}`);
  assert.equal(fixed.text.includes('你不要'), false);
  assert.match(fixed.text, /即时评价/u);
  assert.match(fixed.text, /不代表/u);
  const misplaced = events(PROFILE_RECLASSIFY_EVENTS.misplaced);
  assert.equal(misplaced.length, 1);
  assert.deepEqual(misplaced[0].payload, {
    entryId: seeded.id, fromSide: 'agent', toSide: 'user', reason: 'user-self-description',
  });
  console.log(`131) side=${fixed.side} text="${fixed.text}" event=${misplaced[0].type}/${misplaced[0].payload.reason}`);
});

test('132) previewFixMisplaced + applyReclassify：原错误条目回画像，证据/数值不变', async (t) => {
  const { db, profile, make } = await fresh(t);
  const wrongText = '你不要仅凭用户对动画角色的即时评价推断其喜好';
  const originalText = '用户说某角色可爱只是观剧时的即时反应，不代表对现实人物或自身偏好的表态';
  const target = profile.upsert({
    side: 'agent', category: '人设参考', text: wrongText,
    clarity: 72, efficacy: 41, rank: 'candidate',
  }).entry;
  profile.addEvidence(target.id, { messageId: 'm-1' });
  const maintainer = make();
  db.prepare('INSERT INTO profile_revision (id, entry_id, before, after, at, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      'rev-move-to-agent',
      target.id,
      JSON.stringify({ side: 'user', category: '娱乐', text: originalText }),
      JSON.stringify({ side: 'agent', category: '人设参考' }),
      new Date(T0).toISOString(),
      'reclassify',
    );
  const before = reclassifySnapshot(profile, target.id);

  const fix = maintainer.previewFixMisplaced();
  assert.equal(fix.ok, true);
  assert.equal(fix.changes.length, 1);
  const change = fix.changes[0];
  assert.equal(change.entryId, target.id);
  assert.deepEqual(change.from, { side: 'agent', category: '人设参考' });
  assert.deepEqual(change.to, { side: 'user', category: '娱乐' });
  assert.equal(change.text, originalText);
  assert.ok(change.text.startsWith('用户'));
  assert.equal(change.text.includes('你不要'), false);
  assert.equal(profile.get(target.id).side, 'agent', 'the preview writes nothing');

  const result = await maintainer.applyReclassify(fix);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  const after = reclassifySnapshot(profile, target.id);
  assert.equal(after.side, 'user');
  assert.equal(after.category, '娱乐');
  assert.equal(after.text, originalText);
  assert.equal(after.clarity, before.clarity, 'clarity unchanged');
  assert.equal(after.efficacy, before.efficacy, 'efficacy unchanged');
  assert.equal(after.rank, before.rank, 'rank unchanged (no adoption)');
  assert.equal(after.supportCount, before.supportCount, 'no new support');
  assert.equal(after.evidence, before.evidence, 'evidence rows unchanged');
  const revision = profile.revision(target.id)[0];
  assert.equal(revision.source, 'reclassify');
  assert.equal(revision.after.side, 'user');
  assert.equal(revision.after.text, originalText);
  console.log(`132) changes=${fix.changes.length} from=${change.from.side}/${change.from.category} to=${change.to.side}/${change.to.category} text="${after.text}" C/E=${after.clarity}/${after.efficacy} rank=${after.rank} supports=${after.supportCount} evidence=${after.evidence}`);
});

// ---- fidelity of a rewrite: affect/object/condition are checked, keywords never prove it ----------

test('133) 反例「喜欢无糖茶」→「讨厌无糖茶」：确定性反义护栏判失败并回退源句', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢无糖茶' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户喜欢无糖茶', side: 'user', from: 'user', category: '饮食' }],
  });
  runtime.composeImpl = () => '用户讨厌无糖茶。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.user, '用户喜欢无糖茶。', 'the opposite rewrite is never written');
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected).at(-1);
  assert.equal(rejected.payload.reason, 'fidelity');
  assert.equal(rejected.payload.detail, 'antonym');
  assert.equal(runtime.verifyCalls.length, 0, 'the deterministic guard rejects before any model call');
  const verdict = composeAntonymVerdict({
    text: '用户讨厌无糖茶',
    entries: [{ text: '用户喜欢无糖茶' }],
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    { group: verdict.group, object: verdict.object, source: verdict.source, rewritten: verdict.rewritten },
    { group: 'like', object: '无糖茶', source: ['positive'], rewritten: ['negative'] },
  );
  console.log(`133) box="${runtime.persona.user}" rejected=${rejected.payload.reason}/${rejected.payload.detail} source=${verdict.source} rewritten=${verdict.rewritten} verifyCalls=${runtime.verifyCalls.length}`);
});

test('134) 反例「不喜欢甜食但喜欢辣食」对调：按对象判极性相反，回退源句', async (t) => {
  const { runtime, make, events } = await fresh(t);
  const source = '用户不喜欢甜食但喜欢辣食';
  runtime.persona = { agent: '', user: source };
  runtime.splitImpl = () => ({
    entries: [{ text: source, side: 'user', from: 'user', category: '饮食' }],
  });
  runtime.composeImpl = () => '用户喜欢甜食但不喜欢辣食。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.user, `${source}。`, 'the swapped attitudes fall back to the source sentence');
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected).at(-1);
  assert.equal(rejected.payload.reason, 'fidelity');
  assert.equal(rejected.payload.detail, 'antonym');
  const checked = validateComposeText({
    side: 'user',
    text: '用户喜欢甜食但不喜欢辣食。',
    entries: [{ text: source }],
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.detail, 'antonym');
  console.log(`134) box="${runtime.persona.user}" rejected=${rejected.payload.reason}/${rejected.payload.detail} directOk=${checked.ok} object="${checked.object}" source=${checked.source} rewritten=${checked.rewritten}`);
});

test('135) 忠实改写「你说话温柔自然」→「你说话温柔，语气自然」：通过，不误杀', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '你说话温柔自然', user: '' };
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔自然', side: 'agent', from: 'agent', category: '说话方式' }],
  });
  runtime.composeImpl = () => '你说话温柔，语气自然。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.agent, '你说话温柔，语气自然。', 'the faithful rewrite is kept');
  assert.equal(runtime.verifyCalls.length, 1, 'a rewording is always semantically checked');
  assert.equal(events(PROFILE_COMPOSE_EVENTS.rejected).length, 0, 'nothing is rejected');
  assert.equal(
    composeReworded([{ text: '你说话温柔自然' }], '你说话温柔，语气自然。'),
    true,
    'punctuation/whitespace alone is not a rewrite; the added 语气 is',
  );
  console.log(`135) box="${runtime.persona.agent}" verifyCalls=${runtime.verifyCalls.length} rejected=${events(PROFILE_COMPOSE_EVENTS.rejected).length} reworded=${composeReworded([{ text: '你说话温柔自然' }], '你说话温柔，语气自然。')}`);
});

test('136) 语义核对抛错/超时：判不确认并回退源句，不放行改写', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '你说话温柔自然', user: '' };
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔自然', side: 'agent', from: 'agent', category: '说话方式' }],
  });
  runtime.composeImpl = () => '你说话温柔，语气自然。';
  const maintainer = make({
    boxes: true,
    verifyCompose: async () => {
      throw new Error('semantic verify timeout');
    },
  });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.agent, '你说话温柔自然。', 'a thrown/timed-out check never writes the rewrite');
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected).at(-1);
  assert.equal(rejected.payload.reason, 'unverified');
  assert.equal(rejected.payload.detail, 'verify-failed');
  console.log(`136) box="${runtime.persona.agent}" rejected=${rejected.payload.reason}/${rejected.payload.detail}`);
});

test('137) 无轻量通道（无 verify、无 assist）：改写一律回退源句，不放行', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '你说话温柔自然', user: '' };
  runtime.splitImpl = () => ({
    entries: [{ text: '你说话温柔自然', side: 'agent', from: 'agent', category: '说话方式' }],
  });
  runtime.composeImpl = () => '你说话温柔，语气自然。';
  const maintainer = make({ boxes: true, verifyCompose: null });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.agent, '你说话温柔自然。', 'without a channel the source sentences are written');
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected).at(-1);
  assert.equal(rejected.payload.reason, 'unverified');
  assert.equal(rejected.payload.detail, 'no-channel');
  console.log(`137) box="${runtime.persona.agent}" rejected=${rejected.payload.reason}/${rejected.payload.detail}`);
});

test('138) 条件改变「学习时喜欢安静」→「工作时喜欢安静」：确定性判失败（不依赖模型）', async (t) => {
  const { runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户学习时喜欢安静' };
  runtime.splitImpl = () => ({
    entries: [{ text: '用户学习时喜欢安静', side: 'user', from: 'user', category: '生活习惯' }],
  });
  runtime.composeImpl = () => '用户工作时喜欢安静。';
  const maintainer = make({ boxes: true });

  const result = await maintainer.now({ trigger: 'settings' });
  assert.equal(result.ok, true);
  assert.equal(runtime.persona.user, '用户学习时喜欢安静。', 'the changed condition falls back to the source');
  const rejected = events(PROFILE_COMPOSE_EVENTS.rejected).at(-1);
  assert.equal(rejected.payload.reason, 'fidelity');
  assert.equal(rejected.payload.detail, 'condition');
  const checked = validateComposeText({
    side: 'user',
    text: '用户工作时喜欢安静。',
    entries: [{ text: '用户学习时喜欢安静' }],
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.detail, 'condition');
  console.log(`138) box="${runtime.persona.user}" rejected=${rejected.payload.reason}/${rejected.payload.detail} directOk=${checked.ok}`);
});

// ---- evidence identity wired into extraction / strengthening --------------------------------

const ledgerCount = (db) => db.prepare('SELECT COUNT(*) AS c FROM profile_evidence_identity').get().c;

test('139) 同一条消息换两种措辞提取 → 只强化一次（C/E 只加一次）', async (t) => {
  const { db, profile, runtime, addMessage, make } = await fresh(t);
  const entry = profile.upsert({ side: 'user', category: '娱乐', text: '喜欢快歌' }).entry;
  addMessage('m1', '我喜欢快歌', { sessionId: 's-139', turn: 1 });
  runtime.candidates = [
    { side: 'user', category: '娱乐', text: '喜欢快歌。', message_ids: ['m1'] },
    { side: 'user', category: '娱乐', text: ' 喜欢快歌 ', message_ids: ['m1'] },
  ];

  const result = await make().now();
  const stored = profile.get(entry.id);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.updated, 1, 'the two wordings strengthen one entry');
  assert.equal(profile.list().length, 1, 'no duplicate entry is created');
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53], 'one support: C+10 / E+3');
  assert.equal(stored.evidence_count, 1);
  assert.equal(profile.evidence(entry.id).length, 1, 'm1 is stored once');
  assert.equal(profile.supportCount(entry.id), 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`139) added=${result.summary.added} updated=${result.summary.updated} C/E=${stored.clarity}/${stored.efficacy} evidence=${profile.evidence(entry.id).length} ledger=${ledgerCount(db)}`);
});

test('140) 同会话同轮跨批 / 重启 / 超过 500 对历史后重放 → 不重复加分', async (t) => {
  const { db, profile, runtime, addMessage, make } = await fresh(t);
  const entry = profile.upsert({
    side: 'agent', category: '语言', text: '说话简短', clarity: 50, efficacy: 50, rank: 'original',
  }).entry;
  addMessage('m1', '我希望你说话简短', { sessionId: 's-140', turn: 7, at: T0 - 5000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  const first = make();
  assert.equal((await first.now()).summary.updated, 1);
  assert.equal(profile.get(entry.id).clarity, 60);

  // Same session/turn, next batch, different message id: a replay of the same exchange.
  addMessage('m2', '对，简短一点', { sessionId: 's-140', turn: 7, at: T0 - 4000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m2'] }];
  const replay = await first.now();
  assert.equal(replay.summary.updated, 0, 'the ledger reports a duplicate, not an update');
  assert.equal(profile.get(entry.id).clarity, 60);

  // New process instance (restart) + >500 legacy (entry, exchange) pairs already in state:
  // the old cache is not consulted, so evicting a pair cannot re-open scoring.
  const restarted = make();
  restarted.setState({
    seenExchanges: Array.from({ length: 500 }, (_, index) => `entry-${index}\nexchange-${index}`),
  });
  addMessage('m3', '还是简短点好', { sessionId: 's-140', turn: 7, at: T0 - 3000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m3'] }];
  const afterRestart = await restarted.now();
  assert.equal(afterRestart.summary.updated, 0, 'the persisted ledger blocks the replay after a restart');

  addMessage('m4', '嗯，就这样', { sessionId: 's-140', turn: 7, at: T0 - 2000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m4'] }];
  const afterCacheEviction = await restarted.now();
  assert.equal(afterCacheEviction.summary.updated, 0, 'the 500-pair cache boundary no longer decides scoring');

  const stored = profile.get(entry.id);
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53], 'C/E changed exactly once');
  assert.equal(stored.evidence_count, 1);
  assert.equal(profile.evidence(entry.id).length, 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`140) replay=${replay.summary.updated} afterRestart=${afterRestart.summary.updated} afterEviction=${afterCacheEviction.summary.updated} C/E=${stored.clarity}/${stored.efficacy} evidence=${profile.evidence(entry.id).length} ledger=${ledgerCount(db)}`);
});

test('141) 条件不同（学习时 / 工作时）→ 不合并，分别建条目', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const study = '用户学习的时候喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const work = '用户工作的时候喜欢一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  addMessage('m1', '学习的时候我喜欢安静听歌', { sessionId: 's-141', turn: 1, at: T0 - 3000 });
  addMessage('m2', '上班时也一样，安静听歌', { sessionId: 's-141', turn: 2, at: T0 - 2000 });
  runtime.candidates = [
    { side: 'user', category: '生活习惯', text: study, message_ids: ['m1'] },
    { side: 'user', category: '生活习惯', text: work, message_ids: ['m2'] },
  ];

  const result = await make().now();
  const entries = profile.list({ side: 'user' });
  assert.equal(result.summary.added, 2, 'different conditions are two tendencies');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.text).sort(), [study, work].sort());
  for (const entry of entries) {
    assert.equal(profile.supportCount(entry.id), 1);
    assert.deepEqual([entry.clarity, entry.efficacy], [60, 53]);
  }
  console.log(`141) added=${result.summary.added} entries=${entries.length} texts=${entries.map((entry) => entry.text.length).join(',')} supports=${entries.map((entry) => profile.supportCount(entry.id)).join(',')}`);
});

test('142) 否定不同（喜欢 / 不喜欢）→ 不合并', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  const like = '用户喜欢在周末的下午一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  const dislike = '用户不喜欢在周末的下午一个人安静地待在房间里听一些节奏比较轻快、旋律比较好听的歌曲';
  addMessage('m1', '周末我喜欢安静听歌', { sessionId: 's-142', turn: 1, at: T0 - 3000 });
  addMessage('m2', '不过周末我倒不喜欢安静听歌', { sessionId: 's-142', turn: 2, at: T0 - 2000 });
  runtime.candidates = [
    { side: 'user', category: '娱乐', text: like, message_ids: ['m1'] },
    { side: 'user', category: '娱乐', text: dislike, message_ids: ['m2'] },
  ];

  const result = await make().now();
  const entries = profile.list({ side: 'user' });
  assert.equal(result.summary.added, 2, 'polarity is part of the tendency identity');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.text).sort(), [like, dislike].sort());
  assert.equal(profile.supportCount(entries[0].id), 1);
  assert.equal(profile.supportCount(entries[1].id), 1);
  console.log(`142) added=${result.summary.added} entries=${entries.length} supports=${entries.map((entry) => profile.supportCount(entry.id)).join(',')} C=${entries.map((entry) => entry.clarity).join(',')}`);
});

test('143) 提取返回 entryId 且归属正确 → 强化已有条目，不新建', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  const entry = profile.upsert({ side: 'user', category: '娱乐', text: '喜欢快歌' }).entry;
  addMessage('m1', '我还是喜欢快歌', { sessionId: 's-143', turn: 1 });
  runtime.candidates = [{
    side: 'user', category: '娱乐', text: '喜欢快歌。', entryId: entry.id, message_ids: ['m1'],
  }];

  const result = await make().now();
  const stored = profile.get(entry.id);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.updated, 1);
  assert.equal(profile.list().length, 1, 'the verified entryId reuses the row');
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53]);
  assert.equal(profile.supportCount(entry.id), 1);
  assert.equal(events(PROFILE_EXTRACT_MISMATCH_EVENT).length, 0);
  console.log(`143) added=${result.summary.added} updated=${result.summary.updated} entries=${profile.list().length} C/E=${stored.clarity}/${stored.efficacy} mismatch=0`);
});

test('144) entryId 不存在 / 归属错误 → 新候选 + mismatch 事件', async (t) => {
  const { profile, runtime, addMessage, make, events } = await fresh(t);
  const userEntry = profile.upsert({ side: 'user', category: '饮食', text: '喜欢冰美式' }).entry;
  addMessage('m1', '以后回复简短点', { sessionId: 's-144', turn: 1, at: T0 - 3000 });
  addMessage('m2', '说话温柔点吧', { sessionId: 's-144', turn: 2, at: T0 - 2000 });
  runtime.candidates = [
    {
      side: 'agent', category: '说话方式', text: '回复简短', entryId: 'missing-entry-id', message_ids: ['m1'],
    },
    {
      side: 'agent', category: '说话方式', text: '说话温柔', entryId: userEntry.id, message_ids: ['m2'],
    },
  ];

  const result = await make().now();
  const mismatches = events(PROFILE_EXTRACT_MISMATCH_EVENT);
  assert.equal(result.summary.added, 2, 'a failed claim is filed as a new candidate');
  assert.equal(mismatches.length, 2);
  assert.deepEqual(mismatches.map((event) => event.payload.reason).sort(), ['missing', 'side']);
  assert.deepEqual(
    mismatches.map((event) => event.payload.entryId).sort((left, right) => String(left).localeCompare(String(right))),
    [userEntry.id, 'missing-entry-id'].sort((left, right) => String(left).localeCompare(String(right))),
  );
  const agent = profile.list({ side: 'agent' });
  assert.equal(agent.length, 2);
  assert.deepEqual(agent.map((entry) => entry.text).sort(), ['回复简短', '说话温柔'].sort());
  // The wrongly claimed entry was never strengthened.
  assert.equal(profile.get(userEntry.id).evidence_count, 0);
  assert.equal(profile.supportCount(userEntry.id), 0);
  console.log(`144) added=${result.summary.added} mismatch=${mismatches.length} reasons=${mismatches.map((event) => event.payload.reason).join(',')} agent=${agent.length} claimedEvidence=${profile.evidence(userEntry.id).length}`);
});

test('145) 删除后旧证据重放被拒并记 deleted；新表达按新候选，不继承旧分', async (t) => {
  const { clock, db, profile, runtime, addMessage, make, events } = await fresh(t);
  const entry = profile.upsert({ side: 'user', category: '饮食', text: '喜欢热茶' }).entry;
  addMessage('m-old-1', '我其实喜欢热茶', { sessionId: 's-145', turn: 1, at: T0 - 5000 });
  addMessage('m-old-2', '嗯，热茶不错', { sessionId: 's-145', turn: 2, at: T0 - 4000 });
  runtime.candidates = [{
    side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m-old-1', 'm-old-2'],
  }];
  const maintainer = make();
  await maintainer.now();
  assert.equal(profile.get(entry.id).clarity, 70, 'two supports before the deletion');
  assert.equal(profile.evidence(entry.id).length, 2);

  // Explicit removal through the store boundary (not the maintainer's in-state ledger): the
  // deleted_persona row is now the authoritative memory of this evidence.
  assert.equal(profile.remove(entry.id), true);
  maintainer.setState({ cursor: null });
  runtime.candidates = [{
    side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m-old-1', 'm-old-2'],
  }];
  const replay = await maintainer.now();
  const deleted = events(PROFILE_EVIDENCE_DELETED_EVENT);
  assert.equal(replay.summary.added, 0, 'the deleted tendency is not rebuilt from old evidence');
  assert.equal(replay.summary.dropped, 1);
  assert.equal(profile.list().length, 0);
  assert.equal(deleted.length, 2, 'both old evidence keys are refused');
  assert.equal(ledgerCount(db), 0, 'no ledger row was written for the refused evidence');

  // A genuinely new expression after the deletion is a new candidate with neutral scores.
  clock.ms += 60_000;
  addMessage('m-new', '今天也想喝热茶', { sessionId: 's-145', turn: 3, at: clock.ms - 1000 });
  runtime.candidates = [{ side: 'user', category: '饮食', text: '喜欢热茶', message_ids: ['m-new'] }];
  const rebuilt = await maintainer.now();
  const freshEntry = profile.list({ side: 'user' })[0];
  assert.equal(rebuilt.summary.added, 1);
  assert.notEqual(freshEntry.id, entry.id, 'a new row, not the deleted one');
  assert.deepEqual([freshEntry.clarity, freshEntry.efficacy], [60, 53], 'one new support, old C=70 is not inherited');
  assert.equal(profile.supportCount(freshEntry.id), 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`145) replayAdded=${replay.summary.added} deleted=${deleted.length} newAdded=${rebuilt.summary.added} newC/E=${freshEntry.clarity}/${freshEntry.efficacy} support=${profile.supportCount(freshEntry.id)} ledger=${ledgerCount(db)}`);
});

test('146) 事务失败 → 证据 / 账本 / 评分 / 快照完整回滚', async (t) => {
  const { profile, runtime, addMessage, make } = await fresh(t);
  addMessage('m1', '我希望你说话简短', { sessionId: 's-146', turn: 1 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  const maintainer = make();
  const beforeVersion = profile.libraryVersion();
  const realWriteRankScores = profile.writeRankScores;
  profile.writeRankScores = () => {
    throw new Error('profile rollback boom');
  };
  let result;
  try {
    result = await maintainer.now();
  } finally {
    profile.writeRankScores = realWriteRankScores;
  }

  assert.equal(result.ok, false);
  assert.match(result.error, /profile rollback boom/u);
  assert.equal(profile.list().length, 0, 'the inserted entry rolled back');
  assert.equal(ledgerCount(profile.db), 0, 'no evidence ledger row survived');
  assert.equal(profile.db.prepare('SELECT COUNT(*) AS c FROM profile_evidence').get().c, 0);
  assert.equal(profile.libraryVersion(), beforeVersion);
  assert.equal(maintainer.snapshot(), null, 'no snapshot was written');
  assert.equal(maintainer.state.cursor, undefined, 'the cursor did not advance');
  assert.equal(maintainer.state.lastRunAt, undefined);
  console.log(`146) ok=${result.ok} error="${result.error}" entries=${profile.list().length} ledger=${ledgerCount(profile.db)} snapshot=${maintainer.snapshot()} cursor=${maintainer.state.cursor}`);
});

test('147) 缺轮次身份时回退 messageId：同一 message 重放不重复加分', async (t) => {
  const { db, profile, runtime, addMessage, make } = await fresh(t);
  const entry = profile.upsert({
    side: 'agent', category: '语言', text: '说话简短', clarity: 50, efficacy: 50, rank: 'original',
  }).entry;
  // No sessionId/turn on the source row: the store must fall back to the message id.
  addMessage('m1', '简洁一点', { at: T0 - 3000 });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  const maintainer = make();
  await maintainer.now();
  assert.deepEqual([profile.get(entry.id).clarity, profile.get(entry.id).efficacy], [60, 53]);

  // Replay the same backlog entry (cursor reset) with no turn identity.
  maintainer.setState({ cursor: null });
  runtime.candidates = [{ side: 'agent', category: '语言', text: '说话简短', message_ids: ['m1'] }];
  const replay = await maintainer.now();
  const stored = profile.get(entry.id);
  assert.equal(replay.summary.updated, 0);
  assert.deepEqual([stored.clarity, stored.efficacy], [60, 53], 'the message-id fallback blocks the second score');
  assert.equal(profile.evidence(entry.id).length, 1);
  assert.equal(ledgerCount(db), 1);
  console.log(`147) replayUpdated=${replay.summary.updated} C/E=${stored.clarity}/${stored.efficacy} evidence=${profile.evidence(entry.id).length} ledger=${ledgerCount(db)}`);
});

test('148) 逐条预览：噪声 → kind=noise/suggested=delete，普通 → keep，inBox 区分框内/仅库', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  const noisy = profile.upsert({ side: 'user', category: '生活习惯', text: '用户会频繁测试功能' }).entry;
  const inBox = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const onlyLibrary = profile.upsert({ side: 'user', category: '娱乐', text: '用户喜欢看悬疑电影' }).entry;
  // The model even proposes a move for the noise row: the host's noise rule must win (delete).
  const maintainer = make({
    boxes: true,
    reclassify: async () => ({ changes: [{ entryId: noisy.id, side: 'agent', category: '人设参考' }] }),
  });
  const plan = await maintainer.previewReclassify();
  assert.equal(plan.ok, true);
  assert.equal(plan.total, 3);
  assert.equal(plan.noise, 1, 'one testing-behaviour row');
  assert.equal(plan.inBoxOnly, 2, 'two rows exist only in the library');
  const byId = new Map(plan.items.map((item) => [item.entryId, item]));
  assert.equal(byId.get(noisy.id).kind, 'noise');
  assert.equal(byId.get(noisy.id).suggested, 'delete', 'noise is always a delete suggestion');
  assert.equal(byId.get(noisy.id).to, null);
  assert.equal(byId.get(noisy.id).inBox, false, 'the noise row is not in the box');
  assert.equal(byId.get(inBox.id).kind, 'normal');
  assert.equal(byId.get(inBox.id).suggested, 'keep');
  assert.equal(byId.get(inBox.id).inBox, true, 'the mapped/visible row is 框内');
  assert.equal(byId.get(onlyLibrary.id).kind, 'normal');
  assert.equal(byId.get(onlyLibrary.id).suggested, 'keep');
  assert.equal(byId.get(onlyLibrary.id).inBox, false, 'a library-only row is 仅库');
  assert.deepEqual(events(PROFILE_RECLASSIFY_EVENTS.preview).at(-1).payload, { total: 3, noise: 1, inBoxOnly: 2 });
  console.log(`148) total=${plan.total} noise=${plan.noise} inBoxOnly=${plan.inBoxOnly} noisy=${byId.get(noisy.id).kind}/${byId.get(noisy.id).suggested} inBox=${byId.get(inBox.id).inBox} onlyLibrary=${byId.get(onlyLibrary.id).inBox}`);
});

test('149) 逐条应用：只删除选中项，其余条目与 revision source=reclassify 正确', async (t) => {
  const { profile, make, events } = await fresh(t);
  const noisy = profile.upsert({ side: 'user', category: '生活习惯', text: '用户会频繁测试功能' }).entry;
  const otherNoise = profile.upsert({ side: 'user', category: '生活习惯', text: '用户会反复更换语音合成' }).entry;
  const normal = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  profile.addEvidence(noisy.id, { messageId: 'm-noise-1' });
  profile.addEvidence(noisy.id, { messageId: 'm-noise-2' });
  const maintainer = make({ reclassify: async () => ({ changes: [] }) });
  await maintainer.previewReclassify();
  const result = await maintainer.applyReclassifySelection({ deletes: [noisy.id] });
  assert.equal(result.ok, true);
  assert.equal(result.moved, 0);
  assert.equal(result.deleted, 1);
  assert.equal(result.skipped, 0);
  assert.equal(profile.get(noisy.id), null, 'only the selected row is deleted');
  assert.notEqual(profile.get(otherNoise.id), null, 'an unselected noise row stays untouched');
  assert.notEqual(profile.get(normal.id), null, 'an unselected normal row stays untouched');
  assert.equal(profile.revision(noisy.id)[0].source, 'reclassify');
  assert.deepEqual(profile.revision(noisy.id)[0].after, { removed: true });
  assert.deepEqual(events(PROFILE_RECLASSIFY_EVENTS.applied).at(-1).payload, { moved: 0, deleted: 1 });
  // The applied row is gone from the next preview: no remembered decision is needed.
  const next = await maintainer.previewReclassify();
  assert.equal(next.items.some((item) => item.entryId === noisy.id), false);
  console.log(`149) moved=${result.moved} deleted=${result.deleted} skipped=${result.skipped} remaining=${profile.list().length} revision=${profile.revision(noisy.id)[0].source}`);
});

test('150) 逐条应用 moves：side/category 改变，证据/数值/身份不变', async (t) => {
  const { profile, make, events } = await fresh(t);
  const target = profile.upsert({
    side: 'user', category: '说话方式', text: '用户会先安静地听完',
    clarity: 66, efficacy: 38, rank: 'new',
  }).entry;
  profile.addEvidence(target.id, { messageId: 'm-move-1' });
  profile.addEvidence(target.id, { messageId: 'm-move-2' });
  const before = reclassifySnapshot(profile, target.id);
  const maintainer = make({
    reclassify: async () => ({ changes: [{ entryId: target.id, side: 'agent', category: '说话方式' }] }),
  });
  const plan = await maintainer.previewReclassify();
  const row = plan.items.find((item) => item.entryId === target.id);
  assert.equal(row.suggested, 'move');
  assert.deepEqual(row.to, { side: 'agent', category: '说话方式' });
  const result = await maintainer.applyReclassifySelection({
    moves: [{ id: target.id, side: 'agent', category: '说话方式' }],
  }, { expectedVersion: plan.version });
  assert.equal(result.ok, true);
  assert.equal(result.moved, 1);
  assert.equal(result.deleted, 0);
  const after = reclassifySnapshot(profile, target.id);
  assert.equal(after.side, 'agent');
  assert.equal(after.category, '说话方式');
  assert.equal(after.text.startsWith('你'), true, 'the cross-side pronoun prefix is normalized');
  assert.equal(after.clarity, before.clarity);
  assert.equal(after.efficacy, before.efficacy);
  assert.equal(after.rank, before.rank);
  assert.equal(after.supportCount, before.supportCount);
  assert.equal(after.evidence, before.evidence);
  assert.equal(profile.revision(target.id)[0].source, 'reclassify');
  assert.deepEqual(events(PROFILE_RECLASSIFY_EVENTS.applied).at(-1).payload, { moved: 1, deleted: 0 });
  // The same model suggestion is already satisfied: the next preview lists the row as keep.
  const next = await maintainer.previewReclassify();
  assert.equal(next.items.find((item) => item.entryId === target.id).suggested, 'keep');
  console.log(`150) side=${after.side} category=${after.category} text="${after.text}" C/E=${after.clarity}/${after.efficacy} supports=${after.supportCount} evidence=${after.evidence}`);
});

test('151) 失效 id：moves/deletes 计数为 skipped，不抛错、不写别的条目', async (t) => {
  const { profile, make } = await fresh(t);
  const live = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const gone = profile.upsert({ side: 'user', category: '娱乐', text: '用户喜欢看悬疑电影' }).entry;
  profile.remove(gone.id);
  const maintainer = make({ reclassify: async () => ({ changes: [] }) });
  const result = await maintainer.applyReclassifySelection({
    moves: [{ id: 'missing-entry', side: 'agent', category: '人设参考' }, { id: live.id, side: 'nope', category: '饮食' }],
    deletes: ['missing-entry', gone.id],
  });
  assert.equal(result.ok, true);
  assert.equal(result.moved, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, 4, 'two move ids (missing + bad target) + two delete ids');
  assert.notEqual(profile.get(live.id), null, 'a valid live row mentioned with a bad target survives');
  assert.equal(profile.revision(live.id).length, 0, 'no write happened for a skipped row');
  console.log(`151) ok=${result.ok} moved=${result.moved} deleted=${result.deleted} skipped=${result.skipped} live=${profile.get(live.id) !== null}`);
});

// ---- 152-158: 「库编辑」 entry actions ------------------------------------------------------

test('152) 库编辑列表：每条返回 id/text/side/category/inBox（框内 vs 仅库）', async (t) => {
  const { profile, runtime, make } = await fresh(t);
  const inBox = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const libraryOnly = profile.upsert({ side: 'user', category: '饮食', text: '用户不吃香菜' }).entry;
  const agentEntry = profile.upsert({ side: 'agent', category: '形象', text: '你是一名妹系角色' }).entry;
  runtime.persona = { agent: '你是一名妹系角色', user: '用户喜欢喝无糖茶' };
  const maintainer = make({ boxes: true });
  maintainer.markBoxesAuthoritative();
  const at = new Date(T0).toISOString();
  maintainer.writeSnapshot('', 0, 1, at, [
    { entryId: agentEntry.id, text: agentEntry.text },
    { entryId: inBox.id, text: inBox.text },
  ]);
  maintainer.setState({ syncedText: { agent: runtime.persona.agent, user: runtime.persona.user } });

  const rows = maintainer.entryList();
  assert.equal(rows.length, 3, 'every live entry is listed once');
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId.get(inBox.id), {
    id: inBox.id, text: '用户喜欢喝无糖茶', side: 'user', category: '饮食', inBox: true,
  });
  assert.equal(byId.get(agentEntry.id).inBox, true);
  assert.equal(byId.get(libraryOnly.id).inBox, false, 'a row the box does not contain is 仅库');
  assert.deepEqual(Object.keys(byId.get(libraryOnly.id)).sort(), ['category', 'id', 'inBox', 'side', 'text']);
  console.log(`152) rows=${rows.length} inBox=${byId.get(inBox.id).inBox} agent=${byId.get(agentEntry.id).inBox} libraryOnly=${byId.get(libraryOnly.id).inBox}`);
});

test('153) 改文本：只改 text，C/E/证据/rank 不变，无新证据，revision=user-edit', async (t) => {
  const { profile, runtime, make, events } = await fresh(t);
  const entry = profile.upsert({
    side: 'user', category: '饮食', text: '用户喜欢喝无糖茶', clarity: 72, efficacy: 41, rank: 'candidate',
  }).entry;
  profile.addEvidence(entry.id, { messageId: 'm-edit-1' });
  const before = reclassifySnapshot(profile, entry.id);
  runtime.persona = { agent: '', user: '用户喜欢喝无糖茶' };
  const maintainer = make({ boxes: true });

  const result = maintainer.updateEntryText({ id: entry.id, text: '用户只喝无糖茶' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = reclassifySnapshot(profile, entry.id);
  assert.equal(after.text, '用户只喝无糖茶');
  assert.equal(after.clarity, before.clarity, 'C unchanged');
  assert.equal(after.efficacy, before.efficacy, 'E unchanged');
  assert.equal(after.rank, before.rank, 'rank unchanged');
  assert.equal(after.supportCount, before.supportCount, 'no strengthening');
  assert.equal(after.evidence, before.evidence, 'no new evidence row');
  const [revision] = profile.revision(entry.id);
  assert.equal(revision.source, PROFILE_ENTRY_EDIT_SOURCE);
  assert.deepEqual(revision.before, { text: '用户喜欢喝无糖茶' });
  assert.deepEqual(revision.after, { text: '用户只喝无糖茶' });
  assert.deepEqual(events(PROFILE_ENTRY_EVENTS.updated).at(-1).payload, { id: entry.id, field: 'text' });
  assert.equal(runtime.writeCalls.length, 0, '库编辑 never rewrites the text boxes');
  assert.equal(maintainer.entryList().find((row) => row.id === entry.id).inBox, false, 'edited text is 仅库 until the next organize');
  console.log(`153) text="${after.text}" C/E=${after.clarity}/${after.efficacy} rank=${after.rank} supports=${after.supportCount} evidence=${after.evidence} revision=${revision.source} writes=${runtime.writeCalls.length}`);
});

test('154) 换分类（同父级）：只改 category，文本/证据/数值/rank 不变', async (t) => {
  const { profile, make, events } = await fresh(t);
  const entry = profile.upsert({
    side: 'user', category: '饮食', text: '用户喜欢看悬疑电影', clarity: 64, efficacy: 39, rank: 'new',
  }).entry;
  profile.addEvidence(entry.id, { messageId: 'm-cat-1' });
  const before = reclassifySnapshot(profile, entry.id);
  const maintainer = make();
  const result = maintainer.setEntryCategory({ id: entry.id, category: '娱乐' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = reclassifySnapshot(profile, entry.id);
  assert.equal(after.side, 'user', 'same parent keeps the side');
  assert.equal(after.category, '娱乐');
  assert.equal(after.text, before.text);
  assert.equal(after.clarity, before.clarity);
  assert.equal(after.efficacy, before.efficacy);
  assert.equal(after.rank, before.rank);
  assert.equal(after.supportCount, before.supportCount);
  const [revision] = profile.revision(entry.id);
  assert.equal(revision.source, PROFILE_ENTRY_EDIT_SOURCE);
  assert.deepEqual(revision.before, { side: 'user', category: '饮食' });
  assert.deepEqual(revision.after, { side: 'user', category: '娱乐' });
  assert.deepEqual(events(PROFILE_ENTRY_EVENTS.updated).at(-1).payload, { id: entry.id, field: 'category' });
  console.log(`154) side=${after.side} category=${after.category} C/E=${after.clarity}/${after.efficacy} supports=${after.supportCount} revision=${revision.source}`);
});

test('155) 换分类（跨父级）：side 与 category 同时改，证据/数值/rank/文本不变', async (t) => {
  const { profile, make, events } = await fresh(t);
  const entry = profile.upsert({
    side: 'user', category: '饮食', text: '用户说话时会先安静听完', clarity: 66, efficacy: 38, rank: 'candidate',
  }).entry;
  profile.addEvidence(entry.id, { messageId: 'm-side-1' });
  const before = reclassifySnapshot(profile, entry.id);
  const maintainer = make();
  const result = maintainer.setEntryCategory({ id: entry.id, category: '说话方式' });
  assert.equal(result.ok, true);
  const after = reclassifySnapshot(profile, entry.id);
  assert.equal(after.side, 'agent', 'the category parent owns the side');
  assert.equal(after.category, '说话方式');
  assert.equal(after.text, before.text, 'the category pick never edits the content');
  assert.equal(after.clarity, before.clarity);
  assert.equal(after.efficacy, before.efficacy);
  assert.equal(after.rank, before.rank);
  assert.equal(after.supportCount, before.supportCount);
  assert.equal(after.evidence, before.evidence);
  const [revision] = profile.revision(entry.id);
  assert.equal(revision.source, PROFILE_ENTRY_EDIT_SOURCE);
  assert.deepEqual(revision.before, { side: 'user', category: '饮食' });
  assert.deepEqual(revision.after, { side: 'agent', category: '说话方式' });
  assert.deepEqual(events(PROFILE_ENTRY_EVENTS.updated).at(-1).payload, { id: entry.id, field: 'category' });
  console.log(`155) side=${after.side} category=${after.category} text="${after.text}" C/E=${after.clarity}/${after.efficacy} evidence=${after.evidence}`);
});

test('156) 未知分类拒绝：reason=unknown-category，条目不写、无 revision', async (t) => {
  const { profile, make, events } = await fresh(t);
  const entry = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  const maintainer = make();
  const refused = maintainer.setEntryCategory({ id: entry.id, category: '不存在的分类' });
  assert.deepEqual(refused, { ok: false, reason: 'unknown-category' });
  assert.equal(profile.get(entry.id).category, '饮食');
  assert.equal(profile.get(entry.id).side, 'user');
  assert.equal(profile.revision(entry.id).length, 0, 'a refused change writes no revision');
  assert.equal(events(PROFILE_ENTRY_EVENTS.updated).length, 0, 'a refused change emits no event');
  const missing = maintainer.setEntryCategory({ id: 'missing', category: '饮食' });
  assert.deepEqual(missing, { ok: false, reason: 'unknown-entry' });
  console.log(`156) unknown=${JSON.stringify(refused)} missing=${JSON.stringify(missing)} category=${profile.get(entry.id).category} revisions=${profile.revision(entry.id).length}`);
});

test('157) 删除条目：条目消失、revision=user-delete、删除边界与快照映射同步', async (t) => {
  const { profile, make, events } = await fresh(t);
  const entry = profile.upsert({ side: 'user', category: '饮食', text: '用户喜欢喝无糖茶' }).entry;
  profile.addEvidence(entry.id, { messageId: 'm-del-1' });
  const maintainer = make();
  maintainer.writeSnapshot('用户喜欢喝无糖茶', 12, 1, new Date(T0).toISOString(), [
    { entryId: entry.id, text: '用户喜欢喝无糖茶' },
  ]);
  const result = maintainer.deleteEntry({ id: entry.id });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(profile.get(entry.id), null, 'the entry is gone');
  assert.equal(profile.revision(entry.id).length, 1, 'the revision row survives the delete');
  assert.equal(profile.revision(entry.id)[0].source, PROFILE_ENTRY_DELETE_SOURCE);
  assert.deepEqual(profile.revision(entry.id)[0].after, { removed: true });
  assert.deepEqual(events(PROFILE_ENTRY_EVENTS.deleted).at(-1).payload, { id: entry.id });
  assert.equal(Object.keys(maintainer.deletionBoundaries()).length, 1, 'the evidence boundary is recorded');
  assert.deepEqual(maintainer.snapshot().lines, [], 'the snapshot mapping no longer points at a dead row');
  assert.equal(maintainer.entryList().some((row) => row.id === entry.id), false);
  console.log(`157) removed=${result.removed} live=${profile.get(entry.id) !== null} revision=${profile.revision(entry.id)[0].source} boundaries=${Object.keys(maintainer.deletionBoundaries()).length} lines=${maintainer.snapshot().lines.length}`);
});

test('158) 新建分类：成功、重名（全半角/大小写归一）拒绝、出现在该侧列表', async (t) => {
  const { make, events } = await fresh(t);
  const maintainer = make();
  const created = maintainer.createCategory({ name: '旅行', parent: 'user' });
  assert.equal(created.ok, true);
  assert.deepEqual(created.category, { name: '旅行', parent: 'user' });
  const userRows = maintainer.categoryManageList().filter((row) => row.parent === 'user');
  const travel = userRows.find((row) => row.name === '旅行');
  assert.ok(travel, 'the new category appears in the user-side list');
  assert.equal(travel.source, 'user');
  assert.equal(travel.count, 0);

  const duplicate = maintainer.createCategory({ name: ' 旅 行 ', parent: 'user' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate-name');
  assert.equal(maintainer.categories().filter((row) => row.name === '旅行').length, 1, 'a refused name adds no row');

  const fullWidth = maintainer.createCategory({ name: 'ＡＢＣ', parent: 'agent' });
  assert.equal(fullWidth.ok, true);
  const caseDuplicate = maintainer.createCategory({ name: 'abc', parent: 'agent' });
  assert.equal(caseDuplicate.ok, false, 'NFKC + case normalization makes ＮＦＫＣ/abc the same name');
  assert.equal(caseDuplicate.reason, 'duplicate-name');

  const invalid = maintainer.createCategory({ name: '无父级', parent: 'nope' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-parent');

  const createdEvents = events(PROFILE_CATEGORY_EVENTS.created);
  assert.deepEqual(createdEvents.map((event) => event.payload), [
    { name: '旅行', parent: 'user' },
    { name: 'ＡＢＣ', parent: 'agent' },
  ]);
  console.log(`158) created=${createdEvents.length} userRows=${userRows.length} duplicate=${duplicate.reason} caseDuplicate=${caseDuplicate.reason} invalid=${invalid.reason}`);
});

