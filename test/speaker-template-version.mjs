/**
 * Speaker template versioning — pure version chain and controlled strengthening.
 *
 * The list mirrors the acceptance items:
 *   1. `createVersion()` normalizes/copies its vector and rejects malformed records;
 *   2. an empty chain starts at version 1, a later call increments version/parent and keeps
 *      cumulative evidence;
 *   3. strengthening honors the incoming weight (default 0.5), the per-call sample cap and the
 *      per-call duration cap;
 *   4. an inconsistent batch, a low-similarity batch, a dimension mismatch and an invalid batch
 *      are refused with a reason and produce no version;
 *   5. the chain is bounded, evicts the oldest record and keeps the current version and a
 *      rollback target available;
 *   6. rollback/select restore `currentVersion` without rewriting or appending history; missing
 *      versions and broken vectors are refused;
 *   7. bad state/options/inputs are refused instead of throwing;
 *   8. the module is pure (no file/database/network/clock/global access), and input states,
 *      records and embeddings are never mutated.
 *
 * Run: node --test test/speaker-template-version.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_CONSISTENCY_THRESHOLD,
  DEFAULT_INCOMING_WEIGHT,
  DEFAULT_MAX_DURATION_MS_PER_STRENGTHEN,
  DEFAULT_MAX_SAMPLES_PER_STRENGTHEN,
  DEFAULT_MAX_VERSIONS,
  DEFAULT_MIN_SAMPLES_PER_STRENGTHEN,
  DEFAULT_MIN_SIMILARITY,
  createEmptyVersionState,
  createVersion,
  createVersionState,
  getCurrentVersion,
  nextVersion,
  rollback,
  selectVersion,
} from '../src/host/hearing/speaker-template-version.js';
import {
  buildSpeakerTemplate,
  cosineSimilarity,
} from '../src/host/hearing/speaker-template.js';

const TOLERANCE = 1e-6;

function close(actual, expected, message, tolerance = TOLERANCE) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

function vectorClose(actual, expected, message, tolerance = TOLERANCE) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index += 1) {
    close(actual[index], expected[index], `${message}[${index}]`, tolerance);
  }
}

function norm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function unit(values) {
  const length = norm(values);
  return values.map((value) => value / length);
}

function sample(id, embedding, durationMs = 1000) {
  return { id, embedding, durationMs, quality: 'ok' };
}

function recordOf(state, version) {
  const found = state.versions.find((entry) => entry.version === version);
  assert.ok(found, `version ${version} must exist in state`);
  return found;
}

function snapshotState(state) {
  return {
    currentVersion: state.currentVersion,
    lastVersion: state.lastVersion,
    versions: state.versions.map((record) => ({
      version: record.version,
      vector: [...record.vector],
      sampleCount: record.sampleCount,
      totalDurationMs: record.totalDurationMs,
      createdAt: record.createdAt,
      reason: record.reason,
      parentVersion: record.parentVersion,
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Version records
// ---------------------------------------------------------------------------

test('1. createVersion：归一化/复制向量，契约字段，坏记录拒绝', () => {
  const source = new Float32Array([3, 4]);
  const created = createVersion({
    version: 3,
    vector: source,
    sampleCount: 2,
    totalDurationMs: 3000,
    createdAt: '2026-11-10T00:00:00.000Z',
    reason: 'initial',
    parentVersion: null,
  });
  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created.record).sort(), [
    'createdAt',
    'parentVersion',
    'reason',
    'sampleCount',
    'totalDurationMs',
    'vector',
    'version',
  ]);
  assert.equal(created.record.version, 3);
  vectorClose([...created.record.vector], [0.6, 0.8], 'normalized vector');
  close(norm(created.record.vector), 1, 'unit norm');
  assert.equal(created.record.sampleCount, 2);
  assert.equal(created.record.totalDurationMs, 3000);
  assert.equal(created.record.createdAt, '2026-11-10T00:00:00.000Z');
  assert.equal(created.record.reason, 'initial');
  assert.equal(created.record.parentVersion, null);

  assert.notEqual(created.record.vector, source, 'the record must own a fresh vector');
  created.record.vector[0] = 42;
  assert.deepEqual([...source], [3, 4], 'mutating the record must not touch the input');

  const defaults = createVersion({ vector: [0, 2] });
  assert.equal(defaults.ok, true);
  assert.equal(defaults.record.version, 1);
  assert.equal(defaults.record.sampleCount, 0);
  assert.equal(defaults.record.totalDurationMs, 0);
  assert.equal(defaults.record.createdAt, null);
  assert.equal(defaults.record.reason, 'manual');
  assert.equal(defaults.record.parentVersion, null);
  vectorClose([...defaults.record.vector], [0, 1], 'default normalized vector');

  for (const vector of [
    undefined,
    [],
    new Float32Array(0),
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [1, 1e39],
    [0, 0],
    ['1', 0],
    { 0: 1, length: 1 },
    'AAAA',
    null,
  ]) {
    assert.deepEqual(
      createVersion({ vector }),
      { ok: false, reason: 'invalid-vector' },
      `vector ${String(vector)} must be refused`,
    );
  }
  assert.deepEqual(createVersion(null), { ok: false, reason: 'invalid-record' });
  assert.deepEqual(createVersion([]), { ok: false, reason: 'invalid-record' });

  for (const version of [0, -1, 1.5, Number.NaN, '1']) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], version }),
      { ok: false, reason: 'invalid-version' },
      `version ${String(version)} must be refused`,
    );
  }
  for (const sampleCount of [-1, 1.5, Number.NaN, '2']) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], sampleCount }),
      { ok: false, reason: 'invalid-sample-count' },
    );
  }
  for (const totalDurationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], totalDurationMs }),
      { ok: false, reason: 'invalid-total-duration' },
    );
  }
  for (const parentVersion of [0, -1, 1.5, Number.NaN, '1']) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], parentVersion }),
      { ok: false, reason: 'invalid-parent-version' },
    );
  }
  for (const reason of ['', '   ', 42]) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], reason }),
      { ok: false, reason: 'invalid-reason' },
    );
  }
  for (const createdAt of [Number.NaN, Number.POSITIVE_INFINITY, '', {}, []]) {
    assert.deepEqual(
      createVersion({ vector: [1, 0], createdAt }),
      { ok: false, reason: 'invalid-created-at' },
    );
  }

  const seeded = createVersionState(created.record);
  assert.equal(seeded.ok, true);
  assert.equal(seeded.state.currentVersion, 3);
  assert.equal(seeded.state.lastVersion, 3);
  assert.deepEqual(seeded.state.versions.map((entry) => entry.version), [3]);
  assert.deepEqual(createVersionState({ vector: [0, 0] }), {
    ok: false,
    reason: 'invalid-vector',
  });
});

// ---------------------------------------------------------------------------
// 2. Initial version
// ---------------------------------------------------------------------------

test('2. 空链从 v1 开始；后续强化递增 version/parent 并累计证据', () => {
  const candidates = [
    sample('a', [1, 0], 1000),
    sample('b', [0.8, 0.6], 3000),
  ];
  const started = nextVersion(null, candidates, {
    createdAt: 1_700_000_000_000,
  });
  assert.equal(started.ok, true);
  assert.equal(started.version, 1);

  const state = started.state;
  assert.equal(state.currentVersion, 1);
  assert.equal(state.lastVersion, 1);
  assert.equal(state.versions.length, 1);

  const first = state.versions[0];
  assert.equal(first.version, 1);
  assert.equal(first.reason, 'initial');
  assert.equal(first.parentVersion, null);
  assert.equal(first.sampleCount, 2);
  assert.equal(first.totalDurationMs, 4000);
  assert.equal(first.createdAt, 1_700_000_000_000);
  vectorClose([...first.vector], unit([0.85, 0.45]), 'duration-weighted root vector');
  close(
    cosineSimilarity(first.vector, buildSpeakerTemplate(candidates).vector),
    1,
    'root equals the base builder output',
  );

  assert.deepEqual(nextVersion(null, null), { ok: false, reason: 'invalid-samples' });
  assert.deepEqual(nextVersion(null, 'nope'), { ok: false, reason: 'invalid-samples' });
  assert.deepEqual(nextVersion(null, []), {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 0,
    minSamples: DEFAULT_MIN_SAMPLES_PER_STRENGTHEN,
  });
  assert.deepEqual(nextVersion(null, [sample('x', [1, 0])], { minSamples: 2 }), {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 1,
    minSamples: 2,
  });

  const second = nextVersion(state, [sample('c', [1, 0])], {
    createdAt: 1_700_000_001_000,
    reason: 'user-confirmed',
  });
  assert.equal(second.ok, true);
  assert.equal(second.version, 2);
  const next = recordOf(second.state, 2);
  assert.equal(next.parentVersion, 1);
  assert.equal(next.reason, 'user-confirmed');
  assert.equal(next.sampleCount, 3);
  assert.equal(next.totalDurationMs, 5000);
  const rootDirection = unit([0.85, 0.45]);
  vectorClose(
    [...next.vector],
    unit([(rootDirection[0] + 1) / 2, rootDirection[1] / 2]),
    'half of the new [1,0] direction blended with the root',
  );
  assert.equal(second.state.versions.length, 2);
  assert.equal(second.state.currentVersion, 2);
});

// ---------------------------------------------------------------------------
// 3. Weight and caps
// ---------------------------------------------------------------------------

test('3. 强化权重可配置（默认 0.5）；样本数与总时长上限拒绝且不产版本', () => {
  const seed = nextVersion(null, [sample('seed', [1, 0])]).state;
  assert.equal(DEFAULT_INCOMING_WEIGHT, 0.5);

  const half = nextVersion(seed, [sample('new', [0.8, 0.6])]);
  assert.equal(half.ok, true);
  const halfRecord = recordOf(half.state, 2);
  vectorClose([...halfRecord.vector], unit([0.9, 0.3]), 'default 0.5 incoming share');
  assert.equal(halfRecord.sampleCount, 2);
  assert.equal(halfRecord.totalDurationMs, 2000);
  assert.equal(halfRecord.parentVersion, 1);

  const quarter = nextVersion(seed, [sample('new', [0.8, 0.6])], {
    incomingWeight: 0.25,
  });
  assert.equal(quarter.ok, true);
  vectorClose(
    [...recordOf(quarter.state, 2).vector],
    unit([0.95, 0.15]),
    'configured 0.25 incoming share',
  );

  const takeAll = nextVersion(seed, [sample('new', [0.8, 0.6])], {
    incomingWeight: 1,
  });
  assert.equal(takeAll.ok, true);
  vectorClose([...recordOf(takeAll.state, 2).vector], [0.8, 0.6], 'weight 1 takes incoming');

  const keepOld = nextVersion(seed, [sample('new', [0.8, 0.6])], {
    incomingWeight: 0,
  });
  assert.equal(keepOld.ok, true);
  vectorClose([...recordOf(keepOld.state, 2).vector], [1, 0], 'weight 0 keeps current');

  assert.equal(DEFAULT_MAX_SAMPLES_PER_STRENGTHEN, 8);
  const nine = Array.from({ length: 9 }, (_, index) => sample(`s${index}`, [1, 0]));
  assert.deepEqual(nextVersion(seed, nine), {
    ok: false,
    reason: 'too-many-samples',
    sampleCount: 9,
    maxSamples: 8,
  });
  assert.deepEqual(nextVersion(seed, nine.slice(0, 4), { maxSamples: 3 }), {
    ok: false,
    reason: 'too-many-samples',
    sampleCount: 4,
    maxSamples: 3,
  });

  assert.equal(DEFAULT_MAX_DURATION_MS_PER_STRENGTHEN, 60000);
  const tooLong = nextVersion(
    seed,
    [sample('a', [1, 0], 1500), sample('b', [1, 0], 1500)],
    { maxDurationMs: 2500 },
  );
  assert.deepEqual(tooLong, {
    ok: false,
    reason: 'duration-cap-exceeded',
    totalDurationMs: 3000,
    maxDurationMs: 2500,
  });
  const atCap = nextVersion(
    seed,
    [sample('a', [1, 0], 1500), sample('b', [1, 0], 1500)],
    { maxDurationMs: 3000 },
  );
  assert.equal(atCap.ok, true);
  assert.equal(recordOf(atCap.state, 2).totalDurationMs, 4000);

  // Every refusal above must leave the seed chain untouched.
  assert.equal(seed.currentVersion, 1);
  assert.equal(seed.lastVersion, 1);
  assert.equal(seed.versions.length, 1);

  const badOptions = [
    [{ incomingWeight: -0.1 }, 'invalid-weight'],
    [{ incomingWeight: 1.1 }, 'invalid-weight'],
    [{ incomingWeight: Number.NaN }, 'invalid-weight'],
    [{ incomingWeight: '0.5' }, 'invalid-weight'],
    [{ maxSamples: 0 }, 'invalid-max-samples'],
    [{ maxSamples: 1.5 }, 'invalid-max-samples'],
    [{ maxSamples: '3' }, 'invalid-max-samples'],
    [{ maxDurationMs: 0 }, 'invalid-max-duration'],
    [{ maxDurationMs: Number.POSITIVE_INFINITY }, 'invalid-max-duration'],
    [{ maxDurationMs: '1000' }, 'invalid-max-duration'],
    [{ maxVersions: 1 }, 'invalid-max-versions'],
    [{ maxVersions: 2.5 }, 'invalid-max-versions'],
    [{ maxVersions: '20' }, 'invalid-max-versions'],
    [{ minSamples: 0 }, 'invalid-min-samples'],
    [{ minSamples: 9 }, 'invalid-min-samples'],
    [{ minSamples: 2.5 }, 'invalid-min-samples'],
    [{ minSimilarity: Number.NaN }, 'invalid-min-similarity'],
    [{ minSimilarity: Number.POSITIVE_INFINITY }, 'invalid-min-similarity'],
    [{ minSimilarity: '0.5' }, 'invalid-min-similarity'],
    [{ reason: '' }, 'invalid-reason'],
    [{ reason: 42 }, 'invalid-reason'],
    [{ createdAt: Number.NaN }, 'invalid-created-at'],
    [{ createdAt: {} }, 'invalid-created-at'],
  ];
  for (const [options, reason] of badOptions) {
    assert.deepEqual(
      nextVersion(seed, [sample('x', [1, 0])], options),
      { ok: false, reason },
      `options ${JSON.stringify(options)} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Refusals
// ---------------------------------------------------------------------------

test('4. 不一致/低相似/维度不一致/坏样本拒绝；无新版本，输入链不变', () => {
  const state = nextVersion(null, [sample('seed', [1, 0])], { createdAt: 1 }).state;
  const before = snapshotState(state);

  const inconsistent = nextVersion(state, [
    sample('a', [1, 0]),
    sample('b', [0, 1]),
  ]);
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.reason, 'inconsistent');
  close(inconsistent.minPairCosine, 0, 'pair cosine');
  assert.deepEqual(inconsistent.outlierIds, ['a', 'b']);
  assert.equal('vector' in inconsistent, false);

  const lowSample = nextVersion(state, [sample('a', [1, 0])], { minSamples: 2 });
  assert.deepEqual(lowSample, {
    ok: false,
    reason: 'insufficient-samples',
    sampleCount: 1,
    minSamples: 2,
  });

  const low = nextVersion(state, [
    sample('a', [0, 1]),
    sample('b', [0.1, 0.995]),
  ]);
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'low-similarity');
  assert.ok(low.similarity < DEFAULT_MIN_SIMILARITY, 'similarity must be below the floor');
  assert.equal(low.minSimilarity, DEFAULT_MIN_SIMILARITY);
  assert.equal('vector' in low, false);

  const lenient = nextVersion(
    state,
    [sample('a', [0, 1]), sample('b', [0.1, 0.995])],
    { minSimilarity: 0 },
  );
  assert.equal(lenient.ok, true);
  assert.equal(lenient.version, 2);

  const dim = nextVersion(state, [
    sample('a', [1, 0, 0]),
    sample('b', [0.8, 0.2, 0]),
  ]);
  assert.deepEqual(dim, {
    ok: false,
    reason: 'dim-mismatch',
    expectedDimension: 2,
    actualDimension: 3,
  });

  assert.deepEqual(
    nextVersion(state, [sample('a', [1, Number.NaN])]),
    { ok: false, reason: 'invalid-embedding' },
  );
  assert.deepEqual(
    nextVersion(state, [sample('a', [1, 0], 799)]),
    { ok: false, reason: 'invalid-duration' },
  );
  assert.deepEqual(
    nextVersion(state, [sample('a', [1, 0]), sample('a', [1, 0])]),
    { ok: false, reason: 'duplicate-id' },
  );

  assert.deepEqual(snapshotState(state), before, 'no refusal may mutate the chain');
  assert.equal(state.versions.length, 1);
  assert.equal(state.currentVersion, 1);
});

// ---------------------------------------------------------------------------
// 5. Bounded chain
// ---------------------------------------------------------------------------

test('5. 链有界（20 默认）；超出丢最旧，current 与回滚目标仍在，版本号不复用', () => {
  assert.equal(DEFAULT_MAX_VERSIONS, 20);
  let state = nextVersion(null, [sample('seed', [1, 0])], {
    maxVersions: 4,
    createdAt: 1,
  }).state;

  for (let index = 0; index < 9; index += 1) {
    const strengthened = nextVersion(state, [sample('seed', [1, 0])], {
      maxVersions: 4,
      createdAt: index + 2,
    });
    assert.equal(strengthened.ok, true);
    state = strengthened.state;
    assert.ok(state.versions.length <= 4, 'chain must stay bounded');
    assert.ok(
      state.versions.some((record) => record.version === state.currentVersion),
      'current must stay in the chain',
    );
  }

  assert.equal(state.currentVersion, 10);
  assert.equal(state.lastVersion, 10);
  assert.deepEqual(state.versions.map((entry) => entry.version), [7, 8, 9, 10]);
  assert.equal(recordOf(state, 10).sampleCount, 10);
  assert.equal(recordOf(state, 10).totalDurationMs, 10000);

  const rollbackToSeven = rollback(state, 7);
  assert.equal(rollbackToSeven.ok, true);
  assert.equal(rollbackToSeven.currentVersion, 7);
  assert.deepEqual(rollbackToSeven.state.versions.map((entry) => entry.version), [7, 8, 9, 10]);
  assert.deepEqual(rollback(state, 6), {
    ok: false,
    reason: 'version-not-found',
    version: 6,
  });

  // Strengthening from an older current still issues a brand-new number and evicts the oldest.
  const afterRollback = nextVersion(rollbackToSeven.state, [sample('seed', [1, 0])], {
    maxVersions: 4,
    createdAt: 20,
  });
  assert.equal(afterRollback.ok, true);
  assert.equal(afterRollback.version, 11);
  assert.deepEqual(
    afterRollback.state.versions.map((entry) => entry.version),
    [8, 9, 10, 11],
  );
  const newest = recordOf(afterRollback.state, 11);
  assert.equal(newest.parentVersion, 7, 'parent records the source even if it was evicted');
  assert.equal(afterRollback.state.lastVersion, 11);
  assert.equal(rollback(afterRollback.state, 7).reason, 'version-not-found');

  let defaultBound = nextVersion(null, [sample('seed', [1, 0])]).state;
  for (let index = 0; index < 25; index += 1) {
    const strengthened = nextVersion(defaultBound, [sample('seed', [1, 0])]);
    assert.equal(strengthened.ok, true);
    defaultBound = strengthened.state;
  }
  assert.equal(defaultBound.versions.length, 20);
  assert.deepEqual(
    defaultBound.versions.map((entry) => entry.version),
    Array.from({ length: 20 }, (_, index) => index + 7),
  );
  assert.equal(defaultBound.currentVersion, 26);
});

// ---------------------------------------------------------------------------
// 6. Rollback / select
// ---------------------------------------------------------------------------

test('6. 回滚/选择只移动 current，不改写历史；找不到/坏向量拒绝', () => {
  let state = nextVersion(null, [sample('a', [1, 0])], { createdAt: 1 }).state;
  state = nextVersion(state, [sample('b', [1, 0])], { createdAt: 2 }).state;
  state = nextVersion(state, [sample('c', [1, 0])], { createdAt: 3 }).state;
  const history = snapshotState(state);
  assert.deepEqual(state.versions.map((entry) => entry.version), [1, 2, 3]);

  const restored = rollback(state, 1);
  assert.equal(restored.ok, true);
  assert.equal(restored.currentVersion, 1);
  assert.equal(restored.restoredFrom, 3);
  assert.equal(restored.changed, true);
  assert.deepEqual(
    snapshotState(restored.state).versions,
    history.versions,
    'history must be unchanged',
  );
  assert.equal(restored.state.lastVersion, 3);
  assert.equal(state.currentVersion, 3, 'the input state must not change');

  const same = rollback(restored.state, 1);
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);

  const selected = selectVersion(state, 2);
  assert.equal(selected.ok, true);
  assert.equal(selected.currentVersion, 2);
  assert.equal(selected.previousVersion, 3);
  assert.deepEqual(snapshotState(selected.state).versions, history.versions);

  assert.deepEqual(rollback(state, 99), {
    ok: false,
    reason: 'version-not-found',
    version: 99,
  });
  assert.deepEqual(rollback(state, 0), { ok: false, reason: 'invalid-version' });
  assert.deepEqual(rollback(state, '1'), { ok: false, reason: 'invalid-version' });
  assert.deepEqual(selectVersion(state, Number.NaN), { ok: false, reason: 'invalid-version' });
  assert.deepEqual(selectVersion(createEmptyVersionState(), 1), {
    ok: false,
    reason: 'version-not-found',
    version: 1,
  });
  assert.equal(state.currentVersion, 3, 'refusals must not move current');

  const corruptTarget = structuredClone(state);
  corruptTarget.versions[0].vector = new Float32Array([0, 0]);
  const bad = rollback(corruptTarget, 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-version-vector');
  assert.equal(bad.version, 1);
  assert.equal(corruptTarget.currentVersion, 3);

  const corruptOther = structuredClone(state);
  corruptOther.versions[1].vector = [Number.NaN, 0];
  const badOther = rollback(corruptOther, 3);
  assert.equal(badOther.ok, false);
  assert.equal(badOther.reason, 'invalid-state');
  assert.equal(badOther.detail, 'invalid-vector');
  assert.equal(badOther.version, 2);

  assert.deepEqual(getCurrentVersion(createEmptyVersionState()), { ok: true, record: null });
  const current = getCurrentVersion(state);
  assert.equal(current.ok, true);
  assert.equal(current.record.version, 3);
});

// ---------------------------------------------------------------------------
// 7. Immutability
// ---------------------------------------------------------------------------

test('7. 状态/记录/embedding 均不被修改，输出不与输入共享向量', () => {
  const initial = nextVersion(null, [sample('a', [1, 0])], { createdAt: 1 }).state;
  const before = snapshotState(initial);
  const batch = [{ id: 'b', embedding: new Float32Array([0.8, 0.6]), durationMs: 1000 }];
  const batchBefore = [...batch[0].embedding];

  const strengthened = nextVersion(initial, batch, { createdAt: 2 });
  assert.equal(strengthened.ok, true);
  assert.deepEqual(snapshotState(initial), before, 'input state must be untouched');
  assert.deepEqual([...batch[0].embedding], batchBefore, 'input embeddings must be untouched');
  assert.notEqual(
    recordOf(strengthened.state, 2).vector,
    batch[0].embedding,
    'the new record must own a fresh vector',
  );

  strengthened.state.versions[0].vector[0] = 123;
  strengthened.state.versions[1].vector[0] = 123;
  batch[0].embedding[0] = 123;
  assert.deepEqual(snapshotState(initial), before, 'mutating a result must not reach the input');

  const selected = selectVersion(initial, 1);
  assert.equal(selected.ok, true);
  const originalVector = [...initial.versions[0].vector];
  selected.state.versions[0].vector[0] = 999;
  assert.deepEqual([...initial.versions[0].vector], originalVector);

  const sourceVector = new Float32Array([3, 4]);
  const created = createVersion({
    vector: sourceVector,
    sampleCount: 2,
    totalDurationMs: 1000,
  });
  assert.equal(created.ok, true);
  assert.notEqual(created.record.vector, sourceVector);
  const seeded = createVersionState(created.record);
  assert.equal(seeded.ok, true);
  created.record.vector[0] = 123;
  assert.deepEqual([...sourceVector], [3, 4]);
  vectorClose([...seeded.state.versions[0].vector], [0.6, 0.8], 'seeded copy is independent');
});

// ---------------------------------------------------------------------------
// 8. Bad state
// ---------------------------------------------------------------------------

test('8. 坏 state/重复版本/缺失 current/坏向量均拒绝', () => {
  for (const badState of ['x', 42, [], true]) {
    const refused = nextVersion(badState, [sample('a', [1, 0])]);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'invalid-state');
    assert.equal(refused.detail, 'not-an-object');
  }
  const missingVersions = nextVersion({}, [sample('a', [1, 0])]);
  assert.equal(missingVersions.reason, 'invalid-state');
  assert.equal(missingVersions.detail, 'versions');

  const one = nextVersion(null, [sample('a', [1, 0])]).state;

  const duplicate = structuredClone(one);
  duplicate.versions.push(structuredClone(duplicate.versions[0]));
  const duplicateResult = nextVersion(duplicate, [sample('b', [1, 0])]);
  assert.equal(duplicateResult.reason, 'invalid-state');
  assert.equal(duplicateResult.detail, 'duplicate-version');

  const missingCurrent = structuredClone(one);
  missingCurrent.currentVersion = 99;
  const missingResult = nextVersion(missingCurrent, [sample('b', [1, 0])]);
  assert.equal(missingResult.reason, 'invalid-state');
  assert.equal(missingResult.detail, 'current-missing');

  const lowLast = structuredClone(one);
  lowLast.lastVersion = 0;
  const lowLastResult = nextVersion(lowLast, [sample('b', [1, 0])]);
  assert.equal(lowLastResult.reason, 'invalid-state');
  assert.equal(lowLastResult.detail, 'last-version');

  const badVector = structuredClone(one);
  badVector.versions[0].vector = [0, 0];
  const badVectorResult = nextVersion(badVector, [sample('b', [1, 0])]);
  assert.equal(badVectorResult.reason, 'invalid-state');
  assert.equal(badVectorResult.detail, 'invalid-vector');

  const emptyWithCurrent = { versions: [], currentVersion: 1, lastVersion: 0 };
  assert.equal(nextVersion(emptyWithCurrent, [sample('a', [1, 0])]).detail,
    'current-without-versions');
  assert.deepEqual(getCurrentVersion('nope'), {
    ok: false,
    reason: 'invalid-state',
    detail: 'not-an-object',
    version: null,
  });
});

// ---------------------------------------------------------------------------
// 9. Purity / constants
// ---------------------------------------------------------------------------

test('9. 模块无文件/网络/时钟/全局依赖，常量契约正确', () => {
  const source = readFileSync(
    new URL('../src/host/hearing/speaker-template-version.js', import.meta.url),
    'utf8',
  );
  const imports = [...source.matchAll(/^import\b[\s\S]*?from\s+'([^']+)';/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(imports, ['./speaker-template.js'], 'only the pure template module may be imported');
  assert.doesNotMatch(source, /\brequire\s*\(/u, 'no require');
  assert.doesNotMatch(source, /\bfetch\s*\(/u, 'no fetch');
  assert.doesNotMatch(source, /node:(fs|net|http|https|child_process)/u, 'no file/network modules');
  assert.doesNotMatch(
    source,
    /\b(writeFile|readFile|mkdir|unlink|createWriteStream|readFileSync)\b/u,
    'no file-system calls',
  );
  assert.doesNotMatch(source, /\bself\b/u, 'no self global');
  assert.doesNotMatch(source, /\b(process|globalThis)\b/u, 'no process/globalThis access');
  assert.doesNotMatch(source, /Date\.now|new Date\s*\(/u, 'the module never reads the clock');

  assert.equal(DEFAULT_MAX_VERSIONS, 20);
  assert.equal(DEFAULT_MAX_SAMPLES_PER_STRENGTHEN, 8);
  assert.equal(DEFAULT_MAX_DURATION_MS_PER_STRENGTHEN, 60000);
  assert.equal(DEFAULT_INCOMING_WEIGHT, 0.5);
  assert.equal(DEFAULT_MIN_SIMILARITY, 0.72);
  assert.equal(DEFAULT_MIN_SAMPLES_PER_STRENGTHEN, 1);
  assert.equal(DEFAULT_CONSISTENCY_THRESHOLD, 0.72);

  assert.deepEqual(createEmptyVersionState(), {
    versions: [],
    currentVersion: null,
    lastVersion: 0,
  });
  assert.deepEqual(getCurrentVersion(null), { ok: true, record: null });
});
