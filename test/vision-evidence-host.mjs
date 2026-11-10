/**
 * P-186/P-187 阶段 1 host wiring: the evidence window is filled from a real capture, survives the
 * original screenshot's deletion, is cleared at a privacy/epoch boundary, and leaves no copy behind
 * after unload. The media timeline is asserted through its status projection only; this file never
 * starts ASR, ffmpeg, OBS, the screen or a child process.
 *
 * Run: node --test test/vision-evidence-host.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disposeAll } from './helpers/cleanup.mjs';
import { DIALOGUE_INJECTION_ORDER } from '../src/host/session/conversation/dialogue-summary.js';
import { createCommentEvidence } from '../src/host/vision/comment-evidence.js';

const state = {
  /** Filled by the fixture; the stubbed sight module calls it instead of touching the screen. */
  makeShot: null,
  captures: 0,
  /** Boot/pre-step 门禁：任何失败/误启动的 storyboard 尝试都必须能被测试看见。 */
  storyboardStarts: 0,
  /** Test-only fault injection: the next attachment save fails inside deliverSight. */
  failSave: false,
};
globalThis.__visionEvidenceHostTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const s = globalThis.__visionEvidenceHostTest;
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = (options) => s.makeShot(options.dir);
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = () => {
            s.storyboardStarts = (s.storyboardStarts ?? 0) + 1;
            throw new Error('real capture forbidden');
          };
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
            const value = observation ?? {};
            const at = Number(value.capturedAt ?? value.at);
            const ageMs = Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : null;
            return { ...value, at: ageMs === null ? null : at, ageMs, stale: ageMs === null || ageMs >= ttlMs, hint: '' };
          }`,
      };
    }
    return next(url, context);
  },
});
const { apply, voiceSessionTarget } = await import('../src/host/index.js');
hooks.deregister();

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-host-'));
  const tools = new Map();
  const routes = new Map();
  const promptSections = new Map();
  const promptContexts = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const attachments = {
    async saveImage({ data, mediaType, name }) {
      if (state.failSave === true) throw new Error('fake attachment save failure');
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
        section(definition) {
          promptSections.set(definition.name, definition);
          return () => {};
        },
        context(definition) {
          promptContexts.set(definition.name, definition);
          return () => {};
        },
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
    ...options,
  });

  // A unique capture per call so no coalescing window can hide a second request.
  state.captures = 0;
  state.storyboardStarts = 0;
  state.failSave = false;
  state.makeShot = async (dir) => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `evidence-${++state.captures}.png`);
    const data = Buffer.from(`PNGDATA-EVIDENCE-${state.captures}`);
    await writeFile(file, data);
    return {
      file, bytes: data.length, width: 320, height: 200, engine: 'fake',
      capturedAt: Date.now(),
    };
  };

  const exec = {
    agent: {
      session: {
        id: 'evidence-session',
        requestHeader: () => ({ config: { provider: 'fake', model: 'vision-model' } }),
      },
      options: {},
    },
  };
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return tool.execute(args, exec);
  };
  const render = (name, args, value) => {
    const tool = tools.get(name);
    assert.ok(tool?.output?.render !== undefined, `${name} has a render`);
    return tool.output.render(args, value);
  };
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
  const status = () => route('/assistant/status', undefined, 'GET');
  const action = (body) => route('/assistant/action', body);
  const evidenceDir = () => join(root, 'cache', 'evidence');
  const listEvidence = () => readdir(evidenceDir()).catch(() => []);
  const dispose = async () => disposeAll(disposers.splice(0));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
  };

  t.after(async () => {
    await dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    root, call, render, status, action, evidenceDir, listEvidence, waitFor, dispose,
    promptSections, promptContexts,
  };
}

test('真实截图进入证据窗口，删掉原图后副本仍在；status 只给计数不给路径', async (t) => {
  const app = await fixture(t);
  const seen = await app.call('assistant_see', { reason: 'evidence' });
  assert.equal(seen.ok, true, seen.reason);

  await app.waitFor(async () => (await app.status()).vision.evidence.frames === 1,
    'one evidence frame to be registered');
  const snapshot = await app.status();
  const evidence = snapshot.vision.evidence;
  assert.equal(evidence.frames, 1);
  assert.ok(evidence.bytes > 0, 'the copied bytes are counted');
  assert.ok(Number.isInteger(evidence.generation), 'the window generation is exposed');
  assert.ok(evidence.stats.added >= 1, 'the add is counted');
  assert.ok(evidence.newestAt > 0, 'the capture time is exposed');
  assert.equal(JSON.stringify(evidence).includes('cache'), false, 'no evidence file path is exposed');

  // The media timeline is a separate evidence stream with its own epoch; no loopback session ran.
  assert.equal(snapshot.hearing.media.entries, 0);
  assert.equal(snapshot.hearing.media.epoch, 0);
  assert.equal(JSON.stringify(snapshot.hearing.media).includes('cache'), false);

  const files = await app.listEvidence();
  assert.equal(files.length, 1, 'exactly one copy was made');
  const copied = await readFile(join(app.evidenceDir(), files[0]));
  assert.ok(copied.length > 0);

  // Delivery cleanup deletes the original screenshot, never the evidence copy.
  await rm(seen.file, { force: true });
  assert.equal((await app.listEvidence()).length, 1, 'the evidence copy is independent');
  assert.equal((await app.status()).vision.evidence.frames, 1);
});

test('证据窗口登记原始帧 cells：status 只给计数，隐私边界连原帧一起清理', async (t) => {
  const app = await fixture(t);
  const baseMakeShot = state.makeShot;
  const rawFiles = [];
  state.makeShot = async (dir) => {
    const shot = await baseMakeShot(dir);
    const cells = [];
    for (let i = 0; i < 2; i += 1) {
      const rawFile = join(dir, `original-${state.captures}-${i}.png`);
      const data = Buffer.from(`RAW-FRAME-${state.captures}-${i}`);
      await writeFile(rawFile, data);
      rawFiles.push(rawFile);
      cells.push({
        frameId: `frame-${state.captures}-${i}`,
        capturedAt: shot.capturedAt,
        width: shot.width,
        height: shot.height,
        bytes: data.length,
        file: rawFile,
        shotId: '',
      });
    }
    return { ...shot, cells };
  };

  const seen = await app.call('assistant_see', { reason: 'original-frames' });
  assert.equal(seen.ok, true, seen.reason);
  await app.waitFor(async () => {
    const evidence = (await app.status()).vision.evidence;
    return evidence.frames === 1 && evidence.cells === 2;
  }, 'one sheet with two original frames');

  const snapshot = await app.status();
  assert.equal(snapshot.vision.evidence.cells, 2, '只暴露原帧数量');
  const evidenceJson = JSON.stringify(snapshot.vision.evidence);
  assert.equal(evidenceJson.includes('cache'), false, 'status 不含证据/原帧路径');
  assert.equal(evidenceJson.includes('original-'), false, 'status 不含原帧文件名');
  assert.equal(evidenceJson.includes('frame-'), false, 'status 不暴露 frameId');
  assert.equal((await app.listEvidence()).length, 1, '证据目录仍只复制 sheet');

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  await app.waitFor(async () => (await app.status()).vision.evidence.cells === 0,
    'privacy to clear the original-frame references');
  await app.waitFor(async () => {
    const remaining = await Promise.all(rawFiles.map((file) => readFile(file).then(() => true, () => false)));
    return remaining.every((exists) => exists === false);
  }, 'privacy to delete the original frame files');
  assert.equal(JSON.stringify((await app.status()).vision.evidence).includes('cache'), false);
});

test('进隐私清掉旧证据代次，目录不残留；卸载同样清理副本', async (t) => {
  const app = await fixture(t);
  const seen = await app.call('assistant_see', { reason: 'privacy' });
  assert.equal(seen.ok, true, seen.reason);
  await app.waitFor(async () => (await app.status()).vision.evidence.frames === 1,
    'one evidence frame to be registered');
  const before = (await app.status()).vision.evidence;
  assert.equal((await app.listEvidence()).length, 1);

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  await app.waitFor(async () => (await app.listEvidence()).length === 0,
    'the evidence directory to be cleared');
  const after = await app.status();
  assert.equal(after.vision.evidence.frames, 0, 'no old frame survives the privacy boundary');
  assert.ok(after.vision.evidence.generation > before.generation, 'the window generation advanced');

  // A new capture is refused in privacy, so nothing can seed the cleared window again.
  const refused = await app.call('assistant_see', {});
  assert.equal(refused.ok, false);
  assert.equal((await app.status()).vision.evidence.frames, 0);

  // Unload removes every copy and the directory itself.
  const failures = await app.dispose();
  assert.deepEqual(failures, []);
  await assert.rejects(readdir(app.evidenceDir()), /ENOENT/);
});

test('未进入陪伴轮时，boot 定时器不会启动真实证据采集', async (t) => {
  // 裸宿主 mount + 10ms 的 boot 定时器：到点后没有 companionSessionSeen，必须什么都不做。
  const app = await fixture(t, { evidenceCaptureBootDelayMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const snapshot = await app.status();
  assert.equal(snapshot.vision.evidenceCapture.running, false);
  assert.equal(snapshot.vision.evidenceCapture.startedAt, null);
  assert.equal(snapshot.vision.evidenceCapture.ticks, 0);
  assert.equal(state.storyboardStarts, 0, '门禁必须在调用 startStoryboard 之前就拦住');
  assert.deepEqual(await app.listEvidence(), [], 'cache/evidence 不得出现新文件');
});

test('裸挂载不产生视听证据块：assistant:audiovisual 为空，status.vision.comment 为 0', async (t) => {
  // 没有真实陪伴轮、没有 ASR：只有 prompt context 注册和空的评论证据计数，绝不碰屏幕。
  const app = await fixture(t, { evidenceCaptureBootDelayMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  assert.ok(audiovisual !== undefined, 'assistant:audiovisual 以 runtime context 注册，不是 section');
  assert.equal(app.promptSections.has('assistant:audiovisual'), false, '动态块不得进入历史 section');
  assert.ok(audiovisual.order > DIALOGUE_INJECTION_ORDER, 'order 保持在 dialogue 之后');
  assert.equal(typeof audiovisual.text, 'function');

  // 陪伴会话身份 + voice lane 都满足时，唯一让渲染为空的理由就是“还没有评论证据”。
  const workspace = join(app.root, 'workspace');
  const companion = {
    id: voiceSessionTarget({ root: app.root }).sessionId,
    session: { header: { cwd: workspace } },
  };
  assert.equal(audiovisual.text({ agent: companion }), '', '无记录时不产生空块');
  assert.equal(audiovisual.text({
    agent: { id: 'typed-session', session: { header: { cwd: workspace } } },
  }), '', '非陪伴/typed 会话永远读不到评论证据');

  const snapshot = await app.status();
  assert.deepEqual(snapshot.vision.comment, {
    sessions: 0,
    latestAt: null,
    attached: 0,
    expired: 0,
    evicted: 0,
  }, 'status 只暴露只读计数');
  assert.equal(JSON.stringify(snapshot.vision.comment).includes('cache'), false, '不含证据路径');
  assert.equal(state.storyboardStarts, 0, '裸挂载不得触发真实采集');
});

test('assistant_see 按 evidenceFrameIds 回看缓存帧：不重新截屏且图片块存在', async (t) => {
  const app = await fixture(t);
  const seen = await app.call('assistant_see', { reason: 'evidence-seed' });
  assert.equal(seen.ok, true, seen.reason);
  await app.waitFor(async () => (await app.status()).vision.evidence.recentIds.length === 1,
    'one recent evidence id');

  const before = await app.status();
  const [id] = before.vision.evidence.recentIds;
  assert.match(id, /^ev-\d+$/);
  assert.equal(JSON.stringify(before.vision.evidence).includes('cache'), false, 'status 不含路径');
  assert.ok(before.vision.lastShot !== null, '普通截图仍写 lastVision');
  const capturesBefore = state.captures;
  const lastShotBefore = before.vision.lastShot;

  const replayed = await app.call('assistant_see', { evidenceFrameIds: [id] });
  assert.equal(replayed.ok, true, replayed.reason);
  assert.equal(replayed.evidence, true);
  assert.deepEqual(replayed.frameIds, [id], 'frameIds 是实际交付的 id');
  assert.equal(state.captures, capturesBefore, '回看不得重新截屏');

  const after = await app.status();
  assert.equal(after.vision.evidence.frames, 1, '回看不新增证据帧');
  assert.equal(after.vision.lastShot?.file, lastShotBefore.file, '回看不改变 lastVision 的文件');
  assert.equal(after.vision.lastShot?.capturedAt, lastShotBefore.capturedAt, '回看不改变“现在”');

  const blocks = app.render('assistant_see', { evidenceFrameIds: [id] }, replayed);
  const images = blocks.filter((block) => block.type === 'image');
  assert.equal(images.length, 1, '每张图输出一个 image block');
  assert.equal(images[0].attachment?.id, 'att-1');
  assert.ok(blocks.some((block) => block.type === 'text' && block.text.includes(id)));
});

test('assistant_see 未知 evidenceFrameIds：返回 ok:false，不截图', async (t) => {
  const app = await fixture(t);
  const capturesBefore = state.captures;
  const result = await app.call('assistant_see', { evidenceFrameIds: ['ev-does-not-exist'] });
  assert.equal(result.ok, false);
  assert.equal(result.evidence, true);
  assert.equal(result.error, '证据帧已过期或不可用');
  assert.equal(state.captures, capturesBefore, '没有可用帧时不得捕获新帧');
  assert.equal((await app.status()).vision.evidence.frames, 0);

  const blocks = app.render('assistant_see', { evidenceFrameIds: ['ev-does-not-exist'] }, result);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
  assert.ok(blocks.some((block) => block.type === 'text' && block.text.includes('证据帧已过期或不可用')));
});

test('回看交付被拒：证据副本仍在、recentIds 不变、临时交付文件已清理', async (t) => {
  const app = await fixture(t);
  const seen = await app.call('assistant_see', { reason: 'failed-replay-seed' });
  assert.equal(seen.ok, true, seen.reason);
  await app.waitFor(async () => (await app.status()).vision.evidence.recentIds.length === 1,
    'one recent evidence id');
  const [id] = (await app.status()).vision.evidence.recentIds;
  const evidenceBefore = (await app.listEvidence()).sort();
  assert.equal(evidenceBefore.length, 1);
  const screensDir = join(app.root, 'cache', 'screens');
  const screensBefore = (await readdir(screensDir).catch(() => [])).sort();
  const capturesBefore = state.captures;

  // 让 deliverSight 在读完临时交付文件后、保存附件时失败：覆盖“交付拒绝后证据仍在”。
  state.failSave = true;
  try {
    const failed = await app.call('assistant_see', { evidenceFrameIds: [id] });
    assert.equal(failed.ok, false);
    assert.equal(failed.evidence, true);
    assert.match(failed.error, /附件保存失败/, failed.error);
  } finally {
    state.failSave = false;
  }

  assert.equal(state.captures, capturesBefore, '拒绝不得重新截屏');
  const evidenceAfter = (await app.listEvidence()).sort();
  assert.deepEqual(evidenceAfter, evidenceBefore, '证据副本没有被交付拒绝路径删除');
  const snapshot = await app.status();
  assert.equal(snapshot.vision.evidence.frames, 1);
  assert.ok(snapshot.vision.evidence.recentIds.includes(id), '窗口仍包含该证据 id');

  const screensAfter = (await readdir(screensDir).catch(() => [])).sort();
  assert.deepEqual(screensAfter, screensBefore, '临时交付副本已清理');
  assert.equal(screensAfter.some((file) => file.startsWith('deliver-')), false);
});

test('隐私模式下 evidenceFrameIds 被拒绝，且不截图', async (t) => {
  const app = await fixture(t);
  const seen = await app.call('assistant_see', { reason: 'privacy-replay' });
  assert.equal(seen.ok, true, seen.reason);
  await app.waitFor(async () => (await app.status()).vision.evidence.recentIds.length === 1,
    'one recent evidence id');
  const [id] = (await app.status()).vision.evidence.recentIds;
  const capturesBefore = state.captures;

  const privacy = await app.action({ action: 'vision.mode', mode: 'privacy' });
  assert.equal(privacy.ok, true, privacy.error);
  await app.waitFor(async () => (await app.status()).vision.evidence.frames === 0,
    'privacy to clear the evidence window');

  const refused = await app.call('assistant_see', { evidenceFrameIds: [id] });
  assert.equal(refused.ok, false);
  assert.equal(refused.evidence, true);
  assert.equal(state.captures, capturesBefore, '隐私拒绝不得绕路截图');
  assert.match(refused.reason, /隐私|作废/, refused.reason);

  const blocks = app.render('assistant_see', { evidenceFrameIds: [id] }, refused);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
});

test('assistant_see 超过 3 个 evidenceFrameIds：只交付前 3 张', async (t) => {
  const app = await fixture(t);
  // 每次真实截图之间拉开 > VISION_COALESCE_MS，确保得到 4 个独立证据帧。
  for (let i = 0; i < 4; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 550));
    const before = state.captures;
    const seen = await app.call('assistant_see', { reason: `multi-${i}` });
    assert.equal(seen.ok, true, seen.reason);
    assert.ok(state.captures > before, `第 ${i + 1} 次调用应真正截图`);
    await app.waitFor(async () => (await app.status()).vision.evidence.frames >= i + 1,
      `${i + 1} evidence frames`);
  }
  const ids = (await app.status()).vision.evidence.recentIds;
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, '四个独立帧 id');

  const capturesBefore = state.captures;
  const replayed = await app.call('assistant_see', {
    evidenceFrameIds: [...ids, ids[0]],
  });
  assert.equal(replayed.ok, true, replayed.reason);
  assert.equal(replayed.frameIds.length, 3, '最多交付 3 张');
  assert.deepEqual(replayed.frameIds, ids.slice(0, 3), '按传入顺序取前 3 个可用 id');
  assert.equal(state.captures, capturesBefore, '回看不得重新截屏');

  const blocks = app.render('assistant_see', { evidenceFrameIds: [...ids, ids[0]] }, replayed);
  assert.equal(blocks.filter((block) => block.type === 'image').length, 3, '三张图各一个 image block');
});

test('assistant:audiovisual 走 ephemeral 预算：小额度为空，大额度恢复且不超额度', async (t) => {
  // 裸挂载没有真实 ASR，无法从 onUpdate 制造记录：注入一个已 attach 的 commentEvidence 实例，
  // 只验证 plan/预算/渲染接线，不碰屏幕、不启动采集。
  const seeded = createCommentEvidence();
  const voiceBudget = {
    persona: 100_000,
    fixed: 100_000,
    memory: 0,
    recent: 0,
    ephemeral: 12,
    totalChars: 100_000,
  };
  const app = await fixture(t, {
    commentEvidence: seeded,
    contextBudgets: { voice: voiceBudget },
  });
  const sessionId = voiceSessionTarget({ root: app.root }).sessionId;
  const now = Date.now();
  seeded.attach({
    sessionId,
    utteranceId: 'budget-u',
    startedAt: now - 3_000,
    endedAt: now - 1_000,
    alignment: {
      confidence: 'high',
      reason: 'window',
      window: { from: now - 8_000, to: now - 1_000 },
      cues: { retrospective: false, current: false },
      relatedFrameIds: ['ev-1', 'ev-2'],
      afterSpeechFrameIds: [],
      latestFrameId: 'ev-2',
    },
    latestId: 'ev-2',
    latestAt: now,
    frameCount: 4,
  });

  const audiovisual = app.promptContexts.get('assistant:audiovisual');
  assert.ok(audiovisual !== undefined);
  const workspace = join(app.root, 'workspace');
  const contextFor = () => ({
    agent: { id: sessionId, session: { header: { cwd: workspace } } },
  });

  // 12 字符的 ephemeral 连标题都放不下：环境/非语言/视听块一起被裁掉，绝不能绕过额度。
  const small = audiovisual.text(contextFor());
  assert.equal(small, '', '预算裁掉时不注入');
  assert.ok(small.length <= voiceBudget.ephemeral);

  // 同一实例、同一 session，只放宽 ephemeral；换一个 agent 对象触发全新 plan。
  voiceBudget.ephemeral = 100_000;
  const large = audiovisual.text(contextFor());
  assert.ok(large.length > 0, '额度充足时恢复评论证据块');
  assert.ok(large.includes('评论关联窗口'), '恢复的是同一份评论证据');
  assert.ok(large.includes('语音结束（端点）'), '文案使用语音端点，不写识别完成');
  assert.equal(large.includes('识别完成'), false);
  assert.ok(large.length <= voiceBudget.ephemeral, '任何情况下都不超 ephemeral 额度');
});
