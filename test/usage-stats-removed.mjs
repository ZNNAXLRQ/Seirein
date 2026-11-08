/**
 * Usage/billing statistics are gone for good.
 *
 * The companion no longer keeps a token ledger, a price table, a `/assistant/usage` route or a
 * settings container for it. This test is the guard for that removal: it fails if any of those
 * surfaces come back. Memory capacity (`memory.usage()`) and the voice timing fields are a
 * different concept and must keep working.
 *
 * Run: node --test test/usage-stats-removed.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/host/index.js';
import { VOICE_LATENCY_FIELDS, VOICE_LATENCY_OPTIONAL_FIELDS } from '../src/host/session/delivery/dispatch.js';

const REMOVED_MODULES = ['usage.js', 'pricing.js'];

/** Mount the plugin on a temp root and collect the web routes it registers. */
function mount(root) {
  const routes = new Map();
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
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
  return {
    routes,
    get: (path) => new Promise((resolve, reject) => {
      const handler = routes.get(path);
      assert.ok(handler !== undefined, `route registered: ${path}`);
      const res = { writeHead() {}, end: (payload) => resolve(JSON.parse(payload)) };
      Promise.resolve(handler({ method: 'GET', url: path }, res)).catch(reject);
    }),
    act: (body) => new Promise((resolve, reject) => {
      const handler = routes.get('/assistant/action');
      assert.ok(handler !== undefined, '/assistant/action registered');
      const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
      const res = { writeHead() {}, end: (payload) => resolve(JSON.parse(payload)) };
      Promise.resolve(handler(req, res)).catch(reject);
    }),
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

test('the usage ledger and price table modules are deleted', async () => {
  for (const file of REMOVED_MODULES) {
    const exists = await readFile(new URL(`../src/host/${file}`, import.meta.url), 'utf8')
      .then(() => true, () => false);
    assert.equal(exists, false, `src/host/${file} must be gone`);
  }
});

test('the status object has no usage/billing field', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-usage-removed-'));
  const app = mount(root);
  t.after(async () => {
    app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  });

  const status = await app.get('/assistant/status');
  assert.equal(status.usage, undefined, 'status.usage is gone');
  const leaked = Object.keys(status).filter((key) => /usage|cost|pricing|billing/iu.test(key));
  assert.deepEqual(leaked, [], 'no usage/cost/pricing/billing key anywhere in status');

  // The route and the two settings actions are gone with it.
  assert.equal(app.routes.has('/assistant/usage'), false, '/assistant/usage is not registered');
  for (const action of ['usage.export', 'usage.refresh']) {
    const result = await app.act({ action });
    assert.equal(result.ok, false, `${action} is no longer an action`);
  }

  // Not a billing concept: memory capacity and the voice timing fields stay.
  assert.ok(status.memory?.usage !== undefined, 'memory.usage is preserved');
  assert.equal(typeof status.memory.usage.capacity, 'number', 'memory capacity is preserved');
  assert.equal(typeof status.memory.usage.records, 'number', 'memory records are preserved');
  assert.ok(status.profile?.capacity !== undefined, 'profile capacity is preserved');
  assert.ok(status.voiceLatency !== undefined, 'voice latency is preserved');
  assert.deepEqual(status.voiceLatency.fields, VOICE_LATENCY_FIELDS);
  assert.ok(VOICE_LATENCY_OPTIONAL_FIELDS.length > 0, 'the first-sentence timing fields survive');
});

test('the settings page has no usage/billing container left', async () => {
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const banned of [
    '助手流水', '流水明细', '计价', '费用', '缓存读',
    'usageData', 'usageOpen', 'loadUsage', '/assistant/usage', 'usage.export',
    'fmtMoney', 'fmtMinutes',
    'inputTokens', 'outputTokens', 'totalTokens', 'cacheRead', 'cacheWrite',
  ]) {
    assert.equal(client.includes(banned), false, `client.js must not contain ${banned}`);
  }
  // The rest of the settings page still renders: memory, profile and vision cards are present.
  assert.ok(client.includes('记忆'), 'memory card is still rendered');
  assert.ok(client.includes('人设库'), 'profile card is still rendered');
  assert.ok(client.includes('视觉与感知'), 'vision card is still rendered');
});

test('the host keeps model context limits and drops the ledger wiring', async () => {
  const host = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
  assert.ok(host.includes('maxTokens'), 'maxTokens (context window) is preserved');
  assert.equal(/assistantUsage|DeepSeekPricing|pricing\.json/u.test(host), false,
    'no usage ledger or price table wiring in the host');
  assert.equal(host.includes("'/assistant/usage'"), false, 'the usage route is not declared in the host');
});
