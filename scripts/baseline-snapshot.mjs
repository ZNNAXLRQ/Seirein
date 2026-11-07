#!/usr/bin/env node
/**
 * P-47 baseline snapshot: build / models / protocol / TTS.
 *
 * Read-only collection. The script reads the checkout, node_modules manifests, the runtime
 * settings and the model files, then writes exactly two artifacts under `<root>/cache`:
 * `baseline-<timestamp>.json` and the human-readable `baseline-<timestamp>.md`.
 * It never writes settings, models, events or any runtime state.
 *
 * Usage:
 *   node scripts/baseline-snapshot.mjs
 *   node scripts/baseline-snapshot.mjs --compare <baseline.json>
 *   node scripts/baseline-snapshot.mjs --root <root> --out <root>\cache
 *
 * Compare exits 0 when the comparable projection (versions / models / dependencies /
 * protocol / TTS) is unchanged, 1 when it differs, and 2 on a usage or input error.
 * Only Node built-in modules are used; no npm dependency is required.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'baseline-snapshot/v1';
const HASH_PREFIX = 16;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(SCRIPT_DIR);

/** Packages whose installed version is part of the runtime baseline. */
const KEY_PACKAGES = [
  'sherpa-onnx-node',
  'koffi',
  '@napolab/texture-bridge',
  'msedge-tts',
  'ws',
  'dsh-see-now',
];

const PLUGIN_FALLBACK_VOICES = Object.freeze({
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  en: 'en-US-AriaNeural',
  ko: 'ko-KR-SunHiNeural',
  yue: 'zh-HK-HiuGaaiNeural',
});
const FALLBACK_VOICE = 'zh-CN-XiaoxiaoNeural';

// ---------------------------------------------------------------------------- helpers

function toPosix(value) {
  return String(value).split('\\').join('/');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function walkFiles(dir) {
  const found = [];
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) found.push(absolute);
    }
  };
  visit(dir);
  return found.sort((a, b) => toPosix(a).localeCompare(toPosix(b)));
}

function fileInfo(file) {
  try {
    const stats = statSync(file);
    return { path: file, exists: true, bytes: stats.size };
  } catch {
    return { path: file, exists: false, bytes: null };
  }
}

function extractConstant(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
  return match ? match[1] : null;
}

function defaultStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-`
    + pad(date.getMilliseconds(), 3);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// ---------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { compare: null, root: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--compare') {
      args.compare = argv[index + 1] ?? null;
      index += 1;
      if (!args.compare) throw new Error('--compare needs a baseline JSON path');
    } else if (token === '--root') {
      args.root = argv[index + 1] ?? null;
      index += 1;
      if (!args.root) throw new Error('--root needs a path');
    } else if (token === '--out') {
      args.out = argv[index + 1] ?? null;
      index += 1;
      if (!args.out) throw new Error('--out needs a directory');
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`P-47 baseline snapshot (read-only)

  node scripts/baseline-snapshot.mjs
      Collect and write <root>/cache/baseline-<timestamp>.json plus a .md summary.

  node scripts/baseline-snapshot.mjs --compare <baseline.json>
      Re-collect and compare versions / models / dependencies / protocol / TTS.
      Exit 0 = no difference, 1 = difference, 2 = usage or input error.

  Options: --root <dir>  instance root (default: instance.json or LOCALAPPDATA/Seirein)
           --out <dir>   output directory (default: <root>/cache)
           --help
