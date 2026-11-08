/**
 * 个人语言库 stage B4 — ASR 后处理闭环。
 *
 * The user's fixed rules (2026-11-08/09):
 *   - only CONFIRMED lexicon entries take effect; a candidate never does;
 *   - a `proper-noun` rule replaces WHOLE words only (never a substring of a longer word);
 *   - a `correction` rule needs its stored context (before/after) to still match; without a
 *     context there is deliberately no replacement;
 *   - the raw ASR result is never rewritten: only the text used for delivery/subtitles changes,
 *     and the archive row keeps the raw text;
 *   - no hit → the delivered text is byte-for-byte identical;
 *   - work is bounded (one scan per confirmed entry) and UTF-16 safe (an emoji is never split);
 *   - fail-open: a throwing lexicon store never blocks delivery.
 *
 * A synthetic microphone (registerHooks stub) feeds `onUpdate` exactly like the real capture loop,
 * so the delivery point is exercised end to end; no sound, TTS, model or GUI is used.
 *
 * Run: node --test test/lexicon-asr.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { createLexiconStore, applyLexiconHints, applyLexiconText, lexiconHints } from '../src/host/speech/lexicon-store.js';

// ---------------------------------------------------------------------------
// Pure rule helpers (items 1–5)
// ---------------------------------------------------------------------------

/** One confirmed entry view, shaped like `listConfirmed()` output. */
function entry({ id = 'lex-1', text = '小满', canonical = '向晚', kind = 'proper-noun', wrongForms = ['小满'], context = null, status = 'confirmed' }) {
  return { id, text, canonical, kind, wrongForms, context, status, assigned: true, speakerId: 'spk-1' };
}

/** The production hint builder: only confirmed rows survive. */
const hintsOf = (...entries) => lexiconHints(entries);

/** Debug event sink that records exactly what the wrapper emits. */
function recorder() {
  const events = [];
  return {
    events,
    log: { emit: (type, payload) => events.push({ type, payload }) },
  };
}

const show = (value) => JSON.stringify(value);

// 1 ---------------------------------------------------------------------------

test('1. proper-noun：整词命中「小满→向晚」；小满子串不替换', () => {
  const hints = hintsOf(entry({ wrongForms: ['小满'], canonical: '向晚' }));
  assert.equal(hints.length, 1);

  const whole = applyLexiconHints('小满来了，我叫小满。', hints);
  assert.equal(whole.text, '向晚来了，我叫向晚。');
  assert.deepEqual(whole.applied.map((hit) => [hit.from, hit.to]), [['小满', '向晚'], ['小满', '向晚']]);

  // A longer Han word treated as one token by ICU: 小满子 is NOT the bare name 小满.
  const partial = applyLexiconHints('小满子来了，这是小满子。', hints);
  assert.equal(partial.text, '小满子来了，这是小满子。');
  assert.deepEqual(partial.applied, []);

  // A Latin neighbour is a partial token too, in both directions.
  const latin = hintsOf(entry({ canonical: 'GPT-4', wrongForms: ['GPT4'] }));
  assert.equal(applyLexiconHints('GPT4 是模型', latin).text, 'GPT-4 是模型');
  assert.equal(applyLexiconHints('GPT4x 不存在', latin).text, 'GPT4x 不存在');
  assert.equal(applyLexiconHints('xGPT4 不存在', latin).text, 'xGPT4 不存在');

  console.log('[1] whole=', show(whole.text), 'partial=', show(partial.text), 'latin=', show('GPT4 是模型→GPT-4 是模型'));
});

// 2 ---------------------------------------------------------------------------

test('2. correction：带 context 且上下文命中才替换；无 context / 上下文不符不替换', () => {
  const withContext = hintsOf(entry({
    kind: 'correction',
    canonical: '向晚',
    wrongForms: ['小满'],
    context: { before: '叫', after: '来' },
  }));
  const hit = applyLexiconHints('她叫小满来了', withContext);
  assert.equal(hit.text, '她叫向晚来了');
  assert.deepEqual(hit.applied.map((item) => item.kind), ['correction']);

  // Same wrong form, but the stored context is not around it.
  assert.equal(applyLexiconHints('小满今天很开心', withContext).text, '小满今天很开心');
  assert.equal(applyLexiconHints('她叫小满走了', withContext).text, '她叫小满走了');

  // A correction row WITHOUT context is refused (no global find/replace).
  const noContext = hintsOf(entry({ kind: 'correction', wrongForms: ['小满'], context: null }));
  const refused = applyLexiconHints('她叫小满来了', noContext);
  assert.equal(refused.text, '她叫小满来了');
  assert.deepEqual(refused.applied, []);

  console.log('[2] hit=', show(hit.text), 'miss=', show('小满今天很开心'), 'no-context=', show(refused.text));
});

