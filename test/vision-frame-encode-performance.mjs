/**
 * 原帧 PNG 编码性能与降级验收。
 *
 * 背景：原帧（1920×1200 rgb24）用同步 `deflateSync` 编码时，最坏（不可压缩画面）
 * 约 136 ms/帧；6 帧会在主线程上连续阻塞约 0.8 s。现在编码移到 `worker_threads`：
 *   - 同步基线：单帧 / 6 帧耗时，以及事件循环被阻塞的时长；
 *   - worker 池：同样 6 帧的总耗时，以及主线程最大事件循环延迟；
 *   - 并发/队列上限与过载降级（队列满立刻拒绝，不排队）；
 *   - 编码失败、超时、worker 崩溃后池仍可继续服务；
 *   - 有界内存口径：队列里只持有像素引用，真正复制进 worker 的最多 `concurrency` 帧。
 *
 * 用 `randomFillSync` 生成不可压缩像素，复现最坏 deflate 路径（屏幕噪声/视频画面）。
 *
 * Run: node --test test/vision-frame-encode-performance.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomFillSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { encodePng } from 'dsh-see-now/png';
import { createPngEncoderPool, PNG_ENCODER_DEFAULTS } from '../src/host/vision/png-worker.js';

const WIDTH = 1920;
const HEIGHT = 1200;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

/** 不可压缩的 1920×1200 rgb24：最坏编码路径，和“1920×1200 最坏约 136 ms/帧”的口径一致。 */
function worstCaseFrame() {
  const rgb = Buffer.allocUnsafe(FRAME_BYTES);
  randomFillSync(rgb);
  return rgb;
}

function smallFrame(width = 64, height = 64) {
  const rgb = Buffer.allocUnsafe(width * height * 3);
  randomFillSync(rgb);
  return { rgb, width, height };
}

/**
 * 主线程事件循环延迟探针：每 `intervalMs` 采样一次，记录回调被推迟的最长时间。
 * `stop()` 会先多等几个采样周期，保证阻塞期间积压的回调被观察到。
 */
function createLagProbe(intervalMs = 5) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - intervalMs;
    if (lag > max) max = lag;
    last = now;
  }, intervalMs);
  return {
    max: () => max,
    async stop() {
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 3));
      clearInterval(timer);
      return max;
    },
  };
}

function pngSize(buffer) {
  // worker 通过结构化克隆返回 Uint8Array（不是 Buffer），先包一层再读 PNG 头。
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const formatMs = (value) => `${value.toFixed(1)} ms`;

test('1. 单帧/6 帧：同步编码阻塞事件循环，worker 池把编码移出主线程', { timeout: 120_000 }, async (t) => {
  const rgb = worstCaseFrame();

  // 预热同步路径，避免首次 JIT/分配算进测量。
  encodePng(rgb, WIDTH, HEIGHT, { level: 1 });

  const single = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    encodePng(rgb, WIDTH, HEIGHT, { level: 1 });
    single.push(performance.now() - started);
  }

  const syncProbe = createLagProbe();
  const syncStarted = performance.now();
  for (let index = 0; index < 6; index += 1) encodePng(rgb, WIDTH, HEIGHT, { level: 1 });
  const syncSix = performance.now() - syncStarted;
  const syncBlocked = await syncProbe.stop();
  const singleMs = Math.min(...single);

  const rssBefore = process.memoryUsage().rss;
  const pool = createPngEncoderPool();
  let asyncSix = 0;
  let asyncBlocked = 0;
  let asyncSingle = 0;
  let sizes = [];
  let state;
  try {
    const asyncProbe = createLagProbe();
    const asyncStarted = performance.now();
    const jobs = Array.from({ length: 6 }, (_, index) => {
      const started = performance.now();
      return pool.encode({ rgb, width: WIDTH, height: HEIGHT, level: 1 }).then((png) => ({
        index,
        ms: performance.now() - started,
        bytes: png.length,
        png,
      }));
    });
    const results = await Promise.all(jobs);
    asyncSix = performance.now() - asyncStarted;
    asyncBlocked = await asyncProbe.stop();
    asyncSingle = Math.min(...results.map((result) => result.ms));
    sizes = results.map((result) => pngSize(result.png));
    state = pool.state();
  } finally {
    await pool.close();
  }

  assert.equal(state.completed, 6, '6 帧全部编码完成');
  assert.equal(state.failed, 0);
  assert.equal(state.dropped, 0);
  assert.equal(state.queued, 0, '完成后队列清空');
  assert.ok(sizes.every((size) => size.width === WIDTH && size.height === HEIGHT), '输出尺寸正确');

  // 同步基线必须真的阻塞主线程；worker 池的主线程只做结构化克隆/调度。
  assert.ok(syncBlocked > 400, `同步基线应阻塞主线程，实测 ${formatMs(syncBlocked)}`);
  assert.ok(asyncBlocked < 100, `worker 池主线程阻塞应 <100ms，实测 ${formatMs(asyncBlocked)}`);
  assert.ok(asyncBlocked < syncBlocked / 3, 'worker 池阻塞应显著低于同步基线');
  assert.ok(asyncSix < syncSix, `6 帧异步总耗时应低于同步，实测 ${formatMs(asyncSix)} vs ${formatMs(syncSix)}`);

  const rssAfterMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const rssBeforeMb = Math.round(rssBefore / 1024 / 1024);
  t.diagnostic(`同步：单帧 ${formatMs(singleMs)}，6 帧 ${formatMs(syncSix)}，事件循环阻塞 ${formatMs(syncBlocked)}`);
  t.diagnostic(`worker 池：单帧 ${formatMs(asyncSingle)}（含首次 worker 启动任务），6 帧 ${formatMs(asyncSix)}，主线程最大延迟 ${formatMs(asyncBlocked)}`);
  t.diagnostic(`边界：concurrency=${state.concurrency} queueLimit=${state.queueLimit} 在途上限=${state.concurrency + state.queueLimit} 帧；RSS ${rssBeforeMb} → ${rssAfterMb} MB`);
  t.diagnostic(`内存口径：队列持有像素引用（不复制），真正复制进 worker 的最多 ${state.concurrency} × ${(FRAME_BYTES / 1024 / 1024).toFixed(1)} MB ≈ ${(state.concurrency * FRAME_BYTES / 1024 / 1024).toFixed(1)} MB`);
});

