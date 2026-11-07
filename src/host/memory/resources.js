/**
 * Resource layer — the "important, long-lived information" vault.
 *
 * Distinct from:
 *  - persona (`persona.md`): who the agent is;
 *  - episodic memory (per-domain `*.db`): what happened.
 *
 * This layer holds standing instructions and lookups the user expects the agent to *always*
 * know: "anime info comes from Bangumi", "code references come from GitHub", and optionally
 * credentials. Entries are keyed and tagged, not semantically searched.
 *
 * Secrets are encrypted at rest with Windows DPAPI (user scope) via PowerShell, so the
 * ciphertext is only usable by the same Windows account on the same machine. Plaintext is
 * passed through the child process environment, never argv.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const KIND_ENUM = ['source', 'endpoint', 'convention', 'credential', 'note'];
const SECRET_PREFIX = 'dpapi:';

/** Run a small PowerShell snippet, optionally with env vars. */
function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Encrypt with DPAPI (user scope). Returns a `dpapi:<hex>` string. */
export async function encryptSecret(plaintext) {
  const script = [
    "$ErrorActionPreference = 'Stop';",
    '$sec = ConvertTo-SecureString -String $env:RS_PLAIN -AsPlainText -Force;',
    'ConvertFrom-SecureString -SecureString $sec',
  ].join(' ');
  const hex = (await runPowerShell(script, { RS_PLAIN: plaintext })).trim();
  if (hex.length === 0) throw new Error('DPAPI encryption returned nothing');
  return `${SECRET_PREFIX}${hex}`;
}

/** Decrypt a `dpapi:<hex>` string. */
export async function decryptSecret(stored) {
  if (!stored.startsWith(SECRET_PREFIX)) throw new Error('not a DPAPI secret');
  const script = [
    "$ErrorActionPreference = 'Stop';",
    '$sec = ConvertTo-SecureString $env:RS_ENC;',
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec);',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) }',
    'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
  ].join(' ');
  const out = await runPowerShell(script, { RS_ENC: stored.slice(SECRET_PREFIX.length) });
  return out.replace(/\r?\n$/u, '');
}

/** SQLite-backed resource vault in `memory/profile.db`. */
export class ResourceStore {
  constructor(root) {
    this.file = join(root, 'memory', 'profile.db');
    this.db = null;
  }

  open() {
    if (this.db !== null) return this.db;
    mkdirSync(join(this.file, '..'), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS resource (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      value TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      secret INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.db = db;
    return db;
  }

  /** Insert or replace one resource. Secrets are encrypted before they reach SQLite. */
  async set({ key, value, kind = 'note', title = '', tags = '', secret = false }) {
    const db = this.open();
    const normalizedKind = KIND_ENUM.includes(kind) ? kind : 'note';
    const stored = secret ? await encryptSecret(value) : value;
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id, created_at FROM resource WHERE key = ?').get(key);
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? now;
    db.prepare(
      `INSERT INTO resource (id, key, kind, title, value, tags, secret, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, value = excluded.value,
         tags = excluded.tags, secret = excluded.secret, updated_at = excluded.updated_at`,
    ).run(id, key, normalizedKind, title, stored, tags, secret ? 1 : 0, createdAt, now);
    return { id, key, kind: normalizedKind, title, tags, secret };
  }

  /** Read one resource. Secret plaintext requires `reveal`. */
  async get(key, { reveal = false } = {}) {
    const db = this.open();
    const row = db.prepare('SELECT * FROM resource WHERE key = ?').get(key);
    if (row === undefined) return null;
    const secret = row.secret === 1;
    let value;
    if (secret) {
      value = reveal ? await decryptSecret(row.value) : '••••••';
    } else {
      value = row.value;
    }
    return {
      key: row.key,
      kind: row.kind,
      title: row.title,
      tags: row.tags,
      secret,
      value,
      updatedAt: row.updated_at,
    };
  }

  /** List entries without values. */
  list({ tag = '' } = {}) {
    const db = this.open();
    const rows = db.prepare('SELECT key, kind, title, tags, secret, updated_at FROM resource ORDER BY updated_at DESC').all();
    const filtered = tag.length === 0
      ? rows
      : rows.filter((row) => String(row.tags).split(',').map((part) => part.trim()).includes(tag));
    return filtered.map((row) => ({
      key: row.key,
      kind: row.kind,
      title: row.title,
      tags: row.tags,
      secret: row.secret === 1,
      updatedAt: row.updated_at,
    }));
  }

  forget(key) {
    const db = this.open();
    const info = db.prepare('DELETE FROM resource WHERE key = ?').run(key);
    return info.changes > 0;
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }
}

export { KIND_ENUM };
