/**
 * Gap 2 regression: recall/archive display was a fixed 400-character prefix, so a passphrase
 * that matched at the tail of a long message produced `found:true` with no evidence in the
 * injected text (`containsEvidence:false`). Display now centers on the first hit and reports
 * `displayStart` / `displayEnd` / `displayTruncated`, while a query that matches nothing (a
 * pure time/role recall) still falls back to the old head clip.
 *
 * Gap 1 is covered by the last test: `searchArchive`/`listArchive` keep the message identity
 * columns, `assistant_archive_search` renders one `- [domain·role·time] body` line per hit
 * instead of a count-only line.
 *
 * Run: node --test test/memory-snippet.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { MemoryStore, displayMessageSnippet } from '../src/host/memory/store.js';

const PASSPHRASE = '归档测试口令是蓝莓宇宙';
const BUDGET = 400;
const TERM = '蓝莓宇宙';

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-snippet-'));
  const memory = new MemoryStore(root, { capacity: 2000 });
  memory.open();
  return { root, memory };
}

async function cleanup(root, memory) {
  memory.close();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

/** The recall hit our delivered body, or a failed assertion that names the missing id. */
function hitFor(memory, messageId, query) {
  const recalled = memory.recall({ query });
  const hit = recalled.hits.find((row) => row.messageId === messageId);
  assert.ok(
    hit !== undefined,
    `message ${messageId} is recalled for "${query}" (mode=${recalled.mode} range=${recalled.range} ` +
      `window=${recalled.from}..${recalled.to} hits=${JSON.stringify(recalled.hits.map((row) => row.messageId))})`,
  );
  return hit;
}

test('a) a passphrase at the tail of a 3000-char body is visible in the snippet', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${'长'.repeat(3000 - PASSPHRASE.length)}${PASSPHRASE}`;
    assert.equal(body.length, 3000);
    memory.addMessage({
      role: 'user',
      sessionId: 'snippet-tail',
      turnId: 1,
      messageId: 'tail-1',
      text: body,
    });

    const hit = hitFor(memory, 'tail-1', PASSPHRASE);
    assert.ok(hit.text.includes(PASSPHRASE), `snippet contains the passphrase: ${hit.text.length} chars`);
    assert.equal(hit.containsEvidence, true, 'containsEvidence is reported for the displayed snippet');
    assert.ok(hit.text.length <= BUDGET, `snippet length ${hit.text.length} stays within ${BUDGET}`);
    assert.equal(hit.displayTruncated, true);
    assert.ok(hit.displayStart > 0, 'the window starts past the head');
    assert.equal(hit.displayEnd, body.length, 'the visible window ends at the tail');
    console.log(
      `[snippet] tail: containsEvidence=${hit.containsEvidence} chars=${hit.text.length} ` +
        `window=${hit.displayStart}..${hit.displayEnd}`,
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('b) a passphrase at the head keeps its whole match in the snippet', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${PASSPHRASE}${'长'.repeat(3000 - PASSPHRASE.length)}`;
    memory.addMessage({
      role: 'user',
      sessionId: 'snippet-head',
      turnId: 1,
      messageId: 'head-1',
      text: body,
    });

    const hit = hitFor(memory, 'head-1', PASSPHRASE);
    assert.ok(hit.text.includes(PASSPHRASE), 'the head hit is in the snippet');
    assert.equal(hit.displayStart, 0, 'no characters are dropped on the left');
    assert.ok(hit.text.length <= BUDGET);
    assert.equal(hit.displayTruncated, true);
    assert.ok(hit.text.startsWith(PASSPHRASE));
    assert.ok(hit.text.endsWith('…'), 'the cut tail is marked');
    console.log(`[snippet] head: chars=${hit.text.length} startsAt=${hit.displayStart}`);
  } finally {
    await cleanup(root, memory);
  }
});

test('c) a time-only query with no matching term falls back to the head clip', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = '长'.repeat(3000);
    memory.addMessage({
      role: 'user',
      sessionId: 'snippet-time',
      turnId: 1,
      messageId: 'time-1',
      text: body,
      // The "今天" window is half-open (ts < now); a row written in the same millisecond as the
      // query would otherwise be excluded and make this test flaky.
      ts: new Date(Date.now() - 1000).toISOString(),
    });

    const hit = hitFor(memory, 'time-1', '今天');
    assert.equal(hit.containsEvidence, false, 'no term of the time query appears in the body');
    assert.equal(hit.displayStart, 0, 'the fallback window starts at the head');
    assert.equal(hit.displayEnd, BUDGET - 1, 'the head clip keeps its historical length');
    assert.equal(hit.text, `${body.slice(0, BUDGET - 1)}…`, 'the old head clip is preserved');
    assert.equal(hit.displayTruncated, true);
    console.log(`[snippet] time-only: chars=${hit.text.length} window=0..${hit.displayEnd}`);
  } finally {
    await cleanup(root, memory);
  }
});

