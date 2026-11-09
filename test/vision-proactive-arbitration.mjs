/**
 * P-187 阶段 5：生成结束后的重新仲裁（P2）。
 *
 * 背景：`evaluateProactive` 在调用短句模型之前检查开关/候选/用户说话；模型返回后过去会直接
 * `speakLine`。生成可能持续数秒，期间用户关闭主动回应、评论同一画面取消候选、开始说话或出现
 * 待回复任务时，旧结果仍会播出一次。本套件固定住修复后的三道边界：
 *
 *   1. 纯助手 `revalidateProactiveCandidate`：开关/代次/取消/已说/用户说话/待回复/已 abort/
 *      已卸载任一不满足 → ok:false，全部满足 → ok:true；
 *   2. 宿主接线：生成时传 `signal`，`await` 后、`speakLine` 前用原候选重新仲裁；失败只记
 *      `vision.proactive.rejected { reason }`，不重新抽候选；reset / 用户评论 / 组件关闭 /
 *      开关关闭的 5 秒 tick 都会 abort 在途生成；
 *   3. 宿主 double：用可控仲裁器 + `config.proactiveLineGenerator` deferred 真正走
 *      `evaluateProactive` —— 生成期间关闭开关 → speakLine 调用 0；生成期间候选被取消 →
 *      speakLine 调用 0。
 *
 * 限制：真实宿主只会在后台理解回调里登记候选（需要真实/桩采集与评论链路）。为了在不起采集、
 * 不调用模型的前提下走到 `evaluateProactive`，本文件的宿主 double 只替换了
 * proactive-candidate 模块里的仲裁器；`revalidateProactiveCandidate` 仍是生产实现，index.js
 * 也是真实模块（仅 URL 加 query 以重新求值）。生产仲裁器的 propose/evaluate 语义由
 * test/vision-proactive-candidate.mjs 覆盖。
 *
 * Run: node --test test/vision-proactive-arbitration.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';

// Load the real helper under a query URL: the bare module URL must stay unloaded so the injected
// arbiter below can occupy it for the fresh index.js instance.
import { revalidateProactiveCandidate } from '../src/host/vision/proactive-candidate.js?pure-helper';
import { disposeAll } from './helpers/cleanup.mjs';

const candidateUrl = new URL('../src/host/vision/proactive-candidate.js', import.meta.url).href;
const realCandidateUrl = `${candidateUrl}?real-helper`;

/** The controllable arbiter shared with the injected module (one host at a time). */
const arbiter = {
  candidate: Object.freeze({
    id: 'understand:1700000000000:0',
    from: 1_700_000_000_000,
    to: 1_700_000_000_000,
    description: '画面里有人推开门',
    evidenceFrameIds: Object.freeze(['frame-1']),
    evidenceAudioIds: Object.freeze([]),
    angle: '像是刚回来',
    expiresAt: null,
    priority: 1,
  }),
  pendingIds: [],
  spoken: [],
  canceled: [],
  cancelAllReason: '',
  resetReason: '',
  evaluateCalls: 0,
  lastReason: '',
};
globalThis.__proactiveArbiterDouble = { state: arbiter };

const resetArbiter = () => {
  arbiter.pendingIds = [arbiter.candidate.id];
  arbiter.spoken.length = 0;
  arbiter.canceled.length = 0;
  arbiter.cancelAllReason = '';
  arbiter.resetReason = '';
  arbiter.evaluateCalls = 0;
  arbiter.lastReason = '';
};

/**
 * Replace only the proactive arbiter for a fresh index.js instance. The real revalidation helper
 * is re-exported from the un-hooked module URL, so the double exercises the production decision.
 */
