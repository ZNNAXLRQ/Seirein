/**
 * 个人语言库（stage B3）宿主接线。
 *
 * The host owns one `createLexiconStore({ root })` (`data/lexicon.json`) and exposes six settings
 * actions. Voice delivery feeds a rolling window of delivered transcripts into
 * `extractLexiconCandidates`, but the transcript itself is never rewritten and nothing is
 * auto-confirmed:
 *
 *   1. `lexicon.list` answers the documented `{ok:true, entries, unassigned, candidates}` contract;
 *      confirm/edit/reject/remove pass through the store and the persisted `data/lexicon.json`
 *      reflects every step;
 *   2. a delivered transcript produces CANDIDATES: an explicit form correction from a confirmed
 *      speaker is `assigned` and STILL visible in `unassigned` (with `assigned:true`), the same
 *      correction without a confirmed identity and every ordinary transcript stays unassigned;
 *   3. a fact correction (「不是周五，是周六」) never enters the lexicon and writes no file;
 *   4. a second Host mount over the same root reads the stored entries back (restart);
 *   5. `/assistant/status` exposes `lexicon.speakerId` from `voice.selfSpeakerId`, falling back to
 *      a speaker-shadow match and then to null, with the source labelled;
 *   6. regression: the candidate/correction semantics and the confirmed `wrongForms→canonical`
 *      hints are unchanged, and the six action names are registered.
 *
 * A synthetic microphone (registerHooks stub) feeds `onUpdate` exactly like the real capture loop;
 * no sound, TTS, model or GUI is used.
 *
 * Run: node --test test/lexicon-host-wiring.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import { ACTIONS } from '../src/host/hearing/settings-actions.js';
import {
  applyCorrection,
  extractLexiconCandidates,
  parseExplicitCorrection,
} from '../src/host/speech/lexicon-candidates.js';
import { createLexiconStore, lexiconHints } from '../src/host/speech/lexicon-store.js';

const state = { onUpdate: null, onEvent: null };
globalThis.__lexiconHost = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      // Synthetic microphone: `startHearing` captures the real `onUpdate` the host installed.
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__lexiconHost;
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
      // Never probe/start real capture for a lexicon test.
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
after(() => { delete globalThis.__lexiconHost; });

// ---------------------------------------------------------------------------
// Mounted host: real apply(), synthetic microphone, real /assistant/action route
// ---------------------------------------------------------------------------

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-host-'));
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
      async create(path) { return { id: 'ws-lexicon-host', path }; },
      get() { return { id: 'ws-lexicon-host', async attachSession() {} }; },
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

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function', 'the action route is registered');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
  };
  const events = async () => {
    try {
      const text = await readFile(join(root, 'data', 'events.jsonl'), 'utf8');
      return text.trim().split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.equal(typeof handler, 'function', 'the status route is registered');
    let result = '';
    await handler({ method: 'GET', url: '/assistant/status' }, {
      writeHead() {},
      end(value) { result = value; },
    });
    return JSON.parse(result);
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
    action,
    events,
    status,
    waitFor,
    /** Feed one delivered transcript through the real merge/flush path. */
    say: (text, meta = {}) => state.onUpdate({ final: text, durationMs: 100, ...meta }),
    latestCandidates: async () => (await action({ action: 'lexicon.candidates' })).candidates ?? [],
    list: async () => action({ action: 'lexicon.list' }),
    close: () => disposeAll(cleanups.splice(0)),
  };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const readLexicon = async (root) => JSON.parse(await readFile(join(root, 'data', 'lexicon.json'), 'utf8'));

// 1 ---------------------------------------------------------------------------

