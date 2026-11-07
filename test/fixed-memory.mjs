/**
 * 固定记忆 (formerly 长期资源) — naming, prompt contract and voice add/delete path.
 *
 * The vault is model-driven: the model chooses `assistant_resource_set` /
 * `assistant_resource_forget` from the system-prompt convention and the tool descriptions.
 * These tests therefore (a) assert the user-facing copy, (b) parse the tool names out of the
 * actual convention text and then execute that path against the real tools, and (c) prove a
 * normal preference stays out of the vault.
 *
 * Run: node --test test/fixed-memory.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';

const { DatabaseSync } = await import('node:sqlite');
const { MemoryStore } = await import('../src/host/memory/store.js');

const CLIENT_SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const HOST_SOURCE = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
const STATUS_SOURCE = await readFile(new URL('../src/host/runtime/http/status.js', import.meta.url), 'utf8');
const MEMORY_ACTION_SOURCE = await readFile(new URL('../src/host/memory/settings-actions.js', import.meta.url), 'utf8');
const RESOURCES_SOURCE = await readFile(new URL('../src/host/memory/resources.js', import.meta.url), 'utf8');

const SEMANTICS = [
  '固定记忆：用户明确要求长期保留的内容，每轮注入上下文',
  '普通记忆：由对话自动沉淀，按相关性/重要性/时间召回',
];

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-fixed-memory-'));
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** Mount the real plugin: capture prompt sections, tools and the calls this test makes. */
function mount(root) {
  const sections = new Map();
  const tools = new Map();
  const calls = [];
  const cleanups = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const fakeContext = {
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
        systemPrompt: {
          section(definition) {
            sections.set(definition.name, definition);
            return () => {};
          },
        },
        webServer: { register: () => () => {} },
      });
    },
  };
  apply(fakeContext, { root, enabled: true });
  const context = { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
  const render = (name) => sections.get(name)?.text(context) ?? '';
  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    assert.ok(tool !== undefined, `tool registered: ${name}`);
    calls.push(name);
    return tool.execute(args, {});
  };
  return {
    call,
    calls,
    tools,
    render,
    convention: () => render('assistant:memory-convention'),
    fixedIndex: () => render('assistant:resources'),
    close: () => {
      for (const fn of cleanups.reverse()) fn();
    },
  };
}

