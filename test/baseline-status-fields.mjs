/**
 * P-47 宿主侧字段：`/assistant/status` 必须给基线快照构建器一份**真实**的顶层投影。
 *
 * 这里挂载真实宿主（`apply`），只把 Harness 的默认模型服务换成内存 double；不启动 VTS / OBS、
 * 不采集、不联网。断言分两层：
 *   1. status 的 `model` / `protocol` / `reasoning` / `input` / `tts` / `versions` 存在、类型正确，
 *      `reasoning.applied` 永远是 null（selection 只回答 requested，不冒充实际采用），字段里没有
 *      挂载路径；
 *   2. `buildBaselineSnapshot({ status })` 消费同一份 status 后，同名字段在快照里落位。
 *
 * Run: node --test test/baseline-status-fields.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/host/index.js';
import { buildBaselineSnapshot } from '../src/host/runtime/diagnostics/baseline.js';
import { voiceForLanguage } from '../src/host/speech/tts.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

/** 宿主当前真正会用的 Edge 默认声音（不是测试里另写一份常量）。 */
const EDGE_DEFAULT_VOICE = voiceForLanguage('zh');

/** 只取 P-47 新增的字段，避免把整份 status 的其它内容带进断言。 */
function baselineView(status) {
  return {
    model: status.model,
    protocol: status.protocol,
    reasoning: status.reasoning,
    input: status.input,
    tts: { voice: status.tts?.voice, weightsCold: status.tts?.weightsCold },
    versions: status.versions,
  };
}

/** 新增字段的存在性与类型：缺失一律 null，字符串/布尔只接受本来的类型。 */
function assertBaselineFieldTypes(status) {
  assert.ok(Object.hasOwn(status, 'model'), 'status.model exists');
  assert.deepEqual(Object.keys(status.model).sort(), ['id', 'provider']);
  for (const value of Object.values(status.model)) {
    assert.ok(value === null || typeof value === 'string', 'model fields are string or null');
  }

  assert.ok(Object.hasOwn(status, 'protocol'), 'status.protocol exists');
  assert.ok(status.protocol === null || typeof status.protocol === 'string', 'protocol is string or null');

  assert.ok(Object.hasOwn(status, 'reasoning'), 'status.reasoning exists');
  assert.deepEqual(Object.keys(status.reasoning).sort(), ['applied', 'requested']);
  assert.ok(status.reasoning.requested === null || typeof status.reasoning.requested === 'string',
    'reasoning.requested is string or null');
  assert.equal(status.reasoning.applied, null, 'applied is never fabricated');

  assert.ok(Object.hasOwn(status, 'input'), 'status.input exists');
  assert.deepEqual(Object.keys(status.input).sort(), ['cacheStatsAvailable', 'tokensAvailable']);
  assert.equal(status.input.tokensAvailable, null, 'no real token counter means null');
  assert.equal(status.input.cacheStatsAvailable, false, 'cache stats are unavailable');

  assert.ok(Object.hasOwn(status, 'tts'), 'status.tts exists');
  assert.ok(Object.hasOwn(status.tts, 'voice'), 'tts.voice exists');
  assert.ok(status.tts.voice === null || typeof status.tts.voice === 'string', 'tts.voice is string or null');
  assert.equal(status.tts.weightsCold, null, 'weightsCold is unknown, not guessed');
  // 既有 tts 字段保持不变（voice/weightsCold 只是追加）。
  assert.equal(typeof status.tts.playbackEnabled, 'boolean');
  assert.ok(status.tts.gptSovits !== null && typeof status.tts.gptSovits === 'object');

  assert.ok(Object.hasOwn(status, 'versions'), 'status.versions exists');
  assert.ok(status.versions.vts === null || typeof status.versions.vts === 'string',
    'versions.vts is string or null');
  assert.ok(status.versions.obs === null || typeof status.versions.obs === 'string',
    'versions.obs is string or null');

  // 既有 status 字段仍然在原来的位置。
  assert.equal(status.ok, true);
  assert.equal(typeof status.version, 'string');
  assert.ok(status.live2d !== null && typeof status.live2d === 'object');
  assert.ok(status.fastpath !== null && typeof status.fastpath === 'object');
}

