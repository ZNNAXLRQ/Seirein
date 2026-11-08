/**
 * `instance.setRoot`（首次使用/换根）：
 *
 *   1. 合法绝对路径写入 instance.json（存的是父目录，数据根是 `<parent>/Seirein`），返回
 *      `{ok:true, applied:false, reason:'restart-required'}`，当前运行 root 不变；
 *   2. 写入后重新挂载（相当于重启）才采用新根；
 *   3. 空/相对/指向文件/无法创建（路径里夹着文件）一律拒绝，只返回原因码，不写 instance.json，
 *      错误里也不回显用户路径。
 *
 * Run: node --test test/instance-root.mjs
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply } from '../src/host/index.js';

// The instance file always lives in the OS default location; isolate it from the real profile.
const realLocalAppData = process.env.LOCALAPPDATA;
const instanceHome = await mkdtemp(join(tmpdir(), 'dsh-instance-home-'));
process.env.LOCALAPPDATA = instanceHome;
after(async () => {
  if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = realLocalAppData;
  await rm(instanceHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const instancePath = () => join(instanceHome, 'Seirein', 'instance.json');

/** Mount the real host with the settings routes. `useInstance` starts without config.root. */
async function mount(t, { root: requested = null, useInstance = false } = {}) {
  const tools = new Map();
  const routes = new Map();
  const disposers = [];
  const effect = (fn) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') disposers.push(cleanup);
    return cleanup;
  };
  const request = async (path, body) => {
    let status;
    let data;
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = body === undefined ? 'GET' : 'POST';
    req.url = path;
    await routes.get(path.split('?')[0])(req, {
      writeHead(code) { status = code; },
      end(value) { data = value; },
    });
    return { status, data };
  };

  const configured = useInstance ? null : (requested ?? await mkdtemp(join(tmpdir(), 'dsh-instance-root-')));
  apply({
    effect,
    get: () => undefined,
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    inject: (_dependencies, register) => register({
      effect,
      systemPrompt: { section: () => () => {} },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    }),
  }, useInstance ? { enabled: true } : { enabled: true, root: configured });
  // The instance-file mount reports its resolved root through status; clean that one up too.
  const root = useInstance
    ? JSON.parse((await request('/assistant/status')).data).root
    : configured;
  t.after(async () => {
    await cleanupRoot(root, disposers);
  });

  return {
    root,
    call: (name, args = {}) => tools.get(name).execute(args, {}),
    action: async (body) => JSON.parse((await request('/assistant/action', body)).data),
    status: async () => JSON.parse((await request('/assistant/status')).data),
  };
}

test('1. 合法路径写入 instance.json，返回 restart-required，运行中的 root 不变', async (t) => {
  const app = await mount(t);
  await rm(instancePath(), { force: true });
  const before = await app.status();
  const base = await mkdtemp(join(tmpdir(), 'dsh-instance-choice-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const chosen = join(base, 'chosen');

  const result = await app.action({ action: 'instance.setRoot', root: chosen });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.applied, false, '换根不在运行中应用');
  assert.equal(result.reason, 'restart-required');
  assert.equal(result.root, resolve(chosen), '返回值是持久化的父目录');
  assert.equal(result.dataRoot, join(resolve(chosen), 'Seirein'));

  const stored = JSON.parse(await readFile(instancePath(), 'utf8'));
  assert.equal(stored.root, resolve(chosen), 'instance.json 记录所选父目录');
  assert.equal(existsSync(join(chosen, 'Seirein')), true, '数据根目录已被创建/校验');

  const after = await app.status();
  assert.equal(after.root, before.root, '当前进程仍使用旧 root');
  assert.equal(after.root, app.root);
  assert.equal(after.firstRun, true, '首次使用状态也要等重启后才消失');

  t.diagnostic(`setRoot -> root=${result.root} dataRoot=${result.dataRoot} applied=${result.applied} reason=${result.reason} · running root=${after.root} unchanged`);
});

test('2. 写入后重新挂载才采用新根（重启生效）', async (t) => {
  const app = await mount(t);
  await rm(instancePath(), { force: true });
  const base = await mkdtemp(join(tmpdir(), 'dsh-instance-restart-'));
  const chosen = join(base, 'chosen');
  assert.equal((await app.action({ action: 'instance.setRoot', root: chosen })).ok, true);

  // A new mount without config.root resolves the instance file, exactly like the next start.
  const restarted = await mount(t, { useInstance: true });
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  assert.equal(restarted.root, join(resolve(chosen), 'Seirein'));
  assert.equal((await restarted.status()).root, join(resolve(chosen), 'Seirein'));

  t.diagnostic(`stored parent=${resolve(chosen)} -> restarted root=${restarted.root}`);
});

test('3. 非法路径只返回原因码，不写 instance.json，且不回显路径', async (t) => {
  const app = await mount(t);
  await rm(instancePath(), { force: true });
  const base = await mkdtemp(join(tmpdir(), 'dsh-instance-invalid-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const file = join(base, 'not-a-directory');
  await writeFile(file, 'x');

  const cases = [
    ['相对路径', 'relative/root', 'RELATIVE_ROOT'],
    ['空字符串', '', 'EMPTY_ROOT'],
    ['纯空白', '   ', 'EMPTY_ROOT'],
    ['非字符串', undefined, 'EMPTY_ROOT'],
    ['是文件', file, 'NOT_A_DIRECTORY'],
    ['路径中夹着文件', join(file, 'child'), 'NOT_WRITABLE'],
  ];
  for (const [label, root, expected] of cases) {
    const result = await app.action({ action: 'instance.setRoot', root });
    assert.equal(result.ok, false, `${label} 被拒绝`);
    assert.equal(result.code, expected, `${label} -> ${expected}`);
    assert.equal(result.error, expected, `${label} 只给原因码`);
    assert.equal(JSON.stringify(result).includes(base), false, `${label} 的错误不回显路径`);
    await assert.rejects(readFile(instancePath(), 'utf8'), `${label} 未写入 instance.json`);
  }

  // A null input is refused too, and nothing was ever created.
  assert.equal((await app.action({ action: 'instance.setRoot', root: null })).code, 'EMPTY_ROOT');
  t.diagnostic(`relative/empty/blank/file/inside-file -> ${cases.map((entry) => entry[2]).join(' / ')} · instance.json absent`);
});