const readEvents = async (root) => {
  try {
    return (await readFile(join(root, 'data', 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

/** Poll for one async event: a prompt render emits fire-and-forget, never inside the request. */
const waitForEvent = async (root, type) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const hit = (await readEvents(root)).find((event) => event.type === type);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
};

// ---- 1. settings page copy renamed, user-facing 资源 wording gone -------------------------

test('1. 设置页文案：无「长期资源」，固定记忆入口齐全', async (t) => {
  const root = await tempRoot();
  t.after(() => cleanup(root));

  assert.ok(!CLIENT_SOURCE.includes('长期资源'), 'client.js has no 长期资源');
  for (const legacy of ['新增资源', '还没有资源', '删除资源', '编辑资源', '开源资源查询地点']) {
    assert.ok(!CLIENT_SOURCE.includes(legacy), `legacy copy removed: ${legacy}`);
  }
  for (const copy of [
    '＋ 新增固定记忆',
    '还没有固定记忆。',
    '编辑固定记忆：',
    '新增固定记忆（也可以直接对 agent 说「把这条固定下来」）',
    '删除固定记忆「',
    '固定记忆已保存',
    '固定记忆已删除',
  ]) {
    assert.ok(CLIENT_SOURCE.includes(copy), `settings copy present: ${copy}`);
  }
  for (const line of SEMANTICS) assert.ok(CLIENT_SOURCE.includes(line), `semantics in settings: ${line}`);
  const hint = CLIENT_SOURCE.split('\n').find((line) => line.includes('以后一直这样'));
  assert.ok(hint !== undefined && hint.includes('删掉那条固定记忆'), 'settings hint explains voice add/delete');
  console.log('1) settings copy: 固定记忆 only, add/delete + semantics present');
});

// ---- 2. tool descriptions carry the fixed-vs-normal semantics and the write rule ---------

test('2. 工具描述：仅用户明确要求长期保留时写入 + 两种记忆语义', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  const set = mounted.tools.get('assistant_resource_set');
  const forget = mounted.tools.get('assistant_resource_forget');
  const list = mounted.tools.get('assistant_resource_list');
  assert.ok(set.description.includes('仅用户明确要求长期保留时写入'), 'set description has the write rule');
  for (const line of SEMANTICS) assert.ok(set.description.includes(line), `set description has semantics: ${line}`);
  assert.ok(set.description.includes('普通偏好'), 'set description excludes ordinary preferences');
  assert.ok(!HOST_SOURCE.includes('长期资源'), 'host prompt/tool copy has no 长期资源');
  for (const [name, tool] of [['set', set], ['forget', forget], ['list', list]]) {
    assert.ok(tool.description.includes('固定记忆'), `${name} description says 固定记忆`);
  }
  assert.ok(forget.description.includes('确认目标'), 'forget description requires target confirmation');
  assert.ok(forget.description.includes('assistant_resource_list'), 'forget description points at list first');
  console.log('2) tool descriptions: semantics + explicit-only write rule + confirm-before-delete');
});

// ---- 3. voice add: "以后一直这样记住" → the tool named in the prompt is resource_set ----

test('3. 语音新增：以后一直这样记住 → assistant_resource_set', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  const addLine = mounted.convention().split('\n').find((line) => line.includes('以后一直这样'));
  assert.ok(addLine !== undefined, 'convention has the explicit-retention example');
  const routeTool = addLine.match(/assistant_resource_[a-z]+/u)?.[0];
  assert.equal(routeTool, 'assistant_resource_set', 'the convention routes the phrase to resource_set');

  const saved = await mounted.call(routeTool, {
    key: 'anime.source',
    value: '动画资料从 Bangumi 查：https://bgm.tv',
    kind: 'source',
    title: '动画信息源',
    tags: 'anime',
  });
  assert.equal(saved.ok, true, 'fixed memory saved');
  const index = mounted.fixedIndex();
  assert.ok(index.includes('固定记忆'), 'prompt index is titled 固定记忆');
  assert.ok(index.includes('anime.source'), 'saved key is injected every turn');
  assert.ok((await readEvents(root)).some((event) => event.type === 'resource.set'), 'storage event unchanged');
  console.log('3) voice add: "以后一直这样" parsed route=assistant_resource_set, key=anime.source injected');
});

// ---- 4. voice delete: "删掉固定记忆 X" → list first, then forget the exact key -----------

test('4. 语音删除：删掉固定记忆 X → 先 list 再 forget，key 正确', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  await mounted.call('assistant_resource_set', { key: 'anime.source', value: 'Bangumi', title: '动画资料源' });
  await mounted.call('assistant_resource_set', { key: 'github.token', value: 'ghp_demo', title: 'GitHub 凭据' });

  const deleteLine = mounted.convention().split('\n').find((line) => line.includes('删掉那条固定记忆'));
  assert.ok(deleteLine !== undefined, 'convention has the delete example');
  const order = [...deleteLine.matchAll(/assistant_resource_[a-z]+/gu)].map((match) => match[0]);
  assert.deepEqual(order, ['assistant_resource_list', 'assistant_resource_forget'], 'delete path is list → forget');
  assert.ok(deleteLine.includes('不要猜 key'), 'ambiguous targets are asked about instead of guessed');

  // The user said "删掉固定记忆 动画资料": resolve the title through list, never a guessed key.
  const listed = await mounted.call(order[0], {});
  assert.equal(listed.count, 2);
  const target = listed.entries.find((entry) => entry.title.includes('动画资料'));
  assert.ok(target !== undefined, 'list resolves the spoken title to a key');
  assert.equal(target.key, 'anime.source');

  const removed = await mounted.call(order[1], { key: target.key });
  assert.equal(removed.removed, true, 'forget removes the listed key');
  assert.equal(removed.key, 'anime.source');
  const after = await mounted.call('assistant_resource_list', {});
  assert.deepEqual(after.entries.map((entry) => entry.key), ['github.token'], 'only the confirmed key was deleted');
  assert.deepEqual(mounted.calls.slice(-3), [
    'assistant_resource_list',
    'assistant_resource_forget',
    'assistant_resource_list',
  ], 'list runs before forget');
  console.log('4) voice delete: list → key=anime.source → forget; github.token kept');
});

// ---- 5. a normal preference never reaches the vault --------------------------------------

test('5. 普通偏好「我喜欢咖啡」不写入固定记忆', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  const convention = mounted.convention();
  const addLine = convention.split('\n').find((line) => line.includes('以后一直这样'));
  assert.ok(addLine.includes('普通偏好'), 'the add rule excludes ordinary preferences');
  assert.ok(addLine.includes('不要写入固定记忆'), 'the add rule forbids vaulting ordinary preferences');
  assert.ok(!addLine.includes('我喜欢'), 'the explicit-retention trigger does not cover ordinary preferences');
  assert.ok(
    convention.split('\n').some((line) => line.includes('assistant_remember') && line.includes('事实')),
    'ordinary durable facts route to assistant_remember',
  );

  // The model answers "我喜欢咖啡" through the ordinary-memory path only.
  const remembered = await mounted.call('assistant_remember', {
    text: '我喜欢咖啡',
    domain: 'chat',
    kind: 'preference',
  });
  assert.equal(remembered.domain, 'chat');
  assert.ok(!mounted.calls.includes('assistant_resource_set'), 'ordinary preference never calls resource_set');
  const fixed = await mounted.call('assistant_resource_list', {});
  assert.equal(fixed.count, 0, 'the fixed-memory vault stays empty');
  const events = await readEvents(root);
  assert.ok(!events.some((event) => event.type === 'resource.set'), 'no fixed-memory storage event');
  console.log('5) ordinary preference: assistant_remember only, fixed vault count=0, no resource.set');
});

