/**
 * ProfileStore step 5: the compiled prompt actually reaches the real system prompt.
 *
 * Every case mounts the shipped plugin against a fake context that records the
 * `systemPrompt` sections and the `/assistant/action` route (the same two services the Host
 * provides). The profile database is seeded before mount, so no real model or Host is needed.
 * Model calls are injected through a fake `llm`; only the explicit organize split/compose uses it.
 *
 * Proves:
 *  1. a compiled snapshot appears as「人设与偏好（自动整理）」between persona and memory;
 *  2. an empty snapshot renders no profile block, so the old persona section is unchanged;
 *  3. an over-budget snapshot is skipped whole and `profile.prompt.skipped` is recorded;
 *  4. edit recompiles in the same transaction: the next prompt read already changed;
 *  5. remove and revert do the same;
 *  6. saving the persona box never calls a model and never imports it; only an explicit
 *     organize splits the box into entries, rewrites the prompt and writes it back;
 *  7. the prompt cache invalidates on a write: version +1 and the next read returns the new text.
 *
 * Run: node --test test/profile-prompt.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { apply } from '../src/host/index.js';
import {
  PROFILE_PROMPT_BUDGET_TOKENS,
  PROFILE_PROMPT_EVENTS,
  PROFILE_PROMPT_TITLE,
  createProfileMaintainer,
} from '../src/host/profile/profileMaintain.js';
import { createProfileStore } from '../src/host/profile/profileStore.js';

const PERSONA_HEADER = '# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n';

// ---- fixture -------------------------------------------------------------------------------

/**
 * Create the instance root before `apply`: features off (no mic/camera/speaker autostart in a
 * test), persona files on disk, and an optional pre-seeded library/snapshot.
 */
