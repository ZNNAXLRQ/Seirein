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

const state = {
  /** Filled by the fixture; the stubbed sight module calls it instead of touching the screen. */
  makeShot: null,
  captures: 0,
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
          const forbidden = () => { throw new Error('real capture forbidden'); };
          export const resolveFfmpeg = () => null;
          export const resolveFfplay = () => null;
          export const capture = (options) => s.makeShot(options.dir);
          export const captureDesktop = capture;
          export const captureDevice = capture;
          export const startStoryboard = forbidden;
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
const { apply } = await import('../src/host/index.js');
hooks.deregister();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-host-'));
  const tools = new Map();
  const routes = new Map();
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
      systemPrompt: { section: () => () => {} },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
    }),
  }, { root, enabled: true, defaultDomain: 'chat', privacyScene: 'Privacy' });

  // A unique capture per call so no coalescing window can hide a second request.
  state.captures = 0;
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
  return { root, call, status, action, evidenceDir, listEvidence, waitFor, dispose };
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
