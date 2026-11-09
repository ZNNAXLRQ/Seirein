/**
 * 个人语言库 — 语音 ASR 的 recall + plan 替换接线（stage B5）。
 *
 * The confirmed exact hints (`applyLexiconText`) stay the first pass. Only the VOICE ASR lane
 * then runs `recallLexiconCandidates` + `planLexiconCorrection` + `applyLexiconPlan` for a
 * high-confidence, unique near-miss/reading that the exact pass cannot see:
 *
 *   - high-confidence unique match → delivered/subtitle text is replaced;
 *   - ambiguity / low score / negation / factual form → no replacement;
 *   - the raw ASR copy is never rewritten (`rawText` + `hearing.utterance` keep it);
 *   - a word already rewritten by the exact pass is never replaced a second time;
 *   - the typed/text lane (`applyLexiconText` callers) never gets phonetic replacement;
 *   - `lexicon.replacement` / `lexicon.applied` carry entryId/from/to/reason/source, never the
 *     whole transcript, and a failing store never blocks delivery.
 *
 * Unit rows use a fake store (the helper only calls `listConfirmed()`); the last row mounts the
 * real plugin with a synthetic microphone so the real ASR delivery point is exercised.
 *
 * Run: node --test test/lexicon-replacement-host.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot } from './helpers/cleanup.mjs';
import { applyLexiconText } from '../src/host/speech/lexicon-store.js';

// ---------------------------------------------------------------------------
// Synthetic microphone + inert capture, then the real host module.
// ---------------------------------------------------------------------------

const state = { onUpdate: null };
globalThis.__lexiconReplacement = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__lexiconReplacement;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      return { device: options.device, stop() {}, stats: () => ({ rmsDb: -20 }) };
    };
    export const watchHearingExit = () => {};
    export const annotateTranscript = (text) => text;
    export const joinDetailFields = () => ({});
    export const mergeJoinFallback = () => ({});
    export const offlineLimitedNote = () => '';
    export const truncationNotice = () => '';`,
      };
    }
    if (url === sightUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const forbidden = () => { throw new Error('real capture forbidden'); };
    export const resolveFfmpeg = () => 'ffmpeg-fake';
    export const resolveFfplay = () => null;
    export const capture = forbidden, captureDesktop = forbidden, captureDevice = forbidden, startStoryboard = forbidden;
    export const OBSERVATION_TTL_MS = 30000;
    export function readObservation(o) {
      return { ...(o ?? {}), at: null, ageMs: null, stale: true };
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply, applyVoiceLexiconCorrection } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__lexiconReplacement; });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One confirmed-looking entry; the helper itself never filters on status. */
function entry({
  id = 'lex-1',
  text = '向晚',
  canonical = text,
  reading = '',
  wrongForms = [],
  kind = 'proper-noun',
  context = null,
} = {}) {
  return {
    id,
    key: text,
    text,
    canonical,
    reading,
    wrongForms: [...wrongForms],
    kind,
    category: 'person',
    usage: '',
    library: 'public',
    status: 'confirmed',
    context,
    ambiguous: false,
    speakerId: null,
    assigned: true,
    sourceIds: [],
    at: '2026-11-08T09:00:00.000Z',
    confirmedAt: '2026-11-08T09:01:00.000Z',
    rejectedAt: '',
    editedAt: '',
  };
}

/** The real helper only needs `listConfirmed()`; a fake keeps the unit rows pure. */
function fakeStore(entries) {
  return { listConfirmed: () => entries };
}

function recorder() {
  const events = [];
  return {
    events,
    log: { emit: (type, payload) => { events.push({ type, payload }); } },
  };
}

const show = (value) => JSON.stringify(value);

// 1 ---------------------------------------------------------------------------

test('1. 语音 ASR 高置信唯一：读音精确命中 → 交付文本替换，事件带字段', () => {
  const store = fakeStore([entry({ reading: 'xiangwan' })]);
  const { events, log } = recorder();
  const delivered = applyVoiceLexiconCorrection('xiangwan来了', {
    store, log, utteranceId: 'inst-1:1',
  });
  assert.equal(delivered, '向晚来了');

  const replacement = events.find((row) => row.type === 'lexicon.replacement');
  assert.ok(replacement !== undefined, 'lexicon.replacement is emitted');
  assert.deepEqual(replacement.payload, {
    utteranceId: 'inst-1:1',
    entryId: 'lex-1',
    from: 'xiangwan',
    to: '向晚',
    reason: 'reading:exact',
    source: 'asr-recall',
  });
  const applied = events.find((row) => row.type === 'lexicon.applied');
  assert.deepEqual(applied?.payload, replacement.payload, 'applied mirrors the replacement fields');

  console.log('[1] delivered=', show(delivered), 'event=', show(replacement.payload));
});