// ---- 6. storage unchanged: same table/file/actions/tool names, no migration --------------

test('6. 存储未变：resource 表 / profile.db / resource.* 动作 / 无迁移', async (t) => {
  const root = await tempRoot();
  t.after(() => cleanup(root));

  // No rename or migration of the vault, either in code or in the schema file.
  assert.ok(RESOURCES_SOURCE.includes("join(root, 'memory', 'profile.db')"), 'vault file unchanged');
  assert.ok(RESOURCES_SOURCE.includes('CREATE TABLE IF NOT EXISTS resource'), 'table name unchanged');
  assert.ok(!/ALTER\s+TABLE\s+resource/iu.test(RESOURCES_SOURCE), 'no ALTER migration');
  assert.ok(!/RENAME\s+TO\s+resource/iu.test(RESOURCES_SOURCE), 'no table rename');
  assert.ok(!/migrat/iu.test(RESOURCES_SOURCE), 'no migration hook in the vault');

  // Public names stay resource-based even though the display name is 固定记忆.
  for (const name of ['assistant_resource_set', 'assistant_resource_get', 'assistant_resource_list', 'assistant_resource_forget']) {
    assert.ok(HOST_SOURCE.includes(`name: '${name}'`), `tool name unchanged: ${name}`);
  }
  assert.ok(STATUS_SOURCE.includes('resources: services.resources.list({})'), 'status key resources unchanged');
  for (const action of ['resource.set', 'resource.get', 'resource.delete']) {
    assert.ok(MEMORY_ACTION_SOURCE.includes(`case '${action}'`), `web action unchanged: ${action}`);
  }
  assert.ok(CLIENT_SOURCE.includes("action: 'resource.set'"), 'settings still writes through resource.set');
  assert.ok(CLIENT_SOURCE.includes("action: 'resource.delete'"), 'settings still deletes through resource.delete');
  assert.ok(CLIENT_SOURCE.includes('status.resources'), 'settings still reads status.resources');

  // Round-trip through a fresh mount proves the old database is read, not migrated or wiped.
  const first = mount(root);
  await first.call('assistant_resource_set', { key: 'anime.source', value: 'Bangumi', kind: 'source' });
  first.close();
  const second = mount(root);
  const listed = await second.call('assistant_resource_list', {});
  second.close();
  assert.deepEqual(listed.entries.map((entry) => entry.key), ['anime.source'], 'existing key survives a restart');

  const db = new DatabaseSync(join(root, 'memory', 'profile.db'));
  const columns = db.prepare('PRAGMA table_info(resource)').all().map((row) => row.name);
  db.close();
  assert.deepEqual(columns, ['id', 'key', 'kind', 'title', 'value', 'tags', 'secret', 'created_at', 'updated_at']);
  console.log('6) storage unchanged: memory/profile.db + resource table + resource.* actions, no migration');
});

// ---- 7. the fixed-memory CONTENT is injected, not just the index --------------------------

/** Body characters of one rendered `- key — title [tags]：body` line (0 for an index-only line). */
const bodyChars = (line) => {
  const at = line.indexOf('：');
  return at < 0 ? 0 : line.slice(at + 1).length;
};