// 3 ---------------------------------------------------------------------------

test('3. 候选（未确认）不生效：只有 confirmed 词条参与', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-asr-cand-'));
  t.after(() => cleanupRoot(root));
  const store = createLexiconStore({ root });

  // A correction candidate carries wrongForms/context, but it is NOT a personal word yet.
  const merged = store.mergeCandidates([{
    text: '向晚',
    kind: 'correction',
    wrongForms: ['小满'],
    context: { before: '叫', after: '来' },
    speakerId: 'spk-1',
  }]);
  assert.equal(merged.added, 1);
  assert.deepEqual(store.listConfirmed(), []);
  assert.equal(applyLexiconText('她叫小满来了', { store }), '她叫小满来了');

  // The user's explicit confirm is the only thing that activates the rule.
  const candidate = store.listCandidates()[0];
  assert.equal(store.confirm({ id: candidate.id, speakerId: 'spk-1' }).ok, true);
  assert.equal(store.listConfirmed().length, 1);
  assert.equal(applyLexiconText('她叫小满来了', { store }), '她叫向晚来了');

  console.log('[3] candidate=', show('她叫小满来了'), 'confirmed=', show('她叫向晚来了'),
    'confirmedRows=', store.listConfirmed().length);
});

// 4 ---------------------------------------------------------------------------

test('4. 无命中时原文逐字不变（含 emoji/标点），命中也不切坏 emoji', () => {
  const hints = hintsOf(entry({ wrongForms: ['小满'], canonical: '向晚' }));
  const untouched = '😀🎉，今天没有命中！！…？！';
  const same = applyLexiconHints(untouched, hints);
  assert.equal(same.text, untouched);
  assert.equal(same.applied.length, 0);
  assert.equal(same.scans, 1);

  // Delimiters around a real hit: the emoji stays whole and the text is only locally rewritten.
  const emoji = applyLexiconHints('😀小满😀好', hints);
  assert.equal(emoji.text, '😀向晚😀好');
  assert.equal([...emoji.text].length, 5);
  assert.equal(emoji.text.isWellFormed(), true);

  console.log('[4] identical=', same.text === untouched, 'text=', show(same.text),
    'emojiHit=', show(emoji.text), 'wellFormed=', emoji.text.isWellFormed());
});

// 5 ---------------------------------------------------------------------------

test('5. 多个词条的最长匹配优先；扫描次数 ≤ 已确认词条数', () => {
  const hints = hintsOf(
    entry({ id: 'lex-1', canonical: 'X', wrongForms: ['小满'] }),
    entry({ id: 'lex-2', canonical: 'Y', wrongForms: ['小满子'] }),
  );
  const result = applyLexiconHints('小满子来了', hints);
  assert.equal(result.text, 'Y来了', 'the longer 小满子 rule wins over 小满');
  assert.deepEqual(result.applied.map((hit) => [hit.id, hit.from, hit.to]), [['lex-2', '小满子', 'Y']]);
  assert.ok(result.scans <= hints.length, `scans ${result.scans} <= confirmed entries ${hints.length}`);

  // Non-overlapping hits from different entries both apply, longest first at one position.
  const mixed = hintsOf(
    entry({ id: 'lex-3', canonical: '向晚', wrongForms: ['小满'] }),
    entry({ id: 'lex-4', canonical: 'GPT-4', wrongForms: ['GPT4'] }),
  );
  const both = applyLexiconHints('小满说 GPT4 好用', mixed);
  assert.equal(both.text, '向晚说 GPT-4 好用');
  assert.deepEqual(both.applied.map((hit) => hit.id), ['lex-3', 'lex-4']);
  assert.equal(both.scans, 2);

  console.log('[5] longest=', show(result.text), 'scans=', result.scans,
    'both=', show(both.text));
});

// 6 ---------------------------------------------------------------------------

test('6. fail-open：store 抛错时投递文本不变，只记录失败事件', () => {
  const { events, log } = recorder();
  const brokenStore = { listConfirmed() { throw new Error('lexicon unavailable'); } };
  const text = '小满来了，😀';
  const delivered = applyLexiconText(text, { store: brokenStore, log, utteranceId: 'inst-1:9' });
  assert.equal(delivered, text, 'delivery text is unchanged when the store throws');
  assert.deepEqual(events, [{
    type: 'lexicon.apply.failed',
    payload: { utteranceId: 'inst-1:9', error: 'lexicon unavailable' },
  }]);

  // An absent store is also benign (the lexicon feature may be off).
  assert.equal(applyLexiconText(text, { store: null }), text);

  console.log('[6] delivered=', show(delivered), 'unchanged=', delivered === text,
    'events=', show(events.map((event) => event.type)));
});