// 2 ---------------------------------------------------------------------------

test('2. 歧义不换：两个读音相同的已确认词条 → 原文不变、无替换事件', () => {
  const store = fakeStore([
    entry({ id: 'lex-1', text: '向晚', canonical: '向晚', reading: 'xiangwan' }),
    entry({ id: 'lex-2', text: '向婉', canonical: '向婉', reading: 'xiangwan' }),
  ]);
  const { events, log } = recorder();
  const delivered = applyVoiceLexiconCorrection('xiangwan来了', { store, log, utteranceId: 'u-2' });
  assert.equal(delivered, 'xiangwan来了');
  assert.deepEqual(events, []);

  console.log('[2] delivered=', show(delivered), 'events=', events.length);
});

// 3 ---------------------------------------------------------------------------

test('3. 文字输入不走同音替换；同一文本只有语音 ASR 包装器会替换', () => {
  const store = fakeStore([entry({ reading: 'xiangwan' })]);
  const { events, log } = recorder();
  // The existing text/tool lanes call applyLexiconText only; it has no recall stage.
  assert.equal(applyLexiconText('xiangwan来了', { store, log, utteranceId: 'typed-3' }), 'xiangwan来了');
  assert.deepEqual(events, [], 'the text lane emits no replacement events');
  assert.equal(
    applyVoiceLexiconCorrection('xiangwan来了', { store, log, utteranceId: 'asr-3' }),
    '向晚来了',
  );

  console.log('[3] typed=', show('xiangwan来了'), 'asr=', show('向晚来了'));
});

// 4 ---------------------------------------------------------------------------

test('4. 低分/否定/事实不换', () => {
  // Low score: a one-character miss on a 4-char canonical stays below CORRECTION_MIN_SCORE.
  const low = fakeStore([entry({ text: '星穹铁道', canonical: '星穹铁道' })]);
  const lowEvents = recorder();
  assert.equal(
    applyVoiceLexiconCorrection('星穹铁到', { store: low, log: lowEvents.log }),
    '星穹铁到',
  );
  assert.deepEqual(lowEvents.events, []);

  // Negation: the occurrence is quoted as the wrong side of an explicit correction.
  const negated = fakeStore([entry({ reading: 'xiangwan' })]);
  const negEvents = recorder();
  assert.equal(
    applyVoiceLexiconCorrection('不是xiangwan，是向晚', { store: negated, log: negEvents.log }),
    '不是xiangwan，是向晚',
  );
  assert.deepEqual(negEvents.events, []);

  // Factual form: a date-like confirmed canonical is never guessed into a statement.
  const factual = fakeStore([entry({ text: '周五', canonical: '周五', reading: 'zhouwu' })]);
  const factEvents = recorder();
  assert.equal(
    applyVoiceLexiconCorrection('zhouwu去开会', { store: factual, log: factEvents.log }),
    'zhouwu去开会',
  );
  assert.deepEqual(factEvents.events, []);
  assert.equal(applyLexiconText('zhouwu去开会', { store: factual }), 'zhouwu去开会');

  console.log('[4] low=', show('星穹铁到'), 'negation=', show('不是xiangwan，是向晚'),
    'fact=', show('zhouwu去开会'));
});

// 5 ---------------------------------------------------------------------------

test('5. 与已确认精确纠正不重复：精确已替换的词，plan 报告 already-canonical', () => {
  const store = fakeStore([entry({ wrongForms: ['小满'], reading: '' })]);
  const { events, log } = recorder();
  const delivered = applyVoiceLexiconCorrection('小满来了', { store, log, utteranceId: 'u-5' });
  assert.equal(delivered, '向晚来了');
  assert.equal([...delivered].filter((char) => char === '向').length, 1, 'one canonical only');

  const applied = events.filter((row) => row.type === 'lexicon.applied');
  assert.equal(applied.length, 1, 'exactly one applied row (the legacy exact hit)');
  assert.deepEqual(applied[0].payload, {
    utteranceId: 'u-5', id: 'lex-1', from: '小满', to: '向晚', kind: 'proper-noun',
  });
  assert.equal(events.filter((row) => row.type === 'lexicon.replacement').length, 0,
    'the plan did not rewrite the canonical again');

  console.log('[5] delivered=', show(delivered), 'appliedRows=', applied.length);
});

// 6 ---------------------------------------------------------------------------

