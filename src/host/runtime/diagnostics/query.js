/**
 * Controlled, read-only diagnostics channel (P-111).
 *
 * This module is deliberately not a log tail: callers name one of a fixed set of probes, each
 * probe projects its rows through an explicit field whitelist, and every query is bounded by a
 * row limit, an age window and a byte budget. Raw event rows, free-form file contents and
 * credential-looking values never leave here. Querying never writes memory and never calls a
 * model; the only side effect is the `diagnostics.query` audit event.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  VOICE_LATENCY_FIELDS,
  VOICE_LATENCY_OBSERVATION_FIELDS,
  VOICE_LATENCY_OPTIONAL_FIELDS,
} from '../../session/delivery/dispatch.js';

/** Query defaults and hard caps. `limit` is clamped, never trusted. */
export const DIAGNOSTICS_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 50,
  scanBytes: 256 * 1024,
  maxAgeMs: 24 * 60 * 60 * 1000,
});

/** The canonical event probes (aliases are resolved below and never add a new surface). */
const VOICE_FIELDS = Object.freeze([
  'ts',
  'turn',
  'deliveryMessageId',
  'acceptTurn',
  ...VOICE_LATENCY_FIELDS,
  ...VOICE_LATENCY_OPTIONAL_FIELDS,
  ...VOICE_LATENCY_OBSERVATION_FIELDS,
  'firstAudibleLane',
  'firstAudibleUnknown',
  'firstChunkToAudioMs',
  'textToFirstAudioMs',
  'spokenVersionMs',
  'spokenVersionUsed',
  'spokenSource',
]);

/**
 * Noise-shadow rows are metrics only. Transcript fields (`text`, `onlineText`, `offlineText`),
 * the audio device name and internal segment/decode ids are intentionally not projected.
 */
const NOISE_FIELDS = Object.freeze([
  'ts',
  'endpointReason',
  'durationMs',
  'maxDurationMs',
  'voicedMs',
  'voicedRatio',
  'onlineOfflineAgree',
  'playing',
  'rmsDb',
  'peakDb',
  'suspect',
  'delivered',
  'tags',
]);

/** Whitelisted probes. `fields` is the only projection for an event probe. */
export const DIAGNOSTICS_PROBES = Object.freeze({
  'voice.latency': Object.freeze({ kind: 'events', type: 'voice.latency', fields: VOICE_FIELDS }),
  'noise.shadow': Object.freeze({ kind: 'events', type: 'hearing.noise.shadow', fields: NOISE_FIELDS }),
  'hearing.noise.shadow': Object.freeze({ kind: 'events', type: 'hearing.noise.shadow', fields: NOISE_FIELDS }),
  hotkeys: Object.freeze({ kind: 'state', source: 'hotkeys' }),
  hotkey: Object.freeze({ kind: 'state', source: 'hotkeys' }),
  'memory.stats': Object.freeze({ kind: 'state', source: 'memory.stats' }),
  spout: Object.freeze({ kind: 'state', source: 'spout' }),
});

const PROBE_ALIASES = Object.freeze({
  'hearing.noise.shadow': 'noise.shadow',
  hotkey: 'hotkeys',
});

/**
 * Resolve the opt-in switch: an explicit boolean in settings.json is authoritative; otherwise
 * the plugin config is the baseline; absent both the channel is OFF. Exported so the host wiring
 * and the tests share one rule instead of a second copy.
 */
export function resolveDiagnosticsEnabled(settings = null, config = null) {
  const saved = settings?.diagnostics;
  if (saved !== null && typeof saved === 'object' && typeof saved.enabled === 'boolean') return saved.enabled;
  // Config spellings accepted for older hand-written patches: `diagnostics: true`, its nested
  // `enabled` flag, or the flat `diagnosticsEnabled` key. Absent all of them means OFF.
  return config?.diagnostics === true
    || config?.diagnostics?.enabled === true
    || config?.diagnosticsEnabled === true;
}

const SENSITIVE_KEY = /(?:token|secret|password|passwd|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)/i;

/** Strip credential-shaped strings even when a whitelisted field happens to contain one. */
export function redactDiagnosticText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)(?!Bearer\b|Basic\b)[^\s,;]+/gi, '$1[redacted]');
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded recursive sanitizer for state probes (never a raw passthrough). */
export function sanitizeDiagnosticValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactDiagnosticText(value).slice(0, 512);
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 24)) {
      if (SENSITIVE_KEY.test(key) || entry === undefined) continue;
      output[key] = sanitizeDiagnosticValue(entry, depth + 1);
    }
    return output;
  }
  return null;
}

const finiteNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** State probes are built from named fields; unknown fields and sensitive keys never pass. */
const STATE_PROJECTORS = Object.freeze({
  hotkeys(raw) {
    const bindings = [];
    for (const [action, combo] of Object.entries(raw?.bindings ?? {}).slice(0, 32)) {
      if (SENSITIVE_KEY.test(action)) continue;
      bindings.push({ action, combo: sanitizeDiagnosticValue(combo) });
    }
    const last = raw?.lastTrigger ?? null;
    return [{
      bindings,
      lastAction: typeof last?.action === 'string' ? redactDiagnosticText(last.action) : '',
      lastCombo: typeof last?.combo === 'string' ? redactDiagnosticText(last.combo) : '',
      lastAt: typeof last?.ts === 'string' ? redactDiagnosticText(last.ts) : '',
    }];
  },
  'memory.stats'(raw) {
    const usage = raw?.usage ?? {};
    const states = raw?.states ?? {};
    return [{
      records: finiteNumber(usage.records),
      chars: finiteNumber(usage.chars),
      archived: finiteNumber(usage.archived),
      capacity: finiteNumber(usage.capacity),
      ratio: finiteNumber(usage.ratio),
      candidate: finiteNumber(states.candidate),
      delivered: finiteNumber(states.delivered),
      persisted: finiteNumber(states.persisted),
      total: finiteNumber(states.total),
    }];
  },
  spout(raw) {
    return [{
      running: raw?.running === true,
      pid: finiteNumber(raw?.pid),
      configured: raw?.configured === true,
      readyPhase: sanitizeDiagnosticValue(raw?.readyPhase),
      error: sanitizeDiagnosticValue(raw?.error),
      versions: sanitizeDiagnosticValue(raw?.versions),
      captureRect: sanitizeDiagnosticValue(raw?.captureRect),
      alphaSample: sanitizeDiagnosticValue(raw?.alphaSample),
      lastExit: sanitizeDiagnosticValue(raw?.lastExit),
    }];
  },
});

/** Project one event row through its whitelist; no other payload key can leak. */
function projectEventRow(definition, row) {
  const payload = isPlainObject(row?.payload) ? row.payload : {};
  const output = {};
  for (const field of definition.fields) {
    if (field === 'ts') {
      output.ts = typeof row?.ts === 'string' ? redactDiagnosticText(row.ts) : null;
      continue;
    }
    if (!Object.hasOwn(payload, field) || payload[field] === undefined) continue;
    if (SENSITIVE_KEY.test(field)) continue;
    output[field] = sanitizeDiagnosticValue(payload[field]);
  }
  return output;
}

/**
 * Read the current `events.jsonl` from the tail only. A partially read first line is dropped,
 * and `truncated` says the byte budget omitted older bytes (not that the result is invalid).
 */