// ---------------------------------------------------------------------------
// Mounted host: real apply(), synthetic microphone, real delivery/flush path (item 7)
// ---------------------------------------------------------------------------

const state = { onUpdate: null, onEvent: null };
globalThis.__lexiconAsr = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__lexiconAsr;
    export const modelReady = () => true;
    export const finalModelReady = () => false;
    export const isLoopbackDevice = (name) => /CABLE|Stereo Mix|Virtual/i.test(String(name));
    export const listDevices = async () => ['Fake Mic'];
    export const startHearing = (options) => {
      s.onUpdate = options.onUpdate;
      s.onEvent = options.onEvent;
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
    export function readObservation(o, { now = Date.now(), ttlMs = 30000 } = {}) {
      const v = o ?? {}; const c = Number(v.capturedAt); const s = Number.isFinite(c) && c > 0 ? c : Number(v.at);
      const at = Number.isFinite(s) && s > 0 ? s : null; const ageMs = at === null ? null : Math.max(0, now - at);
      return { ...v, at, ageMs, stale: at === null || ageMs >= ttlMs };
    }`,
      };
    }
    return next(url, context);
  },
});
const { apply } = await import('../src/host/index.js');
hooks.deregister();
after(() => { delete globalThis.__lexiconAsr; });

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-asr-'));
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

/** Seed the real store file with one confirmed word (candidate rows would NOT apply). */
async function seedLexicon(root) {
  const confirmed = {
    id: 'lex-1',
    key: '小满',
    text: '小满',
    canonical: '向晚',
    wrongForms: ['小满'],
    kind: 'proper-noun',
    status: 'confirmed',
    speakerId: 'spk-1',
    assigned: true,
    context: null,
    sourceIds: [],
    ambiguous: false,
    at: '2026-11-08T09:00:00.000Z',
    confirmedAt: '2026-11-08T09:01:00.000Z',
    rejectedAt: '',
    editedAt: '',
  };
  await writeFile(join(root, 'data', 'lexicon.json'), JSON.stringify({
    version: 1,
    nextId: 2,
    entries: [confirmed],
  }, null, 2));
}

async function mount(root) {
  state.onUpdate = null;
  state.onEvent = null;
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['sessionTitle', { get: () => undefined, rename: (_session, title) => ({ title, source: { kind: 'user' } }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-lexicon-asr', path }; },
      get() { return { id: 'ws-lexicon-asr', async attachSession() {} }; },
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
    inject: (_deps, register) => register(scope),
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
    /** Feed one delivered transcript through the real merge/flush/delivery path. */
    say: (text, meta = {}) => state.onUpdate({ final: text, durationMs: 100, ...meta }),
    close: () => disposeAll(cleanups.splice(0)),
  };
}

// 7 ---------------------------------------------------------------------------

test('7. 闭环：已确认词条改投递文本，raw 原样保留，并发 lexicon.applied', async (t) => {
  const root = await newRoot();
  await seedLexicon(root);
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  host.say('小满来了', { utteranceId: 'inst-test:7' });
  const row = await host.waitFor(
    async () => (await host.events()).find((event) => event.type === 'voice.transcript'),
    'voice.transcript',
  );
  assert.equal(row.payload.text, '向晚来了', 'delivered/subtitle text uses the confirmed canonical');
  assert.equal(row.payload.rawText, '小满来了', 'the raw ASR result is preserved in the archive row');

  // The pre-refine ASR row also keeps the raw words: only the delivered copy was post-processed.
  const rawRow = (await host.events()).find((event) => event.type === 'hearing.utterance');
  assert.equal(rawRow.payload.text, '小满来了');

  const applied = await host.waitFor(
    async () => (await host.events()).find((event) => event.type === 'lexicon.applied'),
    'lexicon.applied',
  );
  assert.deepEqual(applied.payload, {
    utteranceId: 'inst-test:7',
    id: 'lex-1',
    from: '小满',
    to: '向晚',
    kind: 'proper-noun',
  });
  assert.ok(!('error' in applied.payload), 'the confirmed rule applied without a failure row');

  console.log('[7] delivered=', show(row.payload.text), 'raw=', show(row.payload.rawText),
    'event=', show(applied.payload));
});
