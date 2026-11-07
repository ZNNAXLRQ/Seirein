/**
 * Subtitle font picker: registry parsing, fallback, the status snapshot and forced refresh.
 *
 * The registry text is injected (`createSubtitleFontCatalog({ exec })` for the unit cases and
 * `config.subtitleFontExec` for the mounted plugin), so no `reg.exe` process runs here and the
 * result does not depend on which fonts this machine happens to have.
 *
 * Run: node --test test/subtitle-fonts.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  FALLBACK_SUBTITLE_FONTS,
  apply,
  fontFamilyFromValueName,
  parseFontRegistryOutput,
} from '../src/host/index.js';
import { cleanupRoot } from './helpers/cleanup.mjs';

const HKLM = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const HKCU = 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';

/** Fake `reg query` output: a hive header followed by `name    REG_SZ    file` rows. */
const registryOutput = (hive, rows) => [
  hive,
  ...rows.map(([name, file]) => `    ${name}    REG_SZ    ${file}`),
  '',
].join('\r\n');

// ---- parsing ---------------------------------------------------------------------------

test('registry output parses to de-duplicated, sorted family names', () => {
  const output = [
    registryOutput(HKLM, [
      ['Microsoft YaHei UI (TrueType)', 'msyh.ttc'],
      ['Arial (TrueType)', 'arial.ttf'],
      ['Bahnschrift (TrueType)', 'bahnschrift.ttf'],
      // Same family, different file type: the family must appear once.
      ['Arial (OpenType)', 'arial.otf'],
    ]),
    registryOutput(HKCU, [
      // A per-user copy of a system family is the same picker entry.
      ['Arial (TrueType)', 'arial.ttf'],
      ['Microsoft YaHei UI (TrueType)', 'msyh.ttc'],
    ]),
  ].join('\n');

  assert.deepEqual(parseFontRegistryOutput(output), ['Arial', 'Bahnschrift', 'Microsoft YaHei UI']);
  // Header lines, blank lines and stray diagnostics are not font families.
  assert.deepEqual(parseFontRegistryOutput(`${HKLM}\r\n\r\nERROR: The system was unable to find the specified registry key or value.\r\n`), []);
});

test('TrueType/OpenType suffixes are stripped from registry value names', () => {
  assert.equal(fontFamilyFromValueName('Microsoft YaHei UI (TrueType)'), 'Microsoft YaHei UI');
  assert.equal(fontFamilyFromValueName('Source Han Serif SC (OpenType)'), 'Source Han Serif SC');
  assert.equal(fontFamilyFromValueName('方正舒体 (TrueType)'), '方正舒体');
  assert.equal(fontFamilyFromValueName('SimSun'), 'SimSun');

  const families = parseFontRegistryOutput(registryOutput(HKLM, [
    ['Microsoft YaHei UI (TrueType)', 'msyh.ttc'],
    ['Noto Sans CJK SC (OpenType)', 'noto.otf'],
    ['DengXian (TrueType)', 'deng.ttf'],
  ]));
  assert.deepEqual(families, ['DengXian', 'Microsoft YaHei UI', 'Noto Sans CJK SC']);
  assert.ok(families.every((family) => !/\((?:True|Open)Type\)/u.test(family)), 'no suffix leaks into a family');
});

// ---- plugin mount ----------------------------------------------------------------------

/** Minimal DSH context: effect disposers, a tool registry and the two settings routes. */
async function mount({ exec } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subtitle-fonts-'));
  const disposers = [];
  const routes = new Map();
  const effect = (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function' || typeof dispose?.dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    effect,
    tools: { register: () => () => {} },
    get: () => undefined,
    inject: (names, register) => {
      // The prompt section is irrelevant here; the host must still mount without it.
      if (names.includes('webServer')) register({ effect, webServer });
    },
  };
  apply(ctx, { root, defaultDomain: 'chat', enabled: true, subtitleFontExec: exec });
  return {
    root,
    routes,
    disposers,
    status: () => callRoute(routes, '/assistant/status'),
    action: (body) => callRoute(routes, '/assistant/action', body),
  };
}

