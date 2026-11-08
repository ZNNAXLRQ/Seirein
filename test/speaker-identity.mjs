/**
 * Speaker identity stage 3 — the attribution helper (pure module).
 *
 * The list mirrors the acceptance items:
 *   1. `match` + `self` + a confirmed selfId → assigned to the confirmed self;
 *   2. `mismatch` → unassigned, `confidence:'mismatch'`, the other id may be recorded but not self;
 *   3. `unsure` / low quality (short / quiet / noisy) → unassigned and no speakerId;
 *   4. no enrollment (absent, empty, unconfirmed or throwing) → unassigned, never a throw;
 *   5. loopback cross-talk → `likely-video-leak` cue and unassigned; the cue is never a rejection;
 *   6. malformed inputs (null / array / primitive / partial row) → unassigned, never a throw;
 *   7. another speakerId is never promoted to self (including a conflicting match row);
 *   8. pure: frozen inputs are not mutated, no import/fs/emit exists, results are independent;
 *   9. the record field shape `{speakerId, assigned, confidence, source:'shadow', at}`;
 *  10. a supplied resolution is reused without asking enrollment again.
 *
 * There is deliberately no microphone, model, memory write, lexicon write, event or hard action.
 *
 * Run: node --test test/speaker-identity.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  IDENTITY_CONFIDENCE,
  RECORD_ATTRIBUTION_SOURCE,
  VIDEO_LEAK_LABEL,
  classifyVideoLeak,
  createRecordAttribution,
  resolveIdentityForNewRecord,
} from '../src/host/hearing/speaker-identity.js';

const SELF_ID = 'spk-self';
const OTHER_ID = 'spk-other';

/** One well-formed shadow row; each test overrides only the field it exercises. */
function shadowRow(overrides = {}) {
  return {
    decision: 'match',
    class: 'self',
    score: 0.93,
    speakerId: SELF_ID,
    quality: 'ok',
    source: 'mic',
    ...overrides,
  };
}

/** The enrollment module shape: getConfirmedSelf() → entry or null. */
function enrollmentWith(selfId, { calls = { count: 0 } } = {}) {
  return {
    calls,
    getConfirmedSelf() {
      calls.count += 1;
      return selfId === null ? null : { speakerId: selfId, status: 'confirmed' };
    },
  };
}

