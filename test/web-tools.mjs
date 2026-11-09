/**
 * Web tools regression: the Seirein preset only had vision / hearing / memory / OBS / Live2D /
 * terminal tools, so a model that needed current information reached for `terminal_open` + curl and
 * got anti-bot or empty responses. These two plugin tools borrow the optional Harness `web` service
 * (`ctx.get('web')`) without shadowing the host's own `web_search` / `web_fetch` names.
 *
 * Proves:
 *  1. `assistant_web_search` / `assistant_web_fetch` are registered with strict, complete schemas;
 *  2. search clamps `maxResults` to 1..8, maps every source field, and bounds the result list;
 *  3. an empty search is still a successful result; a thrown/not-ready search is a short failure
 *     object with its WebError code, never a stack or raw HTML;
 *  4. fetch accepts only http/https, returns non-2xx as a result, truncates the body to 12000
 *     characters, and keeps failures short;
 *  4b. fetch render returns the whole retained body (not a 600-character preview), so an answer
 *     past character 600 reaches the model; a 12000-character cut is named in the header;
 *  5. a missing `web` service answers 「当前没有联网搜索工具」 instead of falling back to curl;
 *  6. the event log records only input length, result count and code — never the query or URL body.
 *
 * No network and no real Host: every case mounts the plugin against a fake context and a fake
 * `web` service.
 *
 * Run: node --test test/web-tools.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../src/host/index.js';
import { EventLog } from '../src/host/runtime/event-log.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

/** Validate one value against the tool-output schema subset (type/oneOf/object/array/enum/const). */
function validate(schema, value, path = 'value') {
  if (Object.hasOwn(schema, 'oneOf')) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path} must match exactly one oneOf branch`);
    return;
  }
  if (Object.hasOwn(schema, 'type')) {
    assert.ok(TYPE_CHECKS[schema.type](value), `${path} must be of type ${schema.type}`);
  }
  if (Object.hasOwn(schema, 'enum')) assert.ok(schema.enum.includes(value), `${path} is not an enum member`);
  if (Object.hasOwn(schema, 'const')) assert.equal(value, schema.const, `${path} must equal const`);
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object', `${path} must be an object`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(properties, key), `"${path}.${key}" is not a declared property`);
      }
    }
  }
  if (schema.type === 'array') {
    for (const [index, item] of value.entries()) validate(schema.items ?? {}, item, `${path}[${index}]`);
  }
}

/** Mount the plugin once against a fake context and expose its tool map. */
async function mount(t, web) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-tools-'));
  const disposers = [];
  t.after(() => cleanupRoot(root, disposers));

  const tools = new Map();
  const ctx = {
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    get: (name) => name === 'web' ? web : undefined,
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true });
  return { tools, root };
}

/** A fake `web` service plus every call it received. */
function fakeWeb(overrides = {}) {
  const calls = { search: [], fetch: [], searchReady: [], fetchReady: [] };
  const web = {
    async searchReady(provider) {
      calls.searchReady.push(provider);
      return true;
    },
    async fetchReady(provider) {
      calls.fetchReady.push(provider);
      return true;
    },
    async search(request, signal) {
      calls.search.push({ request, signal });
      return { content: '', sources: [], truncated: false };
    },
    async fetch(request, signal) {
      calls.fetch.push({ request, signal });
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '' }, truncated: false };
    },
    ...overrides,
  };
  return { web, calls };
}

async function call(tools, name, args = {}, exec = {}) {
  const tool = tools.get(name);
  assert.ok(tool !== undefined, `${name} is registered`);
  return { tool, value: await tool.execute(args, exec) };
}

/** The exact text the Harness would show the model for one result. */
function rendered(tool, args, value) {
  return tool.output.render(args, value).map((block) => block.text).join('\n');
}

test('1. registers assistant_web_search / assistant_web_fetch with strict, complete schemas', async (t) => {
  const { tools } = await mount(t, fakeWeb().web);

  assert.ok(tools.has('assistant_web_search'), 'assistant_web_search is registered');
  assert.ok(tools.has('assistant_web_fetch'), 'assistant_web_fetch is registered');
  assert.equal(tools.has('web_search'), false, 'the host web_search name is not shadowed');

  const search = tools.get('assistant_web_search');
  assert.equal(search.parameters.additionalProperties, false);
  assert.deepEqual([...Object.keys(search.parameters.properties)].sort(), ['maxResults', 'query']);
  assert.equal(search.parameters.properties.maxResults.minimum, 1);
  assert.equal(search.parameters.properties.maxResults.maximum, 8);
  assert.equal(search.output.schema.additionalProperties, false);
  assert.deepEqual(
    [...Object.keys(search.output.schema.properties)].sort(),
    ['code', 'content', 'error', 'ok', 'query', 'sources', 'truncated'],
  );
  const sourceSchema = search.output.schema.properties.sources.items;
  assert.equal(sourceSchema.additionalProperties, false);
  assert.deepEqual(
    [...Object.keys(sourceSchema.properties)].sort(),
    ['publishedAt', 'snippet', 'summary', 'title', 'url'],
  );
  assert.deepEqual(
    [...sourceSchema.required].sort(),
    ['publishedAt', 'snippet', 'summary', 'title', 'url'],
  );

  const fetch = tools.get('assistant_web_fetch');
  assert.equal(fetch.parameters.additionalProperties, false);
  assert.deepEqual([...Object.keys(fetch.parameters.properties)], ['url']);
  assert.equal(fetch.output.schema.additionalProperties, false);
  assert.deepEqual(
    [...Object.keys(fetch.output.schema.properties)].sort(),
    ['code', 'content', 'contentType', 'error', 'ok', 'statusCode', 'truncated', 'url'],
  );
  assert.deepEqual(fetch.output.schema.properties.contentType.enum, ['html', 'text']);
  console.log('1) both tools registered; schemas declare every returned field');
});

test('2. search success maps every source field, calls the service, and renders the summary', async (t) => {
  const { web, calls } = fakeWeb();
  web.search = async (request, signal) => {
    calls.search.push({ request, signal });
    return {
      content: '<b>答案</b>',
      sources: [
        {
          url: 'https://example.com/a',
          title: 'Title A',
          snippet: 'Snippet A',
          summary: 'Summary A',
          publishedAt: '2026-01-02',
        },
        { url: 'https://example.com/b', title: 'Title B', snippet: 'Snippet B' },
      ],
      truncated: false,
    };
  };
  const { tools } = await mount(t, web);

  const args = { query: '天气 上海', maxResults: 5 };
  const { tool, value } = await call(tools, 'assistant_web_search', args);

  assert.deepEqual(value, {
    ok: true,
    query: '天气 上海',
    content: '<b>答案</b>',
    sources: [
      {
        url: 'https://example.com/a',
        title: 'Title A',
        snippet: 'Snippet A',
        summary: 'Summary A',
        publishedAt: '2026-01-02',
      },
      { url: 'https://example.com/b', title: 'Title B', snippet: 'Snippet B', summary: '', publishedAt: '' },
    ],
    truncated: false,
  });
  assert.deepEqual(calls.search[0].request, { query: '天气 上海', maxResults: 5 });
  assert.equal(calls.searchReady.length, 1, 'readiness is checked before searching');

  validate(tool.output.schema, value);
  const text = rendered(tool, args, value);
  assert.ok(text.includes('https://example.com/a'), 'the rendered text lists the URL');
  assert.ok(text.includes('Title A'), 'the rendered text lists the title');
  assert.ok(text.includes('Summary A'), 'the rendered text prefers the summary');
  assert.ok(text.includes('Snippet B'), 'a source without a summary falls back to its snippet');
  assert.ok(text.includes('答案'), 'the optional answer reaches the model');
  assert.equal(text.includes('<b>'), false, 'HTML is stripped from the rendered summary');
  console.log('2) search success: source fields complete; render has titles/URLs/summaries');
});

test('3. search clamps maxResults to 1..8 and bounds an over-returning provider', async (t) => {
  const { web, calls } = fakeWeb();
  const sources = Array.from({ length: 10 }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: `Title ${index}`,
    snippet: `Snippet ${index}`,
    summary: `Summary ${index}`,
    publishedAt: '2026-01-01',
  }));
  web.search = async (request, signal) => {
    calls.search.push({ request, signal });
    return { content: '', sources, truncated: false };
  };
  const { tools } = await mount(t, web);

  const high = await call(tools, 'assistant_web_search', { query: 'x', maxResults: 99 });
  assert.equal(high.value.sources.length, 8, 'an oversized maxResults is clamped to 8');
  assert.equal(high.value.truncated, true, 'a trimmed list is marked truncated');
  assert.deepEqual(calls.search[0].request, { query: 'x', maxResults: 8 });

  const low = await call(tools, 'assistant_web_search', { query: 'x', maxResults: 0 });
  assert.equal(low.value.sources.length, 1, 'a zero maxResults is clamped to 1');
  assert.equal(low.value.truncated, true);
  assert.deepEqual(calls.search[1].request, { query: 'x', maxResults: 1 });

  const omitted = await call(tools, 'assistant_web_search', { query: 'x' });
  assert.equal(omitted.value.sources.length, 8, 'the default is the documented maximum');
  assert.deepEqual(calls.search[2].request, { query: 'x', maxResults: 8 });
  validate(high.tool.output.schema, high.value);
  console.log('3) maxResults 99 -> 8, 0 -> 1, omitted -> 8; sources never exceed the request');
});

test('4. an empty search is still a successful result and renders as no sources', async (t) => {
  const { web } = fakeWeb();
  web.search = async () => ({ sources: [], truncated: false });
  const { tools } = await mount(t, web);

  const args = { query: '没有结果的查询' };
  const { tool, value } = await call(tools, 'assistant_web_search', args);
  assert.deepEqual(value, {
    ok: true,
    query: '没有结果的查询',
    content: '',
    sources: [],
    truncated: false,
  });
  validate(tool.output.schema, value);
  assert.ok(rendered(tool, args, value).includes('没有找到来源'), 'the render says no sources were found');
  console.log('4) empty search -> ok:true with an empty source list');
});

test('5. search failures keep only a short code/message and are skipped when not ready', async (t) => {
  const { web, calls } = fakeWeb();
  const { tools } = await mount(t, web);

  web.searchReady = async (provider) => {
    calls.searchReady.push(provider);
    return false;
  };
  const notReady = await call(tools, 'assistant_web_search', { query: 'x' });
  assert.equal(notReady.value.ok, false);
  assert.equal(notReady.value.code, 'WEB_NOT_READY');
  assert.match(notReady.value.error, /未就绪/u);
  assert.equal(calls.search.length, 0, 'search is not called when readiness is false');
  validate(notReady.tool.output.schema, notReady.value);

  web.searchReady = async () => true;
  web.search = async () => {
    throw Object.assign(new Error('<html>blocked</html>\n at C:\\secret\\provider.js:1'), {
      code: 'WEB_PROVIDER_UNAVAILABLE',
    });
  };
  const failed = await call(tools, 'assistant_web_search', { query: 'x' });
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error, 'blocked', 'tags, stack and HTML are stripped');
  assert.equal(failed.value.code, 'WEB_PROVIDER_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.value).includes('secret'), false, 'no stack leaks');
  assert.equal(rendered(failed.tool, { query: 'x' }, failed.value).includes('<html>'), false,
    'the failure render does not carry HTML');
  validate(failed.tool.output.schema, failed.value);

  web.searchReady = async () => {
    throw Object.assign(new Error('auth failed'), { code: 'WEB_AUTH' });
  };
  const readinessError = await call(tools, 'assistant_web_search', { query: 'x' });
  assert.equal(readinessError.value.ok, false);
  assert.equal(readinessError.value.code, 'WEB_AUTH', 'a readiness error keeps the WebError code');
  assert.equal(readinessError.value.error, 'auth failed');
  console.log('5) not-ready -> WEB_NOT_READY; thrown HTML/stack -> short message + code');
});

test('6. fetch accepts http/https and refuses every other scheme before the service call', async (t) => {
  const { web, calls } = fakeWeb();
  const { tools } = await mount(t, web);

  for (const url of ['http://example.com/a', 'https://example.com/b']) {
    const { value } = await call(tools, 'assistant_web_fetch', { url });
    assert.equal(value.ok, true, `${url} is accepted`);
    assert.equal(value.statusCode, 200);
    assert.equal(value.contentType, 'text');
  }
  assert.equal(calls.fetch.length, 2, 'both http and https reached web.fetch');

  const before = calls.fetch.length;
  for (const url of [
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/file',
    'not a url',
  ]) {
    const { tool, value } = await call(tools, 'assistant_web_fetch', { url });
    assert.equal(value.ok, false, `${url} is refused`);
    assert.equal(value.code, 'INVALID_URL');
    assert.match(value.error, /http\/https/u);
    validate(tool.output.schema, value);
  }
  assert.equal(calls.fetch.length, before, 'no non-http(s) URL reaches web.fetch');
  console.log('6) http/https pass; file/javascript/data/ftp/relative URLs are refused without a call');
});

test('7. fetch returns non-2xx as a result and names the content type', async (t) => {
  const { web } = fakeWeb();
  const { tools } = await mount(t, web);

  web.fetch = async (request) => ({
    url: request.url,
    statusCode: 404,
    body: { kind: 'text', content: 'Not Found' },
    truncated: false,
  });
  const missing = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/missing' });
  assert.deepEqual(missing.value, {
    ok: true,
    url: 'https://example.com/missing',
    statusCode: 404,
    contentType: 'text',
    content: 'Not Found',
    truncated: false,
  });
  validate(missing.tool.output.schema, missing.value);
  const missingText = rendered(missing.tool, { url: 'https://example.com/missing' }, missing.value);
  assert.ok(missingText.includes('HTTP 404'), 'the render shows the status code');
  assert.ok(missingText.includes('text'), 'the render shows the content type');

  web.fetch = async (request) => ({
    url: request.url,
    statusCode: 200,
    body: { kind: 'html', content: '<html><body><p>Hello</p></body></html>' },
    truncated: false,
  });
  const page = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/page' });
  assert.equal(page.value.contentType, 'html');
  const pageText = rendered(page.tool, { url: 'https://example.com/page' }, page.value);
  assert.ok(pageText.includes('HTTP 200'));
  assert.ok(pageText.includes('html'));
  assert.ok(pageText.includes('Hello'), 'the preview keeps readable page text');
  assert.equal(pageText.includes('<html>'), false, 'the full HTML document is not dumped into render');
  console.log('7) 404 is ok:true; render shows status and content type; HTML is not dumped whole');
});

test('8. fetch truncates the body to 12000 characters and marks truncated', async (t) => {
  const { web } = fakeWeb();
  const { tools } = await mount(t, web);
  const body = 'x'.repeat(13_000);

  web.fetch = async (request) => ({
    url: request.url,
    statusCode: 200,
    body: { kind: 'text', content: body },
    truncated: false,
  });
  const args = { url: 'https://example.com/long' };
  const { tool, value } = await call(tools, 'assistant_web_fetch', args);
  assert.equal(value.ok, true);
  assert.equal(value.content.length, 12_000, 'the body is capped at 12000 characters');
  assert.equal(value.content, body.slice(0, 12_000));
  assert.equal(value.truncated, true, 'a body the tool cut is marked truncated');
  validate(tool.output.schema, value);
  const text = rendered(tool, args, value);
  assert.ok(text.length < body.length, 'render stays shorter than the full body');
  assert.ok(text.includes(body.slice(0, 12_000)), 'the whole retained 12000-character body reaches the model');
  assert.ok(text.includes('内容已截断'), 'render marks the cut body');
  assert.ok(text.includes('仅前 12000 字'), 'render names the 12000-character cap');
  assert.ok(text.length <= 12_000 + 200, 'render stays bounded by the same 12000-character budget');

  web.fetch = async (request) => ({
    url: request.url,
    statusCode: 200,
    body: { kind: 'text', content: 'short' },
    truncated: true,
  });
  const providerCut = await call(tools, 'assistant_web_fetch', args);
  assert.equal(providerCut.value.content, 'short');
  assert.equal(providerCut.value.truncated, true, 'a provider truncation flag is preserved');
  console.log('8) 13000 -> 12000 chars, truncated:true; provider truncation is preserved');
});

test('9. fetch failures keep only a short code/message and are skipped when not ready', async (t) => {
  const { web, calls } = fakeWeb();
  const { tools } = await mount(t, web);

  web.fetchReady = async (provider) => {
    calls.fetchReady.push(provider);
    return false;
  };
  const notReady = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/x' });
  assert.equal(notReady.value.ok, false);
  assert.equal(notReady.value.code, 'WEB_NOT_READY');
  assert.match(notReady.value.error, /未就绪/u);
  assert.equal(calls.fetch.length, 0, 'fetch is not called when readiness is false');
  validate(notReady.tool.output.schema, notReady.value);

  web.fetchReady = async () => true;
  web.fetch = async () => {
    throw Object.assign(new Error('<html>bad gateway</html>\n at C:\\secret\\fetch.js:1'), {
      code: 'WEB_PROVIDER_UNAVAILABLE',
    });
  };
  const failed = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/x' });
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error, 'bad gateway');
  assert.equal(failed.value.code, 'WEB_PROVIDER_UNAVAILABLE');
  assert.equal(JSON.stringify(failed.value).includes('secret'), false);
  assert.equal(rendered(failed.tool, { url: 'https://example.com/x' }, failed.value).includes('<html>'), false);
  assert.equal(
    rendered(failed.tool, { url: 'https://example.com/x' }, failed.value),
    '联网抓取失败：bad gateway（WEB_PROVIDER_UNAVAILABLE）',
    'the failure render is unchanged: short message plus code only',
  );
  validate(failed.tool.output.schema, failed.value);

  web.fetchReady = async () => {
    throw Object.assign(new Error('auth failed'), { code: 'WEB_AUTH' });
  };
  const readinessError = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/x' });
  assert.equal(readinessError.value.ok, false);
  assert.equal(readinessError.value.code, 'WEB_AUTH');
  assert.equal(readinessError.value.error, 'auth failed');
  console.log('9) not-ready -> WEB_NOT_READY; thrown HTML/stack -> short message + code');
});

test('10. a missing web service says 当前没有联网搜索工具 and never reaches curl/terminal', async (t) => {
  const { tools } = await mount(t, undefined);

  const search = await call(tools, 'assistant_web_search', { query: 'x' });
  assert.deepEqual(search.value, {
    ok: false,
    query: 'x',
    error: '当前没有联网搜索工具',
    code: 'WEB_UNAVAILABLE',
  });
  validate(search.tool.output.schema, search.value);

  const fetch = await call(tools, 'assistant_web_fetch', { url: 'https://example.com/page' });
  assert.equal(fetch.value.ok, false);
  assert.equal(fetch.value.error, '当前没有联网搜索工具');
  assert.equal(fetch.value.code, 'WEB_UNAVAILABLE');
  assert.equal(fetch.value.url, 'https://example.com/page');
  validate(fetch.tool.output.schema, fetch.value);

  // The plugin never registers a shell fallback of its own and the fake context exposes no
  // terminal service, so the explicit answer is the whole path.
  assert.equal(tools.has('terminal_open'), false);
  assert.equal(tools.has('pwsh'), false);
  console.log('10) missing web service -> explicit no-tool error, no shell fallback');
});

test('11. events carry only input length/result count/status/code, never query or URL body', async (t) => {
  const emitted = [];
  const originalEmit = EventLog.prototype.emit;
  EventLog.prototype.emit = async function emit(type, payload, corrId) {
    emitted.push({ type, payload });
    return originalEmit.call(this, type, payload, corrId);
  };

  try {
    const { web } = fakeWeb();
    web.search = async () => ({
      content: '',
      sources: [{ url: 'https://example.com/result', title: 'Result' }],
      truncated: false,
    });
    web.fetch = async (request) => ({
      url: request.url,
      statusCode: 200,
      body: { kind: 'text', content: 'hello' },
      truncated: false,
    });
    const { tools } = await mount(t, web);

    const query = '绝密查询-不应写入事件';
    await call(tools, 'assistant_web_search', { query, maxResults: 2 });
    const url = 'https://example.com/private?token=secret';
    await call(tools, 'assistant_web_fetch', { url });

    const searchEvents = emitted.filter((event) => event.type === 'web.search');
    const fetchEvents = emitted.filter((event) => event.type === 'web.fetch');
    assert.equal(searchEvents.length, 1, 'one search event is written');
    assert.equal(fetchEvents.length, 1, 'one fetch event is written');
    assert.equal(searchEvents[0].payload.queryLength, query.length);
    assert.equal(searchEvents[0].payload.resultCount, 1);
    assert.equal(searchEvents[0].payload.code, '');
    assert.equal(fetchEvents[0].payload.urlLength, url.length);
    assert.equal(fetchEvents[0].payload.statusCode, 200);
    assert.equal(fetchEvents[0].payload.contentType, 'text');
    assert.equal(fetchEvents[0].payload.contentLength, 5);
    for (const event of [...searchEvents, ...fetchEvents]) {
      const text = JSON.stringify(event.payload);
      assert.equal(text.includes(query), false, 'the query body is not in the event');
      assert.equal(text.includes(url), false, 'the URL body is not in the event');
      assert.equal(Object.hasOwn(event.payload, 'query'), false);
      assert.equal(Object.hasOwn(event.payload, 'url'), false);
    }
    console.log('11) event payloads keep only lengths, counts, status, content type and code');
  } finally {
    EventLog.prototype.emit = originalEmit;
  }
});

test('12. fetch render shows the full body, including content past 600 characters', async (t) => {
  const { web } = fakeWeb();
  const { tools } = await mount(t, web);
  const prefix = 'x'.repeat(700);
  const answer = '答案在 600 字之后';
  const body = `${prefix}${answer}${'y'.repeat(912 - prefix.length - answer.length)}`;
  assert.equal(body.length, 912, 'the fake page is exactly 912 characters');
  assert.ok(body.indexOf(answer) > 600, 'the answer starts after character 600');

  web.fetch = async (request) => ({
    url: request.url,
    statusCode: 200,
    body: { kind: 'text', content: body },
    truncated: false,
  });
  const args = { url: 'https://example.com/912' };
  const { tool, value } = await call(tools, 'assistant_web_fetch', args);
  assert.equal(value.content, body);
  assert.equal(value.content.length, 912);
  assert.equal(value.truncated, false, 'a 912-character body is not truncated');
  validate(tool.output.schema, value);

  const text = rendered(tool, args, value);
  assert.ok(text.includes(answer), 'the answer after character 600 reaches the model');
  assert.ok(text.includes(body), 'the whole 912-character body is rendered, not a 600-character prefix');
  assert.ok(text.includes('HTTP 200'));
  assert.equal(text.includes('内容已截断'), false, 'an untruncated body has no cut marker');
  console.log('12) 912-char page renders in full; an answer past character 600 is visible');
});
