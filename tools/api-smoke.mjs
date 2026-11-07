/**
 * Settings API smoke test: status fields, feature toggle round-trip, snapshot action.
 * Uses Node's fetch so UTF-8 bodies are handled correctly (PowerShell mangles them).
 *
 * Usage: node tools/api-smoke.mjs [baseUrl]
 */
const base = process.argv[2] ?? process.env.ASSISTANT_URL ?? 'http://127.0.0.1:57808';

const post = async (body) => {
  const response = await fetch(`${base}/assistant/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return response.json();
};

const status = await (await fetch(`${base}/assistant/status`, { cache: 'no-store' })).json();
console.log('version:', status.version);
console.log('features:', (status.features ?? []).map((f) => `${f.id}=${f.enabled}`).join(' '));
console.log('devices:', JSON.stringify(status.devices ?? []), 'selected:', status.selectedDevice || '(none)');

// Device selection round-trip (uses the first enumerated device; names stay out of the shell).
if ((status.devices ?? []).length > 0) {
  const device = status.devices[0];
  const set = await post({ action: 'hearing.device', device });
  const after = await (await fetch(`${base}/assistant/status`, { cache: 'no-store' })).json();
  console.log('hearing.device:', set, '-> selected:', after.selectedDevice === device);
}

const target = 'avatar';
const before = (status.features ?? []).find((f) => f.id === target)?.enabled;
console.log(`toggle ${target}: ${before} ->`, await post({ action: 'feature.set', id: target, enabled: !before }));
console.log(`restore ${target}:`, await post({ action: 'feature.set', id: target, enabled: before }));

console.log('snapshot:', await post({ action: 'vision.snapshot' }));
console.log('resource.get:', (await post({ action: 'resource.get', key: 'anime.source' })).ok);
