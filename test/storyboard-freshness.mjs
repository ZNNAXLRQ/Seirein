/**
 * P2 storyboard freshness: packing a sheet must not refresh the observation age.
 *
 * Every process-shaped backend is a test double: `dsh-see-now` becomes a frame tap plus a
 * queue-fed pipeline that returns pre-built sheets, and the clock is the node:test Date mock.
 * No real screen, ffmpeg or packing runs here.
 *
 * Run: node --test test/storyboard-freshness.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = 1_700_000_000_000;
const FPS = 12;

const state = { frame: null, run: null, pushed: [], nextSheet: null };
globalThis.__storyboardFreshnessTest = state;

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/dsh-see-now/src/capture.js')) return {
      format: 'module',
      shortCircuit: true,
      // The fake stream keeps the real contract: `{ i, t: i / fps, buf }`, arrival order.
      source: `const s = globalThis.__storyboardFreshnessTest;
        export const pickScreenEngine = async () => 'ddagrab';
        export const captureArgs = () => ['fake', '-'];
        export const spawnFrames = (options) => { s.frame = options.onFrame; return s.run; };`,
    };
    if (url.endsWith('/dsh-see-now/src/pipeline.js')) return {
      format: 'module',
      shortCircuit: true,
      source: `const s = globalThis.__storyboardFreshnessTest;
        export const createPipeline = () => ({
          push(frame) { s.pushed.push(frame); },
          take() { const sheet = s.nextSheet; s.nextSheet = null; return sheet; },
          flushNow() { return null; },
        });`,
    };
    return next(url, context);
  },
});
const sight = await import('../src/host/vision/sight.js');
// Load the dynamic storyboard dependencies while these exact module doubles are active.
await Promise.all([import('dsh-see-now/capture'), import('dsh-see-now/pipeline')]);
hooks.deregister();
after(() => { delete globalThis.__storyboardFreshnessTest; });

/** Start a storyboard whose ffmpeg/tap is the fake; returns feed/pack/take helpers. */
async function storyboard(t) {
  state.pushed = [];
  state.nextSheet = null;
  state.run = { done: new Promise(() => {}), stop() {} };
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storyboard-freshness-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const session = await sight.startStoryboard({
    dir, ffmpegPath: 'fake', fps: FPS, source: { kind: 'obs' },
  });
  t.after(() => session.stop());
  return {
    session,
    /** One frame arrives right now; the index drives its presentation timestamp. */
    feed(index) { state.frame({ i: index, t: index / FPS, buf: Buffer.alloc(4) }); },
    /** Pack a sheet out of those frame indices, exactly like the pipeline would. */
    pack(indices) {
      state.nextSheet = {
        png: Buffer.alloc(24), w: 800, h: 450, why: 'time',
        from: indices[0] / FPS,
        to: indices.at(-1) / FPS,
        frames: indices.map((index) => ({ t: +(index / FPS).toFixed(2), tier: 1, level: 1, via: 'mark' })),
      };
    },
    take: () => session.take(),
  };
}

test('旧帧打包后 at 不被刷新：3 帧采集于 10 秒前 → ageMs ≥ 10000、stale 按阈值判定', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW - 10_000 });
  const board = await storyboard(t);
  board.feed(0); board.feed(1); board.feed(2);
  // The frames waited in the queue; the model only asks for the sheet now.
  t.mock.timers.tick(10_000);
  board.pack([0, 1, 2]);

  const shot = await board.take();
  assert.equal(shot.frames, 3);
  assert.equal(shot.at, NOW - 10_000, 'at 取采集时间，不是打包时刻');
  assert.equal(shot.capturedAt, NOW - 10_000, '每帧的实际采集时间被保留');
  assert.equal(shot.generatedAt, NOW, '打包时间只写 generatedAt');

  const read = sight.readObservation(shot, { now: NOW });
  assert.ok(read.ageMs >= 10_000, `打包后的 ageMs 必须 ≥ 10000，实际 ${read.ageMs}`);
  assert.equal(read.at, NOW - 10_000);
  assert.equal(read.stale, false, '默认 30 秒阈值内仍算新鲜');
  assert.equal(sight.readObservation(shot, { now: NOW, ttlMs: 5_000 }).stale, true, '5 秒阈值下判定过期');
});

