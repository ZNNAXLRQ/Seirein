/**
 * 持续分镜/证据采集的采集分辨率。
 *
 * 这里只验证 sight.js 的分辨率契约，不启动真实 ffmpeg、屏幕或 OBS：
 *   - 默认 1920×1200，而不是旧的 800×450；
 *   - config 覆盖在合理范围内原样保留，越界值 clamp 到 1280×720..2560×1600；
 *   - `stats()` 暴露本次会话真实生效的 width/height；
 *   - 分辨率变化不改变“变化触发”语义：没有变化时 `take({force:false})` 仍返回 null，
 *     帧数由管线决定（不固定三帧），force 只走原有的最近帧兜底。
 *
 * Run: node --test test/vision-storyboard-resolution.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = {
  pipelineOptions: null,
  spawnOptions: null,
  take: null,
  flushNow: null,
  flushNowCalls: 0,
};

globalThis.__visionResolutionTest = state;

const hooks = registerHooks({
  load(url, context, next) {
    if ((url.endsWith('/dsh-see-now/src/capture.js') || url.endsWith('/vision/frame-capture.js'))) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionResolutionTest;
          export const pickScreenEngine = async () => 'ddagrab';
          export const captureArgs = () => ['fake'];
          export const spawnFrames = (options) => {
            s.spawnOptions = options;
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
        source: `const s = globalThis.__visionResolutionTest;
          export const createPipeline = (options) => {
            s.pipelineOptions = options;
            return {
              push() {},
              take() { return s.take; },
              flushNow() { s.flushNowCalls += 1; return s.flushNow; },
            };
          };`,
      };
    }
    return next(url, context);
  },
});

const sight = await import('../src/host/vision/sight.js');
// Load the dynamic storyboard dependencies while these exact module doubles are active.
await Promise.all([import('dsh-see-now/capture'), import('dsh-see-now/pipeline'), import('../src/host/vision/frame-capture.js')]);
hooks.deregister();
after(() => { delete globalThis.__visionResolutionTest; });

function resetState() {
  state.pipelineOptions = null;
  state.spawnOptions = null;
  state.take = null;
  state.flushNow = null;
  state.flushNowCalls = 0;
}

async function fixture(t, options = {}) {
  resetState();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-resolution-'));
  const session = await sight.startStoryboard({
    dir,
    ffmpegPath: 'fake',
    // obs 源不需要屏幕引擎探测；这里也不碰子进程。
    source: { kind: 'obs', device: 'fake-camera' },
    ...options,
  });
  t.after(async () => {
    session.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  return { dir, session };
}

/** A packed sheet as dsh-see-now returns it; the frame count is intentionally not 3. */
function sheet({ frames = 5, why = 'cut', width = 1920, height = 1200 } = {}) {
  return {
    png: Buffer.from(`SHEET-${frames}`),
    w: width,
    h: height,
    from: 0,
    to: 1,
    why,
    frames: Array.from({ length: frames }, (_, index) => ({
      i: index,
      t: index / 12,
      via: index === 0 ? 'cut' : 'mark',
    })),
  };
}

test('1. 默认采集分辨率是 1920×1200，并原样传给管线与 stats()', async (t) => {
  assert.deepEqual(sight.resolveStoryboardSize(), { width: 1920, height: 1200 });

  const { session } = await fixture(t);
  assert.deepEqual(
    { width: state.pipelineOptions.width, height: state.pipelineOptions.height },
    { width: 1920, height: 1200 },
    'pipeline 按默认分辨率构建',
  );
  assert.deepEqual(
    { width: state.spawnOptions.width, height: state.spawnOptions.height },
    { width: 1920, height: 1200 },
    'ffmpeg 按默认分辨率取帧',
  );
  const stats = session.stats();
  assert.equal(stats.width, 1920);
  assert.equal(stats.height, 1200);
});

test('2. config 覆盖在合理范围内原样保留', async (t) => {
  const { session } = await fixture(t, { width: 1600, height: 1000 });
  assert.deepEqual(
    { width: state.pipelineOptions.width, height: state.pipelineOptions.height },
    { width: 1600, height: 1000 },
  );
  assert.equal(session.stats().width, 1600);
  assert.equal(session.stats().height, 1000);
});

test('3. 越界覆盖按 1280×720..2560×1600 clamp；无效值回退默认', async (t) => {
  const cases = [
    [{ width: 640, height: 360 }, { width: 1280, height: 720 }],
    [{ width: '640', height: '360' }, { width: 1280, height: 720 }],
    [{ width: 3840, height: 2160 }, { width: 2560, height: 1600 }],
    [{ width: '9000', height: '100' }, { width: 2560, height: 720 }],
    [{ width: 'nonsense', height: null }, { width: 1920, height: 1200 }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(sight.resolveStoryboardSize(input), expected, JSON.stringify(input));
    const { session } = await fixture(t, input);
    assert.equal(session.stats().width, expected.width, `stats.width for ${JSON.stringify(input)}`);
    assert.equal(session.stats().height, expected.height, `stats.height for ${JSON.stringify(input)}`);
    assert.equal(state.pipelineOptions.width, expected.width);
    assert.equal(state.pipelineOptions.height, expected.height);
  }
});

test('4. 分辨率不改变变化触发语义：无变化不补帧，帧数不固定为三帧', async (t) => {
  const { session, dir } = await fixture(t);

  // 没有变化：真实管线 take() 返回 null；强制开关也只走原有 flushNow 兜底，不凭空造帧。
  state.take = null;
  state.flushNow = null;
  assert.equal(await session.take({ force: false }), null, '静态画面不得产生合成故事板');
  assert.equal(state.flushNowCalls, 0, 'force:false 不得调用最近帧兜底');

  state.flushNow = sheet({ frames: 2 });
  const forced = await session.take();
  assert.equal(forced.frames, 2, 'force 兜底使用管线自己给的帧数');
  assert.equal(state.flushNowCalls, 1);

  // 有变化：管线给几帧就是几帧（这里故意给 5 帧，而不是固定三帧）。
  state.take = sheet({ frames: 5, why: 'cut' });
  const changed = await session.take({ force: false });
  assert.equal(changed.frames, 5, '变化触发的帧数由管线决定，不能被分辨率改成固定三帧');
  assert.equal(changed.width, 1920);
  assert.equal(changed.height, 1200);
  assert.equal(changed.shotBreak, true);
  assert.equal(session.stats().width, 1920);
  assert.equal(session.stats().height, 1200);
  assert.equal(session.stats().sheets, 2);

  const files = await readdir(dir);
  assert.equal(files.filter((file) => file.endsWith('.png')).length, 2, '只写出真实返回的两张故事板');
});
