/**
 * Speaker-voice shadow — core layer (scoring only; it never gates a delivery).
 *
 * These tests pin the layer's contract, not CAM++'s accuracy (no model, no microphone, no ONNX
 * session and no network is touched here):
 *  1. enroll → matching the same voice scores ~1.0 and decides `match`; one `speaker.shadow` row
 *     carries exactly `{decision, score, speakerId, ms}` and the template is stamped as used;
 *  2. a different voice is `no-match`, a score inside the threshold band is `unsure`, and the
 *     threshold edge is exact (0.60 = match, 0.5999 = unsure, 0.52 = unsure, 0.5199 = no-match);
 *  3. the pinned model entry (URL / bytes / sha256 / target) is fixed, a missing model yields a
 *     null embedder, and matching without an embedding neither throws nor claims a speaker;
 *  4. a removed `speakerId` is retired forever: registering it again is refused, even after the
 *     database is reopened;
 *  5. the short-answer window is inclusive at its edge and never extends itself — 60 s later it is
 *     still closed;
 *  6. regression: both modules pass `node --check`, the shadow has no host wiring import, and the
 *     template table stores no audio column.
 *
 * Run: node --test test/speaker-voice.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DatabaseSync } from 'node:sqlite';

import {
  SPEAKER_MODEL_BYTES,
  SPEAKER_MODEL_FILE,
  SPEAKER_MODEL_SHA256,
  SPEAKER_MODEL_URL,
  ensureModel,
  ensureSpeakerModel,
  isSharedModelTarget,
  speakerModelTarget,
} from '../src/host/platform/modelDownload.js';
import {
  IDENTITY_WINDOW_MS,
  SPEAKER_MATCH_DEFAULTS,
  classifyScore,
  createSpeakerEmbedder,
  createSpeakerLibrary,
  identityWindow,
} from '../src/host/hearing/speakerVoice.js';

const run = promisify(execFile);

/** A 4-dim embedding helper: short, readable and enough to exercise cosine exactly. */
const vector = (values) => Float32Array.from(values);

