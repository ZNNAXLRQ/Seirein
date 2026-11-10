/**
 * Standalone smoke test: mount the plugin against a fake context and exercise every tool.
 * This validates the tool shapes and the JSONL stores without needing the DSH runtime.
 *
 * Run: node test/smoke.mjs
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { apply, name } from '../src/host/index.js';

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'dsh-assistant-'));

const tools = new Map();
let attachmentSeq = 0;
const fakeCtx = {
  effect: (fn) => fn(),
  // assistant_see delivers through the Harness attachment service; a fake keeps this smoke
  // test independent of the real image store while still exercising the delivery path.
  get: (service) => (service === 'attachments' ? {
    async saveImage({ data, mediaType, name }) {
      attachmentSeq += 1;
      return { id: `smoke-att-${attachmentSeq}`, mediaType, name, bytes: data.length };
    },
  } : undefined),
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  },
};

apply(fakeCtx, { root, defaultDomain: 'chat', enabled: true });

const call = async (toolName, args = {}) => {
  const tool = tools.get(toolName);
  if (tool === undefined) throw new Error(`tool not registered: ${toolName}`);
  return tool.execute(args, {});
};

const results = {};
results.tools = [...tools.keys()].sort();

results.rememberPreference = await call('assistant_remember', {
  text: '用户喜欢在深夜写代码，喝冰美式，不喜欢被打断',
  domain: 'chat',
  kind: 'preference',
});
results.rememberWork = await call('assistant_remember', {
  text: '项目 DSH Companion 的记忆库放在 E 盘',
  domain: 'work',
  kind: 'fact',
});
results.recall = await call('assistant_recall', { query: '冰美式', domain: 'chat' });
results.recallMissDomain = await call('assistant_recall', { query: '冰美式', domain: 'work' });
// No domain filter = cross-domain search: a work fact is visible from anywhere.
results.recallAcross = {
  allScopes: await call('assistant_recall', { query: 'DSH Companion' }),
};
// In-place correction: the work record is edited but the record count stays the same.
const workHit = results.recallAcross.allScopes.hits.find((hit) => hit.domain === 'work');
results.correct = await call('assistant_memory_correct', {
  targetId: workHit.id,
  expectedVersion: workHit.version,
  expectedText: 'E 盘',
  replacement: 'F 盘',
  sourceMessageId: 'smoke-correct-1',
});

// Input outside the domain charset must fall back instead of creating a traversal path.
results.domainFallback = await call('assistant_remember', { text: '非法域名应回落到默认域', domain: '../evil' });

// A high-scoring memory must land in the fixed layer and the composed brief.
results.landmark = await call('assistant_remember', {
  text: '第一次答应你：以后每周一起看一部电影，我喜欢这种约定，谢谢你',
  domain: 'chat',
  kind: 'preference',
});
results.brief = await call('assistant_memory_brief', { query: '我们一起看电影的事' });
results.archive = await call('assistant_archive_search', { query: '电影' });

results.say = await call('assistant_say', { text: '我在听。', emotion: 'happy', play: false }).catch((error) => ({ spoken: false, reason: error.message }));
results.see = await call('assistant_see', { reason: '用户问屏幕上写着什么' });

// Resource vault: standing lookup + a secret that must come back masked by default.
results.resourceSet = await call('assistant_resource_set', {
  key: 'anime.source',
  value: '动画资料从 Bangumi 查：https://bgm.tv',
  kind: 'source',
  title: '动画信息源',
  tags: 'anime,movie',
});
results.resourceList = await call('assistant_resource_list', { tag: 'anime' });
results.resourceGet = await call('assistant_resource_get', { key: 'anime.source' });
// The vault encrypts secret values with Windows DPAPI through powershell.exe. A sandboxed or
// locked-down review host may be unable to spawn that process or call the crypto API at all;
// probe the capability so that situation is an explicit skip, while a vault defect still fails.
const dpapi = await (async () => {
  if (process.platform !== 'win32') return { ok: false, reason: `not Windows (${process.platform})` };
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $s = ConvertTo-SecureString -String $env:RS_PROBE -AsPlainText -Force; ConvertFrom-SecureString $s",
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, RS_PROBE: 'dpapi-probe' } });
    if (String(stdout).trim().length === 0) return { ok: false, reason: 'DPAPI encryption returned nothing' };
    return { ok: true, reason: '' };
  } catch (error) {
    const reason = String(error?.stderr ?? '').trim() || String(error?.message ?? error);
    return { ok: false, reason };
  }
})();
results.dpapi = dpapi.ok ? 'available' : `unavailable: ${dpapi.reason}`;
results.secretSet = await call('assistant_resource_set', {
  key: 'demo.credential',
  value: 'demo-password-123',
  kind: 'credential',
  secret: true,
});
results.secretMasked = await call('assistant_resource_get', { key: 'demo.credential' });
results.secretRevealed = await call('assistant_resource_get', { key: 'demo.credential', reveal: true });
results.promptPreview = await call('assistant_prompt_preview');
results.personaAppend = await call('assistant_persona_append', { which: 'user', text: '用户偏好简短回答' });
results.personaView = await call('assistant_persona_view', { which: 'user' });
results.doctor = await call('assistant_doctor');
results.obs = await call('assistant_obs_status');
results.vision = await call('assistant_vision', { action: 'status' });

const events = (await readFile(join(root, 'data', 'events.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
results.eventTypes = events.map((event) => event.type);
results.statusFile = JSON.parse(await readFile(join(root, 'data', 'status.json'), 'utf8'));

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(root, 'memory', 'memory.db'));
results.chatRecords = db.prepare("select count(*) as c from memory_event where domain='chat'").get().c;
results.workRecords = db.prepare("select count(*) as c from memory_event where domain='work'").get().c;
results.ftsRows = db.prepare('select count(*) as c from memory_fts').get().c;
db.close();

console.log(JSON.stringify({ plugin: name, root, results }, null, 2));

// Assertions: the smoke test must fail loudly, not just print.
const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`);
};
assert(results.tools.length === 27, 'twenty-seven tools registered');
assert(results.rememberPreference.domain === 'chat', 'remember writes to chat');
assert(results.recall.hits.length === 1, 'recall finds the preference');
assert(results.recall.scope.includes('chat'), 'scoped recall reports its scope');
assert(results.recallMissDomain.scanned === 1, 'work domain has its own record');
assert(results.recallMissDomain.hits.length === 0, 'a scoped recall stays inside its domain');
assert(results.recallAcross.allScopes.hits.some((hit) => hit.domain === 'work'), 'cross-domain recall reaches another scope');
assert(results.correct.ok === true, 'correction succeeds in place');
assert(results.correct.version === workHit.version + 1, 'correction bumps only the version');
assert(results.domainFallback.domain === 'chat', 'invalid domain falls back');
// `assistant_say` is accepted-then-played: the tool returns a speechId and the outcome arrives
// later as speech.* events, so the smoke checks acceptance here and leaves playback to the
// speech-async suite.
assert(results.say?.accepted === true, 'say accepts the request');
assert(typeof results.say?.speechId === 'string' && results.say.speechId.length > 0, 'say returns a speechId');
assert(results.eventTypes.includes('vision.captured') || results.eventTypes.includes('vision.failed'), 'see records an outcome');
assert(results.chatRecords === 3, 'chat scope has three records');
assert(results.workRecords === 1, 'work scope has one record');
assert(results.ftsRows === 4, 'fts index covers every scope');
assert(results.brief.fixed >= 1, 'high-importance memory reaches the fixed layer');
assert(results.brief.text.includes('电影'), 'brief includes the matched memory');
assert(Array.isArray(results.archive.hits), 'archive search returns a hit list');
assert(typeof results.obs.installed === 'boolean', 'obs status reports installation');
assert(results.vision.mode === 'watch', 'vision starts in watch mode');
assert(Array.isArray(results.vision.scenes), 'vision status reports the OBS scene list');
assert(results.resourceGet.value.includes('bgm.tv'), 'resource value round-trips');
assert(results.resourceList.count === 1, 'resource list filters by tag');
if (!dpapi.ok) {
  // Environment limitation, not a vault defect: no DPAPI means the secret was never stored.
  console.log(`SKIP secret encrypt/reveal: DPAPI unavailable in this environment (${dpapi.reason})`);
  assert(results.secretSet.ok === false, 'without DPAPI the secret write must report failure, not success');
  assert(results.secretRevealed.found === false, 'without DPAPI no secret row exists to reveal');
} else {
  assert(results.secretSet.ok === true, `secret write succeeds when DPAPI works: ${results.secretSet.error ?? 'unknown error'}`);
  assert(results.secretMasked.value !== 'demo-password-123', 'secret is masked without reveal');
  assert(results.secretRevealed.value === 'demo-password-123', 'secret decrypts with reveal');
}
assert(results.promptPreview.text.includes('anime.source'), 'resource index renders for the prompt');
assert(results.personaView.text.includes('用户偏好简短回答'), 'persona append round-trips');
assert(results.promptPreview.text.includes('记忆的收编约定'), 'memory convention reaches the prompt');
assert(typeof results.statusFile.pid === 'number', 'status.json written');

console.log('\nSMOKE TEST PASSED');