async function makeRoot(t, { persona = {}, entries = [], snapshot = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'memory'), { recursive: true });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: false, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: true, fastpath: false,
  })}\n`, 'utf8');
  for (const which of ['agent', 'user']) {
    const text = persona[which];
    if (typeof text !== 'string' || text.length === 0) continue;
    // PersonaStore: agent lives in persona.md, the user profile in user.md.
    writeFileSync(join(root, 'memory', which === 'user' ? 'user.md' : 'persona.md'), `${PERSONA_HEADER}\n${text.trim()}\n`, 'utf8');
  }

  let seeded = [];
  if (entries.length > 0 || snapshot !== null) {
    const db = new DatabaseSync(join(root, 'memory', 'memory.db'));
    const profile = createProfileStore({ db });
    for (const entry of entries) profile.upsert({ ...entry, rank: entry.rank ?? 'original' });
    const maintainer = createProfileMaintainer({ profile, db });
    if (snapshot !== null) {
      maintainer.writeSnapshot(
        snapshot.text,
        snapshot.tokens ?? 0,
        snapshot.version ?? 1,
        snapshot.at ?? new Date().toISOString(),
      );
    } else {
      maintainer.compileNow({ trigger: 'seed' });
    }
    seeded = profile.list();
    db.close();
  }
  return { root, seeded };
}

/** Mount the plugin against recording `systemPrompt` and `webServer` services. */
function mount(root, { split = null } = {}) {
  const sections = new Map();
  const routes = new Map();
  const splitCalls = [];
  const fakeContext = {
    effect: (fn) => {
      fn();
    },
    on: () => () => {},
    get: (service) => {
      if (service === 'llm') {
        return {
          async *stream(input) {
            splitCalls.push('llm');
            if (typeof split !== 'function') throw new Error('no test splitter');
            const prompt = input?.messages?.[0]?.content?.[0]?.text ?? input?.prompt ?? '';
            const value = await split({ ...input, prompt });
            yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
          },
        };
      }
      if (service === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test', model: 'test' }) };
      }
      return undefined;
    },
    tools: { register: () => () => {} },
    inject: (deps, fn) => {
      if (deps.includes('systemPrompt')) {
        fn({
          effect: (inner) => {
            inner();
          },
          systemPrompt: {
            section: (definition) => {
              sections.set(definition.name, definition);
              return () => {};
            },
          },
        });
      }
      if (deps.includes('webServer')) {
        fn({
          effect: (inner) => {
            inner();
          },
          webServer: {
            register: (route) => {
              routes.set(route.path, route.handler);
              return () => {};
            },
          },
        });
      }
    },
  };
  apply(fakeContext, { root });
  const context = { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
  const render = (name) => sections.get(name)?.text(context) ?? '';
  const prompt = () => [...sections.values()]
    .sort((left, right) => left.order - right.order)
    .map((section) => section.text(context))
    .filter((text) => typeof text === 'string' && text.length > 0)
    .join('\n\n');
  const action = async (body) => {
    const handler = routes.get('/assistant/action');
    assert.ok(handler, 'the action route is registered');
    const response = { status: 0, body: '' };
    const request = {
      method: 'POST',
      url: '/assistant/action',
      setEncoding: () => {},
      destroy: () => {},
      on(event, fn) {
        if (event === 'end') {
          queueMicrotask(() => {
            this.emitData?.(JSON.stringify(body));
            fn();
          });
        }
        if (event === 'data') this.emitData = fn;
        return this;
      },
    };
    await handler(request, {
      writeHead: (status) => {
        response.status = status;
      },
      end: (data) => {
        response.body = String(data ?? '');
      },
    });
    return JSON.parse(response.body);
  };
  return { sections, render, prompt, action, splitCalls };
}

/** Events are appended asynchronously by the EventLog; poll briefly instead of sleeping blind. */
async function waitForEvent(root, type, predicate = () => true) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let events = [];
    try {
      events = readFileSync(join(root, 'data', 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      events = [];
    }
    const hit = events.find((event) => event.type === type && predicate(event.payload));
    if (hit !== undefined) return hit;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`event not found: ${type}`);
}

const readSnapshot = (root) => {
  const db = new DatabaseSync(join(root, 'memory', 'memory.db'));
  try {
    const row = db.prepare('SELECT * FROM profile_snapshot WHERE id = ?').get('current');
    const entries = db.prepare('SELECT * FROM profile_entry ORDER BY side, text').all();
    return { snapshot: row === undefined ? null : { ...row }, entries };
  } finally {
    db.close();
  }
};

// ---- 1. compiled snapshot reaches the prompt ------------------------------------------------

test('1. 快照有内容 → 提示词出现「人设与偏好（自动整理）」，persona 段仍在', async (t) => {
  const { root } = await makeRoot(t, {
    persona: { agent: '- 说话温柔' },
    entries: [{ side: 'agent', category: '语言', text: '说话简洁', clarity: 70, efficacy: 56 }],
  });
  const { render, prompt } = mount(root);
  const text = prompt();
  assert.ok(text.includes(PROFILE_PROMPT_TITLE), 'the new section title is present');
  assert.match(text, /说话简洁/u, 'the compiled entry is in the request');
  assert.match(render('assistant:persona'), /## 你的设定/u);
  assert.match(render('assistant:persona'), /说话温柔/u, 'the persona section still renders');
  const personaAt = text.indexOf('## 你的设定');
  const profileAt = text.indexOf(PROFILE_PROMPT_TITLE);
  const memoryAt = text.indexOf('## 记忆的收编约定');
  assert.ok(personaAt >= 0 && personaAt < profileAt && profileAt < memoryAt, 'order: persona < profile < memory');

  const event = await waitForEvent(root, PROFILE_PROMPT_EVENTS.injected);
  assert.equal(event.payload.entries, 1);
  assert.ok(event.payload.tokens > 0);
  console.log(`1) title="${PROFILE_PROMPT_TITLE}" entries=${event.payload.entries} tokens=${event.payload.tokens} order=${personaAt}<${profileAt}<${memoryAt}`);
});

// ---- 2. empty snapshot keeps the old behaviour -----------------------------------------------

test('2. 快照为空 → 不注入新段，旧 persona 文本原样工作', async (t) => {
  const { root } = await makeRoot(t, { persona: { agent: '- 说话温柔' } });
  const { render, prompt } = mount(root);
  const text = prompt();
  assert.equal(render('assistant:profile'), '', 'no profile block without a snapshot');
  assert.doesNotMatch(text, /人设与偏好（自动整理）/u);
  assert.match(render('assistant:persona'), /## 你的设定[\s\S]*- 说话温柔/u);
  assert.match(text, /## 记忆的收编约定/u, 'the rest of the prompt is unchanged');
  console.log(`2) profile="" personaHasText=${render('assistant:persona').includes('说话温柔')}`);
});

// ---- 3. over budget --------------------------------------------------------------------------

test('3. 超预算 → 整体不注入，记 profile.prompt.skipped', async (t) => {
  const longText = `## 人设（自动整理）\n- [语言] ${'很长的条目'.repeat(160)}（C=70, E=50）`;
  const { root } = await makeRoot(t, {
    persona: { agent: '- 说话温柔' },
    snapshot: { text: longText, tokens: 9999 },
  });
  const { render, prompt } = mount(root);
  const text = prompt();
  assert.equal(render('assistant:profile'), '', 'an over-budget block is skipped whole');
  assert.doesNotMatch(text, /人设与偏好（自动整理）/u);
  assert.match(text, /说话温柔/u, 'persona fallback remains');

  const event = await waitForEvent(root, PROFILE_PROMPT_EVENTS.skipped);
  assert.equal(event.payload.reason, 'over-budget');
  assert.ok(event.payload.tokens > PROFILE_PROMPT_BUDGET_TOKENS);
  console.log(`3) reason=${event.payload.reason} tokens=${event.payload.tokens} budget=${PROFILE_PROMPT_BUDGET_TOKENS}`);
});

