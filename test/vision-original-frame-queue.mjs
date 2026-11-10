/**
 * P0 独立原帧队列：故事板负责宏观，原帧负责细节。
 *
 * 这里不启动真实 ffmpeg/屏幕/OBS：dsh-see-now 的 capture/pipeline 被替换成可注入的假实现，
 * 只验证：
 *   1. `take()` 保存 sheet 时，把 `sheet.frames` 引用的独立原帧编码成 PNG 落到同目录；
 *   2. 每个 cell 有稳定 frameId，能通过证据窗口的 byId/latest/between 追溯；
 *   3. 原帧内存队列与文件账本都有 TTL/容量上限，超限从最旧淘汰；
 *   4. 停止/隐私 abort 会删除已落盘原帧；status/证据状态里不出现原帧路径；
 *   5. 原帧编码是异步的：编码完成前不产生 cell；队列满/编码失败只跳过原帧，
 *      故事板照常返回，并记录有界原因（queue_full / encode_failed）。
 *
 * Run: node test/vision-original-frame-queue.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  ORIGINAL_FRAME_DEFAULTS,
  createOriginalFileLedger,
  createOriginalFrameQueue,
} from '../src/host/vision/sight.js';
import { createPngEncoderPool } from '../src/host/vision/png-worker.js';
import { encodePng } from 'dsh-see-now/png';
import { createEvidenceWindow } from '../src/host/vision/evidence-window.js';

const NOW = 1_700_000_000_000;

const state = {
  take: null,
  flushNow: null,
  onFrame: null,
  spawnOptions: null,
  pipelineOptions: null,
};

globalThis.__visionOriginalFrameTest = state;

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('/dsh-see-now/src/capture.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionOriginalFrameTest;
          export const pickScreenEngine = async () => 'ddagrab';
          export const captureArgs = () => ['fake'];
          export const spawnFrames = (options) => {
            s.spawnOptions = options;
            s.onFrame = options.onFrame;
            let finish = null;
            let settled = false;
            const done = new Promise((resolve) => { finish = resolve; });
            return {
              done,
              stop() {
                if (settled) return;
                settled = true;
                finish();
              },
            };
          };`,
      };
    }
    if (url.endsWith('/dsh-see-now/src/pipeline.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionOriginalFrameTest;
          export const createPipeline = (options) => {
            s.pipelineOptions = options;
            const log = [];
            const pending = [];
            return {
              // sight.js 只读 log.length 判断“最老那帧有没有被留下”。
              get log() { return log; },
              push(frame) {
                if (pending.length > 0) {
                  const decided = pending.shift();
                  log.push({ t: decided.t });
                }
                pending.push(frame);
              },
              take() { return s.take; },
              flushNow() { return s.flushNow; },
              // 真实管线用 peek() 暴露队首；sight 用它锁定排队故事板的原帧。
              peek() { return s.take ?? null; },
            };
          };`,
      };
    }
    return next(url, context);
  },
});

const sight = await import('../src/host/vision/sight.js');
// Load the dynamic storyboard dependencies while these exact module doubles are active.
await Promise.all([import('dsh-see-now/capture'), import('dsh-see-now/pipeline')]);
hooks.deregister();
after(() => { delete globalThis.__visionOriginalFrameTest; });

function resetState() {
  state.take = null;
  state.flushNow = null;
  state.onFrame = null;
  state.spawnOptions = null;
  state.pipelineOptions = null;
}

/** rgb24 小帧：内容不重要，尺寸和字节数要真实。 */
function rgb(width, height, value = 0x20) {
  return Buffer.alloc(width * height * 3, value);
}

function sheet({ frames = [], width = 4, height = 3, png = 'SHEET' } = {}) {
  return {
    png: Buffer.from(png),
    w: width,
    h: height,
    from: 0,
    to: 1,
    why: 'cut',
    frames,
  };
}

