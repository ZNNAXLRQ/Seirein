/**
 * P-187 阶段 5：主动回应短句生成器。
 *
 * 这些用例盯住“只做一次短文本调用”的契约：
 *   - 成功时 system 带人设与明确指令，user 带事件描述与 reaction，且请求里没有图片；
 *   - 无 llm / 无 selection / 空文本 / 超长截断 / 流抛错 / finish error / 超时 / 外部取消；
 *   - 畸形 event 只返回 bad-input，不碰模型；
 *   - 构造生成器本身不读全局、不发请求。
 *
 * 所有模型流都是本地假实现，不触网；时间注入只用于超时分支，测试不会真的等 8 秒。
 *
 * Run: node --test test/vision-proactive-line.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROACTIVE_LINE_DEFAULTS,
  createProactiveLineGenerator,
} from '../src/host/vision/proactive-line.js';

/** 把固定分片数组变成 async iterable，模拟 provider 的流。 */
function streamOf(chunks) {
  return (async function* stream() {
    for (const chunk of chunks) yield chunk;
  })();
}

/** 生成一个假 llm service；`onStream` 可替换返回的流或直接抛错。 */
function makeLlm(calls, onStream = null) {
  return {
    stream(options) {
      calls.push(options);
      if (typeof onStream === 'function') return onStream(options);
      return streamOf([]);
    },
  };
}

/** 只提供测试需要的两个服务；其余名字一律 undefined。 */
function servicesOf({ llm, selection } = {}) {
  return (name) => {
    if (name === 'llm') return llm;
    if (name === 'agentDefaultModel') {
      return selection === undefined ? undefined : { currentSelection: () => selection };
    }
    return undefined;
  };
}

const ROUTE = { provider: 'openai', model: 'gpt-test' };

test('默认预算导出且冻结', () => {
  assert.deepEqual(PROACTIVE_LINE_DEFAULTS, { maxChars: 60, maxTokens: 120, timeoutMs: 8_000 });
  assert.equal(Object.isFrozen(PROACTIVE_LINE_DEFAULTS), true);
});

test('成功：system 含人设与指令，user 含描述/反应，只发文本且预算正确', async () => {
  const calls = [];
  const llm = makeLlm(calls, () => streamOf([
    { type: 'text-delta', text: ' 嗯，这里' },
    { type: 'text-delta', text: '有点意外。 ' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]));
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => '你是小夜，说话自然。',
  });

  assert.equal(calls.length, 0, '构造生成器不得发请求');
  const result = await generator.generate({
    event: {
      id: 'understand:100:0',
      description: '角色突然回头看向镜头',
      reaction: '意外',
      evidenceFrameIds: ['f1'],
    },
    state: { sceneSummary: '室内' },
  });

  assert.deepEqual(result, { ok: true, text: '嗯，这里有点意外。', reason: 'ok' });
  assert.equal(calls.length, 1, '一次生成只发一次请求');

  const [request] = calls;
  assert.equal(request.provider, 'openai');
  assert.equal(request.model, 'gpt-test');
  assert.equal(request.maxTokens, PROACTIVE_LINE_DEFAULTS.maxTokens);
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0].role, 'user');
  assert.equal(request.messages[0].content.length, 1, '请求里不带图片');
  assert.equal(request.messages[0].content[0].type, 'text');
  assert.match(request.messages[0].content[0].text, /刚看到：角色突然回头看向镜头/);
  assert.match(request.messages[0].content[0].text, /你的观察角度：意外/);
  assert.match(request.system, /小夜/, 'system 必须带人设文本');
  assert.match(request.system, /不超过 60 个字/);
  assert.match(request.system, /不剧透/);
  assert.ok(request.signal instanceof AbortSignal);
});

test('无 llm、无 selection：分别返回 no-llm / no-model，不抛错', async () => {
  const noLlm = createProactiveLineGenerator({
    getService: servicesOf({}),
    personaText: () => '人设',
  });
  const first = await noLlm.generate({ event: { description: '有人推门' } });
  assert.deepEqual(first, { ok: false, text: '', reason: 'no-llm' });

  const calls = [];
  const llm = makeLlm(calls);
  const noModel = createProactiveLineGenerator({
    getService: servicesOf({ llm }),
    personaText: () => '人设',
  });
  const second = await noModel.generate({ event: { description: '有人推门' } });
  assert.deepEqual(second, { ok: false, text: '', reason: 'no-model' });
  assert.equal(calls.length, 0, '没有 selection 不得发请求');

  const thrownSelection = createProactiveLineGenerator({
    getService: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => { throw new Error('selection exploded'); } };
      }
      return undefined;
    },
  });
  const third = await thrownSelection.generate({ event: { description: '有人推门' } });
  assert.equal(third.reason, 'no-model');
  assert.equal(calls.length, 0);
});