test('6. store 抛错不阻断交付：保留精确纠正后的文本', () => {
  const broken = { listConfirmed() { throw new Error('lexicon unavailable'); } };
  const { events, log } = recorder();
  const text = 'xiangwan来了';
  assert.equal(applyVoiceLexiconCorrection(text, { store: broken, log, utteranceId: 'u-6' }), text);
  assert.equal(events.some((row) => row.type === 'lexicon.replacement.failed'), false);
  // The existing exact wrapper still reports its own failure row; delivery is unchanged.
  assert.equal(events.some((row) => row.type === 'lexicon.apply.failed'), true);

  console.log('[6] delivered=', show(text), 'events=', show(events.map((row) => row.type)));
});

// ---------------------------------------------------------------------------
// Mounted host: real apply(), synthetic microphone, real delivery point
// ---------------------------------------------------------------------------

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-replacement-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false, subtitle: false,
    avatar: false, memory: false, fastpath: false,
  }));
  await writeFile(join(root, 'data', 'settings.json'), JSON.stringify({
    gptSovits: { enabled: false },
    langs: { speech: 'zh', subtitle: 'zh' },
    autoMemory: { enabled: false },
    voice: { chunking: false },
  }));
  return root;
}

/** Seed the real store file with one confirmed reading-only entry (wrongForms deliberately empty). */
async function seedLexicon(root) {
  await writeFile(join(root, 'data', 'lexicon.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    entries: [entry({ reading: 'xiangwan' })],
  }, null, 2));
}

async function mount(root) {
  state.onUpdate = null;
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-lexicon-replacement', path }; },
      get() { return { id: 'ws-lexicon-replacement', async attachSession() {} }; },
    }],
  ]);
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  };
  const on = () => () => {};
  const scope = {
    effect,
    on,
    get: (serviceName) => services.get(serviceName),
    workspaceRegistry: services.get('workspaceRegistry'),
    systemPrompt: { section: () => () => {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  apply({
    effect,
    on,
    get: (serviceName) => services.get(serviceName),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_dependencies, register) => register(scope),
    webServer: { register: () => () => {} },
  }, { root, enabled: true, asrMergeWindowMs: 10 });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `synthetic microphone started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function', 'the hearing session exposes onUpdate');

  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const waitFor = async (check, message, timeoutMs = 4000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out: ${message}`);
      await tick(10);
    }
  };
  return {
    root,
    events,
    waitFor,
    say: (text, meta = {}) => state.onUpdate({ final: text, durationMs: 100, ...meta }),
    close: () => cleanupRoot(root, cleanups.splice(0)),
  };
}

// 7 ---------------------------------------------------------------------------

test('7. 宿主闭环：语音转写替换交付文本，原始 ASR 不变，事件形状正确', async (t) => {
  const root = await newRoot();
  await seedLexicon(root);
  const host = await mount(root);
  t.after(() => host.close());

  host.say('xiangwan来了', { utteranceId: 'inst-test:7' });
  const row = await host.waitFor(
    async () => (await host.events()).find((event) => event.type === 'voice.transcript'),
    'voice.transcript',
  );
  assert.equal(row.payload.text, '向晚来了', 'delivered/subtitle text uses the recalled canonical');
  assert.equal(row.payload.rawText, 'xiangwan来了', 'the raw ASR result is preserved');
  const rawRow = (await host.events()).find((event) => event.type === 'hearing.utterance');
  assert.equal(rawRow.payload.text, 'xiangwan来了', 'the pre-refine archive row keeps the ASR words');

  const replacement = await host.waitFor(
    async () => (await host.events()).find((event) => event.type === 'lexicon.replacement'),
    'lexicon.replacement',
  );
  assert.deepEqual(Object.keys(replacement.payload).sort(), [
    'entryId', 'from', 'reason', 'source', 'to', 'utteranceId',
  ]);
  assert.equal(replacement.payload.entryId, 'lex-1');
  assert.equal(replacement.payload.from, 'xiangwan');
  assert.equal(replacement.payload.to, '向晚');
  assert.equal(replacement.payload.reason, 'reading:exact');
  assert.equal(replacement.payload.source, 'asr-recall');
  assert.ok(!JSON.stringify(replacement.payload).includes('来了'), 'the event never carries the whole body');

  const applied = await host.waitFor(
    async () => (await host.events()).find((event) => event.type === 'lexicon.applied'),
    'lexicon.applied',
  );
  assert.deepEqual(applied.payload, replacement.payload);

  console.log('[7] delivered=', show(row.payload.text), 'raw=', show(row.payload.rawText),
    'event=', show(replacement.payload));
});