export function readRecentEvents({ root, maxBytes = DIAGNOSTICS_LIMITS.scanBytes } = {}) {
  const file = join(String(root ?? ''), 'data', 'events.jsonl');
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], truncated: false };
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(1, Math.floor(Number(maxBytes) || DIAGNOSTICS_LIMITS.scanBytes)));
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line);
        if (isPlainObject(row)) rows.push(row);
      } catch {
        // A torn line is skipped; the rest of the tail is still usable.
      }
    }
    return { rows, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** Make a state provider safe: a throwing provider must not break the HTTP action. */
function readState(projector, provider) {
  try {
    const raw = typeof provider === 'function' ? provider() : provider;
    return { ok: true, rows: projector(raw) };
  } catch (error) {
    return { ok: false, error: redactDiagnosticText(error?.message ?? String(error)) };
  }
}

/**
 * Create the one diagnostics service for a host mount.
 *
 * @param {{root?: string, isEnabled?: (() => boolean)|boolean,
 *   sources?: Record<string, Function>, emit?: ((type: string, payload: object) => unknown)|null,
 *   readTail?: ((input: {root: string, maxBytes: number}) => {rows: object[], truncated: boolean})|null,
 *   now?: () => number}} [options]
 */
export function createDiagnostics({
  root = '',
  isEnabled = () => false,
  sources = {},
  emit = null,
  readTail = null,
  now = () => Date.now(),
} = {}) {
  const enabled = () => (typeof isEnabled === 'function' ? isEnabled() === true : isEnabled === true);
  const reader = typeof readTail === 'function' ? readTail : readRecentEvents;

  return {
    /**
     * @param {{probe?: string, limit?: number}} [input]
     * @returns {Promise<{ok: boolean, probe?: string, rows?: object[], truncated?: boolean,
     *   ms?: number, reason?: string, error?: string}>}
     */
    async query(input = {}) {
      // Checked before anything is read: a disabled channel has no read side effect at all.
      if (!enabled()) return { ok: false, reason: 'disabled' };

      const probe = typeof input.probe === 'string' ? input.probe.trim() : '';
      const definition = Object.hasOwn(DIAGNOSTICS_PROBES, probe) ? DIAGNOSTICS_PROBES[probe] : null;
      if (definition === null) {
        return { ok: false, reason: 'invalid-probe', probe: probe.slice(0, 64), rows: [], truncated: false, ms: 0 };
      }

      const started = now();
      const requestedLimit = input.limit === undefined || input.limit === null ? null : Number(input.limit);
      let limit = requestedLimit === null || !Number.isFinite(requestedLimit)
        ? DIAGNOSTICS_LIMITS.defaultLimit
        : Math.trunc(requestedLimit);
      limit = Math.min(DIAGNOSTICS_LIMITS.maxLimit, Math.max(1, limit));

      if (definition.kind === 'state') {
        const canonical = PROBE_ALIASES[probe] ?? probe;
        const result = readState(STATE_PROJECTORS[canonical], sources[canonical]);
        const ms = Math.max(0, Math.round(now() - started));
        if (!result.ok) {
          audit(emit, { probe, limit, ms, truncated: false });
          return { ok: false, reason: 'source-failed', probe, rows: [], truncated: false, ms, error: result.error };
        }
        audit(emit, { probe, limit, ms, truncated: false });
        return { ok: true, probe, rows: result.rows, truncated: false, ms };
      }

      let tail;
      try {
        tail = reader({ root, maxBytes: DIAGNOSTICS_LIMITS.scanBytes });
      } catch (error) {
        const ms = Math.max(0, Math.round(now() - started));
        audit(emit, { probe, limit, ms, truncated: false });
        return {
          ok: false, reason: 'read-failed', probe, rows: [], truncated: false, ms,
          error: redactDiagnosticText(error?.message ?? String(error)),
        };
      }

      const nowMs = now();
      const rows = [];
      let extraMatches = 0;
      let ageTruncated = false;
      for (let index = tail.rows.length - 1; index >= 0; index -= 1) {
        const row = tail.rows[index];
        if (row?.type !== definition.type) continue;
        const at = Date.parse(row?.ts);
        if (Number.isFinite(at) && nowMs - at > DIAGNOSTICS_LIMITS.maxAgeMs) {
          ageTruncated = true;
          continue;
        }
        if (rows.length >= limit) {
          extraMatches += 1;
          continue;
        }
        rows.push(projectEventRow(definition, row));
      }

      const truncated = tail.truncated === true || extraMatches > 0 || ageTruncated;
      const ms = Math.max(0, Math.round(now() - started));
      audit(emit, { probe, limit, ms, truncated });
      return { ok: true, probe, rows, truncated, ms };
    },
  };
}

/**
 * The audit event is best-effort and never gates the answer. `emit` is invoked without awaiting:
 * a logger that never settles cannot hold the query, and a logger that throws (sync or async)
 * cannot change the result. A failed audit is reported as one non-blocking
 * `diagnostics.audit.failed {error}` through the same emitter; if that channel is broken too the
 * failure simply cannot be recorded, which is still better than blocking the read.
 */
function audit(emit, payload) {
  if (typeof emit !== 'function') return;
  const reportFailure = (error) => {
    try {
      const detail = redactDiagnosticText(error?.message ?? String(error));
      Promise.resolve(emit('diagnostics.audit.failed', { error: detail })).catch(() => {});
    } catch {
      /* a logger broken for the query is usually broken for its own failure record */
    }
  };
  try {
    // Rejections and never-settling promises are both absorbed here; nothing is awaited.
    Promise.resolve(emit('diagnostics.query', payload)).catch(reportFailure);
  } catch (error) {
    // Deferred so even a synchronous logger throw stays off the query's return path.
    queueMicrotask(() => reportFailure(error));
  }
}