test('4 帧不同采集时间 → at = 最早一帧的采集时间', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW - 9_000 });
  const board = await storyboard(t);
  board.feed(0);                              // captured NOW-9000
  t.mock.timers.tick(1_000); board.feed(1);   // captured NOW-8000
  t.mock.timers.tick(3_000); board.feed(2);   // captured NOW-5000
  t.mock.timers.tick(4_000); board.feed(3);   // captured NOW-1000
  t.mock.timers.tick(1_000);                  // NOW: the sheet is only taken now
  board.pack([0, 1, 2, 3]);

  const shot = await board.take();
  assert.equal(shot.frames, 4);
  assert.equal(shot.at, NOW - 9_000, '取最早一帧的采集时间，不是最新一帧');
  assert.equal(shot.capturedAt, NOW - 9_000);
  assert.equal(shot.generatedAt, NOW);

  const read = sight.readObservation(shot, { now: NOW });
  assert.equal(read.ageMs, 9_000);
  assert.equal(read.stale, false);
});

test('打包时间只落在 generatedAt：同一故事板取出后继续变旧，不会重新变新', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW - 12_000 });
  const board = await storyboard(t);
  board.feed(0); board.feed(1);
  t.mock.timers.tick(12_000);
  board.pack([0, 1]);

  const shot = await board.take();
  assert.equal(shot.at, NOW - 12_000);
  assert.equal(shot.generatedAt, NOW);
  assert.notEqual(shot.at, shot.generatedAt, 'AT 不是打包时刻');

  // A later sheet owns its own capture time; the earlier one must keep aging.
  t.mock.timers.tick(20_000);
  board.feed(2); board.feed(3);
  board.pack([2, 3]);
  const second = await board.take();
  assert.equal(second.at, NOW + 20_000, '新故事板按自己的采集时间');
  assert.equal(second.generatedAt, NOW + 20_000);

  const later = sight.readObservation(shot); // default now = mocked NOW + 20s
  assert.equal(later.at, NOW - 12_000);
  assert.equal(later.ageMs, 32_000, '取出后年龄继续增长');
  assert.equal(later.stale, true);
});

test('readObservation 优先 capturedAt，回退 at，并兼容旧观察', () => {
  const prefer = sight.readObservation({ file: 'a.png', capturedAt: NOW - 45_000, at: NOW - 1_000 }, { now: NOW });
  assert.equal(prefer.at, NOW - 45_000, 'capturedAt 优先于被刷新过的 at');
  assert.equal(prefer.ageMs, 45_000);
  assert.equal(prefer.stale, true);
  assert.equal(prefer.file, 'a.png', '读取保留原有字段');

  // Even if a caller stamped `at` again, the real capture time still decides freshness.
  const stamped = sight.readObservation({ capturedAt: NOW - 10_000, at: NOW }, { now: NOW });
  assert.equal(stamped.at, NOW - 10_000);
  assert.equal(stamped.ageMs, 10_000);
  assert.equal(stamped.stale, false);

  const legacy = sight.readObservation({ file: 'b.png', at: NOW - 2_000 }, { now: NOW });
  assert.equal(legacy.at, NOW - 2_000);
  assert.equal(legacy.ageMs, 2_000);
  assert.equal(legacy.stale, false);
  assert.equal(legacy.hint, '');

  // An unusable capturedAt falls back to the legacy field.
  const fallback = sight.readObservation({ capturedAt: 'not-a-time', at: NOW - 31_000 }, { now: NOW });
  assert.equal(fallback.at, NOW - 31_000);
  assert.equal(fallback.stale, true);
  assert.match(fallback.hint, /阈值 30 秒/);

  // No proof of time at all stays stale by construction.
  const missing = sight.readObservation({}, { now: NOW });
  assert.equal(missing.at, null);
  assert.equal(missing.ageMs, null);
  assert.equal(missing.stale, true);
});