test('7. 固定记忆内容注入：约定全文进入请求，secret 只给索引、无明文', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  const saved = await mounted.call('assistant_resource_set', {
    key: 'weekly.anime',
    value: '每周六晚上八点一起看动画，先由我选片',
    kind: 'convention',
    title: '共同约定',
    tags: 'anime',
  });
  assert.equal(saved.ok, true);

  // The vault's DPAPI write is environment-dependent, and the renderer only reads the `secret`
  // flag: a directly written secret row proves the plaintext can never leak into the prompt.
  const db = new DatabaseSync(join(root, 'memory', 'profile.db'));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO resource (id, key, kind, title, value, tags, secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('secret-demo', 'demo.credential', 'credential', '测试凭据', 'demo-password-123', '', 1, now, now);
  db.close();

  const index = mounted.fixedIndex();
  assert.ok(index.includes('每周六晚上八点一起看动画，先由我选片'), `the full convention text is injected: ${index}`);
  assert.ok(index.includes('weekly.anime') && index.includes('共同约定'), 'the index entry stays');
  assert.ok(index.includes('demo.credential'), 'a secret entry is still indexed by key');
  assert.ok(!index.includes('demo-password-123'), 'secret plaintext is never injected');
  assert.ok(index.includes('加密'), 'the secret is marked as encrypted/index-only');

  // The request-facing preview renders the same block, so the model sees the content too.
  const preview = await mounted.call('assistant_prompt_preview');
  assert.ok(preview.text.includes('每周六晚上八点一起看动画，先由我选片'), 'prompt preview carries the content');
  assert.ok(!preview.text.includes('demo-password-123'), 'prompt preview never carries secret plaintext');
  console.log(`7) content injected: "${index.split('\n').find((line) => line.includes('weekly.anime'))}", `
    + `secret key indexed=${index.includes('demo.credential')}, plaintext=${index.includes('demo-password-123')}`);
});

test('7b. 内容截断与预算：单条 200 字、合计 400 字，超出记录事件', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  // Three long bodies: the first two spend the 400-char content budget exactly, the third is cut.
  // The small delay keeps `updated_at` distinct, so the newest-first order is deterministic.
  for (const [key, filler] of [['long.a', '甲'], ['long.b', '乙'], ['long.c', '丙']]) {
    await mounted.call('assistant_resource_set', { key, value: filler.repeat(500), kind: 'note', title: key });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const rendered = mounted.fixedIndex();
  const lines = rendered.split('\n').filter((line) => line.startsWith('- '));
  const clipped = lines.filter((line) => line.includes('…'));
  const total = lines.reduce((sum, line) => sum + bodyChars(line), 0);
  assert.ok(clipped.length >= 1, 'an over-long body is clipped with an ellipsis');
  assert.ok(lines.every((line) => bodyChars(line) <= 200), `per-entry cap 200 (${lines.map(bodyChars).join(',')})`);
  assert.ok(total <= 400, `content budget 400 (${total})`);
  assert.deepEqual(
    lines.filter((line) => bodyChars(line) > 0).map((line) => line.slice(2, line.indexOf(' —'))),
    ['long.c', 'long.b'],
    'entries are truncated in order; the third body has no budget left',
  );
  const event = await waitForEvent(root, 'resource.inject.truncated');
  assert.ok(event !== null, 'the overflow is recorded as an event');
  assert.equal(event.payload.budgetChars, 400);
  assert.equal(event.payload.contentChars, total);
  assert.ok(event.payload.truncated >= 1);
  console.log(`7b) bodies=${lines.map((line) => `"${line.slice(2, line.indexOf(' —'))}":${bodyChars(line)}`).join(',')} `
    + `total=${total}/400 event=${JSON.stringify(event.payload)}`);
});

// ---- 8. importance no longer makes an ordinary memory resident ----------------------------

test('8. 90 分普通记忆不再常驻：importance 不赋予每轮注入资格', async (t) => {
  const root = await tempRoot();
  const mounted = mount(root);
  t.after(() => {
    mounted.close();
    return cleanup(root);
  });

  // 「第一次…答应…以后…陪我…谢谢」 scores exactly 90 by the heuristic importance function.
  const saved = await mounted.call('assistant_remember', {
    text: '第一次答应你：以后每周陪我看一部电影，谢谢你',
    domain: 'chat',
    kind: 'preference',
  });
  assert.equal(saved.domain, 'chat');

  // There is no every-turn fixed section any more, and the preview never carries the body.
  assert.equal(mounted.render('assistant:memory-fixed'), '', 'no importance-derived prompt section');
  const preview = await mounted.call('assistant_prompt_preview');
  assert.ok(!preview.text.includes('第一次答应你'), `the 90-point memory is not resident: ${preview.text}`);

  const store = new MemoryStore(root);
  store.open();
  t.after(() => store.close());
  const row = store.db
    .prepare("SELECT importance FROM memory_event WHERE text LIKE '%第一次答应你%'")
    .get();
  assert.ok(row !== undefined && row.importance >= 90, `the record really is 90 points (${row?.importance})`);
  assert.deepEqual(store.fixedMemories(), [], 'fixedMemories() no longer selects by importance');
  // The on-demand brief still offers it as a landmark: an explicit read is not residency.
  assert.equal(store.landmarkMemories({}).some((entry) => entry.text.includes('第一次答应你')), true);
  console.log(`8) importance=${row.importance}, prompt sections=${mounted.render('assistant:memory-fixed') === '' ? 'none' : 'FOUND'}, `
    + `fixedMemories()=0, landmark=1, preview carries body=${preview.text.includes('第一次答应你')}`);
});
