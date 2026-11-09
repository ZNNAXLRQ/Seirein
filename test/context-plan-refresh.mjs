/**
 * P2-A regression: a cached lane plan must not freeze the dynamic dialogue observation.
 *
 * `beginContextPlan` runs from the persona section (order 100) and used to cache the whole
 * allocation in a WeakMap keyed by the agent. The dialogue section then read `blocks.recent` from
 * that cache, so an utterance appended between assembly and request (or after the observation
 * expired) was invisible: the request kept the text rendered at persona time.
 *
 * The mount below is the shipped fake-host contract (see test/vision-evidence-host.mjs): every
 * `systemPrompt.section/context` text function is captured and called directly, so the refresh is
 * exactly what a request-side render does. No model, screen, microphone or VTube Studio is used.
 *
 * Acceptance:
 *   1. assembly contains A → append B → rendering `assistant:dialogue` again yields B and drops
 *      the old content trimmed out by the lane's recent quota;
 *   2. after the buffer expires (clock) or is cleared, the same render is empty — never old lines;
 *   3. the refreshed text still respects the lane's `recent` quota (the whole plan is reallocated,
 *      not just the recent block patched).
 *
 * Run: node --test test/context-plan-refresh.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanupRoot } from './helpers/cleanup.mjs';
import { apply, voiceSessionTarget } from '../src/host/index.js';
import { createDialogueContext } from '../src/host/session/conversation/dialogueContext.js';

const FEATURES = Object.freeze({
  hearing: true,
  ambient: false,
  voice: false,
  vision: false,
  subtitle: false,
  avatar: false,
  memory: true,
  fastpath: false,
});

/** A lane whose recent quota is tight enough to drop the oldest transcript line once B arrives. */
const RECENT_QUOTA = 60;
const VOICE_BUDGET = Object.freeze({
  persona: 100_000,
  fixed: 100_000,
  memory: 0,
  recent: RECENT_QUOTA,
  ephemeral: 100_000,
  totalChars: 200_000,
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-plan-refresh-'));
  for (const dir of ['data', 'memory', 'workspace']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'data', 'features.json'), `${JSON.stringify(FEATURES)}\n`, 'utf8');
  return root;
}

/**
 * Mount the real plugin against a host double that only records declarations. `render()` calls one
 * declaration's text exactly like the request side does; nothing else is simulated.
 */
function mountHost(root, config = {}) {
  const sections = new Map();
  const contexts = new Map();
  const disposers = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') disposers.push(value);
    return value;
  };
  const on = () => () => {};
  const scope = {
    effect,
    on,
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
      context(definition) {
        contexts.set(definition.name, definition);
        return () => contexts.delete(definition.name);
      },
    },
    webServer: { register: () => () => {} },
  };
  apply({
    effect,
    on,
    get: () => undefined,
    tools: { register: () => () => {} },
    inject: (_dependencies, register) => register(scope),
    webServer: { register: () => () => {} },
  }, {
    root,
    enabled: true,
    promptStabilityThrottleMs: 0,
    ffmpegPath: process.execPath,
    contextBudgets: { voice: VOICE_BUDGET },
    ...config,
  });

  const orderOf = (left, right) => left.order - right.order
    || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const render = (definition, entry) => {
    try {
      return typeof definition.text === 'function' ? definition.text(entry) : definition.text;
    } catch {
      return '';
    }
  };
  const assemble = (entry) => {
    for (const definition of [...sections.values()].sort(orderOf)) render(definition, entry);
    for (const definition of [...contexts.values()].sort(orderOf)) render(definition, entry);
  };
  const sectionText = (name, entry) => {
    const definition = sections.get(name);
    assert.ok(definition !== undefined, `section ${name} is registered`);
    return render(definition, entry);
  };
  const contextText = (name, entry) => {
    const definition = contexts.get(name);
    assert.ok(definition !== undefined, `context ${name} is registered`);
    return render(definition, entry);
  };
  const entryFor = (id) => ({
    agent: { id, session: { id, header: { cwd: join(root, 'workspace') } } },
  });
  return {
    sections,
    contexts,
    assemble,
    sectionText,
    contextText,
    entryFor,
    close: () => cleanupRoot(root, disposers),
  };
}

function voiceEntry(host, root) {
  return host.entryFor(voiceSessionTarget({ root }).sessionId);
}

test('1. 装配含 A → 加入 B → 请求前再渲染得到 B，旧台词被裁掉', async (t) => {
  const root = await tempRoot();
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: 'A-OLD-第一条旧台词。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = voiceEntry(host, root);

  host.assemble(entry);
  const assembled = host.contextText('assistant:dialogue', entry);
  assert.ok(assembled.includes('A-OLD'), 'the assembly observed A');

  // The model request is assembled later: the buffer gained one recognized utterance.
  buffer.push({ text: 'B-NEW-第二条新台词。', at: 1_000, utteranceId: 'u2' });
  const refreshed = host.contextText('assistant:dialogue', entry);
  assert.ok(refreshed.includes('B-NEW'), 'the request-before refresh sees the new utterance');
  assert.equal(refreshed.includes('A-OLD'), false, 'the line trimmed by the lane quota is gone');
});

test('2. 缓冲过期或清空后刷新为空，不保留旧台词', async (t) => {
  const root = await tempRoot();
  let now = 1_000;
  const buffer = createDialogueContext({ now: () => now, maxWindowMs: 1_000 });
  buffer.push({ text: 'A-OLD-会过期的旧台词。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = voiceEntry(host, root);

  host.assemble(entry);
  assert.ok(host.contextText('assistant:dialogue', entry).includes('A-OLD'), 'A is observed first');

  // Expiry is read-time: moving the injected clock past the window empties render().
  now = 2_500;
  assert.equal(host.contextText('assistant:dialogue', entry), '', 'an expired observation renders empty');

  // The same must hold for an explicit clear, with the plan cache already warmed again.
  now = 3_000;
  buffer.push({ text: 'B-NEW-清空前的新台词。', at: 3_000, utteranceId: 'u2' });
  assert.ok(host.contextText('assistant:dialogue', entry).includes('B-NEW'), 'B is observed');
  buffer.clear();
  assert.equal(host.contextText('assistant:dialogue', entry), '', 'a cleared observation renders empty');
});

test('3. 刷新后的 recent 仍受该 lane 配额约束', async (t) => {
  const root = await tempRoot();
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: 'A-OLD-第一条旧台词。', at: 1_000, utteranceId: 'u1' });
  const host = mountHost(root, { dialogueContext: buffer });
  t.after(() => host.close());
  const entry = voiceEntry(host, root);

  host.assemble(entry);
  buffer.push({ text: 'B-NEW-第二条新台词。', at: 1_000, utteranceId: 'u2' });

  const raw = buffer.render();
  assert.ok(raw.length > RECENT_QUOTA, `the raw observation (${raw.length}) exceeds the lane quota`);
  const refreshed = host.contextText('assistant:dialogue', entry);
  assert.ok(refreshed.includes('B-NEW'), 'the newest line survives the reallocation');
  assert.ok(refreshed.length <= RECENT_QUOTA,
    `refreshed recent (${refreshed.length}) stays within the lane quota ${RECENT_QUOTA}`);
});
