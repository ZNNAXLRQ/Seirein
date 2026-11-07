import { execFile } from 'node:child_process';
import { parseFontRegistryOutput } from '../shared/text.js';

// ---- subtitle fonts (Windows registry) ------------------------------------
//
// The subtitle card offers a picker instead of a free-text font name, so the host enumerates the
// installed families once and caches them. `reg query` prints value names such as
// `Microsoft YaHei UI (TrueType)`; the family is that name with the type suffix removed.

/** Fonts hives: machine-wide installs first, then per-user installs. */
const FONT_REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
];

/** Always-present families used when the registry cannot be read at all. */
export const FALLBACK_SUBTITLE_FONTS = [
  'Microsoft YaHei UI',
  '微软雅黑',
  'SimSun',
  'Microsoft JhengHei',
  'Segoe UI',
];

/** `reg query` writes the console code page: strict UTF-8 first, then GBK (zh-CN consoles). */
function decodeRegistryBytes(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      /* try the next code page */
    }
  }
  return bytes.toString('utf8');
}

/** One `reg query` for one hive; resolves its decoded output. */
function queryFontRegistry(key) {
  return new Promise((resolveQuery, rejectQuery) => {
    execFile(
      'reg',
      ['query', key],
      { windowsHide: true, timeout: 10_000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) rejectQuery(error);
        else resolveQuery(decodeRegistryBytes(stdout));
      },
    );
  });
}

/** Default source: both hives concatenated; rejects only when neither hive answers. */
export async function readWindowsFontRegistry() {
  const results = await Promise.allSettled(FONT_REGISTRY_KEYS.map((key) => queryFontRegistry(key)));
  const text = results
    .filter((entry) => entry.status === 'fulfilled')
    .map((entry) => entry.value)
    .join('\n');
  if (text.trim().length === 0) {
    const failure = results.find((entry) => entry.status === 'rejected');
    throw failure?.reason instanceof Error ? failure.reason : new Error('font registry unavailable');
  }
  return text;
}

/**
 * In-process catalog of installed font families for the subtitle picker: the first request
 * enumerates, later reads hit the cache, and `refresh()` forces a new enumeration.
 * @param {object} [options]
 * @param {() => Promise<string>} [options.exec] font source; injected by tests
 * @param {(type: string, payload?: object) => unknown} [options.onEvent] fallback logger
 * @param {number} [options.limit] status snapshot cap; a desktop has ~400 families, so the cap only
 * guards against pathological registries. The current font is prepended by the picker if missing.
 */
export function createSubtitleFontCatalog({ exec = readWindowsFontRegistry, onEvent = async () => {}, limit = 1000 } = {}) {
  let families = null;
  let source = '';
  let inFlight = null;
  const enumerate = async () => {
    let entries;
    try {
      entries = parseFontRegistryOutput(await exec());
      // An empty result is a failure too: a real Windows box always has fonts installed.
      if (entries.length === 0) throw new Error('no font family in registry output');
      source = 'registry';
    } catch (error) {
      entries = [...FALLBACK_SUBTITLE_FONTS];
      source = 'fallback';
      // Logging is attempted and awaited, but a failing log must not turn every poll into a
      // retry of the same doomed enumeration.
      try {
        await onEvent('subtitle.fonts.fallback', { error: error?.message ?? String(error) });
      } catch {
        /* the fallback list still stands */
      }
    }
    families = entries;
    return families;
  };
  const ensure = () => {
    if (families !== null) return Promise.resolve(families);
    if (inFlight === null) {
      inFlight = enumerate().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  const refresh = async () => {
    // Let a request already in flight settle, then drop the cache so the next read is a new query.
    if (inFlight !== null) await inFlight.catch(() => {});
    families = null;
    inFlight = null;
    return ensure();
  };
  const snapshot = () => ({
    fonts: (families ?? []).slice(0, limit),
    truncated: (families ?? []).length > limit,
    total: (families ?? []).length,
    source,
    pending: families === null,
  });
  return { ensure, refresh, snapshot };
}