/** One temp root + one library per test; the sink collects what the shadow emits. */
async function fresh(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'speaker-voice-'));
  const events = [];
  const library = createSpeakerLibrary({
    root,
    onEvent: (type, payload) => events.push({ type, payload }),
    ...options,
  });
  t.after(async () => {
    try {
      library.close();
    } catch {
      /* already closed by the test */
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, library, events };
}

const ofType = (events, type) => events.filter((event) => event.type === type);

test('1) 注册 → 同向量匹配 score≈1 → decision=match，事件字段齐全', async (t) => {
  const { library, events } = await fresh(t);
  const alice = vector([0.9, 0.3, 0.1, 0.2]);

  const registered = library.register('alice', alice, { label: 'Alice' });
  assert.deepEqual(registered, { ok: true, speakerId: 'alice', created: true, activeCount: 1 });
  assert.deepEqual(
    ofType(events, 'speaker.template.updated').map((event) => event.payload),
    [{ speakerId: 'alice', reason: 'register' }],
    'enrollment emits one template.updated',
  );

  // A fresh copy, not the same array: the embedding is compared by value, never by identity.
  const scored = library.match(vector([0.9, 0.3, 0.1, 0.2]));
  assert.equal(scored.decision, 'match');
  assert.equal(scored.speakerId, 'alice');
  assert.equal(scored.score, 1, 'an identical direction scores 1.0');

  // Amplitude is irrelevant to cosine: the same voice recorded louder still matches.
  const louder = alice.map((value) => value * 4);
  assert.equal(library.match(louder).decision, 'match');

  const shadow = library.shadow(vector([0.9, 0.3, 0.1, 0.2]));
  assert.equal(shadow.decision, 'match');
  assert.equal(shadow.score, 1);
  assert.equal(shadow.speakerId, 'alice');
  assert.ok(Number.isFinite(shadow.ms) && shadow.ms >= 0, 'every shadow row carries a measured ms');

  const rows = ofType(events, 'speaker.shadow').map((event) => event.payload);
  assert.equal(rows.length, 1, 'one row per shadow() call, and match() alone emits nothing');
  assert.deepEqual(rows[0], { decision: 'match', score: 1, speakerId: 'alice', ms: shadow.ms });

  const stored = library.get('alice');
  assert.equal(stored.activeCount, 1);
  assert.equal(stored.enabled, true);
  assert.equal(stored.label, 'Alice');
  assert.equal(stored.dim, 4);
  assert.ok(stored.embedding instanceof Float32Array, 'the template vector survives the round trip');
  assert.equal(stored.embedding.length, 4);
  assert.ok(typeof stored.lastMatchedAt === 'string', 'a match stamps lastMatchedAt');
  assert.equal(library.list().length, 1);
  assert.equal(library.list()[0].embedding, undefined, 'list() answers with metadata only');

  console.log(
    `[speaker-voice 1] decision=${scored.decision} score=${scored.score} speakerId=${scored.speakerId} `
    + `ms=${shadow.ms} activeCount=${stored.activeCount} lastMatchedAt=${stored.lastMatchedAt !== null}`,
  );
});

test('2) 不同向量 → no-match；阈值带内 → unsure；阈值边界精确', async (t) => {
  const { library } = await fresh(t);
  library.register('alice', vector([1, 0, 0, 0]));

  // Orthogonal voice: cosine 0, clearly below the band.
  const different = library.match(vector([0, 1, 0, 0]));
  assert.equal(different.decision, 'no-match');
  assert.equal(different.score, 0);
  assert.equal(different.speakerId, 'alice', 'the best candidate is still reported as evidence');

  // cosine 0.36 sits between the lower edge (0.32) and the threshold (0.40).
  const cosine036 = vector([0.36, Math.sqrt(1 - 0.36 * 0.36), 0, 0]);
  const middle = library.match(cosine036);
  assert.equal(middle.decision, 'unsure');
  assert.equal(middle.score, 0.36);
  assert.equal(middle.speakerId, 'alice');

  // The threshold band is configurable, and moving it moves the verdict, not the score.
  assert.equal(library.match(cosine036, { threshold: 0.35 }).decision, 'match');
  assert.equal(library.match(cosine036, { threshold: 0.4, unsureMargin: 0.02 }).decision, 'no-match');

  // Exact edges of the default band: match >= T, unsure in [T-M, T), no-match < T-M.
  const { threshold, unsureMargin } = SPEAKER_MATCH_DEFAULTS;
  const lowerEdge = threshold - unsureMargin;
  assert.equal(threshold, 0.4, 'the upstream example default, kept as the documented starting point');
  assert.equal(unsureMargin, 0.08);
  assert.equal(classifyScore(threshold), 'match');
  assert.equal(classifyScore(threshold - 1e-6), 'unsure');
  assert.equal(classifyScore(lowerEdge), 'unsure', 'the lower edge belongs to unsure');
  assert.equal(classifyScore(lowerEdge - 1e-6), 'no-match');
  assert.equal(classifyScore(Number.NaN), 'unsure', 'an unmeasured score claims nothing');

  console.log(
    `[speaker-voice 2] different=${different.decision}/${different.score} middle=${middle.decision}/${middle.score} `
    + `edge: T=${classifyScore(threshold)} (T-1e-6)=${classifyScore(threshold - 1e-6)} `
    + `(T-M)=${classifyScore(lowerEdge)} (T-M-1e-6)=${classifyScore(lowerEdge - 1e-6)}`,
  );
});

/** A tiny in-memory stand-in for the sherpa extractor; the real one needs a 28 MB model. */
function fakeExtractor({ result = vector([0.1, 0.2, 0.3]), throwOnCompute = false, ready = true } = {}) {
  return {
    dim: 3,
    createStream: () => ({ acceptWaveform() {}, inputFinished() {} }),
    isReady: () => ready,
    compute: () => {
      if (throwOnCompute) throw new Error('onnx session closed');
      return result;
    },
  };
}

/** A fake HTTP response carrying exactly `buffer`, as `ensureModel` expects to read it. */
const responseOf = (buffer) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
});