const hooks = registerHooks({
  load(url, context, next) {
    if (url !== candidateUrl) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import { revalidateProactiveCandidate } from ${JSON.stringify(realCandidateUrl)};
        export { revalidateProactiveCandidate };
        export const PROACTIVE_DEFAULTS = Object.freeze({});
        export function createProactiveArbiter() {
          const g = globalThis.__proactiveArbiterDouble;
          const s = g.state;
          const status = () => ({
            pending: s.pendingIds.length,
            valid: s.pendingIds.length,
            counts: {
              proposed: 1,
              rejected: 0,
              expired: 0,
              evicted: 0,
              duplicate: 0,
              canceled: s.canceled.length,
              spoken: s.spoken.length,
              ignored: 0,
            },
            canceledEvents: s.canceled.length,
            spokenLastHour: s.spoken.length,
            consecutiveIgnored: 0,
            quietUntil: null,
            lastSpokenAt: null,
            lastTopicId: null,
            lastTopic: null,
            lastReason: s.lastReason,
          });
          return {
            propose() { return null; },
            evaluate() {
              s.evaluateCalls += 1;
              if (s.pendingIds.includes(s.candidate.id)) {
                return { speak: true, candidate: s.candidate, reason: 'ok', suppressed: [] };
              }
              return { speak: false, candidate: null, reason: 'no-candidate', suppressed: ['no-candidate'] };
            },
            pendingIds() { return s.pendingIds.slice(); },
            spoken(candidate) {
              s.spoken.push(candidate.id);
              s.pendingIds = s.pendingIds.filter((id) => id !== candidate.id);
              s.lastReason = 'spoken';
              return true;
            },
            cancelFor(ids) {
              const list = Array.isArray(ids) ? ids : [ids];
              s.canceled.push(...list);
              s.pendingIds = s.pendingIds.filter((id) => !list.includes(id));
              s.lastReason = 'canceled';
              return list.length;
            },
            cancelAll(reason) {
              s.cancelAllReason = reason;
              s.lastReason = reason;
              const removed = s.pendingIds.length;
              s.pendingIds = [];
              return removed;
            },
            reset(reason) {
              s.resetReason = reason;
              s.lastReason = reason;
              s.pendingIds = [];
              return 0;
            },
            ignored() { return null; },
            status,
          };
        }
      `,
    };
  },
});
const { apply } = await import('../src/host/index.js?proactive-arbitration-double');
hooks.deregister();

const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const waitFor = async (check, timeoutMs = 5000, stepMs = 10) => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proactive-arbitration-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({}), 'utf8');
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    proactive: { enabled: true },
  }), 'utf8');

  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      return { id: 'att-1', mediaType, name, bytes: data.length };
    },
    async deleteImage() {},
  };
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] };
    },
  };
  apply({
    effect,
    get: (service) => (service === 'attachments' ? attachments : service === 'llm' ? llm : undefined),
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
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
    // 裸挂载：本套件只验证主动回应仲裁，不启动任何真实采集。
    evidenceCaptureEnabled: false,
    dependencyBootDelayMs: 60_000,
    evidenceCaptureBootDelayMs: 60_000,
    proactiveEnabled: true,
    ...options,
  });

  const route = async (path, body, method = 'POST') => {
    const req = method === 'GET'
      ? { method: 'GET', url: path }
      : Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path });
    const handler = routes.get(path.split('?')[0]);
    assert.ok(handler !== undefined, `route ${path} is registered`);
    let payload = '';
    await handler(req, {
      writeHead() {},
      end(data) { payload = data ?? ''; },
    });
    return JSON.parse(payload);
  };
  const action = (body) => route('/assistant/action', body);
  const events = async () => (await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const waitEvent = async (type, predicate = () => true, timeoutMs = 5000) => {
    let found = null;
    const ok = await waitFor(async () => {
      found = (await events()).find((row) => row.type === type && predicate(row.payload ?? {})) ?? null;
      return found !== null;
    }, timeoutMs);
    assert.equal(ok, true, `timed out waiting for ${type}`);
    return found.payload ?? {};
  };

  t.after(async () => {
    await disposeAll(disposers.splice(0));
    await rm(root, { recursive: true, force: true });
  });
  return { root, action, events, waitEvent };
}

/** A deferred generator shaped like proactive-line: cancellation resolves with `aborted`. */
function deferredGenerator() {
  const state = {
    calls: [],
    resolve: null,
    signal: null,
  };
  const generate = (options) => {
    state.calls.push({ event: options.event, signal: options.signal ?? null });
    state.signal = options.signal ?? null;
    return new Promise((resolve) => {
      state.resolve = resolve;
      const signal = options.signal;
      if (signal?.aborted === true) {
        resolve({ ok: false, text: '', reason: 'aborted' });
        return;
      }
      signal?.addEventListener('abort', () => {
        resolve({ ok: false, text: '', reason: 'aborted' });
      }, { once: true });
    });
  };
  return { state, generate };
}

// ---------------------------------------------------------------------------------------------
// 1. Pure revalidation matrix
// ---------------------------------------------------------------------------------------------

test('1. 纯助手：同一条候选必须同时通过开关/代次/待选/说话/播放/待回复', () => {
  const base = {
    candidateId: 'understand:1700000000000:0',
    pendingIds: ['understand:1700000000000:0', 'other'],
    enabled: true,
    generation: 7,
    expectedGeneration: 7,
    aborted: false,
    runtimeActive: true,
    userSpeaking: false,
    assistantBusy: false,
    pendingReply: false,
  };
  assert.deepEqual(revalidateProactiveCandidate(base), { ok: true, reason: 'ok' });

  const rejected = [
    [{ enabled: false }, 'disabled'],
    [{ generation: 8 }, 'generation-changed'],
    [{ aborted: true }, 'aborted'],
    [{ runtimeActive: false }, 'disposed'],
    [{ pendingIds: [] }, 'candidate-missing'],
    [{ pendingIds: ['other'] }, 'candidate-missing'],
    [{ candidateId: '' }, 'candidate-missing'],
    [{ spoken: true }, 'spoken'],
    [{ spoken: true, pendingIds: [] }, 'spoken'],
    [{ userSpeaking: true }, 'user-speaking'],
    [{ assistantBusy: true }, 'assistant-busy'],
    [{ pendingReply: true }, 'pending-reply'],
  ];
  for (const [patch, reason] of rejected) {
    const verdict = revalidateProactiveCandidate({ ...base, ...patch });
    assert.equal(verdict.ok, false, `${JSON.stringify(patch)} must reject`);
    assert.equal(verdict.reason, reason, `${JSON.stringify(patch)} reason`);
  }

  // 畸形输入不抛错；未明确 enabled:true 时按关闭处理，绝不误放行。
  for (const input of [undefined, null, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => revalidateProactiveCandidate(input));
    const verdict = revalidateProactiveCandidate(input);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'disabled');
  }
  assert.equal(typeof revalidateProactiveCandidate(base).reason, 'string', 'reason is a machine code');
});

// ---------------------------------------------------------------------------------------------
// 2. Source wiring: signal, post-await gate, abort points
// ---------------------------------------------------------------------------------------------

test('2. 接线：生成传 signal；await 后只对原候选重新仲裁；关闭路径 abort 在途生成', async () => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');

  // Generation receives an external signal and the originally selected candidate.
  assert.match(source, /signal:\s*abortController\.signal/u,
    'proactiveLine.generate must receive the host abort signal');
  assert.match(source, /const abortController = new AbortController\(\);/u);
  assert.match(source, /let proactiveAbort = null;/u);

  // The gate is between `await generate` and `speakLine`; no second evaluate/candidate draw.
  const generatedAt = source.indexOf('const line = await generate({');
  const gateAt = source.indexOf('gate = revalidateProactiveCandidate({');
  const speakAt = source.indexOf('const spoken = await speakLine(');
  assert.ok(generatedAt >= 0 && gateAt > generatedAt && speakAt > gateAt,
    'revalidation must run after generation and before speakLine');
  const between = source.slice(generatedAt, speakAt);
  assert.equal(between.includes('proactive.evaluate('), false,
    'the host must never draw a different candidate after generation');
  assert.match(between, /candidateId: candidate\.id/u, 'the gate checks the original candidate id');
  assert.match(between, /pendingIds: proactive\.pendingIds\(\)/u);
  assert.match(between, /enabled: proactiveEnabled\(\)/u);
  assert.match(between, /generation: proactiveGeneration/u);
  assert.match(between, /expectedGeneration: generation/u);
  assert.match(between, /userSpeaking: speechEvidence !== null/u);
  assert.match(between, /assistantBusy: ttsIsSpeaking\(\) === true \|\| playback !== null/u);
  assert.match(between, /pendingReply: proactivePendingReply\(\)/u);
  assert.match(between, /if \(gate\.ok !== true\)/u, 'any failed check must skip speakLine');
  assert.match(source, /log\.emit\('vision\.proactive\.rejected', \{ reason: gate\.reason \}\)/u,
    'the rejection event contains only the machine reason');

  // Abort points: reset/dispose, user comment, component close, disabled 5 s tick.
  assert.match(source, /const resetProactive = \(reason\) => \{\s*proactiveGeneration \+= 1;\s*abortProactive\(\);/u,
    'reset must abort the in-flight generation');
  assert.match(source, /abortProactive\(\);\s*proactive\.cancelAll\('user-comment'\)/u,
    'user-comment cancellation must abort the in-flight generation');
  assert.match(source, /const onFeatureDisable = async \(\{ id, reason \}\) => \{[\s\S]{0,300}?abortProactive\(\);/u,
    'any component close must abort the in-flight generation');
  assert.match(source, /if \(!proactiveEnabled\(\)\) \{\s*abortProactive\(\);\s*proactive\.cancelAll\('disabled'\);/u,
    'the 5 s interval must abort and clear candidates once disabled');
});

// ---------------------------------------------------------------------------------------------
// 3. Host double: generation overlaps with disable / candidate cancellation
// ---------------------------------------------------------------------------------------------

test('3. 宿主 double：生成期间关闭开关 → abort 在途生成，speakLine 0 次', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  resetArbiter();
  const { state, generate } = deferredGenerator();
  const app = await fixture(t, { proactiveLineGenerator: generate });

  // The 5 s interval evaluates the controllable candidate and enters the deferred generation.
  t.mock.timers.tick(5_000);
  assert.equal(await waitFor(() => state.calls.length === 1), true, 'evaluateProactive starts one generation');
  assert.equal(state.calls[0].event.id, arbiter.candidate.id, 'the original candidate is generated');
  assert.ok(state.signal instanceof AbortSignal, 'generation receives the host abort signal');
  assert.equal(state.signal.aborted, false);

  const off = await app.action({ action: 'vision.proactive', enabled: false });
  assert.equal(off.ok, true, off.error);
  assert.equal(off.enabled, false);

  // The next tick observes the closed switch: abort + clear candidates before any new evaluate.
  t.mock.timers.tick(5_000);
  const rejected = await app.waitEvent('vision.proactive.rejected');
  assert.deepEqual(rejected, { reason: 'disabled' }, 'only the machine reason is logged');
  assert.equal(state.signal.aborted, true, 'the in-flight generation was really aborted');
  assert.equal(arbiter.cancelAllReason, 'disabled', 'the disabled tick clears pending candidates');
  assert.deepEqual(arbiter.spoken, [], 'nothing was accounted as spoken');
  assert.equal((await app.events()).some((row) => row.type === 'vision.proactive.spoken'), false,
    'speakLine never completed the spoken path');
  assert.equal(arbiter.evaluateCalls, 1, 'a closed switch must not start a second evaluation');
});

test('4. 宿主 double：生成期间候选被取消 → speakLine 0 次', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  resetArbiter();
  const { state, generate } = deferredGenerator();
  const app = await fixture(t, { proactiveLineGenerator: generate });

  t.mock.timers.tick(5_000);
  assert.equal(await waitFor(() => state.calls.length === 1), true, 'evaluateProactive starts one generation');

  // Same observable effect as `cancelAll('user-comment')`: the id leaves the pending pool while
  // the model call is still in flight. The stale line then resolves successfully.
  arbiter.pendingIds = [];
  state.resolve({ ok: true, text: '一句生成得比较慢的反应', reason: 'ok' });

  const rejected = await app.waitEvent('vision.proactive.rejected');
  assert.deepEqual(rejected, { reason: 'candidate-missing' }, 'the stale candidate is rejected, not spoken');
  assert.deepEqual(arbiter.spoken, [], 'the producer did not account it as spoken');
  assert.equal((await app.events()).some((row) => row.type === 'vision.proactive.spoken'), false,
    'a resolved stale line must not reach speakLine');
  assert.ok(arbiter.canceled.includes(arbiter.candidate.id) === false,
    'an already-removed candidate is not re-canceled into the next generation');
});
