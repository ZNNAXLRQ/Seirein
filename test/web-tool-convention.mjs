/**
 * Tool-selection convention for external lookup.
 *
 * A live session wanted Moegirl/Bing/DuckDuckGo results, used `terminal_open` + `curl`, got empty
 * or anti-bot responses, and gave up without calling the `web_search` / `web_fetch` tools it
 * already had. `TOOL_SELECTION` now steers that choice, so this test pins the rendered convention
 * against the source literal. It is a source assertion on purpose: no model, no network, no Host.
 *
 * Proves:
 *  1. external lookup prefers `web_search`, and a specific page is read with `web_fetch`;
 *  2. `curl` / `Invoke-WebRequest` against search-engine result pages or wiki APIs is forbidden;
 *  3. rate limits / empty / anti-bot responses are reported honestly, without hopping engines,
 *     and a delegated subtask follows the same web-first rule;
 *  4. a session without the web tools says 「当前没有联网搜索工具」 instead of faking a search
 *     with curl;
 *  5. the pre-existing pwsh / terminal_open lines and the subtask-dispatch line are unchanged;
 *  6. the new block does not blame permissions or a sandbox.
 *
 * Run: node --test test/web-tool-convention.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8');

/** String lines of a `const NAME = [...] .join('\n')` array literal, unquoted, in order. */
function arrayLines(name) {
  const start = SOURCE.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} is declared in src/host/index.js`);
  const end = SOURCE.indexOf("].join('\\n');", start);
  assert.ok(end > start, `the ${name} array literal closes with .join`);
  return SOURCE.slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith("'") && line.endsWith("',"))
    .map((line) => line.slice(1, -2));
}

const toolSelectionLines = () => arrayLines('TOOL_SELECTION');

/** The one array line containing a fragment — a missing line fails with the fragment named. */
function lineWith(lines, fragment) {
  const line = lines.find((candidate) => candidate.includes(fragment));
  assert.ok(line !== undefined, `TOOL_SELECTION has a line containing ${fragment}`);
  return line;
}

/** The new `### 联网检索` block, so the no-permission check does not see the old terminal line. */
function webRetrievalLines(lines) {
  const headingAt = lines.findIndex((line) => line.includes('### 联网检索'));
  assert.ok(headingAt >= 0, 'TOOL_SELECTION has a ### 联网检索 block');
  return lines.slice(headingAt + 1);
}

test('1. 外部资料优先 web_search，具体页面用 web_fetch', () => {
  const lines = toolSelectionLines();
  const lookup = lineWith(lines, 'web_search');
  assert.match(lookup, /外部资料/u, 'the bullet names external lookups');
  assert.match(lookup, /优先使用\s*`web_search`/u, 'external lookups prefer web_search');
  assert.match(lookup, /具体页面/u, 'the same bullet distinguishes a specific page');
  assert.match(lookup, /`web_fetch`/u, 'a specific page is read with web_fetch');
  console.log(`1) lookup="${lookup}"`);
});

test('2. 禁止用 pwsh/terminal 的 curl、Invoke-WebRequest 抓搜索引擎结果页', () => {
  const lines = toolSelectionLines();
  const banned = lineWith(lines, 'Invoke-WebRequest');
  assert.match(banned, /不要用/u, 'the bullet is a prohibition');
  assert.match(banned, /`pwsh`/u, 'pwsh is named');
  assert.match(banned, /`terminal_open`/u, 'terminal_open is named');
  assert.match(banned, /`curl`/u, 'curl is named');
  assert.match(banned, /搜索引擎结果页/u, 'search-engine result pages are named');
  for (const engine of ['Bing', 'DuckDuckGo', 'Google']) {
    assert.ok(banned.includes(engine), `${engine} is named as an example result page`);
  }
  assert.match(banned, /百科\s*API/u, 'wiki APIs are covered too');
  console.log(`2) banned="${banned}"`);
});

test('3. 限流/空响应/反爬如实说明、不连续换引擎，子任务同样 web 优先', () => {
  const lines = toolSelectionLines();
  const fallback = lineWith(lines, '限流');
  assert.match(fallback, /如实说明/u, 'a failed retrieval is reported honestly');
  assert.match(fallback, /空响应/u, 'empty responses are included');
  assert.match(fallback, /反爬/u, 'anti-bot responses are included');
  assert.match(fallback, /不要连续更换搜索引擎/u, 'engine hopping is refused');
  assert.match(fallback, /派子任务/u, 'delegating the lookup is allowed');
  assert.match(fallback, /子任务同样优先使用\s*`web_search`\s*\/\s*`web_fetch`/u,
    'a subtask follows the same web-first rule');
  console.log(`3) fallback="${fallback}"`);
});

test('4. 没有 web 工具时明确说「当前没有联网搜索工具」，不用 curl 假装搜索', () => {
  const lines = toolSelectionLines();
  const missing = lineWith(lines, '当前没有联网搜索工具');
  assert.match(missing, /工具集中没有/u, 'the bullet is scoped to the session toolset');
  assert.match(missing, /`web_search`\s*\/\s*`web_fetch`/u, 'both web tools are named');
  assert.match(missing, /不要改用\s*curl\s*假装在搜索/u, 'curl must not stand in for a search');
  console.log(`4) missing="${missing}"`);
});

test('5. 现有 TOOL_SELECTION 行与长任务派子任务约定原样保留', () => {
  const lines = toolSelectionLines();
  const headingAt = lines.indexOf('## 执行工具选择');
  assert.equal(headingAt, 0, 'the section heading is first');

  const [dispatchLine] = arrayLines('TASK_DISPATCH').filter((line) => line.includes('先派给子任务（subagent）'));
  assert.ok(dispatchLine !== undefined, 'TASK_DISPATCH still sends long lookups to a subtask first');
  assert.equal(dispatchLine, '- 需要多步执行、耗时较长或要查外部资料的任务，**先派给子任务（subagent）**，立刻用一句话回应（例如「我去查，稍等」），完成后汇报结果。',
    'the long-task dispatch line is unchanged');

  const pwshAt = lines.indexOf('- 执行普通命令时，优先使用一次性命令工具 `pwsh`。');
  assert.ok(pwshAt > headingAt, 'the ordinary-command pwsh line is unchanged');
  const terminalAt = lines.indexOf('- 仅在需要持续交互（等待提示符、多步交互、REPL）时使用 `terminal_open`；若其启动失败，不要反复重试、不要试图扩大权限，改用 `pwsh`，或如实说明当前限制。');
  assert.ok(terminalAt > pwshAt, 'the terminal_open line is unchanged and follows pwsh');
  const webAt = lines.indexOf('### 联网检索');
  assert.ok(webAt > terminalAt, 'the web block is appended after the existing lines');
  assert.equal(lines.filter((line) => line.includes('优先使用一次性命令工具')).length, 1,
    'the pwsh rule is stated once');
  console.log(`5) order heading=${headingAt} pwsh=${pwshAt} terminal=${terminalAt} web=${webAt} dispatchInTaskDispatch=true`);
});

test('6. 联网检索条目不把失败归因于权限或沙箱', () => {
  const webLines = webRetrievalLines(toolSelectionLines());
  assert.ok(webLines.length > 0, 'the web block has bullet lines');
  for (const line of webLines) {
    assert.doesNotMatch(line, /权限|沙箱|sandbox|permission/iu, `no permission/sandbox claim: ${line}`);
  }
  console.log(`6) webLines=${webLines.length} no permission/sandbox claim`);
});