`);
}

// ---------------------------------------------------------------------------- collection

function resolveRoot(override) {
  if (override) return resolve(override);
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  let parent = '';
  try {
    const instance = readJson(join(base, 'Seirein', 'instance.json'));
    if (typeof instance.root === 'string' && instance.root.trim().length > 0) {
      parent = resolve(instance.root.trim());
    }
  } catch {
    /* no instance file: keep the OS default */
  }
  return parent ? join(parent, 'Seirein') : join(base, 'Seirein');
}

function gitInfo() {
  const run = (args) => execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  }).trim();
  try {
    const head = run(['rev-parse', '--short', 'HEAD']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    let dirtyCount = null;
    try {
      dirtyCount = run(['status', '--porcelain']).split('\n').filter(Boolean).length;
    } catch {
      dirtyCount = null;
    }
    return { head, branch, dirtyCount };
  } catch {
    return { head: null, branch: null, dirtyCount: null };
  }
}

/** Read the bundle patch's scalar keys (minimal YAML: the handful of top-level keys we need). */
function bundleConfig() {
  const file = join(REPO, 'cordis.patch.yml');
  let text = '';
  try {
    text = readText(file);
  } catch {
    return { file, available: false, ttsVoice: null, root: null, ttsPlayback: null };
  }
  const scalar = (key) => {
    const match = text.match(new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`, 'm'));
    if (!match) return { present: false, value: null };
    const raw = match[1].replace(/\s+#.*$/, '').trim();
    if (raw === '' || raw === 'null' || raw === '~') return { present: true, value: null };
    return { present: true, value: raw.replace(/^['"]|['"]$/g, '') };
  };
  const boolean = (entry) => {
    if (!entry.present || entry.value === null) return null;
    if (entry.value === 'true') return true;
    if (entry.value === 'false') return false;
    return null;
  };
  return {
    file,
    available: true,
    ttsVoice: scalar('ttsVoice').value,
    root: scalar('root').value,
    ttsPlayback: boolean(scalar('ttsPlayback')),
  };
}

/** Default Edge voice per language, read from tts.js so the snapshot follows the source. */
function defaultVoices() {
  try {
    const source = readText(join(REPO, 'src', 'host', 'speech', 'tts.js'));
    const block = source.match(/DEFAULT_VOICES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
    if (block) {
      const voices = {};
      for (const match of block[1].matchAll(/([a-z]+):\s*'([^']+)'/g)) {
        voices[match[1]] = match[2];
      }
      if (Object.keys(voices).length > 0) return voices;
    }
  } catch {
    /* fall through to the built-in table */
  }
  return { ...PLUGIN_FALLBACK_VOICES };
}

function toolSurface() {
  const file = join(REPO, 'src', 'host', 'index.js');
  const source = readText(file);
  const names = [...source.matchAll(/\bname:\s*['"]assistant_([a-z0-9_]+)['"]/g)]
    .map((match) => `assistant_${match[1]}`);
  const unique = [...new Set(names)].sort();
  const registerCalls = (source.match(/^\s*register\(\{/gm) ?? []).length;
  return {
    count: unique.length,
    names: unique,
    registerCalls,
    consistent: unique.length === registerCalls,
    source: 'src/host/index.js',
  };
}

function annotateModel(relPath) {
  const base = toPosix(relPath).split('/').pop() ?? '';
  if (/^silero_vad.*\.onnx$/i.test(base)) return { role: 'vad', known: 'silero_vad' };
  if (/campplus/i.test(base)) return { role: 'speaker', known: 'campplus' };
  if (/\.tar\.bz2$/i.test(base)) return { role: 'archive', known: null };
  if (toPosix(relPath).startsWith('sherpa-onnx-streaming-')) {
    return { role: 'asr-streaming', known: 'asr-streaming' };
  }
  if (toPosix(relPath).startsWith('sherpa-onnx-sense-voice-')) {
    return { role: 'asr-final', known: 'asr-final' };
  }
  return { role: 'other', known: null };
}

async function collectModels(root) {
  const dir = join(root, 'models');
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  for (const absolute of walkFiles(dir)) {
    const relPath = toPosix(relative(dir, absolute));
    // A model downloader writes `<target>.<taskId>.part` while it runs; a moving file is not
    // a repeatable baseline entry, so record it as skipped instead of hashing a torn state.
    if (/\.part$/i.test(relPath)) {
      skipped.push({ file: relPath, reason: 'partial-download' });
      continue;
    }
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    const annotation = annotateModel(relPath);
    let sha256 = null;
    let hashError = null;
    try {
      sha256 = (await sha256File(absolute)).slice(0, HASH_PREFIX);
    } catch (error) {
      hashError = error?.code ?? error?.message ?? 'hash-failed';
    }
    totalBytes += stats.size;
    files.push({
      file: relPath,
      bytes: stats.size,
      sha256_16: sha256,
      ...(hashError ? { error: hashError } : {}),
      role: annotation.role,
      known: annotation.known,
    });
  }

  const expected = [
    { role: 'vad', path: 'silero_vad.onnx' },
    { role: 'speaker', path: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx' },
    { role: 'asr-streaming', path: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/' },
    { role: 'asr-final', path: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/' },
  ].map((entry) => ({
    ...entry,
    status: existsSync(join(dir, entry.path.replace(/\/$/, ''))) ? 'present' : 'missing',
  }));

  return { dir, hashPrefix: HASH_PREFIX, totalBytes, files, expected, skipped };
}

async function collectTtsModels(settings) {
  const gptSovits = isPlainObject(settings?.gptSovits) ? settings.gptSovits : {};
  const models = isPlainObject(gptSovits.models) ? gptSovits.models : {};
  const candidates = [
    { role: 'gpt', path: models.gptModelPath },
    { role: 'sovits', path: models.sovitsModelPath },
    { role: 'reference', path: gptSovits.refAudioPath },
  ];
  const collected = [];
  for (const candidate of candidates) {
    if (typeof candidate.path !== 'string' || candidate.path.trim().length === 0) continue;
    const info = fileInfo(candidate.path);
    let sha256 = null;
    if (info.exists) {
      try {
        sha256 = (await sha256File(candidate.path)).slice(0, HASH_PREFIX);
      } catch {
        sha256 = null;
      }
    }
    collected.push({
      role: candidate.role,
      path: candidate.path,
      exists: info.exists,
      bytes: info.bytes,
      sha256_16: sha256,
    });
  }
  return collected;
}

function collectDependencies(pkg) {
  const declared = isPlainObject(pkg.dependencies) ? pkg.dependencies : {};
  const dependencies = {};
  for (const name of KEY_PACKAGES) {
    let installed = null;
    try {
      const manifest = readJson(join(REPO, 'node_modules', name, 'package.json'));
      installed = typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
      installed = null;
    }
    let status = 'missing';
    if (installed !== null) {
      if (declared[name] === undefined) {
        status = 'present-not-declared';
      } else {
        const match = declaredMatches(declared[name], installed);
        status = match === null ? 'unknown' : (match ? 'ok' : 'declared-mismatch');
      }
    }
    dependencies[name] = {
      declared: declared[name] ?? null,
      installed,
      status,
    };
  }
  return dependencies;
}

/** Loose caret/tilde comparison: enough to expose a real drift without a semver dependency. */
function declaredMatches(declared, installed) {
  const wanted = String(declared).trim();
  if (wanted === installed) return true;
  if (!/^\d+\.\d+\.\d+/.test(installed)) return false;
  const parts = installed.split('.').map(Number);
  if (wanted.startsWith('^')) {
    const base = wanted.slice(1).split('.').map(Number);
    if (base.some((value) => !Number.isFinite(value))) return null;
    return parts[0] === base[0] && compareVersions(parts, base) >= 0;
  }
  if (wanted.startsWith('~')) {
    const base = wanted.slice(1).split('.').map(Number);
    if (base.some((value) => !Number.isFinite(value))) return null;
    return parts[0] === base[0] && parts[1] === base[1] && compareVersions(parts, base) >= 0;
  }
  if (wanted.startsWith('>=')) return false;
  return false;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const a = Number(left[index] ?? 0);
    const b = Number(right[index] ?? 0);
    if (a !== b) return a - b;
  }
  return 0;
}

async function collect(root) {
  const packageFile = join(REPO, 'package.json');
  const pkg = readJson(packageFile);
  const pluginSource = readText(join(REPO, 'src', 'host', 'index.js'));
  const clientSource = readText(join(REPO, 'client.js'));
  const bundle = bundleConfig();
  const settingsPath = join(root, 'data', 'settings.json');
  let settings = {};
  let settingsError = null;
  try {
    settings = readJson(settingsPath);
  } catch (error) {
    settingsError = error?.code ?? error?.message ?? 'invalid-json';
  }

  const versions = {
    package: typeof pkg.version === 'string' ? pkg.version : null,
    plugin: extractConstant(pluginSource, 'PLUGIN_VERSION'),
    client: extractConstant(clientSource, 'CLIENT_VERSION'),
  };
  versions.consistent = versions.package !== null
    && versions.package === versions.plugin
    && versions.package === versions.client;

  const supportedLangs = new Set(['zh', 'ja', 'en', 'ko', 'yue']);
  const savedSpeechLang = settings?.langs?.speech;
  // Mirror the host rule: an absent or unsupported value falls back to zh.
  const speechLang = supportedLangs.has(savedSpeechLang) ? savedSpeechLang : 'zh';
  const voices = defaultVoices();
  const configuredVoice = bundle.ttsVoice ?? null;
  const effectiveVoice = configuredVoice
    ?? voices[String(speechLang).toLowerCase()]
    ?? FALLBACK_VOICE;
  const gptSovits = isPlainObject(settings?.gptSovits) ? settings.gptSovits : {};
  const gptEnabled = gptSovits.enabled === true;
  const engine = gptEnabled ? 'gpt-sovits' : 'edge-tts';
  const rate = settings?.tts?.rate ?? settings?.voice?.rate ?? null;
  const playbackEnabled = bundle.ttsPlayback ?? true;

  const [models, ttsModels] = await Promise.all([
    collectModels(root),
    collectTtsModels(settings),
  ]);

  const protocolFiles = {
    events: fileInfo(join(root, 'data', 'events.jsonl')),
    settings: fileInfo(settingsPath),
    status: fileInfo(join(root, 'data', 'status.json')),
    hotkeys: fileInfo(join(root, 'data', 'hotkeys.json')),
    features: fileInfo(join(root, 'data', 'features.json')),
  };

  const tts = {
    engine,
    engineNote: gptEnabled
      ? 'GPT-SoVITS is primary; any failure falls back to Edge TTS.'
      : 'Edge TTS is primary.',
    fallbackEngine: 'edge-tts',
    playbackEnabled,
    voiceMuted: settings?.voiceMuted === true,
    voice: {
      lang: speechLang,
      configured: configuredVoice,
      effective: effectiveVoice,
      source: configuredVoice ? 'bundle config ttsVoice' : 'default for speech language',
    },
    rate,
    rateNote: rate === null ? 'no rate setting in settings.json or bundle config' : null,
    format: 'audio-24khz-48kbitrate-mono-mp3',
    gptSovits: {
      enabled: gptEnabled,
      apiBase: typeof gptSovits.apiBase === 'string' ? gptSovits.apiBase : null,
      timeoutMs: Number.isFinite(Number(gptSovits.timeoutMs)) ? Number(gptSovits.timeoutMs) : null,
      textLang: typeof gptSovits.textLang === 'string' ? gptSovits.textLang : '',
      promptLang: typeof gptSovits.promptLang === 'string' ? gptSovits.promptLang : '',
      referenceAudio: typeof gptSovits.refAudioPath === 'string' ? gptSovits.refAudioPath : null,
      promptTextConfigured: typeof gptSovits.promptText === 'string'
        && gptSovits.promptText.trim().length > 0,
      promptTextChars: typeof gptSovits.promptText === 'string' ? gptSovits.promptText.length : 0,
      modelsDirty: null,
    },
    models: ttsModels,
  };
  // `modelsDirty` mirrors the host rule: settings paths differ from the applied snapshot.
  const applied = isPlainObject(gptSovits.applied) ? gptSovits.applied : {};
  const configuredGpt = typeof gptSovits.models?.gptModelPath === 'string'
    ? gptSovits.models.gptModelPath
    : '';
  const configuredSovits = typeof gptSovits.models?.sovitsModelPath === 'string'
    ? gptSovits.models.sovitsModelPath
    : '';
  if (configuredGpt || configuredSovits) {
    tts.gptSovits.modelsDirty = (applied.gptPath ?? '') !== configuredGpt
      || (applied.sovitsPath ?? '') !== configuredSovits;
  }

  const snapshot = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    generatedAtLocal: new Date().toLocaleString('sv-SE'),
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    root,
    repo: {
      path: REPO,
      git: gitInfo(),
    },
    versions,
    dependencies: collectDependencies(pkg),
    models,
    protocol: {
      plugin: typeof pkg.name === 'string' ? pkg.name : null,
      clientPlatform: pkg?.dsh?.client?.platform ?? null,
      bundlePatch: 'cordis.patch.yml',
      bundleConfigAvailable: bundle.available,
      tools: toolSurface(),
      files: protocolFiles,
    },
    config: {
      settingsAvailable: settingsError === null,
      settingsError,
      langs: {
        speech: settings?.langs?.speech ?? null,
        subtitle: settings?.langs?.subtitle ?? null,
      },
      asrDevice: settings?.asrDevice ?? null,
      visionMode: settings?.vision?.mode ?? null,
      ttsPlayback: playbackEnabled,
      voiceMuted: settings?.voiceMuted === true,
    },
    tts,
  };
  return snapshot;
}

// ---------------------------------------------------------------------------- output

function renderMarkdown(snapshot) {
  const lines = [];
  const repo = snapshot.repo?.git ?? {};
  lines.push('# Baseline snapshot');
  lines.push('');
  lines.push(`- 生成时间：${snapshot.generatedAtLocal}（${snapshot.generatedAt}）`);
  lines.push(`- 数据根：\`${snapshot.root}\``);
  lines.push(`- 仓库：\`${snapshot.repo?.path}\` @ \`${repo.head ?? 'unknown'}\` (${repo.branch ?? 'unknown'})，工作区改动 ${repo.dirtyCount ?? 'n/a'} 项`);
  lines.push(`- schema：\`${snapshot.schema}\``);
  lines.push('');
  lines.push('## 版本');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| package.json | ${snapshot.versions.package ?? 'n/a'} |`);
  lines.push(`| PLUGIN_VERSION | ${snapshot.versions.plugin ?? 'n/a'} |`);
  lines.push(`| CLIENT_VERSION | ${snapshot.versions.client ?? 'n/a'} |`);
  lines.push(`| 三处一致 | ${snapshot.versions.consistent ? '是' : '否'} |`);
  lines.push('');
  lines.push('## 模型（models 目录）');
  lines.push('');
  lines.push(`目录：\`${snapshot.models.dir}\``);
  lines.push('');
  if (snapshot.models.files.length === 0) {
    lines.push('_没有找到模型文件。_');
  } else {
    lines.push('| 文件 | 角色 | 字节 | sha256 前 16 位 |');
    lines.push('| --- | --- | ---: | --- |');
    for (const file of snapshot.models.files) {
      lines.push(`| \`${file.file}\` | ${file.role}${file.known && file.known !== file.role ? ` (${file.known})` : ''} | ${file.bytes.toLocaleString('en-US')} | \`${file.sha256_16 ?? 'n/a'}\` |`);
    }
    lines.push('');
    lines.push(`合计：${formatBytes(snapshot.models.totalBytes)}`);
  }
  const missingExpected = snapshot.models.expected.filter((entry) => entry.status !== 'present');
  if (missingExpected.length > 0) {
    lines.push('');
    lines.push('已知但当前缺失：');
    for (const entry of missingExpected) lines.push(`- ${entry.role}：\`${entry.path}\``);
  }
  const skipped = snapshot.models.skipped ?? [];
  if (skipped.length > 0) {
    lines.push('');
    lines.push('采集时跳过的临时文件：');
    for (const entry of skipped) lines.push(`- \`${entry.file}\`（${entry.reason}）`);
  }
  lines.push('');
  lines.push('## 依赖（已安装版本）');
  lines.push('');
  lines.push('| 包 | 声明 | 已安装 | 状态 |');
  lines.push('| --- | --- | --- | --- |');
  for (const [name, value] of Object.entries(snapshot.dependencies)) {
    lines.push(`| ${name} | ${value.declared ?? '—'} | ${value.installed ?? 'missing'} | ${value.status} |`);
  }
  lines.push('');
  lines.push('## 协议');
  lines.push('');
  lines.push(`- 插件工具数：**${snapshot.protocol.tools.count}**（源码中 register 调用 ${snapshot.protocol.tools.registerCalls}，一致：${snapshot.protocol.tools.consistent ? '是' : '否'}）`);
  lines.push(`- 工具清单：${snapshot.protocol.tools.names.map((toolName) => `\`${toolName}\``).join('、')}`);
  lines.push(`- 工具来源：\`${snapshot.protocol.tools.source}\``);
  lines.push(`- 事件文件：\`${snapshot.protocol.files.events.path}\`（${snapshot.protocol.files.events.exists ? formatBytes(snapshot.protocol.files.events.bytes) : '缺失'}）`);
  lines.push(`- settings：\`${snapshot.protocol.files.settings.path}\`（${snapshot.protocol.files.settings.exists ? formatBytes(snapshot.protocol.files.settings.bytes) : '缺失'}）`);
  lines.push(`- status：\`${snapshot.protocol.files.status.path}\`（${snapshot.protocol.files.status.exists ? formatBytes(snapshot.protocol.files.status.bytes) : '缺失'}）`);
  lines.push('');
  lines.push('## TTS');
  lines.push('');
  lines.push(`- 主引擎：**${snapshot.tts.engine}**（回退：${snapshot.tts.fallbackEngine}）`);
  lines.push(`- 播放：${snapshot.tts.playbackEnabled ? '开' : '关'}；静音：${snapshot.tts.voiceMuted ? '是' : '否'}`);
  lines.push(`- 声音：\`${snapshot.tts.voice.effective}\`（语言 ${snapshot.tts.voice.lang}，来源：${snapshot.tts.voice.source}）`);
  lines.push(`- 语速：${snapshot.tts.rate === null ? '未配置（本构建无该设置项）' : snapshot.tts.rate}`);
  lines.push(`- GPT-SoVITS：${snapshot.tts.gptSovits.enabled ? '启用' : '停用'}；apiBase ${snapshot.tts.gptSovits.apiBase ?? '—'}；timeout ${snapshot.tts.gptSovits.timeoutMs ?? '—'} ms`);
  lines.push(`- 参考音频：\`${snapshot.tts.gptSovits.referenceAudio ?? '—'}\`；prompt 已配置：${snapshot.tts.gptSovits.promptTextConfigured ? '是' : '否'}（${snapshot.tts.gptSovits.promptTextChars} 字，内容不落盘）`);
  if (snapshot.tts.models.length > 0) {
    lines.push('');
    lines.push('| 权重/参考 | 路径 | 字节 | sha256 前 16 位 |');
    lines.push('| --- | --- | ---: | --- |');
    for (const weight of snapshot.tts.models) {
      lines.push(`| ${weight.role} | \`${weight.path}\` | ${weight.exists ? weight.bytes.toLocaleString('en-US') : '缺失'} | \`${weight.sha256_16 ?? 'n/a'}\` |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('本快照为只读采集：未修改 settings、模型或任何运行配置；仅写入本 JSON 与这份摘要。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeSnapshot(snapshot, root, outOverride) {
  const outDir = outOverride ? resolve(outOverride) : join(root, 'cache');
  mkdirSync(outDir, { recursive: true });
  const stamp = defaultStamp();
  let base = join(outDir, `baseline-${stamp}`);
  let suffix = 2;
  while (existsSync(`${base}.json`) || existsSync(`${base}.md`)) {
    base = join(outDir, `baseline-${stamp}-${suffix}`);
    suffix += 1;
  }
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  writeFileSync(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(snapshot), 'utf8');
  return { jsonPath, mdPath };
}

function printSummary(snapshot, jsonPath, mdPath) {
  const repo = snapshot.repo?.git ?? {};
  console.log('Baseline snapshot (read-only)');
  console.log(`  root:     ${snapshot.root}`);
  console.log(`  repo:     ${repo.head ?? 'unknown'} (${repo.branch ?? 'unknown'})`);
  console.log(`  versions: package=${snapshot.versions.package} plugin=${snapshot.versions.plugin} client=${snapshot.versions.client}${snapshot.versions.consistent ? '' : ' [MISMATCH]'}`);
  console.log(`  tools:    ${snapshot.protocol.tools.count} (${snapshot.protocol.tools.source})`);
  console.log(`  models:   ${snapshot.models.files.length} files, ${formatBytes(snapshot.models.totalBytes)}`);
  for (const file of snapshot.models.files) {
    console.log(`    - ${file.file} [${file.role}] ${file.bytes} B sha256:${(file.sha256_16 ?? 'n/a').slice(0, 16)}`);
  }
  console.log('  deps:');
  for (const [name, value] of Object.entries(snapshot.dependencies)) {
    console.log(`    - ${name} ${value.installed ?? 'MISSING'} (${value.status})`);
  }
  console.log(`  TTS:      ${snapshot.tts.engine}, voice=${snapshot.tts.voice.effective}, rate=${snapshot.tts.rate ?? 'unset'}`);
  for (const weight of snapshot.tts.models) {
    console.log(`    - ${weight.role}: ${weight.exists ? `${weight.bytes} B sha256:${weight.sha256_16 ?? 'n/a'}` : 'MISSING'}`);
  }
  console.log(`  JSON:     ${jsonPath}`);
  console.log(`  summary:  ${mdPath}`);
}

// ---------------------------------------------------------------------------- compare

function buildComparable(snapshot) {
  const models = {};
  for (const file of snapshot.models?.files ?? []) {
    models[file.file] = {
      bytes: file.bytes,
      sha256_16: file.sha256_16,
      role: file.role,
    };
  }
  const dependencies = {};
  for (const [name, value] of Object.entries(snapshot.dependencies ?? {})) {
    dependencies[name] = value?.installed ?? 'missing';
  }
  const ttsModels = {};
  for (const weight of snapshot.tts?.models ?? []) {
    ttsModels[weight.role] = {
      path: weight.path,
      exists: weight.exists,
      bytes: weight.bytes,
      sha256_16: weight.sha256_16,
    };
  }
  return {
    runtime: {
      node: snapshot.host?.node ?? null,
      platform: snapshot.host?.platform ?? null,
      arch: snapshot.host?.arch ?? null,
    },
    versions: {
      package: snapshot.versions?.package ?? null,
      plugin: snapshot.versions?.plugin ?? null,
      client: snapshot.versions?.client ?? null,
      commit: snapshot.repo?.git?.head ?? null,
    },
    models: {
      files: models,
      totalBytes: snapshot.models?.totalBytes ?? null,
    },
    dependencies,
    protocol: {
      toolCount: snapshot.protocol?.tools?.count ?? null,
      tools: snapshot.protocol?.tools?.names ?? [],
    },
    tts: {
      engine: snapshot.tts?.engine ?? null,
      voice: snapshot.tts?.voice?.effective ?? null,
      speechLang: snapshot.tts?.voice?.lang ?? null,
      rate: snapshot.tts?.rate ?? null,
      gptEnabled: snapshot.tts?.gptSovits?.enabled ?? null,
      models: ttsModels,
    },
  };
}

function diffValues(oldValue, newValue, label, diffs) {
  if (isPlainObject(oldValue) || isPlainObject(newValue)) {
    const left = isPlainObject(oldValue) ? oldValue : {};
    const right = isPlainObject(newValue) ? newValue : {};
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const childLabel = label ? `${label}.${key}` : key;
      diffValues(left[key], right[key], childLabel, diffs);
    }
    return;
  }
  if (Array.isArray(oldValue) || Array.isArray(newValue)) {
    const left = Array.isArray(oldValue) ? oldValue : [];
    const right = Array.isArray(newValue) ? newValue : [];
    if (left.every((entry) => typeof entry === 'string') && right.every((entry) => typeof entry === 'string')) {
      const added = right.filter((entry) => !left.includes(entry));
      const removed = left.filter((entry) => !right.includes(entry));
      if (added.length > 0 || removed.length > 0) {
        diffs.push({ label, kind: 'set', added, removed });
      }
      return;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      diffs.push({ label, kind: 'value', oldValue, newValue });
    }
    return;
  }
  if (!Object.is(oldValue, newValue)) {
    diffs.push({ label, kind: 'value', oldValue, newValue });
  }
}

function showValue(value) {
  if (value === undefined) return '(missing)';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function compare(oldFile, oldSnapshot, currentSnapshot) {
  const before = buildComparable(oldSnapshot);
  const after = buildComparable(currentSnapshot);
  const diffs = [];
  diffValues(before, after, '', diffs);

  console.log('Baseline compare (current read-only state vs saved JSON)');
  console.log(`  saved:   ${oldFile} (${oldSnapshot.generatedAt ?? 'unknown time'})`);
  console.log(`  current: collected ${currentSnapshot.generatedAt}`);
  if (diffs.length === 0) {
    console.log('  result:  no differences');
    return 0;
  }
  for (const diff of diffs) {
    if (diff.kind === 'set') {
      const added = diff.added.length > 0 ? `+ ${diff.added.join(', ')}` : '';
      const removed = diff.removed.length > 0 ? `- ${diff.removed.join(', ')}` : '';
      console.log(`  ${diff.label}: ${[added, removed].filter(Boolean).join('  ')}`);
    } else {
      console.log(`  ${diff.label}: ${showValue(diff.oldValue)} -> ${showValue(diff.newValue)}`);
    }
  }
  console.log(`  result:  ${diffs.length} difference(s)`);
  return 1;
}

// ---------------------------------------------------------------------------- entry

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`baseline-snapshot: ${error.message}`);
    printUsage();
    return 2;
  }
  if (args.help) {
    printUsage();
    return 0;
  }

  const root = resolveRoot(args.root);
  if (args.compare) {
    const oldFile = resolve(args.compare);
    let oldSnapshot;
    try {
      oldSnapshot = readJson(oldFile);
    } catch (error) {
      console.error(`baseline-snapshot: cannot read ${oldFile}: ${error?.message ?? error}`);
      return 2;
    }
    if (!isPlainObject(oldSnapshot) || oldSnapshot.schema !== SCHEMA
      || !isPlainObject(oldSnapshot.versions) || !Array.isArray(oldSnapshot.models?.files)) {
      console.error(`baseline-snapshot: ${oldFile} is not a ${SCHEMA} snapshot`);
      return 2;
    }
    const currentSnapshot = await collect(root);
    return compare(oldFile, oldSnapshot, currentSnapshot);
  }

  const snapshot = await collect(root);
  const { jsonPath, mdPath } = writeSnapshot(snapshot, root, args.out);
  printSummary(snapshot, jsonPath, mdPath);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`baseline-snapshot: ${error?.stack ?? error}`);
    process.exitCode = 2;
  });
