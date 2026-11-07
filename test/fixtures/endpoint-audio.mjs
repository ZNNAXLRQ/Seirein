/**
 * Synthetic endpoint fixtures for `test/endpoint-sweep.mjs`.
 *
 * The corpus is speech + *digital* silence, so an endpoint's trailing-silence rule sees exactly the
 * configured pause and nothing else:
 *   - five short answers ("好", "不", "停", "OK", "嗯") ≈ 0.3–0.5 s of voiced audio;
 *   - one normal sentence pair spliced with 300 / 500 / 800 ms of silence;
 *   - one long, punctuation-heavy sentence.
 *
 * Speech is Microsoft Edge TTS (the same `msedge-tts` dependency the product uses), decoded to
 * 16 kHz mono PCM16 by ffmpeg. If either is unavailable, the whole corpus falls back to
 * program-generated voiced tones and the manifest says `source: "synthetic"` — that fallback is
 * only valid for endpoint *timing*, never for "was the word recognized". Generated WAVs live in
 * `%TEMP%\dsh-endpoint-sweep\v4`; a rerun replays them unless the manifest is missing, hashes
 * differ, or `ENDPOINT_SWEEP_REGENERATE=1`.
 *
 * Regenerate manually: `$env:ENDPOINT_SWEEP_REGENERATE='1'; node --test test/endpoint-sweep.mjs`
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pkg from 'msedge-tts';

const { MsEdgeTTS, OUTPUT_FORMAT } = pkg;
const run = promisify(execFile);

export const FIXTURE_VERSION = 4;
export const SAMPLE_RATE = 16000;
/** Capture-sized chunks used by the sweep (the real chain checks the endpoint per ffmpeg chunk). */
export const CHUNK_MS = 100;
export const LEADING_SILENCE_MS = 200;
/** Long enough for the shipping 3.0 s no-token rule to fire on a text-less short answer. */
export const TRAILING_SILENCE_MS = 3800;
export const PAUSE_MS = Object.freeze([300, 500, 800]);
export const TTS_VOICE = 'zh-CN-XiaoxiaoNeural';

export const SHORT_ANSWERS = Object.freeze([
  Object.freeze({ id: 'short-hao', text: '好' }),
  Object.freeze({ id: 'short-bu', text: '不' }),
  Object.freeze({ id: 'short-ting', text: '停' }),
  Object.freeze({ id: 'short-ok', text: 'OK' }),
  Object.freeze({ id: 'short-en', text: '嗯' }),
]);

export const FIRST_SENTENCE = '今天下午三点开会';
export const SECOND_SENTENCE = '记得带上笔记本';
export const LONG_SENTENCE = '今天下午三点开会，记得带上笔记本，路上不要迟到。';

const CORPUS_ID = `endpoint-v${FIXTURE_VERSION}:short${SHORT_ANSWERS.length}:pause${PAUSE_MS.join('/')}:long1`;
const DEFAULT_ROOT = join(tmpdir(), 'dsh-endpoint-sweep', `v${FIXTURE_VERSION}`);

const nowMs = () => Math.round(performance.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function resolveFfmpeg() {
  const candidates = [
    process.env.ENDPOINT_SWEEP_FFMPEG,
    process.env.DSH_FFMPEG_PATH,
    process.env.FFMPEG_PATH,
    join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    join(homedir(), '.dsh', 'bin', 'ffmpeg.exe'),
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) ?? null;
}

/** 10 ms frame energy trim; returns the voiced core plus `marginMs` of context on each side. */
export function trimSpeech(pcm, {
  sampleRate = SAMPLE_RATE,
  frameMs = 10,
  floorDb = -45,
  marginMs = 20,
} = {}) {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const margin = Math.round((sampleRate * marginMs) / 1000);
  let first = -1;
  let last = -1;
  for (let start = 0; start + frame <= pcm.length; start += frame) {
    let sumSquares = 0;
    for (let index = start; index < start + frame; index += 1) sumSquares += pcm[index] * pcm[index];
    const db = 20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSquares / frame)));
    if (db >= floorDb) {
      if (first < 0) first = start;
      last = start + frame;
    }
  }
  if (first < 0) return new Float32Array(0);
  return pcm.subarray(Math.max(0, first - margin), Math.min(pcm.length, last + margin));
}