test('1. lexicon.list 初始为空；confirm/edit/reject/remove 生效并落盘', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  const initial = await host.list();
  assert.deepEqual(initial, { ok: true, entries: [], unassigned: [], candidates: [] });
  for (const field of ['entries', 'unassigned', 'candidates']) {
    assert.ok(Array.isArray(initial[field]), `lexicon.list returns an array for ${field}`);
  }

  // Two mentions in one delivered transcript reach the extractor's default threshold.
  host.say('向晚来了，向晚走了。');
  const candidate = await host.waitFor(
    async () => (await host.latestCandidates()).find((entry) => entry.text === '向晚'),
    'candidate 向晚',
  );
  assert.equal(candidate.kind, 'proper-noun');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.assigned, false);
  assert.deepEqual((await host.latestCandidates()).map((entry) => entry.text), ['向晚']);

  // The new list contract keeps pending rows in both the visible area and `candidates`.
  const pending = await host.list();
  assert.deepEqual(pending.unassigned.map((entry) => [entry.text, entry.assigned]), [['向晚', false]]);
  assert.deepEqual(pending.candidates.map((entry) => [entry.text, entry.assigned]), [['向晚', false]]);

  const confirmed = await host.action({
    action: 'lexicon.confirm', text: '向晚', speakerId: 'spk-1', canonical: '向晚',
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.entry.id, candidate.id);
  assert.equal(confirmed.entry.status, 'confirmed');
  assert.equal(confirmed.entry.assigned, true);
  assert.deepEqual((await host.list()).entries.map((entry) => entry.text), ['向晚']);
  assert.deepEqual((await host.list()).unassigned, []);
  let saved = await readLexicon(root);
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].status, 'confirmed');
  assert.equal(saved.entries[0].canonical, '向晚');
  assert.equal(saved.entries[0].speakerId, 'spk-1');

  const edited = await host.action({
    action: 'lexicon.edit',
    id: candidate.id,
    canonical: '向晚晚',
    wrongForms: ['小满', '小蛮', ' 小满 '],
    context: { before: '叫', after: '来' },
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.entry.canonical, '向晚晚');
  assert.deepEqual(edited.entry.wrongForms, ['小满', '小蛮']);
  assert.deepEqual(edited.entry.context, { before: '叫', after: '来' });
  assert.ok(typeof edited.entry.editedAt === 'string' && edited.entry.editedAt.length > 0);
  saved = await readLexicon(root);
  assert.equal(saved.entries[0].canonical, '向晚晚');

  // A second candidate: reject keeps it as a tombstone on disk, not in the lists.
  host.say('Seirein 真好用。Seirein 太棒了。');
  await host.waitFor(
    async () => (await host.latestCandidates()).some((entry) => entry.text === 'Seirein'),
    'candidate Seirein',
  );
  const rejected = await host.action({ action: 'lexicon.reject', text: 'Seirein' });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.entry.status, 'rejected');
  assert.deepEqual((await host.latestCandidates()).map((entry) => entry.text), []);
  saved = await readLexicon(root);
  assert.equal(saved.entries.find((entry) => entry.text === 'Seirein').status, 'rejected');

  const removed = await host.action({ action: 'lexicon.remove', id: candidate.id });
  assert.equal(removed.ok, true);
  assert.deepEqual(await host.list(), { ok: true, entries: [], unassigned: [], candidates: [] });
  saved = await readLexicon(root);
  assert.deepEqual(saved.entries.map((entry) => entry.text), ['Seirein']);
  assert.deepEqual(await host.action({ action: 'lexicon.remove', text: '向晚晚' }), { ok: false, reason: 'not-found' });

  const types = (await host.events()).map((event) => event.type);
  for (const type of ['lexicon.candidate.added', 'lexicon.confirmed', 'lexicon.edited', 'lexicon.rejected', 'lexicon.removed']) {
    assert.ok(types.includes(type), `event recorded: ${type}`);
  }
  const added = (await host.events()).find((event) => event.type === 'lexicon.candidate.added');
  assert.deepEqual(Object.keys(added.payload).sort(), ['assigned', 'id', 'kind']);
  assert.equal(added.payload.kind, 'proper-noun');
  assert.equal(added.payload.assigned, false);

  console.log('[1] ok=true arrays=entries,unassigned,candidates', 'empty=', JSON.stringify(initial), 'confirmed=', JSON.stringify(confirmed.entry), 'edited=', JSON.stringify(edited.entry), 'rejected=', JSON.stringify(rejected.entry.status), 'removed=', JSON.stringify(removed.entry.id), 'file=', JSON.stringify(saved.entries.map((entry) => [entry.text, entry.status])));
});