test('2. 过载降级：队列满立刻拒绝（不阻塞、不排队），已受理任务照常完成', { timeout: 60_000 }, async (t) => {
  const pool = createPngEncoderPool({ concurrency: 1, queueLimit: 2 });
  try {
    const { rgb, width, height } = smallFrame();
    // 同步提交 5 个任务：1 个在 worker 里，2 个等待，剩下 2 个必须立刻被队列上限拒绝。
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => pool.encode({ rgb, width, height })),
    );
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 3, '并发 1 + 队列 2 = 3 个任务被受理');
    assert.equal(rejected.length, 2, '超出上限的任务立刻被拒绝');
    assert.ok(rejected.every((entry) => entry.reason?.code === 'queue_full'), '拒绝原因是 queue_full');
    for (const entry of fulfilled) pngSize(entry.value);

    const state = pool.state();
    assert.equal(state.dropped, 2);
    assert.equal(state.completed, 3);
    assert.equal(state.failed, 0);
    assert.equal(state.queued, 0);
    t.diagnostic(`queueLimit=${state.queueLimit} concurrency=${state.concurrency}：受理 3，立刻拒绝 ${state.dropped}（queue_full）`);
  } finally {
    await pool.close();
  }
});

test('3. 失败/超时/关闭都不会挂住调用方，池可以继续服务', { timeout: 60_000 }, async (t) => {
  const pool = createPngEncoderPool({ concurrency: 1, queueLimit: 1 });
  try {
    // 编码器抛错（非法尺寸）→ 任务失败，但 worker 仍活着。
    await assert.rejects(
      pool.encode({ rgb: Buffer.alloc(3), width: 0, height: 0 }),
      (error) => error?.code === 'encode_failed',
    );
    const recovered = await pool.encode(smallFrame());
    pngSize(recovered);
    assert.equal(pool.state().failed, 1);
    assert.equal(pool.state().completed, 1);
    t.diagnostic('编码失败后同一个池继续成功编码');
  } finally {
    await pool.close();
  }

  // 超时：最坏帧编码约 136ms，timeoutMs=5 必然触发；任务被拒绝而不是永久等待。
  const timeoutPool = createPngEncoderPool({ concurrency: 1, queueLimit: 0, timeoutMs: 5 });
  try {
    const started = performance.now();
    await assert.rejects(
      timeoutPool.encode({ rgb: worstCaseFrame(), width: WIDTH, height: HEIGHT }),
      (error) => error?.code === 'encode_timeout',
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5_000, `超时必须快速返回，实测 ${formatMs(elapsed)}`);
    assert.ok(timeoutPool.state().failed >= 1);
    t.diagnostic(`timeoutMs=5：${formatMs(elapsed)} 内以 encode_timeout 拒绝`);
  } finally {
    await timeoutPool.close();
  }

  // 关闭时在途任务立即以 closed 拒绝；调用方（take）不会被卡住。
  const closingPool = createPngEncoderPool({ concurrency: 1, queueLimit: 0 });
  const inFlight = closingPool.encode({ rgb: worstCaseFrame(), width: WIDTH, height: HEIGHT });
  const closePromise = closingPool.close();
  await assert.rejects(inFlight, (error) => error?.code === 'closed');
  await closePromise;
  assert.equal(closingPool.state().closed, true);
});

test('4. 默认边界有界：并发、队列、超时、内存口径', () => {
  assert.ok(Number.isInteger(PNG_ENCODER_DEFAULTS.concurrency));
  assert.ok(PNG_ENCODER_DEFAULTS.concurrency >= 1 && PNG_ENCODER_DEFAULTS.concurrency <= 8);
  assert.ok(Number.isInteger(PNG_ENCODER_DEFAULTS.queueLimit));
  assert.ok(PNG_ENCODER_DEFAULTS.queueLimit >= 0 && PNG_ENCODER_DEFAULTS.queueLimit <= 256);
  assert.ok(PNG_ENCODER_DEFAULTS.timeoutMs > 0 && PNG_ENCODER_DEFAULTS.timeoutMs <= 120_000);

  const inFlightLimit = PNG_ENCODER_DEFAULTS.concurrency + PNG_ENCODER_DEFAULTS.queueLimit;
  // 队列中的任务只持有调用方像素引用；真正复制进 worker 的只有 concurrency 帧。
  const workerCopyBytes = PNG_ENCODER_DEFAULTS.concurrency * FRAME_BYTES;
  assert.ok(inFlightLimit <= 64, `受理任务上限必须有限，实测 ${inFlightLimit}`);
  assert.ok(workerCopyBytes <= 16 * 1024 * 1024, 'worker 像素复制量有界');
});
