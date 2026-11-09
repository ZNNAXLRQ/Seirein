/**
 * P-187 阶段 4 —— 后台图片分析器单测。
 *
 * 覆盖顺序契约、图片能力门禁、整体失败策略、超时/取消、空文本与畸形输入。
 * 所有依赖都是假的：不触网、不读真实文件、不产生真实定时器（除默认路径外）。
 *
 * Run: node --test test/vision-image-analyzer.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IMAGE_ANALYZER_DEFAULTS,
  createImageAnalyzer,
} from '../src/host/vision/image-analyzer.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const FRAME_A = { id: 'f1', file: 'C:\\shots\\one.png' };
const FRAME_B = { id: 'f2', file: 'C:\\shots\\two.png' };

const finish = (kind, code = '') => ({
  type: 'finish',
  reason: {
    kind,
    ...(code ? { failure: { code, message: '不应该出现在结果里的正文' } } : {}),
  },
});

/**
 * 模拟“不响应 abort”的 provider：next() 永不 resolve，只有 return() 能被调用。
 * 旧实现会在这里永久等待并占住在途锁。
 */
function hangingStream(onReturn) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise(() => {});
        },
        return() {
          if (typeof onReturn === 'function') onReturn();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/** 给被测调用加一个很短的护栏，失败时测试报错而不是永久挂起。 */
function within(promise, ms = 1_000) {
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`调用在 ${ms}ms 内未返回`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * 假运行时。默认成功路径：2 帧、图片能力可用、流返回两段文本后 stop。
 * 通过 overrides 替换任一依赖；calls 记录所有可观察调用。
 */
function harness(overrides = {}) {
  const calls = {
    read: [],
    save: [],
    stream: [],
    info: [],
    timerSet: 0,
    timerCleared: 0,
  };
  const options = {
    selection: { provider: 'demo', model: 'vision-model' },
    modelInfo: { inputModalities: ['text', 'image'] },
    frames: [FRAME_A, FRAME_B],
    chunks: [
      { type: 'text-delta', text: '画面' },
      { type: 'text-delta', text: '有一扇窗。' },
      finish('stop'),
    ],
    withLlm: true,
    withAttachments: true,
    withSelection: true,
    ...overrides,
    readFile: overrides.readFile ?? (async (file) => {
      calls.read.push(file);
      return PNG;
    }),
    saveImage: overrides.saveImage ?? (async (input) => {
      calls.save.push(input);
      return { id: `att-${calls.save.length}` };
    }),
    resolveModelInfo: overrides.resolveModelInfo ?? (async (provider, model) => {
      calls.info.push({ provider, model });
      return options.modelInfo;
    }),
  };

  const services = {};
  if (options.withLlm) {
    services.llm = {
      async resolveModelInfo(provider, model, signal) {
        return options.resolveModelInfo(provider, model, signal);
      },
      stream(streamOptions) {
        calls.stream.push(streamOptions);
        if (typeof options.stream === 'function') return options.stream(streamOptions);
        return (async function* emit() {
          for (const chunk of options.chunks) yield chunk;
        })();
      },
    };
  }
  if (options.withAttachments) {
    services.attachments = {
      async saveImage(input) {
        return options.saveImage(input);
      },
    };
  }
  if (options.withSelection) {
    services.agentDefaultModel = {
      currentSelection() {
        return typeof options.selection === 'function' ? options.selection() : options.selection;
      },
    };
  }

  const analyzer = createImageAnalyzer({
    getService: (name) => services[name],
    readFile: options.readFile,
    maxImages: options.maxImages,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    setTimer(fn, ms) {
      calls.timerSet += 1;
      calls.timerMs = ms;
      return options.setTimer ? options.setTimer(fn, ms) : setTimeout(fn, ms);
    },
    clearTimer(timer) {
      calls.timerCleared += 1;
      return options.clearTimer ? options.clearTimer(timer) : clearTimeout(timer);
    },
  });
  return { analyzer, calls, options, services };
}

test('默认预算导出且冻结', () => {
  assert.deepEqual(IMAGE_ANALYZER_DEFAULTS, { maxImages: 3, maxTokens: 800, timeoutMs: 30_000 });
  assert.ok(Object.isFrozen(IMAGE_ANALYZER_DEFAULTS));
});

test('正常：两帧依次保存，内容块是 text + 两个 image，返回模型文本', async () => {
  const { analyzer, calls } = harness({ maxTokens: 321 });
  const result = await analyzer.analyze({
    system: '你是视觉分析器',
    user: '这两张图里有什么？',
    frames: [FRAME_A, FRAME_B],
  });

  assert.deepEqual(result, {
    ok: true,
    text: '画面有一扇窗。',
    reason: 'ok',
    images: 2,
  });
  assert.deepEqual(calls.read, [FRAME_A.file, FRAME_B.file]);
  assert.equal(calls.info.length, 1);
  assert.deepEqual(calls.info[0], { provider: 'demo', model: 'vision-model' });

  assert.equal(calls.save.length, 2);
  assert.deepEqual(calls.save[0], { data: PNG, mediaType: 'image/png', name: 'one.png' });
  assert.deepEqual(calls.save[1], { data: PNG, mediaType: 'image/png', name: 'two.png' });

  assert.equal(calls.stream.length, 1);
  const request = calls.stream[0];
  assert.equal(request.provider, 'demo');
  assert.equal(request.model, 'vision-model');
  assert.equal(request.system, '你是视觉分析器');
  assert.equal(request.maxTokens, 321);
  assert.equal(request.signal.aborted, false);
  assert.deepEqual(request.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: '这两张图里有什么？' },
      { type: 'image', attachment: { id: 'att-1' } },
      { type: 'image', attachment: { id: 'att-2' } },
    ],
  }]);
});