// 2 ---------------------------------------------------------------------------

test('2. 语音转写 → 候选；assigned 取决于已确认说话人；普通转写仍进未归属区', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  // A form correction from a CONFIRMED speaker: attributed, but still only a candidate.
  host.say('不是小满，是向晚', { speakerId: 'spk-1', speakerConfirmed: true });
  const correction = await host.waitFor(
    async () => (await host.latestCandidates()).find((entry) => entry.text === '向晚'),
    'form correction 向晚',
  );
  assert.equal(correction.kind, 'correction');
  assert.equal(correction.status, 'candidate');
  assert.equal(correction.assigned, true, 'a confirmed speaker attributes the correction candidate');
  assert.equal(correction.speakerId, 'spk-1');
  assert.deepEqual(correction.wrongForms, ['小满']);
  assert.deepEqual(correction.context, { before: '不是', after: '，是向晚' });

  // Repeating the same correction must not turn the WRONG form into a proper-noun candidate.
  host.say('不是小满，是向晚', { speakerId: 'spk-1', speakerConfirmed: true });
  await tick(80);
  assert.equal(
    (await host.latestCandidates()).some((entry) => entry.text === '小满'),
    false,
    'a correction sentence is not ordinary candidate evidence',
  );

  // The same shape without a confirmed identity: unassigned, not a personal word.
  host.say('不是小蛮，是林晚');
  const anonymous = await host.waitFor(
    async () => (await host.latestCandidates()).find((entry) => entry.text === '林晚'),
    'unconfirmed correction 林晚',
  );
  assert.equal(anonymous.kind, 'correction');
  assert.equal(anonymous.assigned, false);
  assert.equal(anonymous.speakerId, null);

  // An ordinary proper-noun transcript stays unassigned even with a confirmed speaker: a mention
  // is not proof that the word belongs to that person.
  host.say('Seirein 很好用，Seirein 真不错。', { speakerId: 'spk-1', speakerConfirmed: true });
  const proper = await host.waitFor(
    async () => (await host.latestCandidates()).find((entry) => entry.text === 'Seirein'),
    'proper noun Seirein',
  );
  assert.equal(proper.kind, 'proper-noun');
  assert.equal(proper.assigned, false);
  assert.equal(proper.speakerId, null);

  const listed = await host.list();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.entries, [], 'nothing is auto-confirmed');
  // Every pending candidate is visible in the list: the unassigned area keeps ordinary transcript
  // candidates, and the assigned-but-unconfirmed correction is included with `assigned:true`
  // instead of being reachable only through `lexicon.candidates`.
  assert.deepEqual(
    listed.unassigned.map((entry) => [entry.text, entry.assigned, entry.speakerId]).sort(),
    [['Seirein', false, null], ['林晚', false, null], ['向晚', true, 'spk-1']].sort(),
  );
  const assignedRow = listed.unassigned.find((entry) => entry.text === '向晚');
  assert.equal(assignedRow.assigned, true, 'an assigned candidate is marked assigned in the visible list');
  assert.equal(assignedRow.speakerId, 'spk-1');
  assert.deepEqual(
    listed.candidates.map((entry) => [entry.text, entry.assigned, entry.speakerId]).sort(),
    [['Seirein', false, null], ['林晚', false, null], ['向晚', true, 'spk-1']].sort(),
  );
  assert.deepEqual(
    (await host.latestCandidates()).map((entry) => [entry.text, entry.assigned, entry.speakerId]).sort(),
    [['Seirein', false, null], ['林晚', false, null], ['向晚', true, 'spk-1']].sort(),
  );

  const addedEvents = (await host.events()).filter((event) => event.type === 'lexicon.candidate.added');
  const assignedEvent = addedEvents.find((event) => event.payload.assigned === true);
  assert.ok(assignedEvent, 'an assigned correction emits candidate.added {assigned:true}');
  assert.deepEqual(Object.keys(assignedEvent.payload).sort(), ['assigned', 'id', 'kind']);
  assert.equal(assignedEvent.payload.kind, 'correction');

  console.log('[2] ok=', listed.ok, 'correction=', JSON.stringify([correction.text, correction.assigned, correction.speakerId]), 'anonymous=', JSON.stringify([anonymous.text, anonymous.assigned, anonymous.speakerId]), 'proper=', JSON.stringify([proper.text, proper.assigned, proper.speakerId]), 'entries=', listed.entries.length, 'unassigned=', JSON.stringify(listed.unassigned.map((entry) => [entry.text, entry.assigned])), 'candidates=', JSON.stringify((await host.latestCandidates()).map((entry) => [entry.text, entry.assigned, entry.speakerId])));
});

