/**
 * Prompt stability: dynamic observation must never append a system-prompt copy.
 *
 * DeepSeek's route sets `systemPromptUpdate: 'in-history'`: when the rendered system prompt changes,
 * the loop APPENDS a complete copy to the history (so the prefix stays cacheable) and the old copy
 * stays billed until compaction. Continuous dialogue and the nonverbal cue change almost every
 * utterance, so as sections they appended ~11–13 KB per round. They are now runtime CONTEXT: the
 * loop APPENDS a sourced user-role snapshot each step (the newest wins semantically; older copies
 * stay in history until compaction, bounded by the dialogue window) while the system prompt stays
 * byte-identical.
 *
 * This suite mounts the real `apply()` with a fake `systemPrompt` service that mirrors the shipped
 * assembly contract (`section` text → prompt; `context` text → separate appended snapshot; empty
 * text contributes nothing). It proves:
 *  1. two consecutive rounds with a changing dialogue buffer render the SAME system prompt, while
 *     the runtime context text updates; `assistant.prompt.stable {changed:false}` and
 *     `assistant.context.refreshed` are recorded through the debug-event seam;
 *  2. clearing the buffer removes the observation context, leaves the system prompt unchanged and
 *     reports the cleared snapshot;
 *  3. a persona edit still changes the system prompt (stable sections keep their old semantics);
 *  4. order and text of both dynamic contributions are byte-identical to the old section content.
 *
 * Run: node --test test/prompt-stability.mjs
 * Regression (5): node --test test/expression-rules.mjs test/voice-lanes.mjs test/c2-injection.mjs
 *                 test/rollover-digest-injection.mjs
 *                 node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DIALOGUE_INJECTION_ORDER, apply } from '../src/host/index.js';
import { createDialogueContext } from '../src/host/session/conversation/dialogueContext.js';

const PERSONA_HEADER = '# 人设与用户画像\n\n> 由助手在对话中维护，用户不需要编辑本文件。\n';
const NONVERBAL_ORDER = 105;
const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prompt-stability-'));
  t.after(async () => {
    await delay(120);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  for (const dir of ['data', 'memory', 'workspace']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'data', 'features.json'), `${JSON.stringify({
    hearing: true, ambient: false, voice: false, vision: false,
    subtitle: false, avatar: false, memory: false, fastpath: false,
  })}\n`, 'utf8');
  return root;
}

function writePersona(root, text) {
  writeFileSync(join(root, 'memory', 'persona.md'), `${PERSONA_HEADER}\n${text.trim()}\n`, 'utf8');
}

/** Read the append-only host log, ignoring a partially written tail line. */
function readEvents(root) {
  try {
    return readFileSync(join(root, 'data', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function untilEvents(root, predicate, label, timeoutMs = 3000) {
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt < timeoutMs) {
    events = readEvents(root);
    if (predicate(events)) return events;
    await delay(10);
  }
  assert.fail(`timed out: ${label}; events=${events.map((event) => event.type).join(',')}`);
}

/**
 * Mount the real plugin. The fake prompt service mirrors the shipped contract: section text is
 * joined into the system prompt, context text forms a separate snapshot appended each step (it
 * supersedes semantically but older copies remain until compaction), and an empty contribution
 * disappears. `promptStabilityThrottleMs: 0` is the debug-event seam.
 */
function mount(root, { dialogueContext } = {}) {
  const sections = new Map();
  const contexts = new Map();
  const tools = new Map();
  const cleanups = [];
  const handlers = [];
  const effect = (fn) => {
    const value = fn();
    if (typeof value === 'function') cleanups.push(value);
    return value;
  };
  const on = (type, handler) => {
    const entry = { type, handler };
    handlers.push(entry);
    return () => {
      const index = handlers.indexOf(entry);
      if (index >= 0) handlers.splice(index, 1);
    };
  };
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
    promptStabilityThrottleMs: 0,
    ...(dialogueContext === undefined ? {} : { dialogueContext }),
  });
  // Workspace scope for `scopedText`; the same fact the real agent session header carries.
  const entry = { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
  const assemble = () => {
    const prompt = [...sections.values()]
      .sort((left, right) => left.order - right.order)
      .map((section) => (typeof section.text === 'function' ? section.text(entry) : section.text))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n\n');
    const parts = [...contexts.values()]
      .sort((left, right) => left.order - right.order)
      .map((context) => ({
        name: context.name,
        text: typeof context.text === 'function' ? context.text(entry) : context.text,
      }))
      .filter((part) => typeof part.text === 'string' && part.text.length > 0);
    return {
      prompt,
      hash: sha1(prompt),
      parts,
      contextText: (name) => parts.find((part) => part.name === name)?.text ?? '',
      // What the loop would append as the sourced user-role snapshot ('' = none).
      snapshot: parts.length === 0
        ? ''
        : `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${parts.map((part) => part.text).join('\n\n')}`,
    };
  };
  return {
    sections,
    contexts,
    tools,
    handlers,
    assemble,
    close: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          /* already torn down */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Two rounds: the prompt is stable, the context snapshot updates
// ---------------------------------------------------------------------------

test('1. 两轮连续对话：系统提示逐字不变，运行时 context 更新', async (t) => {
  const root = await tempRoot(t);
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mount(root, { dialogueContext: buffer });
  t.after(() => host.close());

  assert.equal(host.sections.has('assistant:dialogue'), false, 'dialogue is no longer a section');
  assert.equal(host.sections.has('assistant:nonverbal'), false, 'nonverbal cue is no longer a section');
  assert.equal(host.contexts.get('assistant:dialogue')?.order, DIALOGUE_INJECTION_ORDER);
  assert.equal(host.contexts.get('assistant:nonverbal')?.order, NONVERBAL_ORDER);

  const first = host.assemble();
  assert.ok(first.contextText('assistant:dialogue').includes('第一段'), 'the observation is visible as context');
  assert.equal(first.prompt.includes('第一段'), false, 'the observation is not part of the system prompt');
  // The in-history route: a new system node is appended only when the text changes.
  const history = { system: [first.prompt], snapshot: first.snapshot };
  const firstContext = first.contextText('assistant:dialogue');

  // Round 2: one more utterance reaches the shared buffer, exactly what used to rewrite the section.
  buffer.push({ text: '第二段：屋里没有人。', at: 2_000, utteranceId: 'u2' });
  const second = host.assemble();
  const appendedSystem = second.prompt !== history.system[history.system.length - 1];
  if (appendedSystem) history.system.push(second.prompt);
  history.snapshot = second.snapshot;

  assert.equal(second.prompt, first.prompt, 'system prompt text is byte-identical');
  assert.equal(second.hash, first.hash, 'system prompt hash is unchanged');
  assert.equal(second.prompt.includes('第二段'), false, 'the changing observation never enters the prompt');
  assert.equal(appendedSystem, false, 'no new system/message copy is appended');
  assert.equal(history.system.length, 1, 'history keeps one system node');

  const secondContext = second.contextText('assistant:dialogue');
  assert.notEqual(secondContext, firstContext, 'the runtime context text updates');
  assert.ok(secondContext.includes('第二段'), 'the new utterance is visible to the model');
  assert.ok(secondContext.includes('第一段'), 'the observation stays continuous');
  assert.notEqual(second.snapshot, first.snapshot, 'the snapshot is refreshed, not appended');

  const events = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'assistant.prompt.stable')
      && all.some((event) => event.type === 'assistant.context.refreshed'
        && event.payload?.name === 'assistant:dialogue'
        && event.payload?.chars === secondContext.length),
    'prompt stable + context refreshed events',
  );
  const stable = events.find((event) => event.type === 'assistant.prompt.stable');
  assert.equal(stable.payload.changed, false);
  assert.equal(typeof stable.payload.fingerprint, 'string');
  assert.equal(stable.payload.fingerprint.length, 40);
  // Event appends are asynchronous: find by content, not by file position.
  const refreshed = events.find((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue'
    && event.payload?.chars === secondContext.length);
  assert.ok(refreshed, 'the refreshed event carries the new context length');
  assert.equal(refreshed.payload.active, true);

  console.log(`1) promptHash=${first.hash}→${second.hash} same=true `
    + `systemNodes=${history.system.length} contextChars=${firstContext.length}→${secondContext.length} `
    + `stableChanged=${stable.payload.changed} refreshed=${refreshed.payload.chars}`);
});

// ---------------------------------------------------------------------------
// 2. Buffer cleared: the context disappears, the prompt does not move
// ---------------------------------------------------------------------------

test('2. 对话清空：context 消失且系统提示不变', async (t) => {
  const root = await tempRoot(t);
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '第一段：门是开着的。', at: 1_000, utteranceId: 'u1' });
  const host = mount(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const first = host.assemble();
  assert.ok(first.contextText('assistant:dialogue').length > 0, 'the observation starts active');
  buffer.clear();
  const cleared = host.assemble();

  assert.equal(cleared.contextText('assistant:dialogue'), '', 'the dialogue context renders empty');
  assert.equal(cleared.parts.some((part) => part.name === 'assistant:dialogue'), false, 'no empty context is produced');
  assert.equal(cleared.prompt, first.prompt, 'clearing the buffer never rewrites the system prompt');
  assert.equal(cleared.hash, first.hash, 'system prompt hash is unchanged');
  assert.equal(cleared.snapshot, '', 'no observation snapshot remains');

  const events = await untilEvents(
    root,
    (all) => all.some((event) => event.type === 'assistant.context.refreshed'
      && event.payload?.name === 'assistant:dialogue'
      && event.payload?.active === false),
    'context cleared event',
  );
  const clearedEvent = events.find((event) => event.type === 'assistant.context.refreshed'
    && event.payload?.name === 'assistant:dialogue'
    && event.payload?.active === false);
  assert.ok(clearedEvent, 'a cleared observation is reported');
  assert.equal(clearedEvent.payload.chars, 0);

  console.log(`2) promptHash=${first.hash.slice(0, 12)}=${cleared.hash.slice(0, 12)} `
    + `dialogueContext="" snapshotEmpty=${cleared.snapshot === ''} refreshedActive=${clearedEvent.payload.active}`);
});

// ---------------------------------------------------------------------------
// 3. Persona edit: stable sections keep their original semantics
// ---------------------------------------------------------------------------

test('3. persona 变化仍更新提示词，稳定段保持 section', async (t) => {
  const root = await tempRoot(t);
  writePersona(root, '- 说话温柔');
  const host = mount(root);
  t.after(() => host.close());

  const before = host.assemble();
  assert.ok(before.prompt.includes('说话温柔'), 'the persona renders before the edit');
  assert.equal(host.sections.has('assistant:persona'), true, 'persona stays a section');
  assert.equal(host.sections.has('assistant:profile'), true, 'profile stays a section');
  assert.equal(host.sections.has('assistant:resources'), true, 'resources stay a section');
  assert.equal(host.sections.get('assistant:persona').order, 100);
  assert.equal(host.sections.get('assistant:profile').order, 150);
  assert.equal(host.sections.get('assistant:resources').order, 9000);
  await untilEvents(root, (all) => all.some((event) => event.type === 'assistant.prompt.changed'),
    'initial prompt changed event');
  const changedBefore = readEvents(root).filter((event) => event.type === 'assistant.prompt.changed').length;

  writePersona(root, '- 说话温和');
  const after = host.assemble();
  assert.ok(after.prompt.includes('说话温和'), 'the edited persona reaches the prompt');
  assert.equal(after.prompt.includes('说话温柔'), false, 'the old persona text is gone');
  assert.notEqual(after.hash, before.hash, 'a user edit is allowed to change the system prompt');

  const events = await untilEvents(
    root,
    (all) => all.filter((event) => event.type === 'assistant.prompt.changed').length > changedBefore,
    'prompt changed after the persona edit',
  );
  const changedAfter = events.filter((event) => event.type === 'assistant.prompt.changed').length;
  assert.equal(changedAfter, changedBefore + 1);

  console.log(`3) promptHash=${before.hash.slice(0, 12)}→${after.hash.slice(0, 12)} changed=1 `
    + `personaSection=${host.sections.has('assistant:persona')} profileSection=${host.sections.has('assistant:profile')}`);
});

// ---------------------------------------------------------------------------
// 4. Context order/text are identical to the old section content
// ---------------------------------------------------------------------------

test('4. 上下文顺序与文本和旧 section 逐字一致', async (t) => {
  const root = await tempRoot(t);
  writePersona(root, '- 说话温柔');
  const buffer = createDialogueContext({ now: () => 1_000 });
  buffer.push({ text: '钥匙在柜子里，', at: 1_000, utteranceId: 'u1' });
  buffer.push({ text: '你去拿吧。', at: 2_000, utteranceId: 'u2' });
  const host = mount(root, { dialogueContext: buffer });
  t.after(() => host.close());

  const assembled = host.assemble();
  const nonverbal = host.contexts.get('assistant:nonverbal');
  const dialogue = host.contexts.get('assistant:dialogue');
  assert.equal(nonverbal.order, 105, 'old nonverbal section order (105)');
  assert.equal(dialogue.order, DIALOGUE_INJECTION_ORDER, 'old dialogue section order (110)');
  assert.ok(nonverbal.order < dialogue.order, 'relative order: nonverbal before dialogue');
  assert.ok(dialogue.order > host.sections.get('assistant:persona').order, 'dialogue is still after the persona');

  // The old `assistant:dialogue` section body was `dialogueSummary.render()`, i.e. the trimmed
  // buffer render. The context declaration must expose exactly that string, with no wrapper.
  const oldSectionText = buffer.render().trim();
  assert.equal(dialogue.text(entryOf(root)), oldSectionText, 'dialogue context text is byte-identical');
  assert.equal(assembled.contextText('assistant:dialogue'), oldSectionText);
  assert.equal(nonverbal.text(entryOf(root)), '', 'an expired/absent cue still renders empty');
  assert.equal(assembled.parts.some((part) => part.name === 'assistant:nonverbal'), false, 'no empty nonverbal context');

  // Stable sections were NOT converted: same names, same orders, still in the prompt.
  const stable = {
    'assistant:persona': 100,
    'assistant:profile': 150,
    'assistant:memory-convention': 200,
    'assistant:memory-usage': 260,
    'assistant:task-dispatch': 270,
    'assistant:tool-selection': 275,
    'assistant:hearing': 300,
    'assistant:languages': 310,
    'assistant:voice-output': 320,
    'assistant:expression': 330,
    'assistant:ambient': 350,
    'assistant:resources': 9000,
  };
  for (const [name, order] of Object.entries(stable)) {
    assert.equal(host.sections.get(name)?.order, order, `${name} is still a section at order ${order}`);
    assert.equal(host.contexts.has(name), false, `${name} was not moved to context`);
  }

  console.log(`4) dialogueChars=${oldSectionText.length} nonverbalOrder=${nonverbal.order} `
    + `dialogueOrder=${dialogue.order} stableSections=${Object.keys(stable).length} `
    + `dialogueExact=${assembled.contextText('assistant:dialogue') === oldSectionText}`);
});

/** The same workspace scope fact `assemble()` uses, for direct provider calls. */
function entryOf(root) {
  return { agent: { session: { header: { cwd: join(root, 'workspace') } } } };
}