// ---- 4. edit recompiles immediately ----------------------------------------------------------

test('4. 编辑 → 同一事务重编译，下一次读取提示词立即变化', async (t) => {
  const { root, seeded } = await makeRoot(t, {
    entries: [{ side: 'agent', category: '语言', text: '说话简洁', clarity: 70, efficacy: 56 }],
  });
  const id = seeded[0].id;
  const { prompt, action } = mount(root);
  const before = readSnapshot(root);
  assert.match(prompt(), /说话简洁/u);

  const edited = await action({ action: 'profile.edit', id, patch: { text: '说话简短' } });
  assert.equal(edited.ok, true);
  assert.deepEqual(edited.changed, ['text']);
  assert.match(prompt(), /说话简短/u, 'the next read already sees the edit');
  assert.doesNotMatch(prompt(), /说话简洁/u);
  const after = readSnapshot(root);
  assert.equal(after.snapshot.version, before.snapshot.version + 1, 'snapshot version +1');
  assert.match(after.snapshot.text, /说话简短/u);
  console.log(`4) v${before.snapshot.version}→v${after.snapshot.version} snapshot="${after.snapshot.text.split('\n')[1]}"`);
});

// ---- 5. remove / revert recompile immediately -------------------------------------------------

test('5. 删除 / 撤销 → 立即重编译，提示词同步更新', async (t) => {
  const { root, seeded } = await makeRoot(t, {
    entries: [
      { side: 'agent', category: '语言', text: '待删除条目', clarity: 66, efficacy: 52 },
      { side: 'user', category: '饮食', text: '喜欢冰美式', clarity: 64, efficacy: 50 },
    ],
  });
  const doomed = seeded.find((entry) => entry.text === '待删除条目');
  const kept = seeded.find((entry) => entry.text === '喜欢冰美式');
  const { prompt, action } = mount(root);
  assert.match(prompt(), /待删除条目/u);
  const before = readSnapshot(root);

  const removed = await action({ action: 'profile.remove', id: doomed.id });
  assert.equal(removed.removed, true);
  const afterRemove = readSnapshot(root);
  assert.equal(afterRemove.snapshot.version, before.snapshot.version + 1);
  assert.doesNotMatch(prompt(), /待删除条目/u, 'removal is visible on the next read');
  assert.match(prompt(), /喜欢冰美式/u);

  const edited = await action({ action: 'profile.edit', id: kept.id, patch: { text: '喜欢冰拿铁' } });
  assert.equal(edited.ok, true);
  assert.match(prompt(), /喜欢冰拿铁/u);
  const revisions = await action({ action: 'profile.revision', id: kept.id });
  assert.ok(revisions.revisions.length > 0);
  const reverted = await action({ action: 'profile.revert', revisionId: revisions.revisions[0].id });
  assert.equal(reverted.ok, true);
  assert.match(prompt(), /喜欢冰美式/u, 'revert restores the previous text immediately');
  assert.doesNotMatch(prompt(), /喜欢冰拿铁/u);
  const afterRevert = readSnapshot(root);
  assert.ok(afterRevert.snapshot.version >= afterRemove.snapshot.version + 2, 'each mutation bumps the snapshot');
  console.log(`5) removeV=${afterRemove.snapshot.version} revertV=${afterRevert.snapshot.version} promptHasReverted=${prompt().includes('喜欢冰美式')}`);
});

