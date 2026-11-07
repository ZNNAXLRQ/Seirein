/**
 * Voice-session workspace regression: the dated voice session is created with the same
 * workspace metadata as a typed session (`meta.cwd = <root>/workspace`), is attached to the
 * registered workspace, and `/assistant/status` reports that stable workspace id instead of "".
 *
 * Run: node --test test/workspace-session.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { apply, voiceSessionTarget } from '../src/host/index.js';
import { ensureSession } from '../src/host/session/delivery/dispatch.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

function mount(root, disposers) {
  const workspacePath = join(root, 'workspace');
  const registered = [];
  const createdAgents = [];
  const attached = [];
  const tools = new Map();
  const routes = new Map();

  const registry = {
    async create(path, title) {
      registered.push({ path, title });
      return { id: 'ws-seirein-fixed', path, title };
    },
    get(id) {
      if (id !== 'ws-seirein-fixed') return undefined;
      return {
        id,
        path: workspacePath,
        async attachSession(sessionId) {
          attached.push(sessionId);
        },
      };
    },
  };
  const agentLoop = {
    async resume() {
      throw new Error('not persisted yet');
    },
    async createAgent(_ownerCtx, options) {
      createdAgents.push(options);
      return { agent: { id: options.sessionId } };
    },
  };
  const services = {
    agentLoop,
    workspaceRegistry: registry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
  };

  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const ctx = {
    effect,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get: (name) => services[name],
    inject: (deps, register) => {
      if (deps.includes('workspaceRegistry')) {
        register({ effect, workspaceRegistry: registry, get: ctx.get });
        return;
      }
      if (deps.includes('webServer')) {
        register({
          effect,
          webServer: {
            register(route) {
              routes.set(route.path, route.handler);
              return () => routes.delete(route.path);
            },
          },
        });
        return;
      }
      if (deps.includes('systemPrompt')) {
        register({ effect, systemPrompt: { section: () => () => {} } });
      }
    },
  };

  apply(ctx, { root, enabled: true });

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

  return { status, registry, registered, createdAgents, attached, workspacePath, getService: ctx.get, ctx };
}

test('voice session lands in <root>/workspace and keeps one stable workspace id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-session-'));
  // Disposers run first (closing stores, clearing timers), then the temp root is removed; a
  // discarded disposer used to leave `memory.db` locked and the root behind on Windows.
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));
  const app = mount(root, disposers);

  // The registration completes once the registry service is injected; status must already see it.
  const first = await app.status();
  assert.equal(app.registered.length, 1, 'the workspace directory is registered once');
  assert.equal(resolve(app.registered[0].path), resolve(app.workspacePath));
  assert.equal(first.workspace.path, app.workspacePath);
  assert.ok(typeof first.workspace.id === 'string' && first.workspace.id.length > 0, 'status.workspace.id is not empty');
  assert.equal(first.workspace.id, 'ws-seirein-fixed', 'the id comes from the registry, not a random value');

  // Exactly the voice path's target: today's dated session, cwd under <root>/workspace.
  const target = voiceSessionTarget({ root });
  assert.equal(resolve(target.cwd), resolve(join(root, 'workspace')));

  const session = await ensureSession({
    sessionId: target.sessionId,
    cwd: target.cwd,
    workspaceId: first.workspace.id,
    ownerCtx: app.ctx,
    getService: app.getService,
  });
  assert.equal(session.ok, true);
  assert.equal(session.created, true);
  assert.equal(app.createdAgents.length, 1);
  assert.equal(resolve(app.createdAgents[0].meta.cwd), resolve(join(root, 'workspace')));
  assert.equal(app.createdAgents[0].sessionId, target.sessionId);
  assert.deepEqual(app.attached, [target.sessionId], 'the session is attached to the workspace like a typed one');

  const second = await app.status();
  const third = await app.status();
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(third.workspace.id, first.workspace.id);
  assert.equal(third.workspace.id.length > 0, true);
});
