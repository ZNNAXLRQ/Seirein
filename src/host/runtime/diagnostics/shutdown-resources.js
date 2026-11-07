/** Observational shutdown evidence. Never closes, unreferences or claims ownership of a resource. */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const LIMIT = 64;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const text = (value) => typeof value === 'string' ? value.slice(0, 64) : '';
const counts = (values) => {
  const result = Object.create(null);
  for (const value of values) {
    const key = text(value) || 'Unknown';
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
};
const safely = (read, fallback = null) => {
  try { return read(); } catch { return fallback; }
};

/**
 * Sidecar JSONL survives EventLog disposal. No argv, paths of open files, network destinations,
 * environment, message contents or full diagnostic reports are inspected. The snapshot covers
 * the whole Host; unknown handles must not be attributed to this plugin merely by proximity.
 * Private Node enumeration is optional and incomplete; resource counts complement it for timers.
 */
export function createShutdownDiagnostics({
  root, proc = process, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  write = null,
} = {}) {
  const file = join(root, 'data', 'diagnostics', 'shutdown.jsonl');
  const instanceId = randomUUID();
  const ids = new WeakMap();
  const owners = new Map();
  const timers = new Set();
  let nextId = 0;
  let shutdownId = null;
  let startedAt = null;
  let baseline = null;
  let began = false;
  let ended = false;
  let listening = false;

  const list = (name) => {
    if (typeof proc?.[name] !== 'function') return { available: false, values: [] };
    const values = safely(() => proc[name](), null);
    return { available: Array.isArray(values), values: Array.isArray(values) ? values : [] };
  };
  const typeOf = (value) => text(safely(() => value?.constructor?.name, '')) || 'Unknown';
  const describe = (handle) => {
    const row = { type: typeOf(handle) };
    if ((typeof handle === 'object' && handle !== null) || typeof handle === 'function') {
      if (!ids.has(handle)) ids.set(handle, ++nextId);
      row.id = ids.get(handle);
    }
    const ref = safely(() => typeof handle.hasRef === 'function'
      ? handle.hasRef() : handle._handle?.hasRef?.());
    if (typeof ref === 'boolean') row.hasRef = ref;
    const fd = safely(() => handle.fd);
    if (Number.isInteger(fd) && fd >= 0) row.fd = fd;
    const pid = safely(() => handle.pid);
    if (Number.isInteger(pid) && pid > 0) {
      row.pid = pid;
      row.ownerHint = owners.get(pid) ?? 'unknown';
    }
    for (const key of ['destroyed', 'readable', 'writable', 'connected', 'killed']) {
      const value = safely(() => handle[key]);
      if (typeof value === 'boolean') row[key] = value;
    }
    const exitCode = safely(() => handle.exitCode);
    if (Number.isInteger(exitCode)) row.exitCode = exitCode;
    return row;
  };

  const persist = write ?? ((row) => {
    // The after-* timers can fire after a test (or a user) removed the profile root; recreating the
    // directory there would resurrect a deleted tree and break the caller's cleanup with ENOTEMPTY.
    if (!existsSync(root)) return;
    mkdirSync(join(root, 'data', 'diagnostics'), { recursive: true });
    if (safely(() => statSync(file).size, 0) > MAX_FILE_BYTES) {
      renameSync(file, `${file}.previous`);
    }
    // One bounded-size record, opening and closing its fd synchronously; no persistent writer.
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  });

  const capture = (phase, extra = {}) => {
    try {
      const handles = list('_getActiveHandles');
      const requests = list('_getActiveRequests');
      const resources = list('getActiveResourcesInfo');
      const details = handles.values.slice(0, LIMIT).map(describe);
      const resourceCounts = counts(resources.values);
      const currentIds = new Set(details.map((row) => row.id).filter(Number.isInteger));
      const row = {
        schema: 1, ts: new Date(now()).toISOString(), pid: proc.pid, instanceId, shutdownId,
        phase, elapsedMs: startedAt === null ? null : Math.max(0, now() - startedAt),
        scope: 'whole-host', ownership: 'unknown-unless-recorded-pid',
        availability: { handles: handles.available, requests: requests.available, resources: resources.available },
        handles: { count: handles.values.length, counts: counts(handles.values.map(typeOf)),
          details, truncated: handles.values.length > LIMIT },
        requests: { count: requests.values.length, counts: counts(requests.values.map(typeOf)) },
        resources: resourceCounts,
        ipc: { connected: proc.connected === true, channelPresent: proc.channel != null },
        messageListeners: safely(() => proc.listenerCount('message')),
        delta: baseline === null ? null : {
          addedHandleIds: [...currentIds].filter((id) => !baseline.ids.has(id)),
          removedHandleIds: [...baseline.ids].filter((id) => !currentIds.has(id)),
          resources: Object.fromEntries([...new Set([...Object.keys(baseline.resources), ...Object.keys(resourceCounts)])]
            .map((key) => [key, (resourceCounts[key] ?? 0) - (baseline.resources[key] ?? 0)])
            .filter(([, count]) => count !== 0)),
          handlesTruncated: baseline.truncated || handles.values.length > LIMIT,
        },
        ...extra,
      };
      safely(() => {
        const result = persist(row);
        if (typeof result?.catch === 'function') result.catch(() => {});
      });
      return { row, ids: currentIds, resources: resourceCounts, truncated: handles.values.length > LIMIT };
    } catch { return null; }
  };

  const detach = () => {
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    if (listening) {
      proc.off?.('beforeExit', beforeExit);
      proc.off?.('exit', exit);
      listening = false;
    }
  };
  const beforeExit = () => { capture('before-exit'); };
  const exit = () => { capture('exit'); detach(); };
  // A startup baseline helps distinguish ordinary stdio/IPC from resources added by later use.
  baseline = capture('mounted');

  return {
    file,
    noteOwnedPid(name, pid) {
      if (Number.isInteger(pid) && pid > 0 && owners.size < LIMIT) owners.set(pid, text(name));
    },
    begin(reason) {
      if (began) return;
      began = true;
      shutdownId = randomUUID();
      startedAt = now();
      capture('shutdown-begin', { reason: text(reason) });
      if (typeof proc.once === 'function') {
        proc.once('beforeExit', beforeExit);
        proc.once('exit', exit);
        listening = true;
      }
    },
    complete(summary) {
      if (!began || ended) return;
      ended = true;
      capture('plugin-stopped', { pluginConfirmed: summary?.ok === true });
      for (const delay of [200, 1000]) {
        const timer = setTimer(() => {
          timers.delete(timer);
          capture(`after-${delay}ms`);
          if (delay === 1000) detach();
        }, delay);
        timers.add(timer);
        timer.unref?.();
      }
    },
    dispose: detach,
  };
}