/** Deep-freeze a value so any mutation attempt throws in strict mode. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const attributionKeys = ['speakerId', 'assigned', 'confidence', 'source', 'at'];

// ---------------------------------------------------------------------------
// 1. Confirmed self
// ---------------------------------------------------------------------------

test('1. match + self + 已确认 selfId → 归属本人', () => {
  const enrollment = enrollmentWith(SELF_ID);
  const result = resolveIdentityForNewRecord({ shadow: shadowRow(), enrollment });

  assert.deepEqual(result, {
    speakerId: SELF_ID,
    assigned: true,
    confidence: IDENTITY_CONFIDENCE.CONFIRMED,
    reason: 'confirmed-self',
  });
  assert.equal(enrollment.calls.count, 1);

  // A plain `{selfId}` snapshot is the documented alternative input.
  assert.deepEqual(resolveIdentityForNewRecord({ shadow: shadowRow(), enrollment: { selfId: SELF_ID } }), result);
});

// ---------------------------------------------------------------------------
// 2. Mismatch
// ---------------------------------------------------------------------------

test('2. mismatch → 未归属、confidence=mismatch，其他 id 可记录', () => {
  const enrollment = enrollmentWith(SELF_ID);
  const other = resolveIdentityForNewRecord({
    shadow: shadowRow({ decision: 'mismatch', class: 'other', score: 0.12, speakerId: OTHER_ID }),
    enrollment,
  });
  assert.equal(other.assigned, false);
  assert.equal(other.confidence, IDENTITY_CONFIDENCE.MISMATCH);
  assert.equal(other.speakerId, OTHER_ID, 'the other id is evidence, not self');
  assert.notEqual(other.speakerId, SELF_ID);

  // A mismatch whose best candidate happens to be the self template names nobody: null.
  assert.deepEqual(
    resolveIdentityForNewRecord({
      shadow: shadowRow({ decision: 'mismatch', class: 'other', score: 0.3, speakerId: SELF_ID }),
      enrollment,
    }),
    { speakerId: null, assigned: false, confidence: IDENTITY_CONFIDENCE.MISMATCH, reason: 'mismatch' },
  );
});

// ---------------------------------------------------------------------------
// 3. Unsure / low quality
// ---------------------------------------------------------------------------

test('3. unsure 与低质量 → 未归属、speakerId=null', () => {
  const enrollment = enrollmentWith(SELF_ID);
  const unsure = resolveIdentityForNewRecord({
    shadow: shadowRow({ decision: 'unsure', class: 'unknown-identity', score: 0.35 }),
    enrollment,
  });
  assert.deepEqual(unsure, { speakerId: null, assigned: false, confidence: 'unsure', reason: 'unsure' });

  for (const quality of ['short', 'quiet', 'noisy']) {
    // Even a row that says match/self cannot assign when the measurement is unreliable.
    const result = resolveIdentityForNewRecord({ shadow: shadowRow({ quality }), enrollment });
    assert.deepEqual(result, { speakerId: null, assigned: false, confidence: 'unsure', reason: 'low-quality' });
  }
});

// ---------------------------------------------------------------------------
// 4. Enrollment absent
// ---------------------------------------------------------------------------

test('4. 无 enrollment / 未确认 → 未归属，且 getter 抛错不外泄', () => {
  const row = shadowRow();
  for (const enrollment of [null, undefined, {}, { selfId: '' }, enrollmentWith(null)]) {
    const result = resolveIdentityForNewRecord({ shadow: row, enrollment });
    assert.equal(result.assigned, false);
    assert.equal(result.speakerId, null);
    assert.equal(result.confidence, 'unsure');
  }

  const broken = {
    getConfirmedSelf() {
      throw new Error('enrollment store is unreadable');
    },
  };
  const result = resolveIdentityForNewRecord({ shadow: row, enrollment: broken });
  assert.deepEqual(result, { speakerId: null, assigned: false, confidence: 'unsure', reason: 'enrollment-error' });
});

// ---------------------------------------------------------------------------
// 5. Loopback leak cue
// ---------------------------------------------------------------------------

test('5. loopback 串音 → likely-video-leak 线索、未归属', () => {
  const leakRow = shadowRow({
    decision: 'mismatch',
    class: 'other',
    score: 0.08,
    speakerId: OTHER_ID,
    source: 'loopback',
  });
  assert.deepEqual(classifyVideoLeak(leakRow), {
    leak: true,
    label: VIDEO_LEAK_LABEL,
    reason: VIDEO_LEAK_LABEL,
  });

  const result = resolveIdentityForNewRecord({ shadow: leakRow, enrollment: enrollmentWith(SELF_ID) });
  assert.deepEqual(result, {
    speakerId: null,
    assigned: false,
    confidence: 'unsure',
    reason: VIDEO_LEAK_LABEL,
  });

  // Not every loopback row is a leak: a genuine self match stays attributable, and a high score
  // is not "low". The cue never rejects anything either way.
  assert.equal(classifyVideoLeak(shadowRow({ source: 'loopback' })).leak, false);
  assert.equal(
    resolveIdentityForNewRecord({ shadow: shadowRow({ source: 'loopback' }), enrollment: enrollmentWith(SELF_ID) })
      .assigned,
    true,
    'a confirmed self match on loopback is not cross-talk',
  );
  assert.equal(
    classifyVideoLeak(shadowRow({ decision: 'mismatch', class: 'other', score: 0.9, source: 'loopback' })).leak,
    false,
  );
  assert.equal(classifyVideoLeak(shadowRow({ decision: 'mismatch', class: 'other', score: 0.1 })).leak, false);
  assert.equal(classifyVideoLeak(leakRow, { scoreCeiling: 0.05 }).leak, false);
});

// ---------------------------------------------------------------------------
// 6. Bad input
// ---------------------------------------------------------------------------

test('6. 坏输入（null/畸形）不抛且未归属', () => {
  const badShadows = [
    undefined,
    null,
    'match',
    42,
    [],
    {},
    shadowRow({ decision: 'maybe' }),
    shadowRow({ class: null }),
    shadowRow({ speakerId: 42 }),
    shadowRow({ quality: 1 }),
  ];
  for (const shadow of badShadows) {
    let result;
    assert.doesNotThrow(() => {
      result = resolveIdentityForNewRecord({ shadow, enrollment: enrollmentWith(SELF_ID) });
    });
    assert.equal(result.assigned, false, `bad shadow must stay unassigned: ${JSON.stringify(shadow)}`);
    assert.equal(result.speakerId, null);
    assert.equal(result.confidence, 'unsure');
  }

  for (const enrollment of ['store', 7, []]) {
    const result = resolveIdentityForNewRecord({ shadow: shadowRow(), enrollment });
    assert.equal(result.assigned, false);
    assert.equal(result.speakerId, null);
  }

  // The whole argument itself may be absent or a primitive.
  assert.doesNotThrow(() => resolveIdentityForNewRecord());
  assert.equal(resolveIdentityForNewRecord(null).assigned, false);
  assert.equal(resolveIdentityForNewRecord('nope').assigned, false);
});

// ---------------------------------------------------------------------------
// 7. Another speaker is never self
// ---------------------------------------------------------------------------

test('7. 其他 speakerId 不被当 self', () => {
  const enrollment = enrollmentWith(SELF_ID);

  // A match/self row that names a different enrolled voice disagrees with enrollment.
  const conflict = resolveIdentityForNewRecord({
    shadow: shadowRow({ speakerId: OTHER_ID }),
    enrollment,
  });
  assert.deepEqual(conflict, {
    speakerId: null,
    assigned: false,
    confidence: 'unsure',
    reason: 'self-id-conflict',
  });

  // A mismatch keeps its other id as evidence but is still not the user.
  const mismatched = resolveIdentityForNewRecord({
    shadow: shadowRow({ decision: 'mismatch', class: 'other', speakerId: OTHER_ID }),
    enrollment,
  });
  assert.equal(mismatched.assigned, false);
  assert.equal(mismatched.confidence, 'mismatch');
  assert.notEqual(mismatched.speakerId, SELF_ID);
});

// ---------------------------------------------------------------------------
// 8. Purity
// ---------------------------------------------------------------------------

test('8. 纯函数：冻结输入不被改、无 import/写文件/emit、结果互相独立', () => {
  const row = deepFreeze(shadowRow());
  const enrollment = deepFreeze({
    getConfirmedSelf: () => ({ speakerId: SELF_ID, status: 'confirmed' }),
  });
  const before = JSON.stringify({ row, confirmed: enrollment.getConfirmedSelf() });

  const first = resolveIdentityForNewRecord({ shadow: row, enrollment });
  const second = resolveIdentityForNewRecord({ shadow: row, enrollment });
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'each call returns a fresh object');
  assert.equal(JSON.stringify({ row, confirmed: enrollment.getConfirmedSelf() }), before);

  first.speakerId = 'mutated';
  assert.equal(second.speakerId, SELF_ID, 'a returned object is not shared state');

  // The module cannot write a file or emit: it has no imports at all.
  const source = readFileSync(
    fileURLToPath(new URL('../src/host/hearing/speaker-identity.js', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*import\s/mu);
  assert.doesNotMatch(source, /\b(writeFileSync|appendFileSync|createWriteStream|mkdtempSync)\b/u);
  assert.doesNotMatch(source, /\.emit\s*\(/u);
});

// ---------------------------------------------------------------------------
// 9. Record field shape
// ---------------------------------------------------------------------------

test('9. 新记录归属字段结构固定，坏 resolution/at 被降级', () => {
  const resolved = resolveIdentityForNewRecord({ shadow: shadowRow(), enrollment: enrollmentWith(SELF_ID) });
  const attribution = createRecordAttribution({ resolution: resolved, at: '2026-11-09T02:00:00+08:00' });

  assert.deepEqual(Object.keys(attribution).sort(), [...attributionKeys].sort());
  assert.deepEqual(attribution, {
    speakerId: SELF_ID,
    assigned: true,
    confidence: 'confirmed',
    source: RECORD_ATTRIBUTION_SOURCE,
    at: '2026-11-08T18:00:00.000Z',
  });

  // The pipeline form and the resolution form agree.
  assert.deepEqual(
    createRecordAttribution({ shadow: shadowRow(), enrollment: enrollmentWith(SELF_ID), at: new Date(0) }),
    { speakerId: SELF_ID, assigned: true, confidence: 'confirmed', source: 'shadow', at: '1970-01-01T00:00:00.000Z' },
  );

  // Mismatch keeps the other id; unsure stays empty; an invalid instant is null.
  const mismatch = createRecordAttribution({
    resolution: {
      speakerId: OTHER_ID, assigned: false, confidence: 'mismatch', reason: 'mismatch',
    },
    at: 'not-a-date',
  });
  assert.deepEqual(mismatch, {
    speakerId: OTHER_ID,
    assigned: false,
    confidence: 'mismatch',
    source: 'shadow',
    at: null,
  });

  for (const resolution of [null, {}, { speakerId: SELF_ID, assigned: true, confidence: 'unsure' }]) {
    const result = createRecordAttribution({ resolution });
    assert.deepEqual(result, {
      speakerId: null,
      assigned: false,
      confidence: 'unsure',
      source: 'shadow',
      at: null,
    });
  }
});

// ---------------------------------------------------------------------------
// 10. Supplied resolution is reused
// ---------------------------------------------------------------------------

test('10. 已有 resolution 时不再读取 enrollment', () => {
  const enrollment = enrollmentWith(SELF_ID);
  const resolved = resolveIdentityForNewRecord({ shadow: shadowRow(), enrollment });
  assert.equal(enrollment.calls.count, 1);

  createRecordAttribution({ resolution: resolved, enrollment, at: '2026-11-09T02:00:00+08:00' });
  assert.equal(enrollment.calls.count, 1, 'the builder trusts the supplied resolution');
});
