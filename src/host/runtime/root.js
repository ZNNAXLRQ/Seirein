/**
 * Instance root resolution.
 *
 * The plugin's data root can be relocated: an instance file next to the OS default records the
 * chosen parent directory, and the plugin always lives in `<parent>/Seirein`. Layout inside:
 *
 *   Seirein/memory     memory store + persona + resources
 *   Seirein/workspace  sessions created for dispatched tasks (registered as a DSH workspace)
 *   Seirein/cache      tts / screens / subtitle / avatar-layer working files
 *   Seirein/data       events.jsonl, settings, features, hotkeys
 *
 * Dependency downloads (ffmpeg, ASR models) are resolved before this and stay in their own
 * location; nothing here depends on them.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const APP_DIR = 'Seirein';
const LEGACY_DIR = 'dsh-assistant';

function baseDir() {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

/** Where the instance file lives: always in the OS default location, so it survives moves. */
export function instanceFile() {
  return join(baseDir(), APP_DIR, 'instance.json');
}

export function readInstance() {
  try {
    return JSON.parse(readFileSync(instanceFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstance(patch) {
  const file = instanceFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...readInstance(), ...patch }, null, 2)}\n`, 'utf8');
}

/**
 * Copy one legacy tree into the new root without deleting the original, so a failed move is
 * recoverable. Returns the entries that were copied.
 */
export function migrateLegacy(targetRoot) {
  const legacy = join(baseDir(), LEGACY_DIR);
  if (!existsSync(legacy)) return [];
  if (existsSync(targetRoot) && targetRoot !== legacy) {
    const marker = join(targetRoot, '.migrated');
    if (existsSync(marker)) return [];
  }
  mkdirSync(targetRoot, { recursive: true });
  const copied = [];
  for (const entry of ['memory', 'data', 'cache', 'models', 'vts-token.json']) {
    const from = join(legacy, entry);
    if (!existsSync(from)) continue;
    const to = join(targetRoot, entry);
    if (existsSync(to)) continue;
    try {
      cpSync(from, to, { recursive: true });
      copied.push(entry);
    } catch {
      /* skip unreadable entries; the legacy tree stays intact */
    }
  }
  try {
    writeFileSync(join(targetRoot, '.migrated'), new Date().toISOString(), 'utf8');
  } catch {
    /* marker is best-effort */
  }
  return copied;
}

/**
 * Resolve the data root: explicit config wins, then the instance file, then `<default>/Seirein`.
 * Also performs the one-time legacy copy so existing memories are not lost.
 */
export function resolveInstanceRoot(config) {
  const fromConfig = typeof config?.root === 'string' && config.root.trim().length > 0
    ? resolve(config.root.trim())
    : '';
  const fromInstance = readInstance().root;
  const parent = fromConfig
    || (typeof fromInstance === 'string' && fromInstance.length > 0 ? resolve(fromInstance) : baseDir());
  const root = fromConfig || join(parent, APP_DIR);
  // Only migrate when we own the location; an explicit config.root (tests, portable setups)
  // must stay untouched.
  if (!fromConfig) migrateLegacy(root);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  return root;
}