test('无 llm / 无 attachments / 无 selection 分别返回机器原因且不读图', async () => {
  const cases = [
    { overrides: { withLlm: false }, reason: 'no-llm' },
    { overrides: { withAttachments: false }, reason: 'no-attachments' },
    { overrides: { withSelection: false }, reason: 'no-model' },
  ];
  for (const { overrides, reason } of cases) {
    const { analyzer, calls } = harness(overrides);
    const result = await analyzer.analyze({ frames: [FRAME_A] });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.equal(result.reason, reason);
    assert.equal(result.images, 0);
    assert.equal(calls.read.length, 0);
    assert.equal(calls.save.length, 0);
    assert.equal(calls.stream.length, 0);
  }
});

test('inputModalities 缺省或不含 image：no-image-support，且不读图/不保存/不请求', async () => {
  const cases = [
    { inputModalities: ['text'] },
    {},
    undefined,
  ];
  for (const modelInfo of cases) {
    const { analyzer, calls } = harness({ modelInfo });
    const result = await analyzer.analyze({ frames: [FRAME_A] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-image-support');
    assert.equal(result.images, 0);
    assert.equal(calls.read.length, 0);
    assert.equal(calls.save.length, 0);
    assert.equal(calls.stream.length, 0);
    assert.equal(calls.info.length, 1, '能力探测应发生且只发生一次');
  }
});

test('帧数超过 maxImages：只读、只送前 N 张', async () => {
  const frames = [FRAME_A, FRAME_B, { id: 'f3', file: 'C:\\shots\\three.png' }];
  const { analyzer, calls } = harness({ maxImages: 2 });
  const result = await analyzer.analyze({ frames });

  assert.equal(result.ok, true);
  assert.equal(result.images, 2);
  assert.deepEqual(calls.read, [FRAME_A.file, FRAME_B.file]);
  assert.equal(calls.save.length, 2);
  const imageBlocks = calls.stream[0].messages[0].content.filter((block) => block.type === 'image');
  assert.equal(imageBlocks.length, 2);
});

test('没有可用帧：no-frames，能力探测完成后直接返回', async () => {
  const { analyzer, calls } = harness();
  for (const frames of [[], [null, {}, { id: 'bad', file: '' }, { file: 42 }], 'not-an-array']) {
    const result = await analyzer.analyze({ frames });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-frames');
    assert.equal(result.images, 0);
  }
  assert.equal(calls.read.length, 0);
  assert.equal(calls.save.length, 0);
  assert.equal(calls.stream.length, 0);
});

test('readFile 抛错：整体 read-failed，不保存、不请求', async () => {
  const first = harness({
    readFile: async () => {
      throw new Error('C:\\secret\\path 读失败');
    },
  });
  const firstResult = await first.analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.deepEqual(firstResult, { ok: false, text: '', reason: 'read-failed', images: 0 });
  assert.equal(first.calls.save.length, 0);
  assert.equal(first.calls.stream.length, 0);

  // 第二帧才失败时，第一帧即使已保存也不得发请求：不能少图假装看全。
  let reads = 0;
  const second = harness({
    readFile: async () => {
      reads += 1;
      if (reads === 2) throw new Error('second frame failed');
      return PNG;
    },
  });
  const secondResult = await second.analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.equal(secondResult.reason, 'read-failed');
  assert.equal(secondResult.images, 0);
  assert.equal(second.calls.save.length, 1);
  assert.equal(second.calls.stream.length, 0);
});

test('saveImage 抛错：整体 save-failed，不请求', async () => {
  const first = harness({
    saveImage: async () => {
      throw new Error('attachment backend failed');
    },
  });
  const firstResult = await first.analyzer.analyze({ frames: [FRAME_A] });
  assert.deepEqual(firstResult, { ok: false, text: '', reason: 'save-failed', images: 0 });
  assert.equal(first.calls.read.length, 1);
  assert.equal(first.calls.stream.length, 0);

  // 第二张保存失败同样整体失败，而不是把第一张偷偷发出去。
  let saves = 0;
  const second = harness({
    saveImage: async (input) => {
      saves += 1;
      if (saves === 2) throw new Error('second save failed');
      return { id: 'only-one' };
    },
  });
  const secondResult = await second.analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.equal(secondResult.reason, 'save-failed');
  assert.equal(secondResult.images, 0);
  assert.equal(second.calls.stream.length, 0);
});

test('stream 抛错（异步迭代中）：stream-error + provider 错误码，且不泄露正文', async () => {
  const { analyzer, calls } = harness({
    stream: () => (async function* broken() {
      yield { type: 'text-delta', text: '半截' };
      throw Object.assign(new Error('provider body secret'), { code: 'provider_down' });
    })(),
  });
  const result = await analyzer.analyze({ frames: [FRAME_A, FRAME_B] });

  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.reason, 'stream-error');
  assert.equal(result.errorCode, 'provider_down');
  assert.equal(result.images, 2, '图片确实进入过请求');
  assert.equal(calls.stream.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('finish error → stream-error + failure.code；finish aborted → aborted', async () => {
  const errored = harness({
    chunks: [
      { type: 'text-delta', text: '半截' },
      finish('error', 'rate_limited'),
    ],
  });
  const errorResult = await errored.analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.equal(errorResult.ok, false);
  assert.equal(errorResult.text, '');
  assert.equal(errorResult.reason, 'stream-error');
  assert.equal(errorResult.errorCode, 'rate_limited');
  assert.equal(errorResult.images, 2);

  const aborted = harness({
    chunks: [
      { type: 'text-delta', text: '半截' },
      finish('aborted'),
    ],
  });
  const abortedResult = await aborted.analyzer.analyze({ frames: [FRAME_A] });
  assert.equal(abortedResult.ok, false);
  assert.equal(abortedResult.text, '');
  assert.equal(abortedResult.reason, 'aborted');
  assert.equal(abortedResult.errorCode, undefined);
  assert.equal(abortedResult.images, 1);
});

test('文本为空（空白 delta 或空流）：stream-error / errorCode empty', async () => {
  const blank = harness({
    chunks: [
      { type: 'text-delta', text: '   ' },
      finish('stop'),
    ],
  });
  const blankResult = await blank.analyzer.analyze({ frames: [FRAME_A] });
  assert.equal(blankResult.ok, false);
  assert.equal(blankResult.text, '');
  assert.equal(blankResult.reason, 'stream-error');
  assert.equal(blankResult.errorCode, 'empty');
  assert.equal(blankResult.images, 1);

  const empty = harness({ chunks: [] });
  const emptyResult = await empty.analyzer.analyze({ frames: [FRAME_A] });
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.reason, 'stream-error');
  assert.equal(emptyResult.errorCode, 'empty');
});

test('超时：注入 setTimer 立即触发 → timeout，且交给 stream 的 signal 已被 abort', async () => {
  let seenSignal = null;
  let unrefCalled = false;
  let cleared = false;
  const { analyzer, calls } = harness({
    setTimer(fn) {
      fn(); // 立即触发，验证同步定时器也能被处理
      return {
        unref() {
          unrefCalled = true;
        },
      };
    },
    clearTimer() {
      cleared = true;
    },
    stream(options) {
      seenSignal = options.signal;
      return (async function* neverConsumed() {
        yield { type: 'text-delta', text: '不应该被采用' };
      })();
    },
  });

  const result = await analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.equal(result.reason, 'timeout');
  assert.equal(result.images, 2);
  assert.equal(calls.timerSet, 1);
  assert.equal(calls.timerCleared, 1);
  assert.equal(unrefCalled, true);
  assert.equal(cleared, true);
  assert.ok(seenSignal, '请求必须已经构造');
  assert.equal(seenSignal.aborted, true);
});

test('假 stream 的 next() 永不 resolve：期限到即 timeout、释放流，之后仍可再次分析', async () => {
  let fire = null;
  let timerReady;
  const ready = new Promise((resolve) => { timerReady = resolve; });
  let released = 0;
  let cleared = 0;
  let mode = 'hang';
  const { analyzer, calls } = harness({
    timeoutMs: 30_000,
    setTimer(fn) {
      fire = fn;
      timerReady();
      return { unref() {} };
    },
    clearTimer() {
      cleared += 1;
    },
    stream() {
      if (mode === 'hang') return hangingStream(() => { released += 1; });
      return (async function* ok() {
        yield { type: 'text-delta', text: '第二次理解' };
        yield finish('stop');
      })();
    },
  });

  const pending = analyzer.analyze({ frames: [FRAME_A, FRAME_B] });
  await within(ready);
  // 定时器登记后，analyze 同步发请求并挂起在永不返回的 next() 上。
  assert.equal(calls.stream.length, 1);
  assert.equal(typeof fire, 'function');
  fire();

  const timedOut = await within(pending);
  assert.deepEqual(timedOut, {
    ok: false,
    text: '',
    reason: 'timeout',
    images: 2,
  });
  assert.equal(calls.stream[0].signal.aborted, true, '超时必须 abort 模型请求');
  assert.equal(released, 1, '超时后应尽力调用流的 return()');
  assert.equal(cleared, 1, '超时后应清理定时器');

  // 锁已释放：同一个分析器再次调用必须正常完成。
  mode = 'ok';
  const second = await within(analyzer.analyze({ frames: [FRAME_A] }));
  assert.equal(second.ok, true);
  assert.equal(second.text, '第二次理解');
  assert.equal(second.images, 1);
});

test('外部 abort 能打断永不 resolve 的 next()：返回 aborted，并清理监听器与定时器', async () => {
  let fire = null;
  let timerReady;
  const ready = new Promise((resolve) => { timerReady = resolve; });
  let released = 0;
  let cleared = 0;
  const listeners = new Set();
  const external = {
    aborted: false,
    addEventListener(type, fn) {
      if (type === 'abort') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'abort') listeners.delete(fn);
    },
  };
  const { analyzer, calls } = harness({
    timeoutMs: 30_000,
    setTimer(fn) {
      fire = fn;
      timerReady();
      return { unref() {} };
    },
    clearTimer() {
      cleared += 1;
    },
    stream() {
      return hangingStream(() => { released += 1; });
    },
  });

  const pending = analyzer.analyze({ frames: [FRAME_A], signal: external });
  await within(ready);
  assert.equal(calls.stream.length, 1);
  assert.equal(typeof fire, 'function');
  assert.equal(listeners.size, 1, '请求期间应挂上外部 abort 监听器');

  external.aborted = true;
  for (const fn of [...listeners]) fn();

  const result = await within(pending);
  assert.deepEqual(result, {
    ok: false,
    text: '',
    reason: 'aborted',
    images: 1,
  });
  assert.equal(calls.stream[0].signal.aborted, true);
  assert.equal(released, 1, '取消后应尽力调用流的 return()');
  assert.equal(cleared, 1, '取消后应清理定时器');
  assert.equal(listeners.size, 0, '结束必须移除外部 abort 监听器');
});

test('外部 signal 已 abort：aborted，且不读图/不保存/不请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const { analyzer, calls } = harness();
  const result = await analyzer.analyze({
    frames: [FRAME_A, FRAME_B],
    signal: controller.signal,
  });

  assert.deepEqual(result, { ok: false, text: '', reason: 'aborted', images: 0 });
  assert.equal(calls.read.length, 0);
  assert.equal(calls.save.length, 0);
  assert.equal(calls.stream.length, 0);
});

test('capability：正常/无能力/不可探测，只探测不读图不请求', async () => {
  const normal = harness();
  assert.deepEqual(await normal.analyzer.capability(), {
    ok: true,
    usable: true,
    reason: 'ok',
    provider: 'demo',
    model: 'vision-model',
  });
  assert.equal(normal.calls.read.length, 0);
  assert.equal(normal.calls.save.length, 0);
  assert.equal(normal.calls.stream.length, 0);

  for (const modelInfo of [{ inputModalities: ['text'] }, {}, undefined]) {
    const unsupported = harness({ modelInfo });
    assert.deepEqual(await unsupported.analyzer.capability(), {
      ok: true,
      usable: false,
      reason: 'no-image-support',
      provider: 'demo',
      model: 'vision-model',
    });
    assert.equal(unsupported.calls.stream.length, 0);
  }

  // route 形状同样支持。
  const routed = harness({ selection: { route: { provider: 'route-p', model: 'route-m' } } });
  assert.deepEqual(await routed.analyzer.capability(), {
    ok: true,
    usable: true,
    reason: 'ok',
    provider: 'route-p',
    model: 'route-m',
  });

  // capability 按契约不检查 attachments：它只回答模型能力。
  const noAttachments = harness({ withAttachments: false });
  assert.equal((await noAttachments.analyzer.capability()).usable, true);

  const noLlm = harness({ withLlm: false });
  assert.deepEqual(await noLlm.analyzer.capability(), {
    ok: false,
    usable: false,
    reason: 'no-llm',
    provider: '',
    model: '',
  });

  const noSelection = harness({ withSelection: false });
  assert.deepEqual(await noSelection.analyzer.capability(), {
    ok: false,
    usable: false,
    reason: 'no-model',
    provider: '',
    model: '',
  });
});

test('畸形输入不抛错：null/缺省参数、坏 frames、坏 signal、无依赖实例', async () => {
  const { analyzer } = harness();

  const noArgs = await analyzer.analyze();
  assert.equal(noArgs.ok, false);
  assert.equal(noArgs.reason, 'no-frames');

  const nullArgs = await analyzer.analyze(null);
  assert.equal(nullArgs.ok, false);
  assert.equal(nullArgs.reason, 'no-frames');

  const badFields = await analyzer.analyze({
    system: 42,
    user: null,
    frames: 'not-an-array',
    signal: 'not-a-signal',
  });
  assert.equal(badFields.ok, false);
  assert.equal(badFields.reason, 'no-frames');

  const badFrames = await analyzer.analyze({
    frames: [null, { id: 'x' }, { file: 7 }, { file: '   ' }],
  });
  assert.equal(badFrames.ok, false);
  assert.equal(badFrames.reason, 'no-frames');

  // 非对象 signal 按“没有外部取消”处理，而不是抛错。
  const weirdSignal = await analyzer.analyze({
    frames: [FRAME_A],
    signal: 'not-a-signal',
  });
  assert.equal(weirdSignal.ok, true);

  // 完全未注入依赖：任何调用都只返回机器原因。
  const bare = createImageAnalyzer();
  const bareResult = await bare.analyze({ frames: [FRAME_A] });
  assert.equal(bareResult.ok, false);
  assert.equal(bareResult.reason, 'no-llm');
  const bareCapability = await bare.capability();
  assert.equal(bareCapability.ok, false);
  assert.equal(bareCapability.reason, 'no-llm');
});
