/**
 * 终稿的真实采集区间：`audioStartAt` 是这一段第一帧的到达时刻，`audioEndAt` 是端点时刻。
 *
 * 为什么单独测：媒体台词时间线要和视觉证据对齐，只能使用真实采集时间；识别完成的 `at`、
 * 端点的 `endpointAt` 和按时长反推的 `endpointAt - durationMs` 都不是采集起点。这里用可注入的
 * 采集时钟逐帧推进，就能证明起点来自首帧，而不是事后计算。
 *
 * 不需要麦克风、ffmpeg、真实模型或解码线程：子进程和两路识别器都是注入的假对象。
 *
 * 覆盖：
 *   1. 单段终稿：audioStartAt = 首帧时刻，audioEndAt = endpointAt
 *   2. 两段合并：开始取最早段，结束取最后段
 *   3. durationMs 与 partial 的原样行为不被这两字段改变
 *
 * Run: node --test test/hearing-utterance-times.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startHearing } from '../src/host/hearing/hearing.js';

const SAMPLE_RATE = 16000;
/** 接近真实挂钟的基准，避免与 `Date.now()` 的延迟观测产生无意义的巨大差值。 */
const T = 1_700_000_000_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ffmpeg 替身：测试往 stdout 写 PCM，采集循环把它当作真实输入。 */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

/** -12 dBFS 的 440 Hz 音调：足够响，能通过 RMS 门限。 */
function tone(ms) {
  const samples = new Int16Array(Math.round((SAMPLE_RATE * ms) / 1000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE) * 0.25 * 32767);
  }
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) buffer.writeInt16LE(samples[index], index * 2);
  return buffer;
}

/** 可注入的采集时钟：测试手动推进，`captureNow()` 读到的才是可控的真实到达时刻。 */
function fakeClock(value) {
  return { value };
}

/** 流式替身：累计到指定样本数后报端点。 */
function fakeStreaming({ endpointAtSamples, text }) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? text : '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

/** 分段流式替身：`script[i]` 决定第 i 段累计多少样本后报端点。 */
function scriptedStreaming(script) {
  return {
    createStream: () => ({
      samples: 0,
      epoch: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: (stream) => ({ text: stream.samples > 0 ? (script[stream.epoch]?.text ?? '') : '' }),
    isEndpoint: (stream) => {
      const entry = script[stream.epoch];
      return entry !== undefined && stream.samples >= entry.samples;
    },
    reset(stream) {
      stream.samples = 0;
      stream.epoch += 1;
    },
  };
}

/** 离线替身：返回脚本化文本，供同步精确解码路径使用。 */
function fakeFinal(text) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples = samples.length;
      },
    }),
    decode: () => {},
    getResult: () => ({ text }),
  };
}

/** worker 替身：每次解码请求回一条脚本化文本。 */
function fakeWorker(texts) {
  const queue = [...texts];
  const worker = new EventEmitter();
  worker.unref = () => {};
  worker.terminate = () => worker.emit('exit', null);
  worker.postMessage = (message) => {
    const text = queue.length > 0 ? queue.shift() : '';
    const utteranceId = message.utteranceId ?? null;
    setImmediate(() => worker.emit('message', {
      type: 'result',
      id: message.id,
      utteranceId,
      segmentIds: utteranceId === null ? ['s0'] : [`${utteranceId}:s0`],
      text,
      joinFallback: false,
    }));
  };
  return worker;
}

/** 单段同步会话：终稿在端点处理中直接投递，时间断言不需要等异步 decode。 */
function startSingle({ clock, endpointMs, streamingText, offlineText }) {
  const child = new FakeChild();
  const updates = [];
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: fakeStreaming({
      endpointAtSamples: Math.round((SAMPLE_RATE * endpointMs) / 1000),
      text: streamingText,
    }),
    finalRecognizer: fakeFinal(offlineText),
    spawnProcess: () => child,
    now: () => clock.value,
    onUpdate: (event) => updates.push(event),
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');
  return { child, hearing, updates, finals };
}

/** 轮询到条件成立；超时直接失败，避免测试挂死。 */
async function until(predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`等待超时：${label}`);
    await delay(5);
  }
}

// ---------------------------------------------------------------------------
// 1. 单段：audioStartAt 取首帧到达时刻，audioEndAt 就是 endpointAt
// ---------------------------------------------------------------------------

