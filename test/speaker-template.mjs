/**
 * Speaker template — pure decision / vector math.
 *
 * The list mirrors the acceptance items:
 *   1. a consistent set produces one L2 unit vector from the duration-weighted average;
 *   2. duration really is the weight: swapping durations moves the direction accordingly;
 *   3. fewer than two candidates is allowed but marked `low-sample`;
 *   4. any pair below the cosine floor refuses the set, reports `minPairCosine` and `outlierIds`,
 *      and produces no vector;
 *   5. malformed candidates (empty/non-finite/zero embedding, dimension mismatch, bad duration,
 *      bad/duplicate id) are refused with an explainable reason;
 *   6. `mergeTemplate()` weights the incoming share, normalizes, and never mutates its inputs;
 *   7. the module has no file/network/model/library imports and no side effects.
 *
 * Run: node --test test/speaker-template.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SPEAKER_TEMPLATE_MERGE_WEIGHT,
  DEFAULT_SPEAKER_TEMPLATE_THRESHOLD,
  SPEAKER_TEMPLATE_CONFIDENCE,
  SPEAKER_TEMPLATE_MAX_DURATION_MS,
  SPEAKER_TEMPLATE_MIN_DURATION_MS,
  SPEAKER_TEMPLATE_MIN_SAMPLES,
  buildSpeakerTemplate,
  cosineSimilarity,
  mergeTemplate,
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

function candidate(overrides = {}) {
  return {
    id: 'a',
    embedding: [1, 0],
    durationMs: 1000,
    quality: 'ok',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Consistent set
// ---------------------------------------------------------------------------

test('1. 一致候选 → 时长加权的 L2 单位向量，返回证据且不修改输入', () => {
  const firstEmbedding = new Float32Array([1, 0]);
  const secondEmbedding = [0.8, 0.6];
  const first = {
    id: 'a',
    embedding: firstEmbedding,
    durationMs: 1000,
    quality: 'ok',
    createdAt: '2026-11-10T00:00:00.000Z',
  };
  const second = {
    id: 'b',
    embedding: secondEmbedding,
    durationMs: 3000,
    quality: 'ok',
  };

  const result = buildSpeakerTemplate([first, second]);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result).sort(), [
    'confidence',
    'minPairCosine',
    'ok',
    'sampleCount',
    'totalDurationMs',
    'vector',
  ]);

  // (1*1000 + 0.8*3000) / 4000 = 0.85; (0*1000 + 0.6*3000) / 4000 = 0.45, then normalized.
  vectorClose([...result.vector], unit([0.85, 0.45]), 'weighted unit vector');
  close(norm(result.vector), 1, 'unit norm');
  assert.equal(result.sampleCount, 2);
  assert.equal(result.totalDurationMs, 4000);
  close(result.minPairCosine, 0.8, 'pair cosine');
  assert.equal(result.confidence, 'ok');

  // The longer candidate pulls the direction toward itself, not toward the simple mean.
  assert.ok(
    cosineSimilarity(result.vector, unit([0.8, 0.6]))
      > cosineSimilarity(result.vector, unit([1, 0])),
    'the 3000ms candidate must dominate the 1000ms candidate',
  );

  // Fresh output, untouched inputs.
  assert.notEqual(result.vector, firstEmbedding, 'the stored vector must be a copy');
  assert.deepEqual([...firstEmbedding], [...new Float32Array([1, 0])]);
  assert.deepEqual(secondEmbedding, [0.8, 0.6]);
  result.vector[0] = 99;
  assert.deepEqual([...firstEmbedding], [...new Float32Array([1, 0])]);
  assert.deepEqual(secondEmbedding, [0.8, 0.6]);
});

test('2. 时长权重影响方向；相同时长退化为均值方向', () => {
  const longA = buildSpeakerTemplate([
    candidate({ id: 'a', embedding: [1, 0], durationMs: 4000 }),
    candidate({ id: 'b', embedding: [0.8, 0.6], durationMs: 1000 }),
  ]);
  const longB = buildSpeakerTemplate([
    candidate({ id: 'a', embedding: [1, 0], durationMs: 1000 }),
    candidate({ id: 'b', embedding: [0.8, 0.6], durationMs: 4000 }),
  ]);
  const even = buildSpeakerTemplate([
    candidate({ id: 'a', embedding: [1, 0], durationMs: 2000 }),
    candidate({ id: 'b', embedding: [0.8, 0.6], durationMs: 2000 }),
  ]);

  assert.equal(longA.ok, true);
  assert.equal(longB.ok, true);
  assert.equal(even.ok, true);
  assert.equal(longA.totalDurationMs, 5000);
  assert.equal(longB.totalDurationMs, 5000);

  assert.ok(
    cosineSimilarity(longA.vector, unit([1, 0]))
      > cosineSimilarity(longA.vector, unit([0.8, 0.6])),
    'longA must lean toward [1, 0]',
  );
  assert.ok(
    cosineSimilarity(longB.vector, unit([0.8, 0.6]))
      > cosineSimilarity(longB.vector, unit([1, 0])),
    'longB must lean toward [0.8, 0.6]',
  );
  assert.notDeepEqual([...longA.vector], [...longB.vector]);
  vectorClose([...even.vector], unit([0.9, 0.3]), 'equal durations use the mean direction');
});

// ---------------------------------------------------------------------------
// 2. Low sample
// ---------------------------------------------------------------------------

test('3. 少于 2 条允许但标 low-sample；空输入拒绝', () => {
  const only = buildSpeakerTemplate([
    { id: 'only', embedding: new Float32Array([3, 4]), durationMs: 1000, quality: 'ok' },
  ]);
  assert.equal(only.ok, true);
  vectorClose([...only.vector], [0.6, 0.8], 'single candidate normalized');
  close(norm(only.vector), 1, 'single unit norm');
  assert.equal(only.sampleCount, 1);
  assert.equal(only.totalDurationMs, 1000);
  assert.equal(only.minPairCosine, 1, 'one candidate has no pair; 1 is the vacuous minimum');
  assert.equal(only.confidence, 'low-sample');
  assert.equal(SPEAKER_TEMPLATE_CONFIDENCE.LOW_SAMPLE, 'low-sample');

  const negative = buildSpeakerTemplate([
    { id: 'only', embedding: [-2, 0], durationMs: 800, quality: 'ok' },
  ]);
  assert.equal(negative.ok, true);
  vectorClose([...negative.vector], [-1, 0], 'negative single candidate');
  assert.equal(negative.confidence, 'low-sample');

  const pair = buildSpeakerTemplate([
    candidate({ id: 'a', embedding: [1, 0] }),
    candidate({ id: 'b', embedding: [0.8, 0.6] }),
  ]);
  assert.equal(pair.ok, true);
  assert.equal(pair.confidence, 'ok');
  assert.equal(pair.sampleCount, SPEAKER_TEMPLATE_MIN_SAMPLES);

  assert.deepEqual(buildSpeakerTemplate([]), { ok: false, reason: 'no-candidates' });
  assert.deepEqual(buildSpeakerTemplate(null), { ok: false, reason: 'invalid-candidates' });
  assert.deepEqual(buildSpeakerTemplate('nope'), { ok: false, reason: 'invalid-candidates' });
});

// ---------------------------------------------------------------------------
// 3. Consistency
// ---------------------------------------------------------------------------

test('4. 任一对低于阈值 → inconsistent，报 minPairCosine/outlierIds，无模板', () => {
  const a = candidate({ id: 'a', embedding: [1, 0] });
  const b = candidate({ id: 'b', embedding: [0, 1] });
  const refused = buildSpeakerTemplate([a, b]);
  assert.deepEqual(refused, {
    ok: false,
    reason: 'inconsistent',
    minPairCosine: 0,
    outlierIds: ['a', 'b'],
  });
  assert.equal('vector' in refused, false, 'a refused set must not carry a template');

  // One deviant among two compatible samples: removing the deviant makes the rest consistent.
  const goodA = candidate({ id: 'a', embedding: [1, 0] });
  const goodB = candidate({ id: 'b', embedding: [0.8, 0.6] });
  const deviant = candidate({ id: 'c', embedding: [0, 1] });
  const oneBad = buildSpeakerTemplate([goodA, goodB, deviant]);
  assert.equal(oneBad.ok, false);
  assert.equal(oneBad.reason, 'inconsistent');
  close(oneBad.minPairCosine, 0, 'a/c is orthogonal');
  assert.deepEqual(oneBad.outlierIds, ['c'], 'the single removable deviant is named');
  assert.equal('vector' in oneBad, false);

  // No single removal fixes a mutually inconsistent set: fall back to every endpoint.
  const threeWay = buildSpeakerTemplate([
    candidate({ id: 'a', embedding: [1, 0] }),
    candidate({ id: 'b', embedding: [-0.5, Math.sqrt(3) / 2] }),
    candidate({ id: 'c', embedding: [-0.5, -Math.sqrt(3) / 2] }),
  ]);
  assert.equal(threeWay.ok, false);
  assert.equal(threeWay.reason, 'inconsistent');
  assert.deepEqual(threeWay.outlierIds, ['a', 'b', 'c']);

  // A lower floor can accept the same set; the reported minimum stays the real minimum.
  const lenient = buildSpeakerTemplate([goodA, goodB, deviant], { threshold: -0.5 });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.confidence, 'ok');
  close(lenient.minPairCosine, 0, 'minimum is still reported');

  // Exactly at the floor passes; one hair above refuses.
  const boundary = buildSpeakerTemplate(
    [candidate({ id: 'a', embedding: [1, 0] }), candidate({ id: 'b', embedding: [0.6, 0.8] })],
    { threshold: 0.6 },
  );
  assert.equal(boundary.ok, true, 'score >= threshold must pass');
  close(boundary.minPairCosine, 0.6, 'boundary cosine');
  const aboveBoundary = buildSpeakerTemplate(
    [candidate({ id: 'a', embedding: [1, 0] }), candidate({ id: 'b', embedding: [0.6, 0.8] })],
    { threshold: 0.600001 },
  );
  assert.equal(aboveBoundary.ok, false);
  assert.equal(aboveBoundary.reason, 'inconsistent');
});

// ---------------------------------------------------------------------------
// 4. Validation
// ---------------------------------------------------------------------------

test('5. 坏 embedding / 时长 / id / 结构逐项拒绝', () => {
  const badEmbeddings = [
    [],
    new Float32Array(0),
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    [1, 1e39],
    [0, 0],
    ['1', 0],
    { 0: 1, length: 1 },
    'AAAA',
    undefined,
  ];
  for (const embedding of badEmbeddings) {
    assert.deepEqual(
      buildSpeakerTemplate([candidate({ embedding })]),
      { ok: false, reason: 'invalid-embedding' },
      `embedding ${String(embedding)} must be refused`,
    );
  }

  const badDurations = [799, 15001, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, true, ''];
  for (const durationMs of badDurations) {
    assert.deepEqual(
      buildSpeakerTemplate([candidate({ durationMs })]),
      { ok: false, reason: 'invalid-duration' },
      `duration ${String(durationMs)} must be refused`,
    );
  }

  const invalidInputs = [
    [[null], 'invalid-candidate'],
    [[42], 'invalid-candidate'],
    [[candidate({ id: '' })], 'invalid-id'],
    [[candidate({ id: '   ' })], 'invalid-id'],
    [[candidate({ id: 42 })], 'invalid-id'],
    [[candidate(), candidate({ id: 'a' })], 'duplicate-id'],
    [[candidate(), candidate({ id: 'b', embedding: [1, 0, 0] })], 'dim-mismatch'],
  ];
  for (const [candidates, reason] of invalidInputs) {
    assert.deepEqual(buildSpeakerTemplate(candidates), { ok: false, reason });
  }

  // Inclusive duration boundaries; the same compatible direction keeps the set consistent.
  const boundary = buildSpeakerTemplate([
    candidate({ id: 'a', durationMs: 800 }),
    candidate({ id: 'b', durationMs: 15000 }),
  ]);
  assert.equal(boundary.ok, true);
  assert.equal(boundary.totalDurationMs, 15800);
  assert.equal(SPEAKER_TEMPLATE_MIN_DURATION_MS, 800);
  assert.equal(SPEAKER_TEMPLATE_MAX_DURATION_MS, 15000);
});

test('6. quality / createdAt 不参与门槛：选择由调用方负责', () => {
  const result = buildSpeakerTemplate([
    candidate({ id: 'a', quality: 'short', createdAt: 'not-a-date' }),
    candidate({ id: 'b', embedding: [0.8, 0.6], quality: 'noisy', createdAt: undefined }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.sampleCount, 2);
});

// ---------------------------------------------------------------------------
// 5. Merge
// ---------------------------------------------------------------------------

test('7. mergeTemplate：weight 是 incoming 份额，归一化，不动输入', () => {
  const existingVector = new Float32Array([1, 0]);
  const incomingEmbedding = [0, 1];
  const existing = { vector: existingVector, sampleCount: 2, totalDurationMs: 3000 };
  const incoming = {
    id: 'c',
    embedding: incomingEmbedding,
    durationMs: 1000,
    quality: 'ok',
  };
  const existingSnapshot = [...existingVector];
  const incomingSnapshot = [...incomingEmbedding];

  const merged = mergeTemplate(existing, incoming, 0.25);
  assert.equal(merged.ok, true);
  vectorClose([...merged.vector], unit([0.75, 0.25]), 'weighted merge');
  close(norm(merged.vector), 1, 'merged unit norm');
  assert.equal(merged.sampleCount, 3, '2 existing + 1 incoming');
  assert.equal(merged.totalDurationMs, 4000, '3000 existing + 1000 incoming');
  assert.notEqual(merged.vector, existingVector);
  assert.notEqual(merged.vector, incomingEmbedding);
  assert.deepEqual([...existingVector], existingSnapshot);
  assert.deepEqual(incomingEmbedding, incomingSnapshot);

  merged.vector[0] = 123;
  assert.deepEqual([...existingVector], existingSnapshot);
  assert.deepEqual(incomingEmbedding, incomingSnapshot);

  // 0 keeps the existing direction, 1 takes the incoming direction.
  const keep = mergeTemplate(existing, incoming, 0);
  assert.equal(keep.ok, true);
  vectorClose([...keep.vector], [1, 0], 'weight 0');
  const take = mergeTemplate(existing, incoming, 1);
  assert.equal(take.ok, true);
  vectorClose([...take.vector], [0, 1], 'weight 1');

  // Default weight is 0.5; raw vectors and non-unit magnitudes normalize first.
  const half = mergeTemplate([2, 0], [0, 3]);
  assert.equal(half.ok, true);
  vectorClose([...half.vector], unit([0.5, 0.5]), 'default weight');
  assert.equal(DEFAULT_SPEAKER_TEMPLATE_MERGE_WEIGHT, 0.5);
  assert.equal(half.sampleCount, 2);
  assert.equal(half.totalDurationMs, 0);
});

test('8. mergeTemplate：坏权重/坏向量/维度不一致/零和对消全部拒绝', () => {
  for (const weight of [null, '', false, [], -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, 'half']) {
    assert.deepEqual(
      mergeTemplate([1, 0], [0, 1], weight),
      { ok: false, reason: 'invalid-weight' },
      `weight ${String(weight)} must be refused`,
    );
  }
  assert.deepEqual(mergeTemplate(null, [0, 1]), { ok: false, reason: 'invalid-existing' });
  assert.deepEqual(mergeTemplate([1, 0], null), { ok: false, reason: 'invalid-incoming' });
  assert.deepEqual(
    mergeTemplate({ vector: [0, 0] }, [0, 1]),
    { ok: false, reason: 'invalid-existing' },
  );
  assert.deepEqual(
    mergeTemplate([1, 0], { embedding: [1, Number.NaN] }),
    { ok: false, reason: 'invalid-incoming' },
  );
  assert.deepEqual(mergeTemplate([1, 0, 0], [1, 0]), { ok: false, reason: 'dim-mismatch' });
  assert.deepEqual(mergeTemplate([1, 0], [-1, 0], 0.5), { ok: false, reason: 'zero-vector' });
});

// ---------------------------------------------------------------------------
// 6. Purity / constants
// ---------------------------------------------------------------------------

test('9. 模块无 import / 文件 / 网络 / 模型调用；常量契约正确', () => {
  const source = readFileSync(
    new URL('../src/host/hearing/speaker-template.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*import\b/mu, 'no imports');
  assert.doesNotMatch(source, /\brequire\s*\(/u, 'no require');
  assert.doesNotMatch(source, /\bfetch\s*\(/u, 'no fetch');
  assert.doesNotMatch(source, /node:(fs|net|http|https|child_process)/u, 'no file/network modules');
  assert.doesNotMatch(source, /\b(writeFile|readFile|mkdir|unlink|createWriteStream)\b/u,
    'no file-system calls');

  assert.equal(DEFAULT_SPEAKER_TEMPLATE_THRESHOLD, 0.72);
  assert.equal(SPEAKER_TEMPLATE_MIN_DURATION_MS, 800);
  assert.equal(SPEAKER_TEMPLATE_MAX_DURATION_MS, 15000);
  assert.equal(SPEAKER_TEMPLATE_MIN_SAMPLES, 2);
  assert.deepEqual(SPEAKER_TEMPLATE_CONFIDENCE, { OK: 'ok', LOW_SAMPLE: 'low-sample' });
});

test('10. cosineSimilarity：坏对得 0，正常对在 [-1, 1]', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([1, Number.NaN], [1, 0]), 0);
  assert.equal(cosineSimilarity(null, [1, 0]), 0);
  close(cosineSimilarity([1, 0], [0.6, 0.8]), 0.6, 'ordinary cosine');
});
