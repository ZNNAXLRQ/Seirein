/** typed-reply — extracted from index.js; no host entry dependency. */
import { DEFAULT_SPEECH_MAX_CHARS } from './speech-text.js';
import { isAssistantMemoryMessage } from '../shared/text.js';
import { messageTextBlocks } from '../shared/text.js';
import { resolveSpeechBudget } from './speech-text.js';
import { createReplySpeaker } from './reply-speaker.js';
import { formatSpeech } from './format.js';

/**
 * Typed-turn voice relay: the round-end speaker for a text turn.
 *
 * One round has one spoken channel. `voiceOwners` is keyed by `(sessionId, turnId)` and holds
 * `{owner, claimedAt, generation, endedAt, settledAt, spoken, pending}` — never one global
 * "active turn". `spoken` is a fact about the round: once any tool line really played, a later
 * failed line releases only its pending reservation and the owner stays. `assistant_say` claims
 * `'tool'` *before* it starts synthesizing; a typed round claims `'typed'` at `turn/end`; the
 * voice lane claims `'voice'` once it plays. A failed claim returns the owner already holding the
 * round, so the caller skips instead of speaking the same answer twice. `turn/end` only stamps
 * `endedAt`: the owner leaves when its playback ends (`settle`) or never started (`release`).
 * Every callback carries the generation it claimed, so a late clip of turn A can never delete or
 * overwrite the owner of turn B. A tool claim over `'typed'` aborts that claim's lane, which stops
 * the superseded synthesis, queue and clip instead of leaving them to sound later.
 *
 * `observe(session, event)` consumes the session event feed (the host subscribes it as-is):
 * - `turn/start` captures the round's cancellation identity (`captureSignal()` at that instant);
 * - `user/message` binds the turn's `inputSource` from a registered delivery (`noteDelivery`);
 *   a message id nobody registered is a typed turn, and C2's own injection never binds; a relayed
 *   completion (`agent-message` / `subagent-settled` with a foreign `senderSessionId`) is `result`;
 * - `assistant/message` collects the body (no tool-call block, no injection, no interruption);
 * - `turn/end` is the only trigger, and only for an in-scope typed/result round with the setting
 *   on. `aborted | cancelled | error | interrupted` never speak and are logged as skipped.
 *   A result speaks once per `(sessionId, taskId)`, never once per sender: the two notices of one
 *   task (`agent-message` + `subagent-settled`) share the task identity and the second is skipped
 *   as a duplicate (`voice.result.skipped {reason:'duplicate'}`), while a later task from the same
 *   subagent speaks normally. The feed carries no task/run id; a task is identified by an explicit
 *   `source.taskId|runId|jobId|inboxId|spliceId` when a feed supplies one, otherwise by the
 *   `agent-message` message id that opened it, which its `subagent-settled` notice inherits.
 *   A bounded notice map (64 entries / 10 minutes, LRU) keeps that attribution after the open
 *   association closes, so a replayed notice is a duplicate instead of a new task
 *   (`voice.result.notice-replay {noticeId, taskId}`). A failure still releases the task key.
 *   Acceptance is not playback: `voice.result.accepted` → `voice.result.audio.started` (first real
 *   sound) → `voice.result.completed` (the whole answer finished); a synthesis/playback failure is
 *   `voice.result.failed {reason}` and releases the task key so the same task may retry.
 *
 * Typed speech reuses `createReplySpeaker`: the sentence splitter, the single playback session
 * and the mute/barge-in signal stay exactly where they already are. `maxChars` (number or a
 * per-round function) is the shared `voice.speechMaxChars` budget; when the spoken share is cut,
 * `onSpeechBudget(stats)` lets the host show the trailing `（后文见文字）` caption line.
 *
 * @param {object} options injected seams (`emit`, `synthesize`, `play`, `captureSignal`, …)
 * @returns {object} `voiceOwners`, `observe`, `noteDelivery`, `claimTool`, `claimVoice`,
 *                   `watchToolPlayback`, `settle`, `release`, `cancelForUserInput`, `whenIdle`
 */
