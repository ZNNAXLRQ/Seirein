/**
 * 共享词库 v1（手动管理）验收。
 *
 * Covers the user's v1 request, not the deferred v2 recall/injection work:
 *   1. manual add without speakerId → confirmed + assigned, category/usage/reading/library;
 *   2. category text bound / length / library validation, duplicate key → exists;
 *   3. update keeps status, move changes only library, remove deletes;
 *   4. `/word` quoted + whitespace parsing, incomplete arguments never guessed, result carries
 *      the editable entry id;
 *   5. automatic candidate extraction is OFF by default and only writes candidates when
 *      `config.lexicon.autoCandidates === true`.
 *
 * Run: node --test test/lexicon-manual.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupRoot, disposeAll } from './helpers/cleanup.mjs';
import {
  LEXICON_CATEGORIES,
  LEXICON_CATEGORY_MAX_CHARS,
  LEXICON_DEFAULT_LIBRARY,
  LEXICON_LIBRARIES,
  LEXICON_READING_MAX_CHARS,
  LEXICON_TEXT_MAX_CHARS,
  LEXICON_USAGE_MAX_CHARS,
  createLexiconStore,
} from '../src/host/speech/lexicon-store.js';
import {
  createWordCommandDefinition,
  parseWordCommand,
} from '../src/host/hearing/settings-actions.js';

const T0 = '2026-11-10T10:00:00+08:00';
const T1 = '2026-11-10T10:05:00+08:00';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seirein-lexicon-manual-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function collectingLog() {
  const events = [];
  return {
    events,
    emit(event, payload) {
      events.push({ event, ...payload });
      return Promise.resolve();
    },
    of(event) {
      return events.filter((item) => item.event === event);
    },
  };
}

const readLexicon = (root) => JSON.parse(readFileSync(join(root, 'data', 'lexicon.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Store-level tests
// ---------------------------------------------------------------------------

test('1. 无 speakerId 手动添加：直接 confirmed/assigned，字段完整并落盘', (t) => {
  const root = tempRoot(t);
  const clock = () => new Date(T1);
  const log = collectingLog();
  const store = createLexiconStore({ root, log, clock });

  const result = store.addEntry({
    text: '  充电  ',
    category: 'expression',
    usage: '指陪我聊一会，不是给设备充电',
    reading: 'chōng diàn',
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.id, 'lex-1');
  assert.equal(result.entry.status, 'confirmed');
  assert.equal(result.entry.assigned, true);
  assert.equal(result.entry.speakerId, null);
  assert.equal(result.entry.text, '充电');
  assert.equal(result.entry.canonical, '充电');
  assert.equal(result.entry.category, 'expression');
  assert.equal(result.entry.usage, '指陪我聊一会，不是给设备充电');
  assert.equal(result.entry.reading, 'chōng diàn');
  assert.equal(result.entry.library, LEXICON_DEFAULT_LIBRARY);
  assert.equal(result.entry.confirmedAt, new Date(T1).toISOString());
  assert.deepEqual(store.listConfirmed().map((entry) => entry.text), ['充电']);

  const persisted = readLexicon(root).entries[0];
  assert.equal(persisted.status, 'confirmed');
  assert.equal(persisted.assigned, true);
  assert.equal(persisted.speakerId, null);
  assert.equal(persisted.category, 'expression');
  assert.equal(persisted.usage, '指陪我聊一会，不是给设备充电');
  assert.equal(persisted.reading, 'chōng diàn');
  assert.equal(persisted.library, 'public');
  assert.deepEqual(LEXICON_CATEGORIES, [
    'person', 'character', 'work', 'place', 'term', 'expression', 'meme', 'unknown',
  ]);
  assert.deepEqual([...LEXICON_LIBRARIES], ['public', 'voiceprint']);
  assert.deepEqual(log.of('lexicon.store.changed').map((item) => item.op), ['add']);

  // reading is optional and defaults to the empty string
  const minimal = store.addEntry({ text: '向晚', category: 'person', usage: '' });
  assert.equal(minimal.ok, true);
  assert.equal(minimal.entry.reading, '');
  assert.equal(minimal.entry.usage, '');
  assert.equal(minimal.entry.library, 'public');

  console.log('[1] added=', JSON.stringify(result.entry), 'list=', JSON.stringify(store.listConfirmed().map((entry) => entry.text)));
});

test('2. 类别文本/长度/库位校验；重复 key 返回 exists 且不覆盖', (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });

  assert.deepEqual(store.addEntry({ text: '', category: 'person' }), { ok: false, reason: 'text-required' });
  assert.deepEqual(store.addEntry({ text: 'x'.repeat(LEXICON_TEXT_MAX_CHARS + 1), category: 'person' }), { ok: false, reason: 'text-too-long' });
  assert.deepEqual(store.addEntry({
    text: '甲',
    category: '类'.repeat(LEXICON_CATEGORY_MAX_CHARS + 1),
  }), { ok: false, reason: 'invalid-category' });
  assert.deepEqual(store.addEntry({ text: '甲', category: 42 }), { ok: false, reason: 'invalid-category' });
  assert.deepEqual(store.addEntry({ text: '甲', category: 'person', usage: 'x'.repeat(LEXICON_USAGE_MAX_CHARS + 1) }), { ok: false, reason: 'invalid-usage' });
  assert.deepEqual(store.addEntry({ text: '甲', category: 'person', reading: 'x'.repeat(LEXICON_READING_MAX_CHARS + 1) }), { ok: false, reason: 'invalid-reading' });
  assert.deepEqual(store.addEntry({ text: '甲', category: 'person', library: 'private' }), { ok: false, reason: 'invalid-library' });
  assert.deepEqual(store.addEntry({ text: '甲', category: 'person', usage: 42 }), { ok: false, reason: 'invalid-usage' });
  assert.equal(store.list().length, 0, 'every refused add wrote nothing');

  const first = store.addEntry({ text: 'Seirein', category: 'term', usage: '项目名' });
  assert.equal(first.ok, true);
  const duplicate = store.addEntry({ text: '  seirein ', category: 'term', usage: '重复' });
  assert.deepEqual(duplicate, { ok: false, reason: 'exists' }, 'normalized duplicate key is refused');
  assert.equal(store.listConfirmed().length, 1);
  assert.equal(store.listConfirmed()[0].usage, '项目名', 'the existing row was not merged/overwritten');

  const custom = store.addEntry({ text: '奶茶', category: '  饮品  ' });
  assert.equal(custom.ok, true);
  assert.equal(custom.entry.category, '饮品', 'a non-empty arbitrary category is stored (trimmed)');
  assert.equal(store.listConfirmed().length, 2);

  console.log('[2] validation=ok duplicate=', JSON.stringify(duplicate),
    'customCategory=', JSON.stringify(custom.entry.category), 'rows=', store.listConfirmed().length);
});

test('3. update 只改字段不改 status；move 只改库位与归属；remove 真删除', (t) => {
  const root = tempRoot(t);
  const clock = () => new Date(T1);
  const store = createLexiconStore({ root, clock, selfId: 'self-1' });
  const added = store.addEntry({ text: '充电', category: 'expression', usage: '旧用法' });
  const id = added.entry.id;

  const updated = store.updateEntry({
    id,
    canonical: '充电宝',
    category: 'term',
    usage: '便携电源',
    reading: 'chōng diàn bǎo',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.entry.status, 'confirmed', 'update never changes status');
  assert.equal(updated.entry.assigned, true);
  assert.equal(updated.entry.canonical, '充电宝');
  assert.equal(updated.entry.text, '充电宝');
  assert.equal(updated.entry.category, 'term');
  assert.equal(updated.entry.usage, '便携电源');
  assert.equal(updated.entry.reading, 'chōng diàn bǎo');
  assert.notEqual(updated.entry.editedAt, '');

  // Category-only update leaves text/usage untouched and keeps status.
  const categoryOnly = store.updateEntry({ id, category: 'work' });
  assert.equal(categoryOnly.ok, true);
  assert.equal(categoryOnly.entry.text, '充电宝');
  assert.equal(categoryOnly.entry.usage, '便携电源');
  assert.equal(categoryOnly.entry.status, 'confirmed');

  assert.deepEqual(store.updateEntry({ id, category: '类'.repeat(LEXICON_CATEGORY_MAX_CHARS + 1) }), { ok: false, reason: 'invalid-category' });
  assert.deepEqual(store.updateEntry({ id, category: 42 }), { ok: false, reason: 'invalid-category' });
  const customCategory = store.updateEntry({ id, category: '  自定义  ' });
  assert.equal(customCategory.ok, true);
  assert.equal(customCategory.entry.category, '自定义', 'an arbitrary category update is accepted');
  assert.deepEqual(store.updateEntry({ id, canonical: '' }), { ok: false, reason: 'text-required' });
  assert.deepEqual(store.updateEntry({ id, reading: 42 }), { ok: false, reason: 'invalid-reading' });
  assert.deepEqual(store.updateEntry({ id: 'lex-99', category: 'person' }), { ok: false, reason: 'not-found' });
  assert.deepEqual(store.updateEntry({ id }), { ok: false, reason: 'no-editable-field' });
  assert.deepEqual(store.updateEntry({ category: 'person' }), { ok: false, reason: 'id-required' });

  // An update on a candidate still does not confirm/reject it.
  store.mergeCandidates([{ text: '候选词', kind: 'proper-noun', at: T0 }]);
  const candidateRow = store.listCandidates().find((entry) => entry.text === '候选词');
  assert.equal(candidateRow.status, 'candidate');
  const candidateUpdated = store.updateEntry({ id: candidateRow.id, category: 'term' });
  assert.equal(candidateUpdated.ok, true);
  assert.equal(candidateUpdated.entry.status, 'candidate', 'updating a candidate never confirms it');

  const other = store.addEntry({ text: '向晚', category: 'person' });
  assert.equal(other.ok, true);
  assert.deepEqual(store.updateEntry({ id, canonical: '向晚' }), { ok: false, reason: 'exists' },
    'renaming onto another key is refused');
  assert.equal(store.listConfirmed().find((entry) => entry.id === id).text, '充电宝');

  const moved = store.moveEntry({ id, library: 'voiceprint' });
  assert.equal(moved.ok, true);
  assert.equal(moved.entry.library, 'voiceprint');
  assert.equal(moved.entry.status, 'confirmed');
  assert.equal(moved.entry.speakerId, 'self-1', 'voiceprint ownership is the confirmed self');
  assert.deepEqual(store.moveEntry({ id, library: 'private' }), { ok: false, reason: 'invalid-library' });
  assert.deepEqual(store.moveEntry({ id }), { ok: false, reason: 'invalid-library' });
  assert.deepEqual(store.moveEntry({ id: 'lex-99', library: 'public' }), { ok: false, reason: 'not-found' });

  // Moving back to public clears the owner: the word is shared again and no stale speaker filter
  // can hide it from another self.
  const back = store.moveEntry({ id, library: 'public' });
  assert.equal(back.ok, true);
  assert.equal(back.entry.library, 'public');
  assert.equal(back.entry.speakerId, null);

  const removed = store.remove({ id });
  assert.equal(removed.ok, true);
  assert.deepEqual(store.listConfirmed().map((entry) => entry.text), ['向晚']);
  assert.deepEqual(store.remove({ id }), { ok: false, reason: 'not-found' });

  console.log('[3] updated=', JSON.stringify(updated.entry), 'moved=', moved.entry.library, 'remaining=', JSON.stringify(store.listConfirmed().map((entry) => entry.text)));
});

test('4. /word：引号/空格/参数不全；类别可自定义；成功结果带 ID', async (t) => {
  const root = tempRoot(t);
  const store = createLexiconStore({ root });
  const log = collectingLog();
  const command = createWordCommandDefinition({ store, log });
  assert.equal(command.name, 'word');
  assert.equal(typeof command.handler, 'function');

  const parsedQuoted = parseWordCommand('"充电" 特殊表达 "指陪我聊一会，不是给设备充电"');
  assert.deepEqual(parsedQuoted, {
    ok: true,
    value: {
      text: '充电',
      category: 'expression',
      usage: '指陪我聊一会，不是给设备充电',
      reading: '',
    },
  });

  const success = await command.handler({
    rawInput: '"充电" 特殊表达 "指陪我聊一会，不是给设备充电"',
  });
  assert.equal(success.kind, 'success');
  assert.match(success.text, /ID lex-1/u, 'the command names the editable entry id');
  const saved = store.listConfirmed()[0];
  assert.equal(saved.id, 'lex-1');
  assert.equal(saved.category, 'expression');
  assert.equal(saved.usage, '指陪我聊一会，不是给设备充电');
  assert.equal(saved.library, 'public');

  const unquoted = await command.handler({ rawInput: '向晚 人名 角色名' });
  assert.equal(unquoted.kind, 'success');
  assert.equal(store.listConfirmed().find((entry) => entry.text === '向晚').usage, '角色名');

  const withReading = await command.handler({ rawInput: '"Seirein" term "项目名" "se-i-rein"' });
  assert.equal(withReading.kind, 'success');
  assert.equal(store.listConfirmed().find((entry) => entry.text === 'Seirein').reading, 'se-i-rein');

  const parsedCustom = parseWordCommand('奶茶 饮品 "指奶茶"');
  assert.equal(parsedCustom.ok, true);
  assert.equal(parsedCustom.value.category, '饮品', 'an arbitrary category is accepted by /word');
  const customCategory = await command.handler({ rawInput: '奶茶 饮品 "指奶茶"' });
  assert.equal(customCategory.kind, 'success');
  assert.equal(store.listConfirmed().find((entry) => entry.text === '奶茶').category, '饮品');

  const duplicate = await command.handler({ rawInput: '充电 expression "重复添加"' });
  assert.equal(duplicate.kind, 'error');
  assert.match(duplicate.text, /已存在/u);
  assert.match(duplicate.text, /lex-1/u);

  for (const [input, pattern] of [
    ['', /缺少词、类别和用法/u],
    ['充电', /缺少类别/u],
    ['充电 特殊表达', /缺少用法说明/u],
    ['充电 特殊表达 "未闭合', /引号没有闭合/u],
    ['充电 特殊表达 "用法" 读音 多余', /参数过多/u],
  ]) {
    const parsed = parseWordCommand(input);
    assert.equal(parsed.ok, false, `incomplete/invalid input is refused: ${JSON.stringify(input)}`);
    assert.match(parsed.error, pattern);
    const result = await command.handler({ rawInput: input });
    assert.equal(result.kind, 'error');
    assert.match(result.text, pattern);
  }

  const longCategory = '类'.repeat(LEXICON_CATEGORY_MAX_CHARS + 1);
  const longCategoryResult = await command.handler({ rawInput: `奶茶 ${longCategory} "用法"` });
  assert.equal(longCategoryResult.kind, 'error');
  assert.match(longCategoryResult.text, /类别最多/u);
  assert.equal(store.listConfirmed().length, 4, 'refused commands wrote nothing');

  console.log('[4] quoted=', JSON.stringify(parsedQuoted), 'success=', JSON.stringify(success.text), 'rows=', JSON.stringify(store.listConfirmed().map((entry) => [entry.text, entry.category, entry.usage])));
});

// ---------------------------------------------------------------------------
// Host wiring: auto candidates default OFF, explicit opt-in still works
// ---------------------------------------------------------------------------

const state = { onUpdate: null };
globalThis.__lexiconManual = state;

const hearingUrl = new URL('../src/host/hearing/hearing.js', import.meta.url).href;
const sightUrl = new URL('../src/host/vision/sight.js', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, next) {
    if (url === hearingUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
    const s = globalThis.__lexiconManual;
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
after(() => { delete globalThis.__lexiconManual; });

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function newHostRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexicon-manual-'));
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

async function mount(root, { autoCandidates = false } = {}) {
  state.onUpdate = null;
  const cleanups = [];
  const tools = new Map();
  const routes = new Map();
  const services = new Map([
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }],
    ['workspaceRegistry', {
      async create(path) { return { id: 'ws-lexicon-manual', path }; },
      get() { return { id: 'ws-lexicon-manual', async attachSession() {} }; },
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
  }, {
    root,
    enabled: true,
    asrMergeWindowMs: 10,
    ...(autoCandidates ? { lexicon: { autoCandidates: true } } : {}),
  });

  const listen = tools.get('assistant_listen');
  assert.ok(listen !== undefined, 'assistant_listen is registered');
  const started = await listen.execute({ action: 'start' });
  assert.equal(started.ok, true, `synthetic microphone started: ${started.error ?? ''}`);
  assert.equal(typeof state.onUpdate, 'function');

  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.equal(typeof handler, 'function');
    let result;
    await handler(
      Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      { writeHead() {}, end(value) { result = JSON.parse(value); } },
    );
    return result;
  };
  const waitFor = async (check, message, timeoutMs = 3000) => {
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
    waitFor,
    say: (text, meta = {}) => state.onUpdate({ final: text, durationMs: 100, ...meta }),
    list: () => action({ action: 'lexicon.list' }),
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

test('5. 自动候选默认不新增；显式 autoCandidates=true 才新增；历史候选不受影响', async (t) => {
  // Default: a delivered transcript produces no candidate and no lexicon file.
  const defaultRoot = await newHostRoot();
  const defaultHost = await mount(defaultRoot);
  t.after(async () => { await defaultHost.close(); await cleanupRoot(defaultRoot); });
  defaultHost.say('向晚来了，向晚走了。');
  await tick(150);
  assert.deepEqual(await defaultHost.list(), { ok: true, entries: [], unassigned: [], candidates: [] });
  assert.equal(await fileExists(join(defaultRoot, 'data', 'lexicon.json')), false,
    'automatic extraction is off by default, so nothing is written');
  await defaultHost.close();

  // Explicit opt-in preserves the old candidate behaviour.
  const optInRoot = await newHostRoot();
  const optInHost = await mount(optInRoot, { autoCandidates: true });
  t.after(async () => { await optInHost.close(); await cleanupRoot(optInRoot); });
  optInHost.say('向晚来了，向晚走了。');
  const candidate = await optInHost.waitFor(
    async () => (await optInHost.list()).candidates.find((entry) => entry.text === '向晚'),
    'candidate 向晚 with autoCandidates=true',
  );
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.assigned, false);

  // Remount the same root with extraction back at its default: the historical candidate remains,
  // but a new repeat form is not added.
  await optInHost.close();
  const historyHost = await mount(optInRoot);
  t.after(async () => { await historyHost.close(); await cleanupRoot(optInRoot); });
  historyHost.say('Seirein 很好用。Seirein 真不错。');
  await tick(150);
  const listed = await historyHost.list();
  assert.deepEqual(listed.candidates.map((entry) => entry.text), ['向晚'],
    'the historical candidate remains, but no new one is added after opt-in is removed (new mount)');

  console.log('[5] default-no-file=', true, 'optin-candidate=', JSON.stringify(candidate.text),
    'listed=', JSON.stringify(listed.candidates.map((entry) => [entry.text, entry.status])));
});