// 3 ---------------------------------------------------------------------------

test('3. 事实纠正（不是周五是周六）不入库，也不创建 lexicon.json', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  host.say('不是周五，是周六', { speakerId: 'spk-1', speakerConfirmed: true });
  host.say('不是3个，是4个', { speakerId: 'spk-1', speakerConfirmed: true });
  await tick(120);

  assert.deepEqual(await host.list(), { ok: true, entries: [], unassigned: [], candidates: [] });
  assert.deepEqual(await host.latestCandidates(), []);
  assert.equal(await fileExists(join(root, 'data', 'lexicon.json')), false, 'no candidate means no lexicon file');
  // The transcript itself is still logged (it was delivered); what must not exist is any lexicon
  // write: no candidate event and no store.changed row.
  const types = (await host.events()).map((event) => event.type);
  assert.equal(types.includes('lexicon.candidate.added'), false);
  assert.equal(types.includes('lexicon.store.changed'), false);
  assert.equal(types.some((type) => type.startsWith('lexicon.')), false, 'the fact never touches the lexicon lane');

  console.log('[3] candidates=', 0, 'entries=', 0, 'lexicon-file=', false, 'lexicon-events=', 0);
});

// 4 ---------------------------------------------------------------------------

test('4. 重启（同一 root 的第二个 Host 挂载）后条目仍在', async (t) => {
  const root = await newRoot();
  const first = await mount(root);
  first.say('向晚来了，向晚走了。');
  const candidate = await first.waitFor(
    async () => (await first.latestCandidates()).find((entry) => entry.text === '向晚'),
    'candidate 向晚',
  );
  const confirmed = await first.action({
    action: 'lexicon.confirm', id: candidate.id, speakerId: 'spk-1', canonical: '向晚',
  });
  assert.equal(confirmed.ok, true);
  await first.close();

  const second = await mount(root);
  t.after(async () => { await second.close(); await cleanupRoot(root); });
  const listed = await second.list();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].id, candidate.id);
  assert.equal(listed.entries[0].canonical, '向晚');
  assert.equal(listed.entries[0].speakerId, 'spk-1');
  assert.equal(listed.entries[0].status, 'confirmed');
  assert.deepEqual(listed.unassigned, []);

  // A fresh store over the same file agrees (the file is the state, not a cache).
  const store = createLexiconStore({ root });
  assert.deepEqual(store.listConfirmed().map((entry) => [entry.id, entry.canonical, entry.speakerId]), [[candidate.id, '向晚', 'spk-1']]);

  console.log('[4] restart-entry=', JSON.stringify(listed.entries[0]), 'fresh-store=', JSON.stringify(store.listConfirmed().map((entry) => entry.text)));
});

// 5 ---------------------------------------------------------------------------