/** 新增字段里不得出现挂载根目录或任何反斜杠路径。 */
function assertNoPaths(status, root) {
  const text = JSON.stringify(baselineView(status));
  const escapedRoot = JSON.stringify(root).slice(1, -1);
  assert.equal(text.includes(escapedRoot), false, 'no mount path in baseline fields');
  assert.equal(text.includes('\\\\'), false, 'no Windows path in baseline fields');
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baseline-status-'));
  if (options.settings !== undefined) {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(join(root, 'data', 'settings.json'), `${JSON.stringify(options.settings, null, 2)}\n`, 'utf8');
  }

  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const services = new Map(Object.entries(options.services ?? {}));

  apply({
    effect,
    get: (name) => services.get(name),
    tools: {
      register(definition) {
        return () => definition;
      },
    },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: {
        section() { return () => {}; },
        context() { return () => {}; },
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, {
    root,
    enabled: true,
    defaultDomain: 'chat',
    privacyScene: 'Privacy',
    // 裸挂载：测试期间不探测/启动任何外部依赖，也不让证据采集 boot 计时器运行。
    dependencyBootDelayMs: 600000,
    evidenceCaptureBootDelayMs: 600000,
    ...(options.config ?? {}),
  });

  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.ok(handler !== undefined, '/assistant/status is registered');
    let payload = '';
    await handler(
      { method: 'GET', url: '/assistant/status' },
      { writeHead() {}, end(data) { payload = data ?? ''; } },
    );
    return JSON.parse(payload);
  };

  t.after(async () => {
    await cleanupRoot(root, disposers);
  });
  return { root, status };
}

test('有默认模型选择：顶层字段来自 selection，快照同名段落位', async (t) => {
  const app = await fixture(t, {
    services: {
      agentDefaultModel: {
        currentSelection: () => ({
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
          // 当前 Harness 的 selection 没有 protocol；这里显式给出，验证“只在明确时填”。
          protocol: 'openai-chat',
        }),
      },
    },
    config: { ttsVoice: 'zh-CN-XiaoxiaoNeural' },
  });

  const status = await app.status();
  assertBaselineFieldTypes(status);
  assert.deepEqual(status.model, { provider: 'deepseek-account', id: 'deepseek-flash' });
  assert.equal(status.protocol, 'openai-chat');
  assert.deepEqual(status.reasoning, { requested: 'high', applied: null });
  assert.deepEqual(status.input, { tokensAvailable: null, cacheStatsAvailable: false });
  assert.equal(status.tts.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(status.tts.weightsCold, null);
  assert.deepEqual(status.versions, { vts: null, obs: null });
  assertNoPaths(status, app.root);

  const snapshot = buildBaselineSnapshot({ status });
  assert.deepEqual(snapshot.model, status.model);
  assert.equal(snapshot.protocol, status.protocol);
  assert.deepEqual(snapshot.reasoning, status.reasoning);
  assert.deepEqual(snapshot.input, status.input);
  assert.equal(snapshot.tts.voice, status.tts.voice);
  assert.equal(snapshot.tts.weightsCold, null);
  // 既有 tts.gptSovits.enabled=false 仍被构建器按主机规则推导为 edge-tts。
  assert.equal(snapshot.tts.backend, 'edge-tts');
  assert.deepEqual(snapshot.versions, {
    electron: null,
    vts: null,
    obs: null,
    node: null,
    os: null,
  });
});

test('selection 只给 route：provider/id/protocol 走 route 回退，requested 可用显式配置', async (t) => {
  const app = await fixture(t, {
    services: {
      agentDefaultModel: {
        currentSelection: () => ({
          route: {
            provider: 'route-provider',
            model: 'route-model',
            protocol: 'route-protocol',
          },
        }),
      },
    },
    config: { reasoningEffort: 'medium' },
  });

  const status = await app.status();
  assertBaselineFieldTypes(status);
  assert.deepEqual(status.model, { provider: 'route-provider', id: 'route-model' });
  assert.equal(status.protocol, 'route-protocol');
  assert.deepEqual(status.reasoning, { requested: 'medium', applied: null });
  // 没有显式 ttsVoice、GPT-SoVITS 关闭：voice 是宿主真正会用的 Edge 默认声音。
  assert.equal(status.tts.voice, EDGE_DEFAULT_VOICE);
  assertNoPaths(status, app.root);

  const snapshot = buildBaselineSnapshot({ status });
  assert.deepEqual(snapshot.model, { provider: 'route-provider', id: 'route-model' });
  assert.equal(snapshot.protocol, 'route-protocol');
  assert.equal(snapshot.reasoning.requested, 'medium');
  assert.equal(snapshot.reasoning.applied, null);
  assert.equal(snapshot.tts.voice, EDGE_DEFAULT_VOICE);
});

test('没有默认模型服务：缺失字段一律 null，不猜 provider/protocol/reasoning', async (t) => {
  const app = await fixture(t);
  const status = await app.status();
  assertBaselineFieldTypes(status);

  assert.deepEqual(status.model, { provider: null, id: null });
  assert.equal(status.protocol, null);
  assert.deepEqual(status.reasoning, { requested: null, applied: null });
  assert.deepEqual(status.input, { tokensAvailable: null, cacheStatsAvailable: false });
  assert.equal(status.tts.voice, EDGE_DEFAULT_VOICE, 'Edge default is real current voice');
  assert.equal(status.tts.weightsCold, null);
  assert.deepEqual(status.versions, { vts: null, obs: null });
  assertNoPaths(status, app.root);

  const snapshot = buildBaselineSnapshot({ status });
  assert.deepEqual(snapshot.model, { provider: null, id: null });
  assert.equal(snapshot.protocol, null);
  assert.deepEqual(snapshot.reasoning, { requested: null, applied: null });
  assert.deepEqual(snapshot.input, { tokensAvailable: null, cacheStatsAvailable: false });
  assert.equal(snapshot.tts.voice, EDGE_DEFAULT_VOICE);
  assert.equal(snapshot.tts.weightsCold, null);
});

test('GPT-SoVITS 开启且无显式 voice：voice 为 null，构建器仍能推导 backend', async (t) => {
  const app = await fixture(t, {
    settings: { gptSovits: { enabled: true } },
  });
  const status = await app.status();
  assertBaselineFieldTypes(status);

  assert.equal(status.tts.gptSovits.enabled, true);
  assert.equal(status.tts.voice, null, 'GPT-SoVITS has no voice name to report');
  assert.equal(status.tts.weightsCold, null);
  assertNoPaths(status, app.root);

  const snapshot = buildBaselineSnapshot({ status });
  assert.equal(snapshot.tts.backend, 'gpt-sovits');
  assert.equal(snapshot.tts.voice, null);
  assert.equal(snapshot.tts.weightsCold, null);
});

test('路径形状不进入基线字段：model/protocol/reasoning/voice 都不拿路径冒充', async (t) => {
  const app = await fixture(t, {
    services: {
      agentDefaultModel: {
        currentSelection: () => ({
          provider: 'C:\\Users\\alice\\provider',
          model: 'D:\\Seirein\\model.bin',
          protocol: 'file:///C:/Seirein/protocol.json',
          reasoningEffort: 'C:\\Seirein\\effort',
        }),
      },
    },
    config: { ttsVoice: 'G:\\Seirein\\voice.wav' },
  });

  const status = await app.status();
  assertBaselineFieldTypes(status);
  assert.deepEqual(status.model, { provider: null, id: null });
  assert.equal(status.protocol, null);
  assert.deepEqual(status.reasoning, { requested: null, applied: null });
  // 显式 voice 是路径时同样不采用；此时宿主真实的当前声音仍是 Edge 默认。
  assert.equal(status.tts.voice, EDGE_DEFAULT_VOICE);
  assertNoPaths(status, app.root);

  const snapshot = buildBaselineSnapshot({ status });
  assert.deepEqual(snapshot.model, { provider: null, id: null });
  assert.equal(snapshot.protocol, null);
  assert.equal(snapshot.reasoning.requested, null);
  assert.equal(snapshot.tts.voice, EDGE_DEFAULT_VOICE);
});