async function callRoute(routes, path, body) {
  const handler = routes.get(path);
  assert.ok(handler !== undefined, `route registered: ${path}`);
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = body === undefined ? 'GET' : 'POST';
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      this.body = String(text ?? '');
    },
  };
  await handler(req, res);
  return JSON.parse(res.body);
}

/** The status route starts enumeration in the background; poll like the 3 s page poll does. */
async function statusWithFonts(app, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  let snapshot = await app.status();
  while (Date.now() < end && (snapshot.subtitle?.availableFonts ?? []).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = await app.status();
  }
  return snapshot;
}

test('a failed enumeration falls back to the built-in list and records subtitle.fonts.fallback', async (t) => {
  const app = await mount({
    exec: async () => {
      throw new Error('reg.exe unavailable');
    },
  });
  t.after(() => cleanupRoot(app.root, app.disposers));

  const status = await statusWithFonts(app);
  assert.deepEqual(status.subtitle.availableFonts, FALLBACK_SUBTITLE_FONTS, 'the picker still has usable names');
  assert.equal(status.subtitle.truncatedFonts, false);

  const events = (await readFile(join(app.root, 'data', 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const fallback = events.filter((event) => event.type === 'subtitle.fonts.fallback');
  assert.equal(fallback.length, 1, 'the fallback is visible in the event log');
  assert.match(String(fallback[0].payload?.error ?? ''), /reg\.exe unavailable/u);
});

test('status.subtitle exposes at most 1000 families and reports truncation', async (t) => {
  const many = Array.from(
    { length: 1050 },
    (_, index) => [`Font ${String(index).padStart(4, '0')} (TrueType)`, `font${index}.ttf`],
  );
  const broad = await mount({ exec: async () => registryOutput(HKLM, many) });
  t.after(() => cleanupRoot(broad.root, broad.disposers));

  const wide = await statusWithFonts(broad);
  assert.ok(Array.isArray(wide.subtitle.availableFonts), 'availableFonts is an array');
  assert.ok(wide.subtitle.availableFonts.length <= 1000, 'the snapshot is capped at 1000');
  assert.equal(wide.subtitle.availableFonts.length, 1000);
  assert.equal(wide.subtitle.truncatedFonts, true, 'truncation is reported');
  assert.equal(wide.subtitle.availableFonts[0], 'Font 0000');
  assert.equal(wide.subtitle.availableFonts[999], 'Font 0999');

  const few = await mount({
    exec: async () => registryOutput(HKLM, [
      ['SimSun (TrueType)', 'simsun.ttc'],
      ['Arial (TrueType)', 'arial.ttf'],
    ]),
  });
  t.after(() => cleanupRoot(few.root, few.disposers));

  const narrow = await statusWithFonts(few);
  assert.deepEqual(narrow.subtitle.availableFonts, ['Arial', 'SimSun']);
  assert.equal(narrow.subtitle.availableFonts.length, 2);
  assert.equal(narrow.subtitle.truncatedFonts, false);
});

test('subtitle.fonts.refresh forces a new enumeration', async (t) => {
  let calls = 0;
  const app = await mount({
    exec: async () => {
      calls += 1;
      return registryOutput(HKLM, [['Arial (TrueType)', 'arial.ttf']]);
    },
  });
  t.after(() => cleanupRoot(app.root, app.disposers));

  const first = await statusWithFonts(app);
  assert.equal(calls, 1, 'the first status request enumerated exactly once');
  assert.deepEqual(first.subtitle.availableFonts, ['Arial']);

  const refreshed = await app.action({ action: 'subtitle.fonts.refresh' });
  assert.equal(refreshed.ok, true);
  assert.equal(calls, 2, 'refresh re-enumerates even though the cache is warm');
  assert.equal(refreshed.total, 1);
  assert.deepEqual(refreshed.fonts, ['Arial']);

  const after = await app.status();
  assert.equal(calls, 2, 'later status reads are served from the cache');
  assert.deepEqual(after.subtitle.availableFonts, ['Arial']);
});