async function fixture(t, options = {}) {
  resetState();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-original-frame-'));
  const controller = new AbortController();
  const session = await sight.startStoryboard({
    dir,
    ffmpegPath: 'fake',
    source: { kind: 'obs', device: 'fake-camera' },
    signal: controller.signal,
    ...options,
  });
  t.after(async () => {
    await session.stop();
    await session.done?.catch?.(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { dir, session, controller };
}

/** 喂帧：sight 的 onFrame 会同步 push 到假管线，并记录被留下的原帧。 */
function feed(frames) {
  for (const [index, value] of frames.entries()) {
    state.onFrame({ i: index, t: index * 0.5, buf: value });
  }
}

function pngHeader(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const listPng = async (dir) => (await readdir(dir).catch(() => []))
  .filter((file) => file.endsWith('.png'));

const listRawPng = async (dir) => (await listPng(dir)).filter((file) => file.includes('-frame-'));

test('1. take() 把独立原帧编码到同目录：连续帧全有 cell，frameId 稳定、PNG 尺寸正确', async (t) => {
  const { dir, session } = await fixture(t);
  const buffers = Array.from({ length: 12 }, (_, index) => rgb(4, 3, 0x10 + index));
  feed(buffers);
  // 连续 5 帧都要有独立原帧：如果按“隔一帧判定”错位，这里会少于 5 个 cell。
  const expectedTimes = [0.0, 0.5, 1.0, 1.5, 2.0];
  state.take = sheet({
    frames: expectedTimes.map((time, index) => ({ t: time, via: index === 0 ? 'cut' : 'mark' })),
  });

  const taken = await session.take({ force: false });
  assert.ok(taken !== null);
  assert.equal(taken.frames, 5);
  assert.equal(taken.cells.length, 5, 'sheet 的每个帧都产生一个独立原帧');
  assert.equal(new Set(taken.cells.map((cell) => cell.frameId)).size, 5, 'frameId 互不相同');
  for (const cell of taken.cells) {
    assert.match(cell.frameId, /^frame-\d+$/);
    assert.ok(Number.isFinite(cell.capturedAt) && cell.capturedAt > 0);
    assert.equal(cell.width, 4);
    assert.equal(cell.height, 3);
    assert.ok(cell.bytes > 0);
    assert.equal(cell.shotId, '', 'shotId 由宿主登记证据时补上');
    assert.equal(typeof cell.file, 'string');
  }

  const files = await listPng(dir);
  assert.equal(files.length, 6, '一张 sheet + 五个原帧');
  const rawFiles = await listRawPng(dir);
  assert.equal(rawFiles.length, 5);
  for (const file of rawFiles) {
    const header = pngHeader(await readFile(join(dir, file)));
    assert.deepEqual(header, { width: 4, height: 3 }, '原帧是各自独立的 PNG，不是 sheet 切片');
  }

  const stats = session.stats();
  assert.equal(stats.originalFrames, 5);
  assert.ok(stats.originalBytes > 0);
  assert.equal(stats.originalFrameErrors, 0);
});

test('2. 兼容 frame.buf 直出（未来 dsh-see-now 把像素留在 sheet 上）', async (t) => {
  const { dir, session } = await fixture(t);
  state.take = sheet({
    frames: [{ t: 7.5, via: 'user', buf: rgb(4, 3, 0x7f) }],
  });
  const taken = await session.take({ force: false });
  assert.equal(taken.cells.length, 1);
  assert.equal(taken.cells[0].width, 4);
  assert.equal(taken.cells[0].height, 3);
  assert.equal((await listRawPng(dir)).length, 1);
});

test('3. 证据窗口保存 sheet + cells 引用；byId/latest/between 可取到；status 无路径', () => {
  const window = createEvidenceWindow({
    now: () => NOW,
    minGapMs: 0,
    maxAgeMs: 60_000,
  });
  const cells = [
    {
      frameId: 'frame-1',
      capturedAt: NOW + 1_000,
      shotId: 'shot-7',
      width: 1920,
      height: 1200,
      bytes: 111,
      file: 'C:\\cache\\screens\\sheet-a-frame-0.png',
    },
    {
      frameId: 'frame-2',
      capturedAt: NOW + 1_200,
      shotId: 'shot-7',
      width: 1920,
      height: 1200,
      bytes: 222,
      file: 'C:\\cache\\screens\\sheet-a-frame-1.png',
    },
  ];
  const added = window.add({
    file: 'C:\\cache\\evidence\\sheet-a.png',
    bytes: 1_000,
    capturedAt: NOW,
    startedAt: NOW,
    endedAt: NOW + 2_000,
    source: 'desktop',
    sourceEpoch: 1,
    kind: 'storyboard',
    shotId: 'shot-7',
    width: 1920,
    height: 1200,
    cells,
  });
  assert.ok(added !== null);
  assert.equal(added.cells.length, 2);
  assert.deepEqual(added.cells.map((cell) => cell.frameId), ['frame-1', 'frame-2']);
  assert.deepEqual(added.cells.map((cell) => cell.shotId), ['shot-7', 'shot-7']);

  // 三种查询都能从 sheet 取到它的原帧引用。
  const byId = window.byId(added.id)[0];
  assert.equal(byId.file, 'C:\\cache\\evidence\\sheet-a.png');
  assert.deepEqual(byId.cells.map((cell) => cell.frameId), ['frame-1', 'frame-2']);
  assert.deepEqual(window.between(NOW, NOW + 2_000)[0].cells.map((cell) => cell.frameId),
    ['frame-1', 'frame-2']);
  assert.deepEqual(window.latest({ source: 'desktop' }).cells.map((cell) => cell.frameId),
    ['frame-1', 'frame-2']);

  // 返回副本：改到的是副本，不是窗口内部引用。
  byId.cells[0].file = 'C:\\cache\\screens\\tampered.png';
  assert.equal(window.byId(added.id)[0].cells[0].file, 'C:\\cache\\screens\\sheet-a-frame-0.png');

  const status = window.state();
  assert.equal(status.cells, 2, 'status 只报原帧数量');
  assert.equal(JSON.stringify(status).includes('cache'), false, 'status 不含证据/原帧路径');
  assert.equal(JSON.stringify(status).includes('.png'), false, 'status 不含文件名');
});

test('4. 原帧内存队列：TTL / 帧数 / 字节上限都从最旧淘汰', () => {
  let clock = NOW;
  const evicted = [];
  const queue = createOriginalFrameQueue({
    now: () => clock,
    ttlMs: 1_000,
    maxFrames: 2,
    maxBytes: 100,
    onEvict: (record, reason) => evicted.push([record.key, reason]),
  });
  queue.add({ t: 0, capturedAt: NOW, buf: Buffer.alloc(4) });
  clock = NOW + 100;
  queue.add({ t: 0.5, capturedAt: clock, buf: Buffer.alloc(4) });
  clock = NOW + 200;
  queue.add({ t: 1, capturedAt: clock, buf: Buffer.alloc(4) });
  assert.equal(queue.state().frames, 2, '帧数上限');
  assert.deepEqual(evicted, [['t:0.00', 'frames']]);

  const byteQueue = createOriginalFrameQueue({
    now: () => clock,
    ttlMs: 1_000,
    maxFrames: 10,
    maxBytes: 6,
  });
  byteQueue.add({ t: 0, capturedAt: clock, buf: Buffer.alloc(4) });
  byteQueue.add({ t: 0.5, capturedAt: clock, buf: Buffer.alloc(4) });
  assert.equal(byteQueue.state().frames, 1, '字节上限');
  assert.ok(byteQueue.state().bytes <= 6);
  assert.equal(byteQueue.get({ t: 0 }), null, '最旧的原帧被字节淘汰');

  clock = NOW + 2_000;
  assert.equal(queue.get({ t: 1 }), null, '过期后取不到');
  assert.ok(evicted.some(([, reason]) => reason === 'age'));
  assert.equal(queue.state().frames, 0);
});

test('4b. 排队故事板引用的原帧优先保留；解锁后恢复普通淘汰，TTL 仍是硬上限', () => {
  let clock = NOW;
  const queue = createOriginalFrameQueue({ now: () => clock, ttlMs: 1_000, maxFrames: 2, maxBytes: 1_000 });
  queue.add({ t: 0, capturedAt: clock, buf: Buffer.alloc(4) });
  clock = NOW + 100;
  queue.add({ t: 0.5, capturedAt: clock, buf: Buffer.alloc(4) });
  queue.pin([{ t: 0 }]);
  clock = NOW + 200;
  queue.add({ t: 1, capturedAt: clock, buf: Buffer.alloc(4) });
  assert.ok(queue.get({ t: 0 }) !== null, '排队故事板的原帧不能被容量淘汰');
  assert.equal(queue.get({ t: 0.5 }), null, '未锁定的旧帧先走');
  assert.equal(queue.state().pinned, 1);

  queue.unpinAll();
  clock = NOW + 300;
  queue.add({ t: 1.5, capturedAt: clock, buf: Buffer.alloc(4) });
  assert.equal(queue.get({ t: 0 }), null, '解锁后恢复普通淘汰');

  queue.pin([{ t: 1.5 }]);
  clock = NOW + 2_000;
  queue.prune();
  assert.equal(queue.get({ t: 1.5 }), null, '锁定不能突破 TTL');
});

test('5. 原帧文件账本：TTL/文件数上限，clear 返回全部待删引用', () => {
  let clock = NOW;
  const ledger = createOriginalFileLedger({
    now: () => clock,
    ttlMs: 1_000,
    maxFiles: 2,
    maxBytes: 10_000,
  });
  assert.deepEqual(ledger.add({ file: 'a.png', bytes: 10, createdAt: NOW }), []);
  clock = NOW + 100;
  ledger.add({ file: 'b.png', bytes: 10, createdAt: clock });
  clock = NOW + 200;
  const evicted = ledger.add({ file: 'c.png', bytes: 10, createdAt: clock });
  assert.deepEqual(evicted.map((entry) => entry.file), ['a.png'], '文件数上限淘汰最旧');
  assert.equal(ledger.state().files, 2);

  clock = NOW + 2_000;
  assert.deepEqual(ledger.prune().map((entry) => entry.file), ['b.png', 'c.png'], 'TTL 淘汰');
  assert.equal(ledger.state().files, 0);

  ledger.add({ file: 'd.png', bytes: 10, createdAt: clock });
  assert.deepEqual(ledger.clear().map((entry) => entry.file), ['d.png']);
  assert.equal(ledger.state().files, 0);
});

test('6. 停止清理：已落盘原帧被删除，sheet 文件保持原语义', async (t) => {
  const { dir, session } = await fixture(t);
  feed([rgb(4, 3, 0x10), rgb(4, 3, 0x20), rgb(4, 3, 0x30)]);
  state.take = sheet({ frames: [{ t: 0, via: 'cut' }] });
  const taken = await session.take({ force: false });
  assert.equal(taken.cells.length, 1);
  const rawFile = taken.cells[0].file;
  assert.ok((await listPng(dir)).includes(basename(rawFile)));

  await session.stop();
  await session.done;
  assert.deepEqual(await listRawPng(dir), [], '停止后不留下独立原帧');
});

test('7. 隐私/切源 abort：原帧清理与停止同一路径，状态不暴露路径', async (t) => {
  const { dir, session, controller } = await fixture(t);
  feed([rgb(4, 3, 0xa0), rgb(4, 3, 0xb0), rgb(4, 3, 0xc0)]);
  state.take = sheet({ frames: [{ t: 0, via: 'cut' }] });
  const taken = await session.take({ force: false });
  assert.equal(taken.cells.length, 1);
  assert.equal(JSON.stringify(session.stats()).includes('cache'), false, 'stats 不含路径');

  controller.abort(new Error('privacy'));
  await session.done.catch(() => {});
  assert.deepEqual(await listRawPng(dir), [], 'abort 后不留下独立原帧');
});

test('8. 默认边界存在且不是无限缓存', () => {
  assert.ok(ORIGINAL_FRAME_DEFAULTS.ttlMs > 0 && ORIGINAL_FRAME_DEFAULTS.ttlMs <= 60_000);
  assert.ok(ORIGINAL_FRAME_DEFAULTS.maxFrames > 0 && ORIGINAL_FRAME_DEFAULTS.maxFrames <= 40);
  assert.ok(ORIGINAL_FRAME_DEFAULTS.maxBytes > 0);
  assert.ok(ORIGINAL_FRAME_DEFAULTS.maxFiles >= ORIGINAL_FRAME_DEFAULTS.maxFrames);
  assert.ok(ORIGINAL_FRAME_DEFAULTS.maxFileBytes > 0);
});

test('9. 异步编码：take() 等编码完成才把原帧标成可用', async (t) => {
  const pending = [];
  const encoder = {
    encode(input) {
      return new Promise((resolve, reject) => pending.push({ input, resolve, reject }));
    },
  };
  const { dir, session } = await fixture(t, { originalFrameEncoding: { encoder } });
  feed([rgb(4, 3, 0x42)]);
  state.take = sheet({ frames: [{ t: 0, via: 'cut' }] });

  let resolved = false;
  const taking = session.take({ force: false }).then((value) => {
    resolved = true;
    return value;
  });
  for (let wait = 0; wait < 200 && pending.length === 0; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(pending.length, 1, '编码任务已提交');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolved, false, '编码未完成时 take() 不返回');
  assert.deepEqual(await listRawPng(dir), [], '未完成编码不产生原帧文件');

  const { input, resolve } = pending[0];
  resolve(encodePng(input.rgb, input.width, input.height, { level: 1 }));
  const taken = await taking;
  assert.equal(taken.cells.length, 1, '编码完成后才出现 cell');
  assert.equal((await listRawPng(dir)).length, 1);
  const stats = session.stats();
  assert.equal(stats.originalFrames, 1);
  assert.equal(stats.originalFrameSkipped, 0);
});

test('10. 过载降级：队列满只跳过原帧，故事板照常返回并记录有界原因', async (t) => {
  const pool = createPngEncoderPool({ concurrency: 1, queueLimit: 0 });
  t.after(() => pool.close());
  const { dir, session } = await fixture(t, { originalFrameEncoding: { encoder: pool } });
  const times = [0, 0.5, 1, 1.5, 2, 2.5];
  feed(times.map((_, index) => rgb(4, 3, 0x10 + index)));
  state.take = sheet({ frames: times.map((time) => ({ t: time, via: 'mark' })) });

  const taken = await session.take({ force: false });
  assert.ok(taken !== null);
  assert.equal(taken.frames, 6, '故事板本身完整返回');
  assert.equal(taken.cells.length, 1, '并发 1 + 队列 0：只有第一个原帧被受理');
  assert.equal((await listRawPng(dir)).length, 1);

  const stats = session.stats();
  assert.equal(stats.originalFrameSkipped, 5);
  assert.equal(stats.originalFrameSkipReasons.queue_full, 5);
  assert.equal(stats.originalFrameErrors, 5);
  assert.equal(stats.originalEncoder.dropped, 5);
});

test('11. 编码失败不阻塞 take：故事板保留，cell 缺席并记录原因', async (t) => {
  const encoder = {
    async encode() {
      const error = new Error('encode boom');
      error.code = 'worker_error';
      throw error;
    },
  };
  const { dir, session } = await fixture(t, { originalFrameEncoding: { encoder } });
  feed([rgb(4, 3, 0xa0), rgb(4, 3, 0xb0), rgb(4, 3, 0xc0)]);
  state.take = sheet({ frames: [0, 0.5, 1].map((time) => ({ t: time, via: 'mark' })) });

  const started = Date.now();
  const taken = await session.take({ force: false });
  assert.ok(Date.now() - started < 2_000, '编码失败必须快速返回，不能挂住 take');
  assert.equal(taken.cells.length, 0);
  assert.deepEqual(await listRawPng(dir), []);
  assert.equal((await listPng(dir)).length, 1, 'sheet 仍然落盘');

  const stats = session.stats();
  assert.equal(stats.originalFrameErrors, 3);
  assert.equal(stats.originalFrameSkipped, 3);
  assert.equal(stats.originalFrameSkipReasons.encode_failed, 3);
});

test('12. 同一会话多次 take：worker 池复用，第二轮原帧仍能编码', async (t) => {
  const { dir, session } = await fixture(t);
  feed([rgb(4, 3, 0x11), rgb(4, 3, 0x22)]);

  state.take = sheet({ frames: [{ t: 0, via: 'cut' }] });
  const first = await session.take({ force: false });
  assert.equal(first.cells.length, 1);

  state.take = sheet({ frames: [{ t: 0.5, via: 'mark' }] });
  const second = await session.take({ force: false });
  assert.equal(second.cells.length, 1, '第二次 take 复用同一个编码池');
  assert.notEqual(first.cells[0].frameId, second.cells[0].frameId);
  assert.equal((await listRawPng(dir)).length, 2);
  assert.equal(session.stats().originalEncoder.completed, 2);
});