// ---- 6. save vs organize ---------------------------------------------------------------------

test('6a. 保存不触发模型调用：库空 + persona 有文本 → 只写框、不入库、不拆分', async (t) => {
  const { root } = await makeRoot(t, {
    persona: { agent: '- 说话温柔', user: '- 喜欢简短回答' },
  });
  const { prompt, render, action, splitCalls } = mount(root);
  const saved = await action({ action: 'profile.save', agent: '- 说话温柔', user: '- 喜欢简短回答' });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.pending, { agent: true, user: true });
  assert.equal(splitCalls.length, 0, 'the save path never hands the prompt to a model');

  const { snapshot, entries } = readSnapshot(root);
  assert.equal(entries.length, 0, 'save stores no library row');
  assert.equal(snapshot, null, 'save writes no compiled snapshot');
  assert.equal(render('assistant:profile'), '', 'the box is injected as persona, not as a compiled duplicate');
  const text = prompt();
  assert.match(text, /说话温柔/u);
  assert.match(text, /喜欢简短回答/u);
  console.log(`6a) splitCalls=${splitCalls.length} entries=${entries.length} pending=${JSON.stringify(saved.pending)} profileSection="${render('assistant:profile')}"`);
});

test('6b. 下一轮：设置框改一个词 + 新增一行 → 显式整理才拆分入库并重写', async (t) => {
  const { root } = await makeRoot(t, { persona: { agent: '- 说话温柔' } });
  const { action, splitCalls } = mount(root, {
    split: ({ prompt }) => {
      // The rewrite is always verified now: answer the semantic check explicitly, otherwise an
      // unparsable reply would (correctly) fall back to the source sentence.
      if (String(prompt).includes('请核对正文是否忠实于来源')) return '{"ok":true,"issues":[]}';
      if (String(prompt).includes('碎片：')) return '你会温柔地说话。';
      if (String(prompt).includes('喜欢安静')) {
        return [
          { text: '说话温和', category: '语言' },
          { text: '喜欢安静', category: '性格' },
        ];
      }
      return [{ text: '说话温柔', category: '语言' }];
    },
  });
  // The first explicit organize is the only round that may split the never-saved box.
  const first = await action({ action: 'profile.maintain.now' });
  assert.equal(first.ok, true);
  assert.equal(first.reason, 'initial');
  assert.equal(readSnapshot(root).entries.length, 1);
  const firstRoundCalls = splitCalls.length;
  assert.equal(firstRoundCalls, 3, 'first organize: one split + one compose + one fidelity check');

  // The user edits the persona box: one word changed, one line appended. Only an explicit
  // organize may import it; the round now splits once and rewrites once.
  writeFileSync(join(root, 'memory', 'persona.md'), `${PERSONA_HEADER}\n- 说话温和\n- 喜欢安静\n`, 'utf8');
  const result = await action({ action: 'profile.maintain.now' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'box-changed');
  assert.equal(splitCalls.length, firstRoundCalls + 3, 'one split + one compose + one fidelity check (the explicit organize)');

  const { snapshot, entries } = readSnapshot(root);
  assert.equal(entries.length, 2);
  const edited = entries.find((entry) => entry.text === '说话温和');
  const added = entries.find((entry) => entry.text === '喜欢安静');
  assert.notEqual(edited, undefined, 'a one-word edit updates the entry text');
  assert.notEqual(added, undefined);
  assert.equal(entries.some((entry) => entry.text === '说话温柔'), false);
  assert.equal(edited.rank, 'original');
  assert.deepEqual([edited.clarity, edited.efficacy], [50, 50], 'a text edit never changes C/E');
  assert.equal(added.rank, 'original');
  assert.deepEqual(JSON.parse(snapshot.lines).map((line) => line.text).sort(), ['喜欢安静', '说话温和'].sort());
  assert.equal(readFileSync(join(root, 'memory', 'persona.md'), 'utf8').trim(), '你会温柔地说话。',
    'the composed rewrite is written back into the box');
  console.log(`6b) splitCalls=${splitCalls.length} entries=${entries.map((entry) => entry.text).join(',')} box="${readFileSync(join(root, 'memory', 'persona.md'), 'utf8').trim()}"`);
});

// ---- 7. cache invalidation -------------------------------------------------------------------

test('7. 缓存失效：写操作后版本 +1，读取拿到新内容', async (t) => {
  const { root, seeded } = await makeRoot(t, {
    entries: [{ side: 'agent', category: '语言', text: '缓存旧值', clarity: 70, efficacy: 50 }],
  });
  const { prompt, action } = mount(root);
  const first = readSnapshot(root);
  const firstPrompt = prompt();
  const again = prompt();
  assert.equal(firstPrompt, again, 'a repeated read is stable (cache hit returns the same block)');
  assert.match(firstPrompt, /缓存旧值/u);

  await action({ action: 'profile.edit', id: seeded[0].id, patch: { text: '缓存新值' } });
  const second = readSnapshot(root);
  const secondPrompt = prompt();
  assert.equal(second.snapshot.version, first.snapshot.version + 1);
  assert.notEqual(second.snapshot.text, first.snapshot.text);
  assert.match(secondPrompt, /缓存新值/u);
  assert.doesNotMatch(secondPrompt, /缓存旧值/u);
  console.log(`7) v${first.snapshot.version}→v${second.snapshot.version} old="${firstPrompt.match(/缓存旧值|缓存新值/u)?.[0]}" new="${secondPrompt.match(/缓存旧值|缓存新值/u)?.[0]}"`);
});

// ---- 8. one persona copy after a save -------------------------------------------------------

test('8. 保存后人设只出现一份：persona 段有文本、assistant:profile 段为空（互相排斥）', async (t) => {
  const { root } = await makeRoot(t, { persona: { agent: '- 说话温柔' } });
  const { render, prompt, action, splitCalls } = mount(root, {
    split: () => [{ text: '说话温柔', category: '语言' }],
  });

  const saved = await action({ action: 'profile.save', agent: '说话温柔', user: '' });
  assert.equal(saved.ok, true);
  assert.equal(splitCalls.length, 0, 'the save path only persists the box; it never splits');

  assert.match(render('assistant:persona'), /说话温柔/u, 'the box text is injected through persona');
  assert.equal(render('assistant:profile'), '', 'assistant:profile must not inject a second copy');
  const text = prompt();
  assert.equal((text.match(/## 你的设定/gu) ?? []).length, 1, 'exactly one persona block in the request');
  assert.equal(text.includes(PROFILE_PROMPT_TITLE), false, 'no compiled duplicate after the save');
  console.log(`8) profileSectionEmpty=${render('assistant:profile') === ''} personaBlocks=${(text.match(/## 你的设定/gu) ?? []).length} splitCalls=${splitCalls.length}`);
});