test('d) a hit in the middle marks both truncated sides and stays inside the budget', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${'长'.repeat(1500)}${PASSPHRASE}${'长'.repeat(1489)}`;
    assert.equal(body.length, 3000);
    memory.addMessage({
      role: 'user',
      sessionId: 'snippet-middle',
      turnId: 1,
      messageId: 'middle-1',
      text: body,
    });

    const hit = hitFor(memory, 'middle-1', PASSPHRASE);
    assert.ok(hit.text.startsWith('…'), 'the left cut is marked');
    assert.ok(hit.text.endsWith('…'), 'the right cut is marked');
    assert.ok(hit.text.includes(PASSPHRASE), 'the hit itself is inside the window');
    assert.ok(hit.displayStart > 0 && hit.displayEnd < body.length, 'both offsets point inside the body');
    assert.ok(hit.displayEnd - hit.displayStart <= BUDGET - 2);
    assert.equal(hit.text.length, hit.displayEnd - hit.displayStart + 2, 'two ellipses, no hidden padding');
    assert.ok(hit.text.length <= BUDGET);
    console.log(
      `[snippet] middle: chars=${hit.text.length} window=${hit.displayStart}..${hit.displayEnd}`,
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('e) archive search keeps message identity and renders each hit body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-snippet-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => {}));
  const at = '2026-11-04T16:58:03.000Z';
  const body = `${'长'.repeat(3000 - PASSPHRASE.length)}${PASSPHRASE}`;

  const memory = new MemoryStore(root, { capacity: 2000 });
  memory.open();
  const id = randomUUID();
  try {
    memory.db
      .prepare(`INSERT INTO memory_archive
        (id, ts, domain, kind, text, importance, clarity, archived_at, reason,
         message_id, session_id, turn_id, role, truncated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, at, 'work', 'fact', body, 50, 'trace', at, 'test',
        'msg-archive-1', 'sess-archive-1', 7, 'user', 0,
      );

    const rows = memory.searchArchive(PASSPHRASE);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.role, 'user', 'searchArchive returns role');
    assert.equal(row.session_id, 'sess-archive-1', 'searchArchive returns session_id');
    assert.equal(row.turn_id, 7, 'searchArchive returns turn_id');
    assert.equal(row.message_id, 'msg-archive-1', 'searchArchive returns message_id');
    assert.equal(row.truncated, 0, 'searchArchive returns truncated');

    const listed = memory.listArchive({ limit: 5 })[0];
    assert.equal(listed.session_id, 'sess-archive-1', 'listArchive returns session_id');
    assert.equal(listed.turn_id, 7, 'listArchive returns turn_id');
    assert.equal(listed.message_id, 'msg-archive-1', 'listArchive returns message_id');
  } finally {
    memory.close();
  }

  // Mount the real plugin on the seeded store, so both execute() and render() are exercised.
  const tools = new Map();
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  apply(ctx, { root, defaultDomain: 'work', enabled: true });
  const tool = tools.get('assistant_archive_search');
  const args = { query: PASSPHRASE };
  const value = await tool.execute(args, {});
  assert.equal(value.count, 1);
  const hit = value.hits[0];
  assert.equal(hit.role, 'user');
  assert.equal(hit.session_id, 'sess-archive-1');
  assert.equal(hit.turn_id, 7);
  assert.equal(hit.message_id, 'msg-archive-1');
  assert.ok(hit.text.includes(PASSPHRASE), 'the tool snippet carries the passphrase');
  assert.equal(hit.containsEvidence, true);
  assert.ok(hit.text.length <= BUDGET);

  const text = tool.output.render(args, value).map((block) => block.text).join('\n');
  const lines = text.split('\n');
  assert.match(lines[0], /^归档命中 1 条（/u, 'the total count line is preserved');
  assert.ok(
    lines[1].startsWith('- [work·user·2026-11-04T16:58Z] '),
    `each hit is one labelled line, got: ${lines[1]}`,
  );
  assert.ok(lines[1].includes(PASSPHRASE), 'the rendered line carries the body');
  console.log(`[snippet] archive render line: ${lines[1]}`);
});

// --- Snippet budget boundaries: reserve the match before spending context -------------------

