/** event-log — extracted from store.js; no host entry dependency. */
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

const DEFAULT_ROOT = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-assistant');

const DOMAIN_RE = /^[a-z][a-z0-9_-]{0,31}$/u;


export const nowIso = () => new Date().toISOString();


/** Resolve the assistant root: explicit config wins, otherwise the per-user default. */
export function resolveRoot(config) {
  const raw = config?.root;
  if (typeof raw === 'string' && raw.trim().length > 0) return resolve(raw.trim());
  return DEFAULT_ROOT;
}


/** Normalize a caller-supplied domain, falling back to the configured default. */
export function normalizeDomain(input, config) {
  const fallback = typeof config?.defaultDomain === 'string' ? config.defaultDomain : 'chat';
  if (typeof input !== 'string' || input.trim().length === 0) return fallback;
  const value = input.trim().toLowerCase();
  return DOMAIN_RE.test(value) ? value : fallback;
}


/** Append-only JSONL event log with size-based rotation (10 MB x 5 generations). */
const EVENT_LOG_LIMIT = 10 * 1024 * 1024;

const EVENT_LOG_KEEP = 5;


export class EventLog {
  constructor(root) {
    this.file = join(root, 'data', 'events.jsonl');
  }

  /** Rename the current file once it grows past the limit; oldest generation falls off. */
  rotate() {
    try {
      if (statSync(this.file).size < EVENT_LOG_LIMIT) return;
    } catch {
      return; // no file yet
    }
    for (let index = EVENT_LOG_KEEP - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`);
      } catch {
        // that generation does not exist yet
      }
    }
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // lost the race with another writer; the next emit simply appends
    }
  }

  async emit(type, payload, corrId = null) {
    const event = { id: randomUUID(), ts: nowIso(), type, corr_id: corrId, payload };
    // A late event (after-* timer, shutdown flush) must not recreate a profile root that a test or
    // a user already removed: mkdir here would resurrect the tree and break their cleanup.
    if (!existsSync(dirname(dirname(this.file)))) return event;
    await mkdir(dirname(this.file), { recursive: true });
    this.rotate();
    await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }
}

export { DEFAULT_ROOT, DOMAIN_RE, EVENT_LOG_LIMIT, EVENT_LOG_KEEP };