test('5. status.lexicon：voice.selfSpeakerId 权威优先，其次声纹影子 match，否则 null', async (t) => {
  const root = await newRoot();
  const host = await mount(root);
  t.after(async () => { await host.close(); await cleanupRoot(root); });

  const writeVoice = async (voice) => {
    const file = join(root, 'data', 'settings.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, `${JSON.stringify({ ...saved, voice }, null, 2)}\n`);
  };

  let status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: null, source: null },
    'no registration and no matched shadow -> no guessed identity');

  // An explicit `voice.selfSpeakerId` (the user or a later voiceprint registration writes it).
  await writeVoice({ chunking: false, selfSpeakerId: 'spk-self' });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: 'spk-self', source: 'setting' });
  assert.equal(status.lexicon.speakerId, 'spk-self');

  await writeVoice({ chunking: false });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: null, source: null },
    'clearing the setting falls back: no matched shadow means null');

  // The shadow is only a fallback: a `match` verdict supplies its speakerId, `unsure` does not.
  assert.equal(typeof state.onEvent, 'function', 'the hearing session exposes onEvent');
  state.onEvent('speaker.shadow', { decision: 'match', score: 0.91, speakerId: 'spk-shadow' });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: 'spk-shadow', source: 'shadow' });

  // An explicit registration always wins over the shadow.
  await writeVoice({ chunking: false, selfSpeakerId: 'spk-self' });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: 'spk-self', source: 'setting' });

  // Blank / non-string registrations are not an identity and fall back to the shadow (or null).
  await writeVoice({ chunking: false, selfSpeakerId: '   ' });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: 'spk-shadow', source: 'shadow' },
    'a blank registration does not shadow the fallback');

  state.onEvent('speaker.shadow', { decision: 'unsure', score: 0.4, speakerId: 'spk-shadow' });
  status = await host.status();
  assert.deepEqual(status.lexicon, { speakerId: null, source: null },
    'an unsure verdict is not an identity');

  console.log('[5] setting=', JSON.stringify({ speakerId: 'spk-self', source: 'setting' }),
    'shadow=', JSON.stringify({ speakerId: 'spk-shadow', source: 'shadow' }),
    'none=', JSON.stringify({ speakerId: null, source: null }));
});

// 6 ---------------------------------------------------------------------------

test('6. 回归：候选/纠正语义、confirmed 提示形状、六个动作已注册', async () => {
  for (const action of [
    'lexicon.list', 'lexicon.candidates', 'lexicon.confirm',
    'lexicon.edit', 'lexicon.reject', 'lexicon.remove',
  ]) {
    assert.ok(ACTIONS.includes(action), `action registered: ${action}`);
  }

  const fact = parseExplicitCorrection('不是周五，是周六');
  assert.equal(fact.kind, 'fact-correction');
  assert.equal(fact.ignored, true);
  assert.deepEqual(extractLexiconCandidates({ corrections: [{ ...fact, speakerId: 'spk-1' }] }), []);

  const form = parseExplicitCorrection('不是小满，是向晚');
  const [formCandidate] = extractLexiconCandidates({ corrections: [{ ...form, speakerId: 'spk-1' }] });
  assert.equal(formCandidate.kind, 'correction');
  assert.equal(formCandidate.assigned, true);
  assert.deepEqual(formCandidate.wrongForms, ['小满']);

  // Hints expose wrongForms→canonical data; only a correction WITH context is replaceable.
  const hints = lexiconHints([
    { id: 'lex-1', text: '向晚', canonical: '向晚', kind: 'correction', status: 'confirmed', wrongForms: ['小满'], context: { before: '叫', after: '来' } },
    { id: 'lex-2', text: 'GPT4', canonical: 'GPT-4', kind: 'proper-noun', status: 'confirmed', wrongForms: ['GPT4'], context: null },
    { id: 'lex-3', text: 'x', canonical: '', kind: 'proper-noun', status: 'candidate', wrongForms: ['y'], context: null },
  ]);
  assert.deepEqual(hints.map((hint) => [hint.id, hint.kind, hint.canonical, hint.wrongForms, hint.replaceable]), [
    ['lex-1', 'correction', '向晚', ['小满'], true],
    ['lex-2', 'proper-noun', 'GPT-4', ['GPT4'], false],
  ]);
  assert.equal(applyCorrection('她叫小满来了', hints[0]).changed, true);
  assert.equal(applyCorrection('小满今天很开心', hints[0]).changed, false, 'no global replacement');
  assert.equal(applyCorrection('GPT4 是模型', hints[1]).reason, 'context-required');

  console.log('[6] actions=', 6, 'fact-candidate=', 0, 'form=', JSON.stringify([formCandidate.text, formCandidate.assigned, formCandidate.wrongForms]), 'hints=', JSON.stringify(hints.map((hint) => [hint.kind, hint.replaceable])));
});