test('budget a) a 100-char budget keeps 蓝莓宇宙 whole at the tail of a long body', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${'长'.repeat(2000 - TERM.length)}${TERM}`;
    memory.addMessage({
      role: 'user',
      sessionId: 'budget-tail',
      turnId: 1,
      messageId: 'budget-tail-1',
      text: body,
    });

    const recalled = memory.recall({ query: TERM, displayChars: 100 });
    const hit = recalled.hits.find((row) => row.messageId === 'budget-tail-1');
    assert.ok(hit !== undefined, 'the tail hit is recalled');
    assert.ok(hit.text.includes(TERM), `the snippet carries the whole term: ${hit.text}`);
    assert.equal(hit.containsEvidence, true);
    assert.ok(
      hit.text.length <= 100 + TERM.length,
      `chars<=100+matchLen, got ${hit.text.length}`,
    );
    assert.equal(hit.budgetOverflow, false);
    assert.equal(hit.displayEnd, body.length, 'the window still ends at the tail');
    assert.ok(hit.displayStart > 0, 'the window starts past the head');
    console.log(`[budget] 100-char snippet (${hit.text.length} chars): ${hit.text}`);
  } finally {
    await cleanup(root, memory);
  }
});

test('budget b) three hits with total 600 spend it once; the third is explicitly skipped', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${'长'.repeat(1500 - TERM.length)}${TERM}`;
    for (let index = 1; index <= 3; index += 1) {
      memory.addMessage({
        role: 'user',
        sessionId: `budget-multi-${index}`,
        turnId: 1,
        messageId: `budget-multi-${index}`,
        text: body,
      });
    }

    const recalled = memory.recall({ query: TERM, budgetChars: 600, displayChars: BUDGET });
    assert.equal(recalled.hits.length, 3, 'all three hits stay visible in the result');
    const delivered = recalled.hits.filter((hit) => hit.skippedByBudget !== true);
    const skipped = recalled.hits.filter((hit) => hit.skippedByBudget === true);
    assert.equal(delivered.length, 2, 'the first two hits get a body');
    assert.ok(delivered.every((hit) => hit.text.length > 0 && hit.containsEvidence === true));
    assert.equal(skipped.length, 1, 'the third hit is explicitly marked skipped');
    assert.equal(skipped[0].text, '', 'a skipped hit delivers no fake evidence text');
    assert.equal(skipped[0].containsEvidence, false, 'containsEvidence is false for a skipped hit');
    assert.equal(skipped[0].budgetOverflow, false);
    const chars = delivered.reduce((sum, hit) => sum + hit.text.length, 0);
    assert.ok(chars <= 600, `delivered evidence stays inside 600 (${chars})`);
    console.log(
      `[budget] total=600 delivered=${delivered.length} chars=${chars} ` +
        `skippedByBudget=${skipped[0].messageId}`,
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('budget c) a budget smaller than the match overflows instead of cutting evidence', async () => {
  const { root, memory } = await tempStore();
  try {
    const body = `${'长'.repeat(100)}${TERM}${'长'.repeat(100)}`;
    memory.addMessage({
      role: 'user',
      sessionId: 'budget-tiny',
      turnId: 1,
      messageId: 'budget-tiny-1',
      text: body,
    });

    const recalled = memory.recall({ query: TERM, displayChars: 3 });
    const hit = recalled.hits.find((row) => row.messageId === 'budget-tiny-1');
    assert.ok(hit !== undefined, 'the tiny-budget hit is recalled');
    assert.equal(hit.budgetOverflow, true, 'the overshoot is flagged');
    assert.equal(hit.text, TERM, 'the whole match is delivered verbatim');
    assert.ok(hit.text.includes(TERM));
    assert.equal(hit.containsEvidence, true);
    assert.equal(hit.displayStart, 100);
    assert.equal(hit.displayEnd, 100 + TERM.length);
    console.log(
      `[budget] displayChars=3 → budgetOverflow=${hit.budgetOverflow} text=${hit.text} ` +
        `window=${hit.displayStart}..${hit.displayEnd}`,
    );
  } finally {
    await cleanup(root, memory);
  }
});

test('budget d) containsEvidence always equals text.includes(term)', async () => {
  const texts = [
    `${'长'.repeat(2000 - TERM.length)}${TERM}`,
    `${'长'.repeat(100)}${TERM}${'长'.repeat(100)}`,
    `${TERM}${'长'.repeat(2000 - TERM.length)}`,
    TERM,
    '长'.repeat(500),
  ];
  for (const text of texts) {
    for (const maxChars of [3, 50, 100, BUDGET, 5000]) {
      const shown = displayMessageSnippet(text, { query: TERM, maxChars });
      assert.equal(
        shown.containsEvidence,
        shown.text.includes(TERM),
        `consistent at len=${text.length} max=${maxChars}: ${shown.text}`,
      );
      assert.equal(shown.displayEnd >= shown.displayStart, true);
    }
  }

  const { root, memory } = await tempStore();
  try {
    for (let index = 1; index <= 3; index += 1) {
      memory.addMessage({
        role: 'user',
        sessionId: `budget-meta-${index}`,
        turnId: 1,
        messageId: `budget-meta-${index}`,
        text: `${'长'.repeat(1500 - TERM.length)}${TERM}`,
      });
    }
    const recalled = memory.recall({ query: TERM, budgetChars: 600, displayChars: BUDGET });
    for (const hit of recalled.hits) {
      assert.equal(
        hit.containsEvidence,
        hit.text.includes(TERM),
        `recall metadata matches delivered text for ${hit.messageId}`,
      );
    }
    console.log(`[budget] metadata consistency checked across ${recalled.hits.length} recall hits`);
  } finally {
    await cleanup(root, memory);
  }
});