/** Voiced runs of a clip, in ms. Used for the long sentence's internal punctuation pauses. */
export function detectSpeechRanges(pcm, { frameMs = 20, floorDb = -50, minSilenceMs = 100 } = {}) {
  const frame = Math.max(1, Math.round((SAMPLE_RATE * frameMs) / 1000));
  const runs = [];
  let start = -1;
  let lastVoiced = -1;
  for (let offset = 0; offset + frame <= pcm.length; offset += frame) {
    let sumSquares = 0;
    for (let index = offset; index < offset + frame; index += 1) sumSquares += pcm[index] * pcm[index];
    const voiced = 20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSquares / frame))) >= floorDb;
    if (voiced) {
      if (start < 0) start = offset;
      lastVoiced = offset + frame;
    } else if (start >= 0 && (offset - lastVoiced) >= (SAMPLE_RATE * minSilenceMs) / 1000) {
      runs.push([Math.round((start * 1000) / SAMPLE_RATE), Math.round((lastVoiced * 1000) / SAMPLE_RATE)]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([Math.round((start * 1000) / SAMPLE_RATE), Math.round((lastVoiced * 1000) / SAMPLE_RATE)]);
  return runs;
}

function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.alloc(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) {
    const value = Math.max(-32768, Math.min(32767, Math.round(pcm[index] * 32767)));
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Minimal RIFF reader for the 16 kHz mono PCM16 files this module writes. */
export function readWav(file) {
  const buffer = readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (fmt === null || data === null) throw new Error(`${file}: missing fmt/data chunk`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== SAMPLE_RATE || fmt.bitsPerSample !== 16) {
    throw new Error(`${file}: expected PCM16 mono ${SAMPLE_RATE} Hz, got ${JSON.stringify(fmt)}`);
  }
  const pcm = new Float32Array(data.length / 2);
  for (let index = 0; index < pcm.length; index += 1) pcm[index] = data.readInt16LE(index * 2) / 32768;
  return { ...fmt, pcm, durationMs: (pcm.length * 1000) / SAMPLE_RATE };
}

function silence(ms) {
  return new Float32Array(Math.round((SAMPLE_RATE * ms) / 1000));
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Deterministic voiced fallback: harmonic "vowel" with a syllabic envelope (never real speech). */
function syntheticVoice(ms, seed = 1) {
  const length = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Float32Array(length);
  let phase = 0;
  for (let index = 0; index < length; index += 1) {
    const t = index / SAMPLE_RATE;
    const syllable = 0.62 + 0.38 * Math.sin(2 * Math.PI * 4 * t + seed);
    const f0 = 180 + 12 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SAMPLE_RATE;
    out[index] = syllable * (
      0.28 * Math.sin(phase) +
      0.16 * Math.sin(2 * phase) +
      0.08 * Math.sin(3 * phase + 0.4) +
      0.04 * Math.sin(2 * Math.PI * 1200 * t)
    );
  }
  return out;
}

async function withDeadline(promise, ms, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function synthesizeMp3(tts, text, timeoutMs) {
  const chunks = [];
  const { audioStream } = tts.toStream(text);
  audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await withDeadline(new Promise((resolve, reject) => {
    audioStream.once('close', resolve);
    audioStream.once('error', reject);
  }), timeoutMs, `TTS "${text}"`);
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw new Error(`TTS "${text}" returned no audio`);
  return audio;
}

/** Edge TTS + ffmpeg for every unique sentence; any failure throws so the caller can fall back. */
async function synthesizeCorpus(rootDir, { timeoutMs = 30000 } = {}) {
  if (process.env.ENDPOINT_SWEEP_TTS === '0') throw new Error('ENDPOINT_SWEEP_TTS=0');
  const ffmpeg = resolveFfmpeg();
  if (ffmpeg === null) throw new Error('ffmpeg not found (TTS decode needs it)');
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 20000 });
  const spoken = new Map();
  const cacheDir = join(rootDir, 'tts-cache');
  mkdirSync(cacheDir, { recursive: true });
  try {
    await tts.setMetadata(TTS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const texts = [
      ...SHORT_ANSWERS.map((entry) => entry.text),
      FIRST_SENTENCE,
      SECOND_SENTENCE,
      LONG_SENTENCE,
    ];
    for (const [index, text] of texts.entries()) {
      const mp3 = join(cacheDir, `line-${index}.mp3`);
      const raw = join(cacheDir, `line-${index}.s16le`);
      writeFileSync(mp3, await synthesizeMp3(tts, text, timeoutMs));
      await withDeadline(run(ffmpeg, [
        '-y', '-loglevel', 'error', '-i', mp3,
        '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', raw,
      ], { windowsHide: true, timeout: timeoutMs }), timeoutMs, `ffmpeg decode "${text}"`);
      const bytes = readFileSync(raw);
      const pcm = new Float32Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
      const core = trimSpeech(pcm);
      if (core.length < SAMPLE_RATE * 0.15) throw new Error(`TTS "${text}" voiced core is too short`);
      spoken.set(text, core);
      await sleep(60);
    }
    return { source: 'edge-tts', spoken };
  } finally {
    tts.close();
  }
}

function synthesizeFallbackCorpus() {
  const spoken = new Map();
  for (const entry of SHORT_ANSWERS) spoken.set(entry.text, syntheticVoice(300, entry.id.length));
  spoken.set(FIRST_SENTENCE, syntheticVoice(1500, 2));
  spoken.set(SECOND_SENTENCE, syntheticVoice(1300, 3));
  spoken.set(LONG_SENTENCE, syntheticVoice(4200, 4));
  return { source: 'synthetic', spoken };
}

function buildClip({ id, kind, text, core, leading = LEADING_SILENCE_MS, trailing = TRAILING_SILENCE_MS, pauseMs = null, secondCore = null, secondText = null }) {
  const lead = silence(leading);
  const parts = [lead, core];
  const ranges = [[leading, leading + Math.round((core.length * 1000) / SAMPLE_RATE)]];
  if (secondCore !== null) {
    const pauseStart = leading + Math.round((core.length * 1000) / SAMPLE_RATE);
    const pauseSamples = Math.round((SAMPLE_RATE * pauseMs) / 1000);
    parts.push(new Float32Array(pauseSamples), secondCore);
    const secondStart = pauseStart + pauseMs;
    ranges.push([secondStart, secondStart + Math.round((secondCore.length * 1000) / SAMPLE_RATE)]);
  }
  parts.push(silence(trailing));
  const pcm = concat(parts);
  // The long sentence has real punctuation pauses inside one TTS line; record their onsets so a
  // split there is measurable as a split (and its latency is measured from the pause onset).
  const measuredRanges = kind === 'long' ? detectSpeechRanges(pcm) : ranges;
  return {
    id,
    kind,
    text,
    secondText,
    pauseMs,
    pcm,
    speechRangesMs: measuredRanges,
    speechMs: measuredRanges.reduce((sum, [start, end]) => sum + (end - start), 0),
    durationMs: Math.round((pcm.length * 1000) / SAMPLE_RATE),
  };
}

function describeClips(spoken) {
  const clips = [];
  for (const entry of SHORT_ANSWERS) {
    clips.push(buildClip({ id: entry.id, kind: 'short-answer', text: entry.text, core: spoken.get(entry.text) }));
  }
  for (const pauseMs of PAUSE_MS) {
    clips.push(buildClip({
      id: `pause-${pauseMs}`,
      kind: 'pause',
      text: FIRST_SENTENCE,
      secondText: SECOND_SENTENCE,
      core: spoken.get(FIRST_SENTENCE),
      secondCore: spoken.get(SECOND_SENTENCE),
      pauseMs,
    }));
  }
  clips.push(buildClip({
    id: 'long-sentence',
    kind: 'long',
    text: LONG_SENTENCE,
    core: spoken.get(LONG_SENTENCE),
  }));
  return clips;
}

const MANIFEST_NAME = 'manifest.json';

function loadReplay(rootDir) {
  if (process.env.ENDPOINT_SWEEP_REGENERATE === '1') return null;
  const file = join(rootDir, MANIFEST_NAME);
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.kind !== 'endpoint-audio-fixtures' || manifest.version !== FIXTURE_VERSION) return null;
    if (manifest.corpusId !== CORPUS_ID || !Array.isArray(manifest.clips)) return null;
    for (const clip of manifest.clips) {
      const wav = join(rootDir, clip.file);
      if (!existsSync(wav)) return null;
      const buffer = readFileSync(wav);
      if (buffer.length !== clip.bytes || sha256(buffer) !== clip.sha256) return null;
    }
    return { ...manifest, clips: manifest.clips.map((clip) => ({ ...clip, path: join(rootDir, clip.file) })) };
  } catch {
    return null;
  }
}

let pending = null;

/**
 * Generate (or replay) the fixture corpus.
 * @param {{rootDir?: string, force?: boolean, log?: (line: string) => void}} [options]
 * @returns {Promise<object>} the manifest, with absolute `file` paths on every clip
 */
export function ensureEndpointFixtures({ rootDir = DEFAULT_ROOT, force = false, log = () => {} } = {}) {
  if (!force && pending !== null) return pending;
  pending = (async () => {
    const root = rootDir;
    mkdirSync(root, { recursive: true });
    if (!force) {
      const replay = loadReplay(root);
      if (replay !== null) {
        log(`fixtures: replay ${replay.clips.length} clips from ${root} (${replay.source})`);
        return { ...replay, rootDir: root };
      }
    }
    const started = nowMs();
    let corpus;
    try {
      corpus = await synthesizeCorpus(root);
      log(`fixtures: TTS ${corpus.spoken.size} lines in ${nowMs() - started} ms`);
    } catch (error) {
      log(`fixtures: TTS unavailable (${error?.message ?? error}); using the synthetic timing fallback`);
      corpus = synthesizeFallbackCorpus();
    }
    const clips = describeClips(corpus.spoken).map((clip) => {
      const file = `${clip.id}.wav`;
      const buffer = encodeWav(clip.pcm);
      writeFileSync(join(root, file), buffer);
      return {
        id: clip.id,
        kind: clip.kind,
        text: clip.text,
        secondText: clip.secondText,
        pauseMs: clip.pauseMs,
        file,
        path: join(root, file),
        bytes: buffer.length,
        sha256: sha256(buffer),
        durationMs: clip.durationMs,
        speechRangesMs: clip.speechRangesMs,
        speechMs: clip.speechMs,
      };
    });
    const manifest = {
      kind: 'endpoint-audio-fixtures',
      version: FIXTURE_VERSION,
      corpusId: CORPUS_ID,
      generatedAt: new Date().toISOString(),
      source: corpus.source,
      voice: TTS_VOICE,
      sampleRate: SAMPLE_RATE,
      chunkMs: CHUNK_MS,
      leadingSilenceMs: LEADING_SILENCE_MS,
      trailingSilenceMs: TRAILING_SILENCE_MS,
      pauseMs: [...PAUSE_MS],
      disclaimer: corpus.source === 'edge-tts'
        ? 'Edge TTS 合成语音 + 数字静音拼接；不是真人录音，只用于端点时序与切段对照。'
        : 'TTS 不可用，退化为程序生成的正弦/谐波信号 + 数字静音；不是真实语音，答案识别结果无意义，只用于端点时序。',
      clips,
    };
    writeFileSync(join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    rmSync(join(root, 'tts-cache'), { recursive: true, force: true });
    log(`fixtures: generated ${clips.length} clips in ${nowMs() - started} ms (${manifest.source})`);
    return { ...manifest, rootDir: root };
  })();
  return pending;
}

export function defaultFixtureRoot() {
  return DEFAULT_ROOT;
}
