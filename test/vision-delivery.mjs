/**
 * C1 vision delivery: `assistant_see` must hand the model the real pixels, not only a path.
 *
 * Every process/frame/attachment backend here is a test double: the fake sight module writes a
 * small PNG-shaped file to disk, the fake attachment service records exactly what it was asked
 * to save, and no real screen is ever captured.
 *
 * Run: node --test test/vision-delivery.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { EventLog } from '../src/host/memory/store.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const state = {
  capture: null,
  shrink: null,
  captures: 0,
  shrinkCalls: [],
  saves: [],
  attachments: [],
  saveGate: null,
  saveError: null,
  route: null,
  modalities: null,
  resolveCalls: 0,
};
globalThis.__visionDeliveryTest = state;

const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const obsUrl = new URL('../src/host/vision/obs.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `const s = globalThis.__visionDeliveryTest;
          export const resolveFfmpeg = () => 'fake-ffmpeg';
          export const resolveFfplay = () => null;
          export const capture = (o) => s.capture(o);
          export const captureDesktop = (o) => s.capture(o);
          export const captureDevice = (o) => s.capture(o);
          export const startStoryboard = () => { throw new Error('storyboard is not used here'); };
          export const shrinkShot = (shot, options) => s.shrink(shot, options);
          // Freshness is a real module export now (index.js + ambient.js import it), so the
          // stub must keep the same contract even though no test here ages a frame.
          export const OBSERVATION_TTL_MS = 30000;
          export function readObservation(observation, { now = Date.now(), ttlMs = 30000 } = {}) {
            const value = observation ?? {};
            const captured = Number(value.capturedAt);
            const stored = Number.isFinite(captured) && captured > 0 ? captured : Number(value.at);
            const at = Number.isFinite(stored) && stored > 0 ? stored : null;
            const ageMs = at === null ? null : Math.max(0, now - at);
            const stale = ageMs === null || ageMs >= ttlMs;
            return { ...value, at, ageMs, stale, hint: stale ? 'stale' : '' };
          }`,
      };
    }
    if (url === obsUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function connectObs() { return {
          async request(type) {
            if (type === 'GetSceneList') {
              return { currentProgramSceneName: 'Main', scenes: [{ sceneName: 'Main' }, { sceneName: 'Privacy' }] };
            }
            return { outputActive: true };
          },
          close() {},
        }; }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__visionDeliveryTest; });

const SUPPORTED = {
  currentSelection: () => ({ provider: 'fake', model: 'vision-model', supportsVision: true }),
};

async function fixture(t, {
  attachments = true,
  selection = SUPPORTED,
  maxAttachmentBytes,
  modalities = ['text', 'image'],
  route = { provider: 'fake', model: 'vision-model' },
  llm = true,
} = {}) {
  state.capture = null;
  state.shrink = null;
  state.captures = 0;
  state.shrinkCalls = [];
  state.saves = [];
  state.attachments = [];
  state.saveGate = null;
  state.saveError = null;
  state.route = route;
  state.modalities = modalities;
  state.resolveCalls = 0;

  const root = await mkdtemp(join(tmpdir(), 'dsh-vision-delivery-'));
  const tools = new Map();
  const disposers = [];
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const attachmentsService = {
    async saveImage(input) {
      state.saves.push(input);
      if (state.saveGate !== null) await state.saveGate;
      if (state.saveError !== null) throw state.saveError;
      const attachment = { id: `att-${state.saves.length}`, mediaType: input.mediaType, name: input.name };
      state.attachments.push(attachment);
      return attachment;
    },
  };
  apply({
    effect,
    get: (service) => {
      if (service === 'attachments') return attachments ? attachmentsService : undefined;
      if (service === 'agentDefaultModel') return selection;
      // The real Host resolves the calling route through `llm`, exactly like read_image.
      if (service === 'llm') {
        if (!llm) return undefined;
        return {
          async resolveModelInfo(provider, model) {
            state.resolveCalls += 1;
            return {
              provider,
              id: model,
              name: model,
              ...(state.modalities === undefined || state.modalities === null ? {} : { inputModalities: state.modalities }),
            };
          },
        };
      }
      return undefined;
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register: () => () => {} },
    }),
  }, {
    root,
    enabled: true,
    obsPort: 1,
    privacyScene: 'Privacy',
    ...(maxAttachmentBytes === undefined ? {} : { vision: { maxAttachmentBytes } }),
  });
  t.after(() => cleanupRoot(root, disposers));

  const exec = (overrides = {}) => ({
    ...overrides,
    agent: overrides.agent ?? {
      session: { requestHeader: () => ({ config: state.route ?? {} }) },
      options: {},
    },
  });
  const call = async (name, args = {}, overrides = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `${name} is registered`);
    return { tool, value: await tool.execute(args, exec(overrides)) };
  };
  const captureWith = (data, { width = 320, height = 200 } = {}) => {
    state.capture = async ({ dir }) => {
      state.captures += 1;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${randomUUID()}.png`);
      await writeFile(file, data);
      return { file, bytes: data.length, width, height, engine: 'fake' };
    };
  };
  const events = async () => {
    const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8').catch(() => '');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const render = (tool, value) => tool.output.render({}, value);
  return { root, call, captureWith, events, render };
}

test('normal delivery returns one text block and one image block built from saveImage', async (t) => {
  const app = await fixture(t);
  const data = Buffer.from('PNGDATA-SECRET-PIXELS-0123456789');
  app.captureWith(data);

  const { tool, value } = await app.call('assistant_see', { reason: 'test' });
  assert.equal(value.ok, true);
  assert.equal(value.bytes, data.length);
  assert.equal(value.width, 320);
  assert.equal(value.height, 200);
  assert.equal(value.attachmentId, 'att-1');

  // The attachment service received the real bytes, not a path or placeholder.
  assert.equal(state.saves.length, 1);
  const save = state.saves[0];
  assert.ok(Buffer.isBuffer(save.data), 'saveImage receives a Buffer');
  assert.ok(save.data.equals(data), 'the saved bytes are the captured bytes');
  assert.equal(save.mediaType, 'image/png');
  assert.equal(save.name, basename(value.file));

  const blocks = app.render(tool, value);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].attachment, state.attachments[0], 'the image block carries the saved attachment');

  const delivered = (await app.events()).find((event) => event.type === 'vision.delivered');
  assert.ok(delivered !== undefined, 'vision.delivered is recorded');
  assert.deepEqual(delivered.payload, { bytes: data.length, width: 320, height: 200, attachmentId: 'att-1' });
});

test('the text description is metadata only and never leaks picture content', async (t) => {
  const app = await fixture(t);
  const sentinel = 'SECRET_PIXEL_CONTENT_DO_NOT_RENDER';
  app.captureWith(Buffer.from(`PNG${sentinel}PNG`));

  const { tool, value } = await app.call('assistant_see', {});
  const text = app.render(tool, value).filter((block) => block.type === 'text').map((block) => block.text).join('\n');

  assert.match(text, /320x200/);
  assert.match(text, new RegExp(`\\b${value.bytes}\\b`), 'byte count is visible');
  assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'capture time is visible');
  assert.match(text, /mode=watch/);
  assert.match(text, /privacy=off/);
  assert.ok(!text.includes(sentinel), 'picture content never appears in the text');
  assert.ok(!text.includes(value.file), 'the absolute path is not needed to describe the frame');
});

test('an unavailable attachment service refuses before capturing and returns no image block', async (t) => {
  const app = await fixture(t, { attachments: false });
  app.captureWith(Buffer.from('PNGDATA-SHOULD-NOT-BE-READ'));

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /附件服务不可用/);
  assert.equal(state.captures, 0, 'the capability check runs before the screen is touched');
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  const refused = events.find((event) => event.type === 'vision.delivery.refused');
  assert.ok(refused !== undefined);
  assert.match(refused.payload.reason, /附件服务不可用/);
});

test('an oversized frame goes through the proportional shrinker and stays under the cap', async (t) => {
  const maxAttachmentBytes = 1024;
  const app = await fixture(t, { maxAttachmentBytes });
  app.captureWith(Buffer.alloc(maxAttachmentBytes * 4, 0x41));
  const small = Buffer.alloc(512, 0x42);
  state.shrink = async (shot, options) => {
    state.shrinkCalls.push({ shot, options });
    const file = join(dirname(shot.file), `${randomUUID()}-small.png`);
    await writeFile(file, small);
    return { file, bytes: small.length, width: 160, height: 100, data: small };
  };

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, true);
  assert.equal(value.scaled, true);
  assert.equal(state.shrinkCalls.length, 1, 'the shrinker was called exactly once');
  assert.equal(state.shrinkCalls[0].options.maxBytes, maxAttachmentBytes);
  assert.equal(state.saves.length, 1);
  assert.ok(state.saves[0].data.length < maxAttachmentBytes, 'delivered bytes are under the cap');
  assert.equal(value.bytes, small.length);
  assert.equal(value.width, 160);
  assert.equal(value.height, 100);

  const blocks = app.render(tool, value);
  assert.equal(blocks[1].type, 'image');
  const delivered = (await app.events()).find((event) => event.type === 'vision.delivered');
  assert.equal(delivered.payload.bytes, small.length);
  assert.equal(delivered.payload.width, 160);
  assert.equal(delivered.payload.height, 100);
});

test('privacy at call time refuses delivery and returns no image block', async (t) => {
  const app = await fixture(t);
  app.captureWith(Buffer.from('PNGDATA-PRIVATE'));

  const mode = await app.call('assistant_vision', { action: 'set', mode: 'privacy' });
  assert.equal(mode.value.ok, true);
  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /隐私/);
  assert.equal(state.captures, 0, 'privacy is checked before capture');
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused' && /隐私/.test(event.payload.reason)));
});

test('a text-only route is refused before capture and renders no image block', async (t) => {
  const app = await fixture(t, { modalities: ['text'] });
  app.captureWith(Buffer.from('PNGDATA-TEXT-ONLY-SHOULD-NOT-BE-READ'));

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /不支持图像输入/);
  assert.equal(state.captures, 0, 'the route capability is checked before the screen is touched');
  assert.equal(state.resolveCalls, 1, 'the exact calling route is resolved once');
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused' && /不支持图像输入/.test(event.payload.reason)));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
});

test('a route that cannot be resolved is rejected as unknown before capture', async (t) => {
  const app = await fixture(t, { route: null });
  app.captureWith(Buffer.from('PNGDATA-UNKNOWN-ROUTE-SHOULD-NOT-BE-READ'));

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /无法确认/);
  assert.equal(state.captures, 0, 'an unknown route must not touch the screen');
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.capability.unknown-rejected'));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
});

test('a pre-cancelled tool signal refuses before capture and returns no image', async (t) => {
  const app = await fixture(t);
  app.captureWith(Buffer.from('PNGDATA-PRE-CANCELLED-SHOULD-NOT-BE-READ'));
  const controller = new AbortController();
  controller.abort(new Error('cancelled by the caller'));

  const { tool, value } = await app.call('assistant_see', {}, { signal: controller.signal });
  assert.equal(value.ok, false);
  assert.match(value.reason, /取消/);
  assert.equal(state.captures, 0, 'a cancelled call must not capture');
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused' && /取消/.test(event.payload.reason)));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
});

test('privacy flipped during the awaited delivery log refuses the late image', async (t) => {
  const app = await fixture(t);
  app.captureWith(Buffer.from('PNGDATA-PRIVACY-AFTER-LOG'));
  const entered = deferred();
  const finish = deferred();
  const emit = EventLog.prototype.emit;
  t.mock.method(EventLog.prototype, 'emit', async function (type, ...args) {
    if (type === 'vision.delivered') {
      entered.resolve();
      await finish.promise;
    }
    return emit.call(this, type, ...args);
  });

  const pending = app.call('assistant_see', {});
  await entered.promise;
  const mode = await app.call('assistant_vision', { action: 'set', mode: 'privacy' });
  assert.equal(mode.value.ok, true);
  finish.resolve();

  const { tool, value } = await pending;
  assert.equal(value.ok, false);
  assert.equal(value.attachment, null);
  assert.equal(app.render(tool, value).some((block) => block.type === 'image'), false);
  assert.match(value.reason, /隐私|作废/);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused'));
});

test('cancellation during capture aborts the shared signal lane and never delivers', async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  let captureSignal = null;
  state.capture = async ({ signal }) => {
    state.captures += 1;
    captureSignal = signal;
    entered.resolve();
    await new Promise((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const controller = new AbortController();

  const pending = app.call('assistant_see', {}, { signal: controller.signal });
  await entered.promise;
  assert.equal(captureSignal?.aborted, false);
  controller.abort(new Error('cancelled during capture'));

  const { tool, value } = await pending;
  assert.equal(value.ok, false);
  assert.equal(state.captures, 1);
  assert.equal(app.render(tool, value).some((block) => block.type === 'image'), false);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused' && /取消|作废/.test(event.payload.reason)));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
});

test('cancellation while saveImage is pending refuses the late result and never renders it', async (t) => {
  const app = await fixture(t);
  app.captureWith(Buffer.from('PNGDATA-CANCELLED-DURING-SAVE'));
  const gate = deferred();
  state.saveGate = gate.promise;

  const pending = app.call('assistant_see', {});
  // Wait until the delivery has entered saveImage, then flip privacy under it.
  while (state.saves.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const mode = await app.call('assistant_vision', { action: 'set', mode: 'privacy' });
  assert.equal(mode.value.ok, true);
  gate.resolve();

  const { tool, value } = await pending;
  assert.equal(value.ok, false);
  assert.equal(value.attachment, null);
  assert.equal(app.render(tool, value).some((block) => block.type === 'image'), false);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.delivery.refused'));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false, 'the late frame is not delivered');
});

test('cancellation during shrink deletes the screenshot and clears lastShot', async (t) => {
  const app = await fixture(t, { maxAttachmentBytes: 1024 });
  const data = Buffer.alloc(4096, 0x41);
  let shotFile = '';
  state.capture = async ({ dir }) => {
    state.captures += 1;
    await mkdir(dir, { recursive: true });
    shotFile = join(dir, `${randomUUID()}.png`);
    await writeFile(shotFile, data);
    return { file: shotFile, bytes: data.length, width: 320, height: 200, engine: 'fake' };
  };
  const entered = deferred();
  state.shrink = async (shot, options) => {
    shotFile = shot.file;
    entered.resolve();
    await new Promise((_resolve, reject) => {
      if (options.signal?.aborted) return reject(options.signal.reason);
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const pending = app.call('assistant_see', {}, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('cancelled during shrink'));

  const { tool, value } = await pending;
  assert.equal(value.ok, false);
  assert.match(value.reason, /cancelled during shrink/);
  assert.equal(value.attachment, null);
  assert.equal(app.render(tool, value).some((block) => block.type === 'image'), false);
  const exists = await readFile(shotFile).then(() => true, () => false);
  const status = (await app.call('assistant_vision', { action: 'status' })).value;
  t.diagnostic(`shrink-cancel: ${basename(shotFile)} exists=${exists}; lastShot=${JSON.stringify(status.lastShot)}`);
  assert.equal(exists, false, 'the undelivered screenshot is deleted');
  assert.equal(status.lastShot, null, 'lastShot no longer points at the deleted file');

  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
  const refused = events.filter((event) => event.type === 'vision.delivery.refused').at(-1);
  assert.equal(refused.payload.stage, 'shrink', 'the refusal names the shrink stage');
});

test('a failed saveImage deletes the captured file and clears lastShot', async (t) => {
  const app = await fixture(t);
  const data = Buffer.from('PNGDATA-SAVE-FAILS');
  let shotFile = '';
  state.capture = async ({ dir }) => {
    state.captures += 1;
    await mkdir(dir, { recursive: true });
    shotFile = join(dir, `${randomUUID()}.png`);
    await writeFile(shotFile, data);
    return { file: shotFile, bytes: data.length, width: 320, height: 200, engine: 'fake' };
  };
  state.saveError = new Error('attachment store unavailable');

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /附件保存失败/);
  assert.equal(app.render(tool, value).some((block) => block.type === 'image'), false);
  const exists = await readFile(shotFile).then(() => true, () => false);
  const status = (await app.call('assistant_vision', { action: 'status' })).value;
  t.diagnostic(`save-failure: ${basename(shotFile)} exists=${exists}; lastShot=${JSON.stringify(status.lastShot)}`);
  assert.equal(exists, false, 'a failed save does not leave the screenshot on disk');
  assert.equal(status.lastShot, null);

  const events = await app.events();
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
  const refused = events.filter((event) => event.type === 'vision.delivery.refused').at(-1);
  assert.equal(refused.payload.stage, 'save', 'the refusal names the save stage');
});

test('a failed delivery log deletes the frame instead of leaving it behind', async (t) => {
  const app = await fixture(t);
  const data = Buffer.from('PNGDATA-LOG-FAILS');
  let shotFile = '';
  state.capture = async ({ dir }) => {
    state.captures += 1;
    await mkdir(dir, { recursive: true });
    shotFile = join(dir, `${randomUUID()}.png`);
    await writeFile(shotFile, data);
    return { file: shotFile, bytes: data.length, width: 320, height: 200, engine: 'fake' };
  };
  const emit = EventLog.prototype.emit;
  t.mock.method(EventLog.prototype, 'emit', async function (type, ...args) {
    if (type === 'vision.delivered') throw new Error('event log unavailable');
    return emit.call(this, type, ...args);
  });

  const { value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.match(value.reason, /交付日志写入失败/);
  const exists = await readFile(shotFile).then(() => true, () => false);
  const status = (await app.call('assistant_vision', { action: 'status' })).value;
  t.diagnostic(`delivery-log-failure: ${basename(shotFile)} exists=${exists}; lastShot=${JSON.stringify(status.lastShot)}`);
  assert.equal(exists, false);
  assert.equal(status.lastShot, null);
  const refused = (await app.events()).filter((event) => event.type === 'vision.delivery.refused').at(-1);
  assert.equal(refused.payload.stage, 'delivery-log');
});

test('unknown model metadata is rejected before capture and never renders an image', async (t) => {
  const app = await fixture(t, { modalities: null });
  app.captureWith(Buffer.from('PNGDATA-UNKNOWN-MODALITIES'));

  const { tool, value } = await app.call('assistant_see', {});
  assert.equal(value.ok, false);
  assert.equal(state.captures, 0);
  assert.deepEqual(app.render(tool, value).map((block) => block.type), ['text']);

  const events = await app.events();
  assert.ok(events.some((event) => event.type === 'vision.capability.unknown-rejected'));
  assert.equal(events.some((event) => event.type === 'vision.delivered'), false);
});
