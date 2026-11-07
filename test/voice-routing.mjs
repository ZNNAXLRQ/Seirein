/**
 * Voice routing regression: a voice utterance always enters the dated Seirein session in
 * `<root>/workspace`, never the GUI session that happens to be focused. Page presence is not
 * a routing input, so an attached page and a detached page must resolve the same target.
 *
 * Run: node --test test/voice-routing.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { apply, dayStampFor, voiceSessionTarget } from '../src/host/index.js';

/** A generic instance root; the live one comes from the runtime context. */
const ROOT = resolve('D:\\Projects\\dsh-assistant');
const WORKSPACE = join(ROOT, 'workspace');

/** The browser session the user is typing in: the default workspace, NOT the voice target. */
const GUI_SESSION = {
  sessionId: 'session-test-default-workspace',
  cwd: resolve('C:\\Users\\user\\Documents\\deepseek-harness\\default-workspace'),
};

test('GUI online: voice targets the dated session under <root>/workspace, not the browser session', () => {
  const target = voiceSessionTarget({ root: ROOT, guiOnline: true });
  assert.match(target.sessionId, /^seirein-\d{4}-\d{2}-\d{2}$/u);
  assert.equal(target.sessionId, dayStampFor(new Date()).sessionId, 'today\'s dated session');
  assert.equal(target.cwd, WORKSPACE);
  assert.notEqual(target.sessionId, GUI_SESSION.sessionId);
  assert.notEqual(target.cwd, GUI_SESSION.cwd);
});

test('GUI offline resolves exactly the same target', () => {
  const online = voiceSessionTarget({ root: ROOT, guiOnline: true });
  const offline = voiceSessionTarget({ root: ROOT, guiOnline: false });
  assert.deepEqual(offline, online);
  assert.equal(offline.cwd, WORKSPACE);
  assert.notEqual(offline.sessionId, GUI_SESSION.sessionId);
});

test('the 04:00 day boundary decides the session id', () => {
  const before = dayStampFor(new Date(2026, 10, 5, 2, 0, 0), 4);
  const after = dayStampFor(new Date(2026, 10, 5, 4, 0, 0), 4);
  assert.equal(before.sessionId, 'seirein-2026-11-04');
  assert.equal(after.sessionId, 'seirein-2026-11-05');
  assert.equal(
    voiceSessionTarget({ root: ROOT, now: new Date(2026, 10, 5, 2, 0, 0) }).sessionId,
    'seirein-2026-11-04',
  );
});

test('the host routes voice through voiceSessionTarget and no longer queues it to the composer', async () => {
  const source = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.ok(
    /voiceSessionTarget\(\{ root, rolloverHour: ROLLOVER_HOUR \}\)/u.test(source),
    'the delivery target comes from voiceSessionTarget',
  );
  assert.ok(
    /sessionId,\s*cwd:\s*target\.cwd,/u.test(source),
    'ensureSession is called with the target sessionId and workspace cwd',
  );
  // The page heartbeat must no longer be routing state for voice.
  assert.ok(!/lastClientSeen/u.test(source), 'no heartbeat-based lane switch remains');
  assert.ok(!/pendingVoice\.push\(\{ text/u.test(source), 'voice is never queued for the composer');
});

/** Mount the plugin against a temp root and capture the settings routes it registers. */
function mountWithRoutes(root) {
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    inject: (_deps, register) => {
      register({
        effect,
        systemPrompt: { section: () => () => {} },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    },
  };
  apply(ctx, { root, enabled: true });
  const call = async (toolName, args = {}, exec = {}) => {
    const tool = tools.get(toolName);
    assert.ok(tool !== undefined, `tool registered: ${toolName}`);
    return tool.execute(args, exec);
  };
  const status = async () => {
    const handler = routes.get('/assistant/status');
    assert.ok(handler !== undefined, 'status route registered');
    return new Promise((resolveStatus, rejectStatus) => {
      const res = {
        writeHead() {},
        end(body) {
          try {
            resolveStatus(JSON.parse(body));
          } catch (error) {
            rejectStatus(error);
          }
        },
      };
      Promise.resolve(handler({}, res)).catch(rejectStatus);
    });
  };
  return {
    call,
    status,
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('workspaceScope defaults to enabled at <root>/workspace and blocks other workspaces', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-scope-'));
  const app = mountWithRoutes(root);
  t.after(async () => {
    // Disposers close the SQLite stores (memory, resource vault) before the temp root is removed;
    // otherwise Windows reports EBUSY on `memory/profile.db`.
    app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // Warm the memory store first. MemoryStore.migrate() probes every `memory/*.db` — including
  // `profile.db` — and its throw path does not close the probe handle, so a vault created earlier
  // would stay locked past cleanup. With memory opened first the vault does not exist yet and is
  // closed by its own disposer.
  const inScope = await app.call('assistant_remember', { text: '作用域内的记忆' }, {
    agent: { session: { header: { cwd: join(root, 'workspace') } } },
  });
  assert.ok(typeof inScope.id === 'string' && inScope.id.length > 0, 'in-scope write succeeds');
  assert.equal(inScope.domain, 'chat');

  const state = await app.status();
  assert.equal(state.workspaceScope.enabled, true, 'scope is on without a saved setting');
  assert.equal(state.workspaceScope.path, join(root, 'workspace'));
  assert.deepEqual(state.hotkeys.map((row) => row.action), ['mic', 'vision', 'layerEdit', 'ambient']);

  const outside = await app.call('assistant_remember', { text: '默认工作区的记忆' }, {
    agent: { session: { header: { cwd: GUI_SESSION.cwd } } },
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.error, '当前工作区不在 Seirein 作用域内');
});