test('3) 模型条目固定；模型缺失 → embedder=null、match/shadow 不抛', async (t) => {
  const { root, library } = await fresh(t);

  // The pinned entry: exact source, size and digest, and the shared `models/` destination.
  assert.equal(
    SPEAKER_MODEL_URL,
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
      + '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  );
  assert.equal(SPEAKER_MODEL_FILE, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx');
  assert.equal(SPEAKER_MODEL_BYTES, 28281138);
  assert.match(SPEAKER_MODEL_SHA256, /^[0-9a-f]{64}$/u);
  const target = speakerModelTarget({ modelDir: join(root, 'models', 'stream') });
  assert.equal(target, join(root, 'models', SPEAKER_MODEL_FILE));
  assert.equal(isSharedModelTarget(target), true);

  // A missing model is `null`, never a throw: both the empty path and an absent file.
  assert.equal(createSpeakerEmbedder({ modelPath: join(root, 'missing.onnx') }), null);
  assert.equal(createSpeakerEmbedder({}), null);

  // The pinned download reuses ensureModel: wrong bytes fail verification and emit speaker.model.*.
  const events = [];
  await assert.rejects(
    ensureSpeakerModel({
      targetPath: target,
      fetchImpl: async () => responseOf(Buffer.alloc(64, 3)),
      retries: 0,
      onEvent: (type, payload) => events.push({ type, payload }),
    }),
    (error) => error.reason === 'size-mismatch',
  );
  assert.deepEqual(events.map((event) => event.type), ['speaker.model.failed']);
  assert.equal(events[0].payload.reason, 'size-mismatch');
  assert.equal(existsSync(target), false, 'no half file or unverified target is left behind');

  // The prefix is a parameter of the shared mechanism, so the VAD events keep their old names.
  const body = Buffer.alloc(128, 5);
  const vadEvents = [];
  await ensureModel({
    targetPath: join(root, 'models', 'silero_vad.onnx'),
    url: 'https://example.invalid/silero_vad.onnx',
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    retries: 0,
    fetchImpl: async () => responseOf(body),
    onEvent: (type, payload) => vadEvents.push({ type, payload }),
  });
  assert.deepEqual(vadEvents.map((event) => event.type), ['vad.model.download', 'vad.model.ready']);

  // No embedding means "unsure", not "not them": the shadow refuses to guess and never throws.
  const result = library.match(null);
  assert.deepEqual(result, { decision: 'unsure', speakerId: null, score: 0 });
  assert.doesNotThrow(() => library.shadow(null));
  assert.equal(library.shadow(null).decision, 'unsure');

  // The extractor wrapper itself: a real (dummy) file plus the test seam proves embed()'s contract.
  const dummy = join(root, 'dummy.onnx');
  await writeFile(dummy, 'not-a-real-model');
  const embedder = createSpeakerEmbedder({ modelPath: dummy, extractorFactory: () => fakeExtractor() });
  assert.ok(embedder !== null);
  const embedding = embedder.embed(new Float32Array(1600));
  assert.ok(embedding instanceof Float32Array);
  assert.equal(embedding.length, 3);
  assert.equal(embedder.embed(null), null, 'no PCM → no vector');
  assert.equal(embedder.embed(new Float32Array(0)), null);
  const notReady = createSpeakerEmbedder({
    modelPath: dummy,
    extractorFactory: () => fakeExtractor({ ready: false }),
  });
  assert.ok(notReady !== null);
  assert.equal(notReady.embed(new Float32Array(1600)), null, 'a stream that never became ready yields null');
  const brokenEmbedder = createSpeakerEmbedder({
    modelPath: dummy,
    extractorFactory: () => fakeExtractor({ throwOnCompute: true }),
  });
  assert.ok(brokenEmbedder !== null);
  assert.equal(brokenEmbedder.embed(new Float32Array(1600)), null, 'a failing extractor yields null, not a throw');
  assert.equal(createSpeakerEmbedder({ modelPath: dummy, extractorFactory: () => null }), null);

  console.log(
    `[speaker-voice 3] url=pinned bytes=${SPEAKER_MODEL_BYTES} sha256=${SPEAKER_MODEL_SHA256.slice(0, 12)}… `
    + `embedder(missing)=null match(null)=${result.decision}/${result.speakerId}/${result.score} `
    + `downloadEvent=${events[0].type}:${events[0].payload.reason} vadEvents=${vadEvents.length}`,
  );
});

test('4) 删除后同 speakerId 再注册 → 拒绝（不可复用），重开库仍拒绝', async (t) => {
  const { root, library } = await fresh(t);
  const bob = vector([0.4, 0.5, 0.6, 0.7]);
  assert.equal(library.register('bob', bob).ok, true);

  assert.deepEqual(library.remove('bob'), { ok: true, speakerId: 'bob' });
  assert.equal(library.get('bob'), null);
  assert.deepEqual(library.list(), []);
  assert.deepEqual(library.remove('bob'), { ok: false, reason: 'missing', speakerId: 'bob' });

  const again = library.register('bob', bob);
  assert.deepEqual(again, { ok: false, reason: 'retired', speakerId: 'bob' });
  assert.equal(library.get('bob'), null, 'a refused re-registration writes nothing');
  assert.equal(library.list().length, 0);

  // Another speaker is unaffected, and removal is not an excuse to reuse the id.
  assert.equal(library.register('carol', bob).ok, true);
  assert.equal(library.match(bob).speakerId, 'carol');

  // The tombstone is durable: a reopened database still refuses the retired id.
  library.close();
  const reopened = createSpeakerLibrary({ root });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.register('bob', bob), { ok: false, reason: 'retired', speakerId: 'bob' });
  assert.equal(reopened.get('carol')?.speakerId, 'carol', 'live templates survive the reopen');

  console.log(
    `[speaker-voice 4] removed=bob reRegister=retired reopen=retired live=carol `
    + `list=${reopened.list().length}`,
  );
});

test('5) 短答窗口：窗口内 true、窗口外 false，60 秒后仍 false（不自动续期）', async () => {
  assert.ok(IDENTITY_WINDOW_MS >= 3000 && IDENTITY_WINDOW_MS <= 5000, 'the default lives in 3–5 s');

  const window = identityWindow({ lastConfirmedAt: 1_000_000, windowMs: 4000 });
  assert.equal(window.canReuse(1_000_000), true, 'the confirmation moment itself is inside');
  assert.equal(window.canReuse(1_004_000), true, 'the edge is inclusive');
  assert.equal(window.canReuse(1_004_001), false, 'one ms past the edge is outside');
  assert.equal(window.canReuse(1_060_000), false, '60 s later it is still closed');
  assert.equal(window.lastConfirmedAt, 1_000_000, 'canReuse never moves the confirmation');
  assert.equal(window.expiresAt, 1_004_000);

  // "Noise" is just repeated reads: a hundred checks cannot extend the window.
  for (let index = 0; index < 100; index += 1) assert.equal(window.canReuse(1_003_000), true);
  assert.equal(window.canReuse(1_004_001), false);

  // A clock that runs backwards is not evidence of a live window.
  assert.equal(window.canReuse(999_999), false);

  // No confirmation yet → never reusable; the default window is used when none is given.
  assert.equal(identityWindow({}).canReuse(Date.now()), false);
  assert.equal(identityWindow({ lastConfirmedAt: 0 }).canReuse(0), false);
  const withDefault = identityWindow({ lastConfirmedAt: 5_000 });
  assert.equal(withDefault.windowMs, IDENTITY_WINDOW_MS);
  assert.equal(withDefault.canReuse(8_000), true);
  assert.equal(withDefault.canReuse(9_001), false);

  // A Date is accepted on both sides.
  const dated = identityWindow({ lastConfirmedAt: new Date(1_000_000) });
  assert.equal(dated.canReuse(new Date(1_002_000)), true);

  console.log(
    `[speaker-voice 5] windowMs=${window.windowMs} edge(1_004_000)=true edge+1ms=false `
    + `60s=false default=${IDENTITY_WINDOW_MS}`,
  );
});

test('6) 回归：node --check、无宿主依赖、表里没有音频列', async (t) => {
  // Syntax check both modules exactly as the review procedure does.
  for (const file of ['hearing/speakerVoice.js', 'platform/modelDownload.js']) {
    const path = fileURLToPath(new URL(`../src/host/${file}`, import.meta.url));
    await assert.doesNotReject(run(process.execPath, ['--check', path]));
  }

  // No host wiring: the shadow must stay importable without index.js/hearing.js/dispatch.js.
  const source = await readFile(new URL('../src/host/hearing/speakerVoice.js', import.meta.url), 'utf8');
  for (const forbidden of ['./index.js', './hearing.js', './dispatch.js', './hotkeys.js']) {
    assert.ok(!source.includes(`'${forbidden}'`), `speakerVoice.js must not import ${forbidden}`);
  }
  assert.ok(source.includes("from '../memory/store.js'"), 'root/ISO helpers are reused from store.js');

  // What is actually stored: metadata + one vector BLOB, never raw audio.
  const { root, library } = await fresh(t);
  library.register('dave', vector([0.2, 0.2, 0.2, 0.2]));
  library.open();
  const db = new DatabaseSync(join(root, 'memory', 'speaker.db'));
  t.after(() => db.close());
  const columns = db.prepare('PRAGMA table_info(speaker_template)').all().map((row) => row.name);
  assert.deepEqual(columns, [
    'speaker_id', 'label', 'dim', 'embedding', 'created_at', 'updated_at',
    'last_matched_at', 'active_count', 'enabled',
  ]);
  assert.ok(!columns.some((name) => /audio|pcm|wave|sample/iu.test(name)), 'no audio column exists');
  const retired = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'speaker_retired'")
    .get();
  assert.equal(retired?.name, 'speaker_retired', 'the retirement tombstone owns a table');

  // An already-open connection may be injected (the profileStore habit): the library uses it and
  // must never close a connection it does not own.
  const sharedRoot = await mkdtemp(join(tmpdir(), 'speaker-voice-shared-'));
  await mkdir(join(sharedRoot, 'memory'), { recursive: true });
  const injected = new DatabaseSync(join(sharedRoot, 'memory', 'memory.db'));
  t.after(async () => {
    try {
      injected.close();
    } catch {
      /* already closed */
    }
    await rm(sharedRoot, { recursive: true, force: true }).catch(() => {});
  });
  const shared = createSpeakerLibrary({ db: injected });
  assert.equal(shared.register('erin', vector([0.5, 0.5])).ok, true);
  assert.ok(
    injected.prepare("SELECT name FROM sqlite_master WHERE name = 'speaker_template'").get(),
    'tables are created on the injected connection',
  );
  shared.close();
  assert.equal(
    injected.prepare('SELECT COUNT(*) AS c FROM speaker_template').get().c,
    1,
    'close() leaves an injected connection open',
  );

  console.log(
    `[speaker-voice 6] node --check=ok hostImports=none columns=${columns.join(',')} retiredTable=ok `
    + `injectedDb=ok`,
  );
});