export function createTypedVoiceRelay({
  emit = async () => {},
  synthesize = null,
  play = null,
  speakWhole = null,
  captureSignal = null,
  setting = () => true,
  inScope = () => true,
  isSubagent = () => false,
  now = () => Date.now(),
  // A5: the same shared budget the auto lane and `assistant_say` use; 0 means "speak it all".
  maxChars = DEFAULT_SPEECH_MAX_CHARS,
  budget: resolveBudget = resolveSpeechBudget,
  /** Called with the final budget stats when the spoken share was cut; the host shows the note. */
  onSpeechBudget = null,
  /**
   * Round-level speech preparation (`text` is the whole body): one condense before the sentence
   * splitter, so the typed lane honours "one spoken version" and "read it all".
   */
  prepareRoundText = null,
  limit = 128,
} = {}) {
  /** `${sessionId}\u0000${turnId}` -> {owner, claimedAt, generation, endedAt, settledAt, spoken, pending}. */
  const voiceOwners = new Map();
  /** Typed claim key -> {generation, controller, sessionId, turnId}: aborted by a tool/user input. */
  const typedLanes = new Map();
  /** Typed claim key -> {generation, reason}: an aborted lane whose late result must not speak. */
  const staleTyped = new Map();
  /** sessionId -> the user's latest input turn: a late older `turn/end` never speaks. */
  const inputTurns = new Map();
  /** `${sessionId}\u0000${turnId}` -> {ok, signal}: cancellation identity captured at turn start. */
  const turnIdentities = new Map();
  /** requestId -> {inputSource, sessionId, at}: a voice delivery registered before its turn. */
  const deliveries = new Map();
  const openTurns = new Map();
  const turnSources = new Map();
  const pendingSources = new Map();
  /** `${sessionId}\0${turnId}` -> {kind, senderSessionId, messageId, taskId}: a result relaying here. */
  const turnResults = new Map();
  /** sessionId -> {kind, senderSessionId, messageId, taskId}: a result that arrived before its turn. */
  const pendingResults = new Map();
  /** `${sessionId}\0${senderSessionId}` -> {taskId, kind, at}: the sender's open completion task. */
  const resultEpochs = new Map();
  /** `${sessionId}\0${taskId}` -> {state, kind, senderSessionId, messageId, turn, at}: one result task. */
  const resultCompletions = new Map();
  /** Bounded LRU: `${sessionId}\0${noticeId}` -> {taskId, at}. An end notice that is replayed after
   * its sender association closed must still resolve to the task it belonged to the first time,
   * so a replay is a duplicate instead of a new task. 64 notices / 10 minutes, oldest evicted. */
  const resultNotices = new Map();
  const RESULT_NOTICE_LIMIT = 64;
  const RESULT_NOTICE_TTL_MS = 10 * 60 * 1000;
  const bodies = new Map();
  /** `${sessionId}\0${turnId}` -> the user's own words for the round (drives "read it all"). */
  const turnUtterances = new Map();
  const inflight = new Set();
  let sequence = 0;

  const keyFor = (sessionId, turnId) => `${sessionId}\u0000${turnId ?? 'none'}`;
  /** One delegated task in one parent session: both notices of that task resolve to one identity. */
  const resultKey = (sessionId, taskId) => `${sessionId}\u0000${taskId}`;
  const resultSenderKey = (sessionId, senderSessionId) => `${sessionId}\u0000${senderSessionId}`;
  const trim = (map) => {
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  };
  const noticeKey = (sessionId, noticeId) => `${sessionId}\u0000${noticeId}`;
  /** Remember notice id -> task id, evicting the oldest past 64 so the map can never grow forever. */
  const rememberResultNotice = (sessionId, noticeId, taskId) => {
    if (noticeId.length === 0 || taskId.length === 0) return;
    const key = noticeKey(sessionId, noticeId);
    resultNotices.delete(key);
    resultNotices.set(key, { taskId, at: now() });
    while (resultNotices.size > RESULT_NOTICE_LIMIT) {
      const oldest = resultNotices.keys().next().value;
      if (oldest === undefined) break;
      resultNotices.delete(oldest);
    }
  };
  /** Notice-id lookup; a hit is an LRU touch, and an entry older than 10 minutes is a miss. */
  const recallResultNotice = (sessionId, noticeId) => {
    if (noticeId.length === 0) return '';
    const key = noticeKey(sessionId, noticeId);
    const entry = resultNotices.get(key);
    if (entry === undefined) return '';
    if (now() - entry.at > RESULT_NOTICE_TTL_MS) {
      resultNotices.delete(key);
      return '';
    }
    resultNotices.delete(key);
    resultNotices.set(key, { ...entry, at: now() });
    return entry.taskId;
  };
  /**
   * Task/run ids a future feed may supply. Today's persisted feed carries none: a result
   * `user/message` has `data {content, source, role, id}` and `source {kind, form, senderSessionId,
   * summary?}` only, so the sender epoch below is the fallback identity.
   */
  const RESULT_TASK_FIELDS = ['taskId', 'runId', 'jobId', 'inboxId', 'spliceId'];
  const explicitResultTaskId = (data) => {
    for (const holder of [data?.source, data?.message?.source, data]) {
      if (holder === null || typeof holder !== 'object') continue;
      for (const field of RESULT_TASK_FIELDS) {
        const value = holder[field];
        if (typeof value === 'string' && value.length > 0) return value;
      }
    }
    return '';
  };
  const log = async (type, payload) => {
    try {
      await emit(type, payload);
    } catch {
      /* the event log is best-effort */
    }
  };
  /**
   * Close the sender's open task association once that task has reached a terminal voice state.
   * Only the task that is still open is closed, so a late notice of an older task never deletes a
   * newer association. The next completion notice then opens its own task key.
   */
  const closeResultTask = (sessionId, result, reason) => {
    if (result === null || typeof result !== 'object') return '';
    const senderKey = resultSenderKey(sessionId, result.senderSessionId);
    const open = resultEpochs.get(senderKey);
    if (open === undefined) return '';
    if (typeof result.taskId === 'string' && result.taskId.length > 0 && open.taskId !== result.taskId) return '';
    resultEpochs.delete(senderKey);
    void log('voice.result.task-close', { taskId: open.taskId, reason });
    return open.taskId;
  };
  /**
   * Resolve one result document's task identity. An explicit task/run id wins. Then the bounded
   * notice map: a replayed end notice keeps the task it was first attributed to, even after the
   * sender's open association was closed (otherwise it would open a new task under its own id and
   * speak again). Then the sender's open association for a settled notice; an `agent-message`
   * always opens its own task, so a same-sender new task is never swallowed. Finally its own id.
   */
  const bindResultTask = (sessionId, result) => {
    if (result === null || typeof result !== 'object') return result;
    const senderKey = resultSenderKey(sessionId, result.senderSessionId);
    const supplied = typeof result.taskId === 'string' ? result.taskId : '';
    const noticeId = typeof result.messageId === 'string' ? result.messageId : '';
    // 1. The bounded notice map: a hit means this exact notice was already attributed.
    const seen = recallResultNotice(sessionId, noticeId);
    if (seen.length > 0) void log('voice.result.notice-replay', { noticeId, taskId: seen });
    // 2. The sender's open association. Only a settled notice inherits it.
    const open = resultEpochs.get(senderKey);
    // Explicit feed id > remembered notice task > open association (settled only) > own id.
    let taskId = supplied.length > 0 ? supplied : seen;
    if (taskId.length === 0 && result.kind !== 'agent-message') taskId = open?.taskId ?? '';
    if (taskId.length === 0) taskId = noticeId.length > 0 ? noticeId : `at:${now()}`;
    // A replayed notice never re-opens a finished association (that would make the sender's next
    // settled-only task inherit it), but a task that never played may still reopen it for a retry.
    const reopen = seen.length === 0 || !resultCompletions.has(resultKey(sessionId, taskId));
    if (result.kind === 'agent-message' && reopen) {
      resultEpochs.set(senderKey, { taskId, kind: result.kind, at: now() });
      trim(resultEpochs);
      void log('voice.result.task-open', { taskId, sender: result.senderSessionId });
    }
    // 3. Remember the resolution (bounded, 64 / 10 min): the replay finds it after the close.
    rememberResultNotice(sessionId, noticeId, taskId);
    return { ...result, taskId };
  };
  const turnOf = (event) => {
    if (Number.isInteger(event?.data?.turn)) return event.data.turn;
    return Number.isInteger(event?.turnId) ? event.turnId : null;
  };
  /** Take the round's cancellation identity exactly once, when the round starts. */
  const captureIdentity = () => {
    if (typeof captureSignal !== 'function') return { ok: true, signal: undefined };
    try {
      const value = captureSignal();
      if (value === undefined || value === null) return { ok: true, signal: value };
      return { ok: value.aborted !== true, signal: value };
    } catch {
      return { ok: false, signal: undefined };
    }
  };
  const STOPPED_END_REASONS = new Set(['aborted', 'cancelled', 'canceled', 'error', 'interrupted']);
  /** `turn/end.reason` is `{kind}`/`{type}` or a bare string; '' means a normal end. */
  const stoppedReasonOf = (data) => {
    const raw = data?.reason;
    const value = typeof raw === 'string'
      ? raw
      : String(raw?.kind ?? raw?.type ?? raw?.reason ?? '');
    const normalized = value.trim().toLowerCase();
    if (!STOPPED_END_REASONS.has(normalized)) return '';
    return normalized === 'error' ? 'error' : 'aborted';
  };
  /** True while this exact claim still owns the round (the only generation check that mutates). */
  const current = (key, generation) => {
    const entry = voiceOwners.get(key);
    return entry !== undefined && entry.generation === generation;
  };
  /**
   * One tool claim. `spoken` is shared with the round's entry, so a later line sees what an earlier
   * line already did: playback that really started is a fact about the round, not about one call.
   */
  const toolClaim = (entry, key, sessionId, turnId, extra = {}) => ({
    ok: true,
    owner: 'tool',
    key,
    generation: entry.generation,
    sessionId,
    turnId,
    get spoken() {
      return entry.spoken === true;
    },
    set spoken(value) {
      entry.spoken = value === true;
    },
    ...extra,
  });
  /**
   * Release one claim's reservation. The owner leaves only when no sibling claim is still
   * synthesizing and nothing in the round really spoke: a failed line must not free the same answer
   * for the typed trigger while another call is still working, nor after the round already played.
   */
  const release = (claim, { spoken = false } = {}) => {
    if (claim === null || typeof claim !== 'object') return false;
    const { sessionId, turnId, generation } = claim;
    if (typeof sessionId !== 'string' || !Number.isInteger(turnId)) return false;
    const key = keyFor(sessionId, turnId);
    const entry = voiceOwners.get(key);
    if (entry === undefined) return false;
    // A callback from an older claim must never delete the owner that replaced it.
    if (Number.isInteger(generation) && entry.generation !== generation) return false;
    if (spoken === true) {
      try {
        claim.spoken = true;
      } catch {
        /* a plain callback object has no shared entry */
      }
    }
    // Release only this attempt's reservation. The owner survives while a sibling claim is still
    // synthesizing (`pending > 0`) and never leaves once the round has really spoken.
    entry.pending = Math.max(0, (entry.pending ?? 0) - 1);
    if (entry.pending === 0 && entry.spoken !== true) {
      voiceOwners.delete(key);
      const lane = typedLanes.get(key);
      if (lane !== undefined && lane.generation === entry.generation) typedLanes.delete(key);
    }
    return true;
  };
  /** Playback ended: delete at once unless the turn has not ended yet (then the owner stays). */
  const settle = ({ sessionId, turnId, generation } = {}) => {
    if (typeof sessionId !== 'string' || !Number.isInteger(turnId)) return false;
    const key = keyFor(sessionId, turnId);
    const entry = voiceOwners.get(key);
    if (entry === undefined) return false;
    if (Number.isInteger(generation) && entry.generation !== generation) return false;
    entry.pending = Math.max(0, (entry.pending ?? 0) - 1);
    entry.settledAt = now();
    // Keeping the owner until `turn/end` is what makes the typed trigger stay silent after a
    // tool line: the tool's clip is over, but the round is not.
    if (entry.endedAt > 0) voiceOwners.delete(key);
    return true;
  };
  /** Claim the round for `assistant_say`, before any synthesis starts. Never overwrites blindly. */
  const claimTool = ({ sessionId, turnId } = {}) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !Number.isInteger(turnId)) {
      return { ok: true, owner: 'tool', key: '', generation: 0, sessionId: '', turnId: 0, unbound: true, spoken: false };
    }
    const key = keyFor(sessionId, turnId);
    const entry = voiceOwners.get(key);
    if (entry === undefined) {
      const generation = ++sequence;
      const created = {
        owner: 'tool', claimedAt: now(), generation, endedAt: 0, settledAt: 0, spoken: false, pending: 1,
      };
      voiceOwners.set(key, created);
      return toolClaim(created, key, sessionId, turnId);
    }
    if (entry.owner === 'voice') return { ok: false, owner: 'voice', key, sessionId, turnId };
    if (entry.owner === 'typed') {
      // The tool wins the round: stop the typed synthesis/queue/playback it superseded, then make
      // every typed callback stale by moving the generation forward.
      const lane = typedLanes.get(key);
      if (lane !== undefined) {
        typedLanes.delete(key);
        try {
          lane.controller.abort(new DOMException('Typed speech superseded', 'AbortError'));
        } catch {
          /* already aborted */
        }
      }
      entry.owner = 'tool';
      entry.claimedAt = now();
      entry.generation = ++sequence;
      entry.settledAt = 0;
      entry.pending = 1;
      void log('voice.typed.superseded', { sessionId, turn: turnId, owner: 'tool', previous: 'typed' });
      return toolClaim(entry, key, sessionId, turnId, { tookOver: true });
    }
    // Already this tool's channel: a deliberate second line is the same claim, not a conflict.
    entry.pending = (entry.pending ?? 0) + 1;
    return toolClaim(entry, key, sessionId, turnId, { already: true });
  };
  /** The voice lane played this round; a later tool call in it must not add a second clip. */
  const claimVoice = ({ sessionId, turnId } = {}) => {
    if (typeof sessionId !== 'string' || !Number.isInteger(turnId)) return false;
    const key = keyFor(sessionId, turnId);
    const entry = voiceOwners.get(key);
    if (entry === undefined) {
      voiceOwners.set(key, {
        owner: 'voice', claimedAt: now(), generation: ++sequence, endedAt: 0, settledAt: 0, spoken: false, pending: 0,
      });
      return true;
    }
    return entry.owner === 'voice';
  };
  const claimTyped = (sessionId, turnId) => {
    const key = keyFor(sessionId, turnId);
    const entry = voiceOwners.get(key);
    if (entry !== undefined) return { ok: false, owner: entry.owner, key, sessionId, turnId };
    const generation = ++sequence;
    // One abort controller per typed claim: a tool takeover or the user's next input cancels
    // synthesis, the queue and the clip already playing. The new claim starts from a clean slate:
    // a stale marker left by an older generation of this key must not drop this round.
    staleTyped.delete(key);
    const lane = new AbortController();
    typedLanes.set(key, { generation, controller: lane, sessionId, turnId });
    // The round already ended, so `endedAt` is stamped at creation: the owner leaves with the clip.
    voiceOwners.set(key, {
      owner: 'typed', claimedAt: now(), generation, endedAt: now(), settledAt: 0, spoken: false, pending: 0,
    });
    return { ok: true, owner: 'typed', key, generation, sessionId, turnId, cancel: lane.signal };
  };
  /** The reason this exact claim was retired by a user input, or '' when it still owns the round. */
  const staleReasonOf = (key, generation) => {
    const stale = staleTyped.get(key);
    return stale !== undefined && stale.generation === generation ? stale.reason : '';
  };
  /**
   * The user's own next input (a typed message or an accepted voice delivery): every typed round
   * that already exists belongs to an older answer, so its synthesis, unplayed queue and sounding
   * clip stop now. The claim keeps its generation until its own `handleEnd` settles, which is what
   * lets a synthesis result that lands after the release be recognised and DROPPED instead of
   * starting a clip. A round created after this call claims a new generation and is untouched.
   * `sessionId`+`turn` (when known) record the input floor: a late `turn/end` of an older round in
   * that session is dropped before it can claim or synthesize anything.
   */
  const cancelForUserInput = ({ reason = 'user-input', sessionId = '', turn = null } = {}) => {
    const scoped = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
    const inputTurn = Number.isInteger(turn) ? turn : null;
    if (scoped.length > 0 && inputTurn !== null) {
      inputTurns.set(scoped, inputTurn);
      trim(inputTurns);
    }
    let cancelled = 0;
    for (const [key, lane] of [...typedLanes]) {
      // The just-arriving round is not old: never cancel the claim the input itself is asking for.
      if (scoped.length > 0 && inputTurn !== null
        && lane.sessionId === scoped && lane.turnId === inputTurn) continue;
      typedLanes.delete(key);
      staleTyped.set(key, { generation: lane.generation, reason });
      trim(staleTyped);
      try {
        lane.controller.abort(new DOMException(`Typed speech cancelled: ${reason}`, 'AbortError'));
      } catch {
        /* already aborted */
      }
      void log('voice.speech.cancelled', {
        reason, scope: 'typed', sessionId: lane.sessionId, turn: lane.turnId, generation: lane.generation,
      });
      cancelled += 1;
    }
    return cancelled;
  };
  /** Watch one tool clip: settle (delete once the round ended) when its player finishes. */
  const watchToolPlayback = (claim, done) => {
    if (claim === null || typeof claim !== 'object') return false;
    if (typeof claim.key !== 'string' || claim.key.length === 0) return false;
    const task = Promise.resolve(done)
      .catch(() => {})
      .then(() => settle({ sessionId: claim.sessionId, turnId: claim.turnId, generation: claim.generation }))
      .catch(() => {});
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
    return true;
  };
  /** Register a delivery's request id so its turn is marked `voice` instead of `typed`. */
  const noteDelivery = ({ requestId, inputSource = 'voice', sessionId = '' } = {}) => {
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    deliveries.set(requestId, { inputSource: inputSource === 'voice' ? 'voice' : 'typed', sessionId, at: now() });
    trim(deliveries);
    return true;
  };
  const runSpeaker = async ({
    text, signal, key, generation, cancel, sessionId = '', turnId = null, utterance = '',
    onFirstAudio = null,
  }) => {
    // B: the typed body is Markdown. It is parsed once here; the speaker only ever queues the
    // plain form, and `finish({fullText})` cannot fall back to the raw markers either.
    const formatted = formatSpeech(text);
    let speechText = formatted.speech;
    // Accepted is not started: this flips only when the reply's first clip really begins to sound.
    let audioStarted = false;
    const noteFirstAudio = async (at) => {
      if (audioStarted || !(Number(at) > 0)) return;
      audioStarted = true;
      if (typeof onFirstAudio !== 'function') return;
      try {
        await onFirstAudio({ at: Number(at) });
      } catch {
        /* bookkeeping only, never a reason to cut the answer */
      }
    };
    if (formatted.empty) {
      await log('voice.speech.skipped', { reason: 'empty-after-format', sessionId, turn: turnId });
    }
    // ONE condense per round, before the sentence splitter: later sentences are already short, so a
    // per-sentence rewrite would either read the whole body or fire one request per sentence.
    if (typeof prepareRoundText === 'function' && speechText.length > 0) {
      try {
        const preparedRound = await prepareRoundText(speechText, { signal, sessionId, turnId, utterance });
        if (typeof preparedRound?.text === 'string' && preparedRound.text.length > 0) {
          speechText = preparedRound.text;
        }
      } catch {
        // A failed rewrite keeps the full body, exactly like the voice lane's fallback.
      }
    }
    // The captured mute/barge-in signal and the claim's supersede controller are one lane: a tool
    // takeover cancels synthesis, the queued sentences and the clip already playing.
    const lanes = [signal, cancel].filter((value) => value !== undefined && value !== null);
    const lane = lanes.length === 0 ? undefined : (lanes.length === 1 ? lanes[0] : AbortSignal.any(lanes));
    // A5: a function is read per round, so a settings change applies without remounting the host.
    const roundMaxChars = typeof maxChars === 'function' ? maxChars() : maxChars;
    const speaker = createReplySpeaker({
      signal: lane,
      startedAt: now(),
      maxChars: roundMaxChars,
      budget: resolveBudget,
      // P-46 stage 2: the typed round's attribution; the host copies it onto `voice.tts.request`.
      sessionId,
      turn: turnId,
      // A5: `voice.speech.budget` reaches the event log through the same emit seam as the rest.
      onBudget: (event) => {
        const { type, ...data } = event;
        void log(type, data);
      },
      synthesize: (options) => synthesize(options),
      play: async (options) => {
        const started = await play({
          ...options, isCurrent: () => current(key, generation), sessionId, turnId,
        });
        await noteFirstAudio(started?.audioStartedAt);
        return started;
      },
      speakWhole: typeof speakWhole === 'function'
        ? async (value) => {
          const started = await speakWhole(value, { sessionId, turnId });
          await noteFirstAudio(started?.audioStartedAt);
          return started;
        }
        : null,
    });
    const onAbort = () => { speaker.cancel('typed-interrupted'); };
    try {
      lane?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      /* a foreign signal object without listeners */
    }
    try {
      speaker.push(speechText);
      const stats = await speaker.finish({ fullText: speechText });
      return { ...stats, audioStarted };
    } finally {
      try {
        lane?.removeEventListener?.('abort', onAbort);
      } catch {
        /* same */
      }
    }
  };
  const handleEnd = async (session, sessionId, turnId, key, source, text, {
    reason = '', identity = null, utterance = '', result = null,
  } = {}) => {
    const entry = voiceOwners.get(key);
    // `turn/end` only stamps the round: deleting the owner here would free the same answer for a
    // second entry while its clip is still playing. The clip's own callback deletes it.
    if (entry !== undefined) entry.endedAt = now();
    const finished = () => {
      if (entry === undefined) return;
      // A tool/typed claim lives until its playback ends; the voice lane's marker leaves with the
      // turn because its own sentence speaker owns that playback.
      if (entry.settledAt > 0 || entry.owner === 'voice') voiceOwners.delete(key);
    };
    // A relayed delegated result (`agent-message` / `subagent-settled`) is the parent's answer for
    // that turn, so it takes the same outlet as a typed round; the task identity (never merely the
    // sender) decides whether it is a duplicate, so a later task from the same subagent still speaks.
    const isResult = source === 'result' && result !== null && typeof result === 'object'
      && typeof result.senderSessionId === 'string' && result.senderSessionId.length > 0;
    const resultTaskId = isResult
      ? (typeof result.taskId === 'string' && result.taskId.length > 0
        ? result.taskId
        : (typeof result.messageId === 'string' && result.messageId.length > 0
          ? result.messageId
          : `turn:${turnId}`))
      : '';
    const taskKey = isResult ? resultKey(sessionId, resultTaskId) : '';
    const resultSkipped = async (skipReason, detail = '') => {
      if (!isResult) return;
      // A settled notice is the task's last word: whatever it decided, the sender's open
      // association must not be inherited by the next task.
      if (result.kind === 'subagent-settled') closeResultTask(sessionId, result, skipReason);
      await log('voice.result.skipped', {
        turn: turnId,
        senderSessionId: result.senderSessionId,
        taskId: resultTaskId,
        reason: skipReason,
        ...(detail.length > 0 ? { detail } : {}),
      });
    };
    /** A synthesis/playback failure frees the task key, so the same task may be spoken on retry. */
    const resultFailed = async (reason) => {
      resultCompletions.delete(taskKey);
      // A failed task never sounded: drop the association so the same task may retry.
      closeResultTask(sessionId, result, 'failed');
      await log('voice.result.failed', {
        turn: turnId,
        senderSessionId: result.senderSessionId,
        taskId: resultTaskId,
        reason,
      });
    };
    if (source !== 'typed' && !isResult) {
      finished();
      return;
    }
    if (isResult) {
      // `agent-message` and `subagent-settled` are two notices of one task: one voice, while the
      // same sender's next task has its own key and speaks normally.
      if (resultCompletions.has(taskKey)) {
        finished();
        await resultSkipped('duplicate');
        return;
      }
      if (isSubagent(session) === true) {
        finished();
        await resultSkipped('subagent');
        return;
      }
      if (inScope(session) !== true) {
        finished();
        await resultSkipped('out-of-scope');
        return;
      }
    } else if (text.length === 0 || isSubagent(session) === true || inScope(session) !== true) {
      finished();
      return;
    }
    if (text.length === 0) {
      finished();
      await resultSkipped('silent');
      return;
    }
    // A turn that was cancelled/errored has no answer to speak, even when body text was collected
    // before it ended. This is checked before the claim so nothing is reserved for it.
    if (reason === 'aborted' || reason === 'error') {
      finished();
      if (isResult) {
        closeResultTask(sessionId, result, 'cancelled');
        await resultSkipped('silent', reason);
      } else await log('voice.typed.skipped', { sessionId, turn: turnId, reason });
      return;
    }
    if (setting() !== true || typeof synthesize !== 'function' || typeof play !== 'function') {
      finished();
      await resultSkipped('silent', 'voice-off');
      return;
    }
    // The identity captured at `turn/start`, never a fresh read: mute-then-unmute during the
    // round must not hand the old turn a live signal. An identity that was aborted after capture
    // (mute/barge-in mid-generation) is dead too, so nothing is reserved for it.
    const captured = identity ?? captureIdentity();
    if (captured.ok !== true || captured.signal?.aborted === true) {
      finished();
      if (isResult) await resultSkipped('silent', 'muted');
      else await log('voice.typed.skipped', { sessionId, turn: turnId, owner: 'muted' });
      return;
    }
    // A round that the user already superseded must never start synthesizing: its `turn/end`
    // arrives late (the input only bumped the floor, no claim existed yet), and speaking it would
    // put the old answer after the new question. Dropped before the claim, never after a clip.
    const inputTurn = inputTurns.get(sessionId);
    if (Number.isInteger(inputTurn) && Number.isInteger(turnId) && turnId < inputTurn) {
      finished();
      if (isResult) closeResultTask(sessionId, result, 'cancelled');
      await log('voice.typed.stale-dropped', { sessionId, turn: turnId, reason: 'user-input' });
      return;
    }
    const claim = claimTyped(sessionId, turnId);
    if (claim.ok !== true) {
      // Another entry already speaks this round: the same answer is never spoken twice.
      finished();
      if (isResult) await resultSkipped('silent', `owner:${claim.owner}`);
      else await log('voice.typed.skipped', { sessionId, turn: turnId, owner: claim.owner });
      return;
    }
    /** A late synth/playback result of a round the user's input retired: drop it, never sound it. */
    const dropIfStale = async () => {
      const reason = staleReasonOf(key, claim.generation);
      if (reason.length === 0) return false;
      staleTyped.delete(key);
      release(claim);
      if (isResult) {
        const reservation = resultCompletions.get(taskKey);
        if (reservation === undefined || reservation.state === 'accepted') resultCompletions.delete(taskKey);
        closeResultTask(sessionId, result, 'cancelled');
      }
      await log('voice.typed.stale-dropped', { sessionId, turn: turnId, reason });
      return true;
    };
    // Accepted is a reservation, not playback: mark it synchronously before any await so a second
    // notice of the same task (even one arriving while synthesis runs) is a duplicate. The key is
    // marked done only when the answer really finished sounding; a failure releases it.
    if (isResult) {
      resultCompletions.set(taskKey, {
        state: 'accepted', kind: result.kind, senderSessionId: result.senderSessionId,
        messageId: typeof result.messageId === 'string' ? result.messageId : '', turn: turnId, at: now(),
      });
      trim(resultCompletions);
      await log('voice.result.accepted', {
        turn: turnId, senderSessionId: result.senderSessionId, taskId: resultTaskId, kind: result.kind,
      });
    }
    const onFirstAudio = isResult
      ? async ({ at }) => {
        const reservation = resultCompletions.get(taskKey);
        if (reservation !== undefined && reservation.state === 'accepted') reservation.state = 'started';
        await log('voice.result.audio.started', {
          turn: turnId, senderSessionId: result.senderSessionId, taskId: resultTaskId, at,
        });
      }
      : null;
    let stats;
    try {
      stats = await runSpeaker({
        text, signal: captured.signal, key, generation: claim.generation, cancel: claim.cancel,
        sessionId, turnId, utterance, onFirstAudio,
      });
    } catch (error) {
      if (await dropIfStale()) return;
      release(claim);
      const reason = error?.message ?? String(error);
      if (isResult) await resultFailed(reason);
      else await log('voice.typed.failed', { sessionId, turn: turnId, error: reason });
      return;
    }
    // The synthesis may resolve after the abort (a TTS seam need not observe the signal): the
    // user's input retired this round, so the finished audio is discarded, never started.
    if (await dropIfStale()) return;
    // A newer claim (a tool line after turn/end) replaced this round: leave its state alone, but a
    // result that never sounded must not stay reserved or its retry would be a permanent duplicate.
    if (!current(key, claim.generation)) {
      if (isResult) {
        const reservation = resultCompletions.get(taskKey);
        if (reservation === undefined || reservation.state === 'accepted') resultCompletions.delete(taskKey);
        closeResultTask(sessionId, result, 'cancelled');
      }
      return;
    }
    if (stats?.cancelled === true) {
      release(claim);
      if (isResult) {
        // Accepted but never sounded is not "played": release the key so a later notice can retry.
        // A clip that was already heard stays reserved, so an interruption never replays it.
        const reservation = resultCompletions.get(taskKey);
        if (reservation === undefined || reservation.state === 'accepted') resultCompletions.delete(taskKey);
        closeResultTask(sessionId, result, 'cancelled');
        await resultSkipped('silent', 'interrupted');
      } else {
        await log('voice.typed.skipped', { sessionId, turn: turnId, owner: 'interrupted' });
      }
      return;
    }
    const sentences = Math.max(0, Number(stats?.sentences) || 0);
    const chars = Math.max(0, Number(stats?.chars) || 0);
    // "Sounded" is a fact about real playback, never about acceptance or synthesis finishing.
    const sounded = stats?.audioStarted === true || Number(stats?.played) > 0
      || Number(stats?.firstPlayStartedAt) > 0;
    if (typeof stats?.error === 'string' && stats.error.length > 0) {
      release(claim);
      if (!isResult) {
        await log('voice.typed.failed', { sessionId, turn: turnId, error: stats.error });
        return;
      }
      // A result whose fallback really sounded was still heard: it is reported as a partial
      // completion, never replayed from the top. Only a result with no sound frees its key.
      if (!sounded) {
        await resultFailed(stats.error);
        return;
      }
    }
    if (isResult) {
      if (!sounded) {
        release(claim);
        await resultFailed('not-played');
        return;
      }
      const reservation = resultCompletions.get(taskKey);
      if (reservation !== undefined) reservation.state = 'done';
      await log('voice.result.completed', {
        turn: turnId,
        senderSessionId: result.senderSessionId,
        taskId: resultTaskId,
        chars,
        sentences,
        ...(typeof stats?.error === 'string' && stats.error.length > 0
          ? { partial: true, error: stats.error }
          : {}),
      });
      // The settled notice is the task's final notification: the sender's next task opens anew.
      if (result.kind === 'subagent-settled') closeResultTask(sessionId, result, 'completed');
    } else {
      await log('voice.typed.spoken', { sessionId, turn: turnId, inputSource: 'typed', sentences, chars });
    }
    // A5: the captions already covered exactly the spoken sentences; the trailing note tells the
    // user where the rest of the answer went. The host turns this callback into a subtitle line.
    if (stats?.truncated === true && typeof onSpeechBudget === 'function') {
      try {
        await onSpeechBudget({ ...stats, sessionId, turnId });
      } catch {
        /* the note is best-effort, never a reason to fail the round */
      }
    }
    release(claim);
  };
  const observe = (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      if (sessionId.length === 0 || event === null || typeof event !== 'object') return undefined;
      const data = event.data ?? {};
      const turnId = turnOf(event);
      if (event.type === 'turn/start') {
        if (turnId === null) return undefined;
        openTurns.set(sessionId, turnId);
        const startKey = keyFor(sessionId, turnId);
        bodies.delete(startKey);
        // The round's cancellation identity is the signal live right now. A later mute/barge-in
        // aborts it, so the round can never borrow the post-unmute signal at `turn/end`.
        turnIdentities.set(startKey, captureIdentity());
        trim(turnIdentities);
        const pending = pendingSources.get(sessionId);
        if (pending !== undefined) {
          pendingSources.delete(sessionId);
          turnSources.set(startKey, pending);
          trim(turnSources);
        }
        const pendingResult = pendingResults.get(sessionId);
        if (pendingResult !== undefined) {
          pendingResults.delete(sessionId);
          turnResults.set(startKey, pendingResult);
          trim(turnResults);
        }
        return undefined;
      }
      if (event.type === 'user/message') {
        // C2's injected block is the plugin's own reference material: it never binds a turn.
        if (isAssistantMemoryMessage(data)) return undefined;
        const messageId = data.id ?? data.messageId ?? data.message?.id;
        const registered = typeof messageId === 'string' ? deliveries.get(messageId) : undefined;
        if (registered !== undefined) deliveries.delete(messageId);
        const sourceKind = data?.source?.kind ?? data?.message?.source?.kind;
        const senderSessionId = [data?.source?.senderSessionId, data?.message?.source?.senderSessionId, data?.senderSessionId]
          .find((value) => typeof value === 'string' && value.length > 0) ?? '';
        // A delegated completion relays into the parent as a user message: it is its own lane,
        // but only in the parent. A child's own session never binds it and says why.
        const resultShaped = (sourceKind === 'agent-message' || sourceKind === 'subagent-settled')
          && senderSessionId.length > 0 && senderSessionId !== sessionId;
        if (resultShaped && isSubagent(session) === true) {
          void log('voice.result.skipped', {
            turn: turnId ?? openTurns.get(sessionId) ?? null,
            senderSessionId,
            reason: 'subagent',
          });
          return undefined;
        }
        const result = resultShaped
          ? {
            kind: sourceKind,
            senderSessionId,
            messageId: typeof messageId === 'string' ? messageId : '',
            taskId: explicitResultTaskId(data),
          }
          : null;
        // Only a registered delivery, a genuine user message or a relayed result may decide the lane.
        if (registered === undefined && result === null && sourceKind !== undefined && sourceKind !== 'user') return undefined;
        const source = registered?.inputSource === 'voice' ? 'voice' : (result === null ? 'typed' : 'result');
        const ownerTurn = turnId ?? openTurns.get(sessionId) ?? null;
        if (ownerTurn === null) {
          if (!pendingSources.has(sessionId)) pendingSources.set(sessionId, source);
          if (result !== null) pendingResults.set(sessionId, bindResultTask(sessionId, result));
          trim(pendingSources);
          trim(pendingResults);
          return undefined;
        }
        const turnKey = keyFor(sessionId, ownerTurn);
        // Never overwrite a voice/typed lane another event already bound to this turn.
        if (turnSources.has(turnKey)) return undefined;
        turnSources.set(turnKey, source);
        trim(turnSources);
        if (result !== null) {
          turnResults.set(turnKey, bindResultTask(sessionId, result));
          trim(turnResults);
          // A relayed result's text is the child's, not the parent user's own words.
          return undefined;
        }
        // The round's own words: the typed path needs them to honour "read the whole thing".
        const said = (typeof data.text === 'string' && data.text.trim().length > 0
          ? data.text.trim()
          : (messageTextBlocks(data.message ?? null).trim()
            || messageTextBlocks({ content: Array.isArray(data.content) ? data.content : [] }).trim()));
        if (said.length > 0) {
          turnUtterances.set(turnKey, said);
          trim(turnUtterances);
        }
        return undefined;
      }
      if (event.type === 'assistant/message') {
        const ownerTurn = turnId ?? openTurns.get(sessionId) ?? null;
        if (ownerTurn === null) return undefined;
        const key = keyFor(sessionId, ownerTurn);
        const message = data.message ?? null;
        // Reply body only: a step with tool calls is machinery, a cancelled step is not an answer.
        if (data.interrupted === true || hasToolCallBlocks(message)) return undefined;
        const text = messageTextBlocks(message).trim();
        if (text.length === 0) return undefined;
        // A committed message carries its step's cumulative text, so a later step replaces it.
        bodies.set(key, { text });
        trim(bodies);
        return undefined;
      }
      if (event.type !== 'turn/end') return undefined;
      const ownerTurn = turnId ?? openTurns.get(sessionId) ?? null;
      openTurns.delete(sessionId);
      if (ownerTurn === null) return undefined;
      const key = keyFor(sessionId, ownerTurn);
      const source = turnSources.get(key) ?? pendingSources.get(sessionId) ?? 'unknown';
      const result = turnResults.get(key) ?? pendingResults.get(sessionId) ?? null;
      pendingSources.delete(sessionId);
      pendingResults.delete(sessionId);
      turnSources.delete(key);
      turnResults.delete(key);
      const text = bodies.get(key)?.text ?? '';
      bodies.delete(key);
      const utterance = turnUtterances.get(key) ?? '';
      turnUtterances.delete(key);
      const identity = turnIdentities.get(key) ?? null;
      turnIdentities.delete(key);
      const reason = stoppedReasonOf(data);
      const task = handleEnd(session, sessionId, ownerTurn, key, source, text, {
        reason, identity, utterance, result,
      }).catch(() => {});
      inflight.add(task);
      void task.finally(() => inflight.delete(task));
      return task;
    } catch {
      // Bookkeeping only: the session feed must never break a turn.
      return undefined;
    }
  };
  /**
   * Will this exact typed or relayed-result round speak its answer through the reply outlet at
   * `turn/end`? Only a registered lane with the setting on does; a voice delivery, an out-of-scope
   * turn or a direct tool call has no reply outlet. Read-only: the caller never mutates the round.
   */
  const answersThisTurn = ({ sessionId = '', turnId = null } = {}) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    const turn = Number.isInteger(turnId) ? turnId : openTurns.get(sessionId) ?? null;
    if (!Number.isInteger(turn)) return false;
    if (setting() !== true || typeof synthesize !== 'function' || typeof play !== 'function') return false;
    // A relayed result speaks its own answer at `turn/end` exactly like a typed round.
    const lane = turnSources.get(keyFor(sessionId, turn));
    return lane === 'typed' || lane === 'result';
  };
  /** Wait for every speech task the feed started (tests and shutdown diagnostics). */
  const whenIdle = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };
  return {
    voiceOwners,
    observe,
    noteDelivery,
    claimTool,
    claimVoice,
    watchToolPlayback,
    settle,
    release,
    cancelForUserInput,
    answersThisTurn,
    whenIdle,
  };
}


/**
 * Does one committed assistant message call a tool? The Harness commits such a step before the
 * call runs, so its text is pre-tool commentary — machinery, never the reply body.
 */
function hasToolCallBlocks(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => typeof block?.type === 'string' && block.type.startsWith('tool'));
}


// ---- C2: pre-step memory injection ----------------------------------------
// One reference block is appended to the first pre-step of a turn. It is not user input: the one
// custom source kind `assistant-memory` is the exclusion marker every other lane checks, so the
// block can never be recorded back, re-queried, or turned into a voice trigger.

/** Sentinel that separates "the slice finished" from "the budget expired first". */
const PRE_STEP_TIMEOUT = Symbol('pre-step-timeout');

export { hasToolCallBlocks, PRE_STEP_TIMEOUT };