test('单段终稿：audioStartAt 是首帧真实到达时刻，audioEndAt 等于 endpointAt', async () => {
  const clock = fakeClock(T);
  const { child, hearing, updates, finals } = startSingle({
    clock,
    endpointMs: 900,
    streamingText: '今天',
    offlineText: '今天',
  });

  // 第一块 500 ms：这一段开始，起点必须在这里记下。
  child.stdout.write(tone(500));
  assert.deepEqual(updates[0], { partial: '今天' }, '首帧后先照常到达 partial');

  // 200 ms 后第二块到达并触发端点：终点是此刻，而不是首帧时刻。
  clock.value = T + 200;
  child.stdout.write(tone(400));

  const events = finals();
  assert.equal(events.length, 1, '端点后投递一次终稿');
  const final = events[0];
  assert.equal(final.audioStartAt, T, '起点是首帧的采集时刻');
  assert.equal(final.audioEndAt, T + 200, '终点是端点的采集时刻');
  assert.equal(final.audioEndAt, final.endpointAt, 'audioEndAt 与 endpointAt 同源');
  assert.ok(final.audioStartAt < final.audioEndAt, '终稿确实带一段非空采集区间');
  // 900 ms 识别音频对应 200 ms 的挂钟跨度：反推会得到 T-700，这里必须仍是首帧时刻。
  assert.notEqual(final.audioStartAt, final.endpointAt - final.durationMs, '起点不是按时长反推的');
  assert.equal(final.durationMs, 900, '时长仍是识别音频的真实长度');
  assert.equal(final.final, '今天');
  hearing.stop();
});

// ---------------------------------------------------------------------------
// 2. 两段合并：开始取最早，结束取最后
// ---------------------------------------------------------------------------

test('两段合并：audioStartAt 取最早段开始，audioEndAt 取最后段结束', async () => {
  const clock = fakeClock(T);
  const child = new FakeChild();
  const updates = [];
  const worker = fakeWorker(['前半句', '后半句']);
  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fake-device',
    recognizer: scriptedStreaming([
      { samples: 20_000 * 16, text: '前半句' },
      { samples: 600 * 16, text: '后半句' },
    ]),
    asrWorkerFactory: () => worker,
    spawnProcess: () => child,
    now: () => clock.value,
    onUpdate: (event) => updates.push(event),
  });
  const finals = () => updates.filter((event) => typeof event.final === 'string');

  // 第一段 20 s：首帧在 T，内部时长切点在 T+120。
  child.stdout.write(tone(10_000));
  clock.value = T + 120;
  child.stdout.write(tone(10_000));
  await until(() => hearing.stats().group?.segmentIds?.length === 1, '第一段进入分组缓冲');

  // 第二段紧接其后：首帧在 T+5000，端点在 T+5700。
  clock.value = T + 5_000;
  child.stdout.write(tone(300));
  clock.value = T + 5_700;
  child.stdout.write(tone(300));

  await until(() => finals().length === 1, '合并后的终稿');
  const final = finals()[0];
  assert.equal(final.final, '前半句后半句', '文本仍按采集顺序拼接');
  assert.equal(final.audioStartAt, T, '开始取最早那一段的首帧时刻');
  assert.equal(final.audioEndAt, T + 5_700, '结束取最后那一段的端点时刻');
  assert.equal(final.audioEndAt, final.endpointAt, '音频终点仍与 endpointAt 一致');
  assert.notEqual(final.audioStartAt, T + 5_000, '开始不是最后一段的开始');
  assert.notEqual(final.audioEndAt, T + 120, '结束不是第一段的结束');
  assert.equal(final.durationMs, 20_600, '合并时长仍是两段音频之和');
  hearing.stop();
});

// ---------------------------------------------------------------------------
// 3. 原有行为不变：durationMs 照旧，partial 原样到达且不带时间字段
// ---------------------------------------------------------------------------

test('不改变原有行为：durationMs 仍按音频计算，partial 文案原样到达', async () => {
  const clock = fakeClock(T);
  const { child, hearing, updates, finals } = startSingle({
    clock,
    endpointMs: 600,
    streamingText: '流式草稿',
    offlineText: '最终结果',
  });

  child.stdout.write(tone(200));
  clock.value = T + 50;
  child.stdout.write(tone(400));

  const partials = updates.filter((event) => typeof event.partial === 'string');
  assert.equal(partials.length, 1, 'partial 仍只在文本变化时到达一次');
  assert.deepEqual(partials[0], { partial: '流式草稿' }, 'partial 文案原样到达，未被追加时间字段');

  const events = finals();
  assert.equal(events.length, 1);
  assert.equal(events[0].final, '最终结果');
  assert.equal(events[0].refined, true);
  assert.equal(events[0].durationMs, 600, 'durationMs 仍等于识别的音频长度');
  assert.equal(events[0].audioStartAt, T);
  assert.equal(events[0].audioEndAt, T + 50);
  hearing.stop();
});
