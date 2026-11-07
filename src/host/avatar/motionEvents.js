/**
 * Communication events → sentence-level motion intents (P-139 stage 2).
 *
 * This module is pure data plus pure functions: no timers, no transport, no runtime state. It only
 * answers "what does this communication event mean for the body". Staging, the generation check,
 * the one-action-at-a-time rule and the actual parameter writes stay in `avatarRuntime.js`, so the
 * mapping table can change without touching the writer path.
 *
 * ## Why events, not per-sentence host calls
 *
 * The host reports *phases* of the conversation (turn started, user is talking, the model is
 * thinking, an answer started/ended, silence). The runtime turns a phase into ONE intent and holds
 * it until the next sentence boundary (`speechClip('start')`), so the gesture lands at the start of
 * a sentence instead of wherever a host timer happened to fire.
 *
 * ## Mapping table
 *
 * `DEFAULT_INTENT_TABLE` below is the shipped table. It is fully replaceable through
 * `config.intentTable` or `runtime.setIntentTable()`. A table only decides WHICH intent an event
 * selects; amplitude, duration, tempo and every other dimension stay style/persona-owned (stage 3
 * adds the style dimensions on top of this table — the table itself never reads a style).
 *
 * `settle` is the one intent that is not a gesture: it fades the running action and lets the held
 * idle posture resume ("刚结束 / 长时间安静"). It is also the neutral fallback used when a
 * `lookAtUser` cannot be proved to have a real target.
 */

/**
 * Communication phases a host may report. These are edges, not per-token ticks.
 *
 * `confused` is the one stage-4 addition: it is still a phase (the user's utterance was not
 * understood), not a per-token score, and it selects `tilt` so the head tilt and the brow share one
 * gesture. The six stage-2 rows below are unchanged.
 */
export const MOTION_EVENTS = Object.freeze([
  'turn-start',
  'user-speaking',
  'thinking',
  'answer-start',
  'answer-end',
  'idle',
  'confused',
]);

/**
 * The intent vocabulary. The first four are the existing one-shot gestures; `settle` is the
 * "no gesture, return to the idle posture" intent introduced with the event table.
 */
export const MOTION_INTENTS = Object.freeze(['nod', 'lookAtUser', 'tilt', 'surprise', 'settle']);

/**
 * Intents that read as "I am listening". A listening phase may only select one of these; the
 * mapping table is asserted against this set so a noisy news event can never turn into a surprise
 * gesture while the user is still talking.
 */
export const LISTENING_INTENTS = Object.freeze(['nod', 'lookAtUser', 'tilt']);

/** The neutral intent: no gesture, fade back to the idle posture. */
export const NEUTRAL_INTENT = 'settle';

/**
 * Shipped event → intent table (P-139 stage 2, plus the stage-4 `confused` row):
 *
 *   turn-start    → lookAtUser  a new turn begins: attend to the user (requires a verified target)
 *   user-speaking → nod         the user is talking: a small acknowledgment, nothing else
 *   thinking      → tilt        the model is processing: a head tilt, no gesture burst
 *   answer-start  → nod         the answer begins: one nod at the head of a sentence
 *   answer-end    → settle      the answer is over: fade the gesture, resume the idle posture
 *   idle          → settle      silence: the same relaxed return, never a new gesture
 *   confused      → tilt        "I did not follow": a gentle tilt (+ brows, via the profile)
 *
 * The `confused` row is the only change to this table in stage 4; every earlier row is byte-identical.
 */
export const DEFAULT_INTENT_TABLE = Object.freeze({
  'turn-start': 'lookAtUser',
  'user-speaking': 'nod',
  thinking: 'tilt',
  'answer-start': 'nod',
  'answer-end': 'settle',
  idle: 'settle',
  confused: 'tilt',
});

/**
 * P-139 stage 4 — gesture profiles a communication source may carry.
 *
 * A profile is EXPRESSION only: it changes the amplitude / duration / brow contribution of the
 * intent the table already selected. It never selects an intent, never rewrites the table and never
 * adds a channel→input mapping. `markConclusion()` carries `conclusion`; the `confused` phase
 * carries `confused`.
 */
export const MOTION_PROFILES = Object.freeze(['conclusion', 'confused']);

/** The profile one phase carries, or `null` when the phase is a plain gesture. */
export function motionProfileFor(event) {
  return String(event ?? '') === 'confused' ? 'confused' : null;
}

/** True when a profile is part of the shipped vocabulary (unknown profiles are ignored). */
export function isMotionProfile(profile) {
  return MOTION_PROFILES.includes(String(profile ?? ''));
}

const asIntent = (raw) => {
  if (typeof raw === 'string') return raw.trim();
  if (raw !== null && typeof raw === 'object') return String(raw.intent ?? raw.kind ?? '').trim();
  return '';
};

/**
 * Merge a host-supplied table over the shipped defaults.
 *
 * Missing events keep the default. An entry naming an unknown intent is reported in `invalid`
 * and keeps the default for that event (the typo is visible instead of silently changing motion).
 * Unknown event keys are reported in `ignored` and never become a trigger: only the phases in
 * `MOTION_EVENTS` exist, so a typo cannot add a new lifecycle hook.
 *
 * @param {object|null} [raw] `{ event: intent }` or `{ event: { intent } }`
 * @param {{base?: object}} [options] base table, default `DEFAULT_INTENT_TABLE`
 * @returns {{ok: boolean, table: object, invalid: string[], ignored: string[]}}
 */
export function normalizeIntentTable(raw, { base = DEFAULT_INTENT_TABLE } = {}) {
  const fallback = base !== null && typeof base === 'object' ? base : DEFAULT_INTENT_TABLE;
  const table = {};
  for (const event of MOTION_EVENTS) {
    table[event] = asIntent(fallback[event]) || NEUTRAL_INTENT;
  }
  const invalid = [];
  const ignored = [];
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { ok: true, table, invalid, ignored };
  }
  for (const [event, value] of Object.entries(raw)) {
    if (!MOTION_EVENTS.includes(event)) {
      ignored.push(event);
      continue;
    }
    const intent = asIntent(value);
    if (!MOTION_INTENTS.includes(intent)) {
      invalid.push(event);
      continue;
    }
    table[event] = intent;
  }
  return { ok: true, table, invalid, ignored };
}

/**
 * Read one event's intent. The runtime always normalises first, so an unknown event here is a
 * caller bug; `null` means "no intent selected" and is recorded rather than guessed.
 */
export function intentForEvent(table, event) {
  const intent = asIntent(table?.[String(event ?? '')]);
  return MOTION_INTENTS.includes(intent) ? intent : null;
}

/**
 * `lookAtUser` is executed only with a real target AND a verified gaze mapping (the existing rule;
 * the pose layer already falls back to the preset neutral direction otherwise). Without both, the
 * event degrades to `settle`: nothing is written, so the body keeps its neutral attention
 * direction instead of pretending to see the user.
 *
 * @param {string} intent
 * @param {{targetVerified?: boolean}} [options]
 * @returns {{intent: string, degraded: boolean, reason: string}}
 */
export function degradeIntent(intent, { targetVerified = false } = {}) {
  const kind = asIntent(intent);
  if (kind !== 'lookAtUser') return { intent: kind, degraded: false, reason: '' };
  if (targetVerified === true) return { intent: kind, degraded: false, reason: '' };
  return { intent: NEUTRAL_INTENT, degraded: true, reason: 'no-target' };
}

/** True for an intent that may run while the user is still talking (see LISTENING_INTENTS). */
export function isListeningIntent(intent) {
  return LISTENING_INTENTS.includes(asIntent(intent));
}