test('空/纯空白文本返回 empty，不把空白送进语音出口', async () => {
  const calls = [];
  const llm = makeLlm(calls, () => streamOf([
    { type: 'text-delta', text: '   ' },
    { type: 'text-delta', text: '\n\t' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]));
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => '人设',
  });

  const result = await generator.generate({ event: { description: '画面变化' } });
  assert.deepEqual(result, { ok: false, text: '', reason: 'empty' });
  assert.equal(calls.length, 1);
});

test('超长按码点截断到 maxChars，不留下半个代理对', async () => {
  const emoji = '🎬';
  const longText = `开头${emoji.repeat(20)}结尾`;
  const calls = [];
  const llm = makeLlm(calls, () => streamOf([
    { type: 'text-delta', text: longText },
    { type: 'finish', reason: { kind: 'stop' } },
  ]));
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => '人设',
    maxChars: 8,
  });

  const result = await generator.generate({ event: { description: '画面变化' } });
  assert.equal(result.ok, true);
  assert.equal(Array.from(result.text).length, 8);
  assert.equal(result.text, '开头' + emoji.repeat(6));
});

test('stream 同步抛错与 finish error 都只给 stream-error，不泄露异常正文', async () => {
  const throwing = createProactiveLineGenerator({
    getService: servicesOf({
      llm: makeLlm([], () => { throw new Error('secret provider path D:/private'); }),
      selection: ROUTE,
    }),
    personaText: () => '人设',
  });
  const thrown = await throwing.generate({ event: { description: '画面变化' } });
  assert.deepEqual(thrown, { ok: false, text: '', reason: 'stream-error' });

  const finishError = createProactiveLineGenerator({
    getService: servicesOf({
      llm: makeLlm([], () => streamOf([
        { type: 'text-delta', text: '半句' },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'x' } } },
      ])),
      selection: ROUTE,
    }),
    personaText: () => '人设',
  });
  const errored = await finishError.generate({ event: { description: '画面变化' } });
  assert.deepEqual(errored, { ok: false, text: '', reason: 'stream-error' });
});

test('超时：注入定时器触发即 abort，返回 timeout', async () => {
  const calls = [];
  const llm = makeLlm(calls, () => streamOf([]));
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => '人设',
    setTimer: (fn) => {
      // 同步触发等价于“请求还没真正开始就已到 deadline”，用来稳定复核 timeout 分支。
      fn();
      return { unref() {} };
    },
    clearTimer: () => {},
  });

  const result = await generator.generate({ event: { description: '画面变化' } });
  assert.deepEqual(result, { ok: false, text: '', reason: 'timeout' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true, '超时必须 abort 模型请求');
});

test('外部取消：已取消的 signal 直接 aborted，流中途取消也不拼完', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const early = createProactiveLineGenerator({
    getService: servicesOf({
      llm: makeLlm([], () => streamOf([{ type: 'text-delta', text: '不该到' }])),
      selection: ROUTE,
    }),
    personaText: () => '人设',
  });
  const earlyResult = await early.generate({
    event: { description: '画面变化' },
    signal: aborted.signal,
  });
  assert.deepEqual(earlyResult, { ok: false, text: '', reason: 'aborted' });

  const controller = new AbortController();
  const mid = createProactiveLineGenerator({
    getService: servicesOf({
      llm: makeLlm([], () => (async function* stream() {
        yield { type: 'text-delta', text: '前半' };
        controller.abort();
        yield { type: 'text-delta', text: '后半' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })()),
      selection: ROUTE,
    }),
    personaText: () => '人设',
  });
  const midResult = await mid.generate({
    event: { description: '画面变化' },
    signal: controller.signal,
  });
  assert.deepEqual(midResult, { ok: false, text: '', reason: 'aborted' });
});

test('畸形 event 返回 bad-input，且在碰服务之前就拒绝', async () => {
  const calls = [];
  const llm = makeLlm(calls);
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => '人设',
  });

  const badValues = [undefined, null, 'event', [], {}, { description: '' }, { description: '   ' }, { description: 42 }];
  for (const event of badValues) {
    const result = await generator.generate({ event });
    assert.deepEqual(result, { ok: false, text: '', reason: 'bad-input' });
  }
  // 参数本身也允许畸形。
  assert.equal((await generator.generate(null)).reason, 'bad-input');
  assert.equal((await generator.generate('x')).reason, 'bad-input');
  assert.equal(calls.length, 0, '畸形输入不得发请求');
});

test('user 文本按码点截断到 600 字，人设读取抛错时退化为只有指令', async () => {
  const calls = [];
  const longDescription = '描'.repeat(900);
  const llm = makeLlm(calls, () => streamOf([
    { type: 'text-delta', text: '好' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]));
  const generator = createProactiveLineGenerator({
    getService: servicesOf({ llm, selection: ROUTE }),
    personaText: () => { throw new Error('persona unavailable'); },
  });

  const result = await generator.generate({
    event: { description: longDescription, reaction: '反应' },
  });
  assert.equal(result.ok, true);
  const userText = calls[0].messages[0].content[0].text;
  assert.equal(Array.from(userText).length, 600);
  assert.match(calls[0].system, /你正和用户一起看屏幕/);
  assert.equal(calls[0].system.includes('persona unavailable'), false);
});
