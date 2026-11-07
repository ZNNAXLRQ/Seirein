#!/usr/bin/env node
/**
 * Fixture generator for the "a word straddles the 15 s / 30 s ASR decode cut" question.
 *
 * The final pass in `src/host/hearing/hearing.js` decodes a long utterance in fixed-size pieces
 * (`decodeCapSec`, default 15 s) and concatenates the texts with `joinSegmentTexts`. Whether a
 * word that crosses one of those boundaries survives is an empirical question, so this script
 * builds a reproducible test set that *really* crosses the boundaries:
 *
 *  1. Synthesize each script sentence with the host TTS (Edge, zh-CN-XiaoxiaoNeural) and convert
 *     it to 16 kHz mono PCM WAV.
 *  2. Assemble one ~40 s master timeline. Two two-syllable marker words (`橙子`, `雷达`) are
 *     placed so their *measured* speech span straddles 15.000 s and 30.000 s respectively.
 *     Speech is filled with neutral filler sentences first, so the file is continuous speech
 *     with 120 ms gaps, not a long stretch of silence with two words in it.
 *  3. Verify on the assembled waveform (frame RMS, 20 ms frames / 10 ms hop) that the marker's
 *     acoustic span crosses the cut with >= 40 ms of voiced audio on each side, and that the cut
 *     itself falls inside voiced audio (-30 ms / +30 ms probes). If it does not, the script fails.
 *  4. Derive five versions from that same master: prepend 0 / 0.3 / 0.6 / 0.9 s of silence, plus a
 *     `trim-0.45` control that shifts the markers *before* the cut (the master keeps 1.2 s of
 *     leading silence so a negative shift is possible). The same words therefore land before,
 *     across and after the boundary.
 *  5. Write `test/fixtures/asr-cutpoint/{manifest.json,*.wav}` with expected text, normalized
 *     checks, per-version marker ranges and sha256 checksums.
 *
 * Scope: this set is TTS "clear pronunciation" only. It cannot replace a human recording (natural
 * pacing, coarticulation, pauses). `tools/asr-cutpoint-check.mjs --wav <file>` accepts a user WAV
 * directly, which is the intended next step.
 *
 * Usage:
 *   node tools/asr-cutpoint-fixture.mjs [--out test/fixtures/asr-cutpoint] [--voice <name>]
 *                                       [--ffmpeg <path>] [--force] [--keep-cache]
 *
 * Output is deterministic per cached TTS clip: rerunning reuses `.tmp-asr-cutpoint/cache` unless
 * `--force` is given.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesize } from '../src/host/speech/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 16000;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;
const FRAME_SAMPLES = 320; // 20 ms analysis frame
const HOP_SAMPLES = 160; // 10 ms hop
const DECODE_CAP_SEC = 15;
const TOTAL_MS = 40_000;
const LEAD_MS = 1_200; // kept so trim variants can move speech EARLIER than the cut
const GAP_MS = 120; // between two speech clips
const CACHE_VERSION = 1;

/** Two cut points, two marker words; each marker's speech onset is placed relative to its cut. */
const MARKER_SPECS = [
  // The boundary must land inside voiced audio (not in an inter-syllable pause), so each onset is
  // tuned against the measured frame energies of the TTS clip and re-checked after assembly.
  { key: 'marker1', text: '橙子', cutMs: 15_000, targetOnsetMs: 14_750, windowMs: [14_500, 15_400] },
  { key: 'marker2', text: '雷达', cutMs: 30_000, targetOnsetMs: 29_850, windowMs: [29_600, 30_500] },
];

/**
 * One master timeline. The two sentences the regression cares about (digits/negation and the
 * repeated phrase) are real script text; the rest is connective speech so the file is not mostly
 * silence. Every filler avoids 非常 / marker words / digits so the checks stay unambiguous.
 */
const ORDER = [
  { text: '第三十七号房间不是四十二号，请确认一万二千五百这个数。' },
  { text: '非常非常重要，非常非常重要，这一点非常关键。' },
  { marker: 'marker1' },
  { text: '接下来我们确认后面的内容，请先不要走开。' },
  { text: '这段录音会被分成好几个小段，每一段都会单独识别一次。' },
  { marker: 'marker2' },
  { text: '最后重复一遍，第三十七号房间和一万二千五百都没有变。' },
  { text: '以上就是这次边界测试的全部内容。' },
];

const FILLERS = [
  '我们先把这个位置记下来。',
  '继续往下看。',
  '这里需要一点耐心。',
  '好的，我们继续。',
  '请保持安静，很快就好了。',
];

const VARIANTS = [
  { name: 'offset-0.0', offsetMs: 0, trimMs: 0, note: '基准：两个定位词压在 15 s / 30 s 切点上（跨切点）' },
  { name: 'offset-0.3', offsetMs: 300, trimMs: 0, note: '整体后移 300 ms：定位词落到切点之后' },
  { name: 'offset-0.6', offsetMs: 600, trimMs: 0, note: '整体后移 600 ms：定位词落到切点之后' },
  { name: 'offset-0.9', offsetMs: 900, trimMs: 0, note: '整体后移 900 ms：定位词落到切点之后' },
  { name: 'trim-0.45', offsetMs: 0, trimMs: 450, note: '对照组：整体前移 450 ms（削掉前导静音）：定位词落到切点之前' },
];

const CHECKS = {
  // Order matters: the same two numbers appear a second time in the closing sentence.
  numbers: [37, 42, 12500, 37, 12500],
  negation: '不是',
  /** `非常非常重要，非常非常重要，这一点非常关键` → five `非常` in the whole script. */
  veryCount: 5,
  /** If the two repeated halves are merged/dropped this exact run breaks. */
  repetitionPair: '非常非常重要非常非常重要',
  markers: ['橙子', '雷达'],
  tail: '全部内容',
};

// ---------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    out: join(REPO, 'test', 'fixtures', 'asr-cutpoint'),
    voice: 'zh-CN-XiaoxiaoNeural',
    ffmpeg: '',
    force: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
      index += 1;
      return value;
    };
    if (arg === '--out') options.out = resolve(next());
    else if (arg === '--voice') options.voice = next();
    else if (arg === '--ffmpeg') options.ffmpeg = next();
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/asr-cutpoint-fixture.mjs [--out <dir>] [--voice <name>] [--ffmpeg <path>] [--force]');
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function resolveFfmpeg(explicit) {
  const candidates = [
    explicit,
    process.env.ASSISTANT_FFMPEG,
    join(process.env.USERPROFILE ?? homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    throw new Error('找不到 ffmpeg：安装到 %USERPROFILE%\\.dsh\\tools\\ffmpeg\\bin\\ffmpeg.exe，或用 --ffmpeg/ASSISTANT_FFMPEG 指定');
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Minimal RIFF reader: enough for 16-bit PCM mono/stereo WAV from ffmpeg. */
function readWav(buffer, label = 'wav') {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label}: 不是 RIFF/WAVE`);
  }
  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (fmt === null || dataStart < 0) throw new Error(`${label}: 缺少 fmt/data chunk`);
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) throw new Error(`${label}: 需要 16-bit PCM`);
  const frames = Math.floor(dataLength / (2 * fmt.channels));
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    const base = dataStart + index * 2 * fmt.channels;
    samples[index] = buffer.readInt16LE(base) / 32768;
  }
  return { ...fmt, samples, dataLength, durationMs: (frames * 1000) / fmt.sampleRate };
}

/** 16 kHz mono 16-bit PCM WAV, with no extra chunks. */
function encodeWav(samples) {
  const bytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(bytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
}

/** Peak-normalize a clip (max +6 dB) and fade 8 ms at both edges so splice points do not click. */
function conditionClip(samples) {
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  const gain = peak > 0.02 ? Math.min(2, 0.9 / peak) : 1;
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) out[index] = samples[index] * gain;
  const fade = Math.min(128, Math.floor(out.length / 2));
  for (let index = 0; index < fade; index += 1) {
    const ramp = index / fade;
    out[index] *= ramp;
    out[out.length - 1 - index] *= ramp;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// waveform analysis (the evidence that matters: is the cut really inside voiced audio?)
// ---------------------------------------------------------------------------------------------
function frameEnergies(samples, fromMs, toMs) {
  const from = Math.max(0, Math.round(fromMs * SAMPLES_PER_MS));
  const to = Math.min(samples.length, Math.round(toMs * SAMPLES_PER_MS));
  const frames = [];
  for (let start = from; start + FRAME_SAMPLES <= to; start += HOP_SAMPLES) {
    let sum = 0;
    for (let index = start; index < start + FRAME_SAMPLES; index += 1) sum += samples[index] * samples[index];
    frames.push({ startMs: start / SAMPLES_PER_MS, rms: Math.sqrt(sum / FRAME_SAMPLES) });
  }
  return frames;
}

/** Adaptive voiced threshold: 10 % of the region's 95th percentile (min -54 dBFS). */
function voicedThreshold(frames) {
  if (frames.length === 0) return 0.002;
  const sorted = frames.map((frame) => frame.rms).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(0.002, p95 * 0.1);
}

/** RMS in dBFS over a 20 ms window centred on `centreMs`. */
function rmsDbAt(samples, centreMs) {
  const start = Math.max(0, Math.round((centreMs - 10) * SAMPLES_PER_MS));
  const end = Math.min(samples.length, start + FRAME_SAMPLES);
  if (end <= start) return -120;
  let sum = 0;
  for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
  return 20 * Math.log10(Math.max(1e-7, Math.sqrt(sum / (end - start))));
}

/** Voiced span of one clip, measured from its own waveform (TTS adds a little lead/tail silence). */
function measureClip(samples) {
  const frames = frameEnergies(samples, 0, (samples.length / SAMPLES_PER_MS) + 1);
  const threshold = voicedThreshold(frames);
  const voiced = frames.filter((frame) => frame.rms >= threshold);
  if (voiced.length === 0) return { onsetMs: 0, offsetMs: (samples.length / SAMPLES_PER_MS), voiced: false };
  return {
    onsetMs: Math.max(0, voiced[0].startMs - 10),
    offsetMs: Math.min(samples.length / SAMPLES_PER_MS, voiced[voiced.length - 1].startMs + 20),
    voiced: true,
  };
}

/** Measure a marker's acoustic span in a concrete variant file and test the cut. */
function analyzeMarker(samples, marker, shiftMs) {
  const clip = marker.clip;
  const expectedStart = marker.placedStartMs + clip.onsetMs + shiftMs;
  const expectedEnd = marker.placedStartMs + clip.offsetMs + shiftMs;
  // The search window stays inside the 120 ms gaps around the marker, so neighbours cannot leak in.
  const frames = frameEnergies(samples, expectedStart - 60, expectedEnd + 60);
  const threshold = voicedThreshold(frames);
  const voiced = frames.filter((frame) => frame.rms >= threshold);
  const startMs = voiced.length > 0 ? voiced[0].startMs : expectedStart;
  const endMs = voiced.length > 0 ? voiced[voiced.length - 1].startMs + 20 : expectedEnd;
  const cutMs = marker.spec.cutMs;
  const marginBeforeMs = cutMs - startMs;
  const marginAfterMs = endMs - cutMs;
  const relation = startMs >= cutMs ? 'after' : endMs <= cutMs ? 'before' : 'cross';
  return {
    startMs,
    endMs,
    expectedStartMs: expectedStart,
    expectedEndMs: expectedEnd,
    driftMs: startMs - expectedStart,
    relation,
    crosses: marginBeforeMs >= 40 && marginAfterMs >= 40,
    marginBeforeMs: Math.round(marginBeforeMs),
    marginAfterMs: Math.round(marginAfterMs),
    cutEnergyDb: { before: rmsDbAt(samples, cutMs - 30), after: rmsDbAt(samples, cutMs + 30) },
    voiced,
  };
}

// ---------------------------------------------------------------------------------------------
// TTS clips (cached in .tmp-asr-cutpoint, which .gitignore already covers)
// ---------------------------------------------------------------------------------------------
async function loadClip({ text, voice, ffmpeg, force }) {
  const cacheDir = join(REPO, '.tmp-asr-cutpoint', 'cache');
  await mkdir(cacheDir, { recursive: true });
  const key = createHash('sha1').update(`${CACHE_VERSION}|${voice}|${text}`).digest('hex').slice(0, 16);
  const wavPath = join(cacheDir, `${key}.wav`);
  const metaPath = join(cacheDir, `${key}.json`);

  let meta = null;
  if (!force && existsSync(wavPath) && existsSync(metaPath)) {
    try {
      const cached = JSON.parse(await readFile(metaPath, 'utf8'));
      if (cached.text === text && cached.voice === voice && cached.cacheVersion === CACHE_VERSION) meta = cached;
    } catch {
      /* fall through and regenerate */
    }
  }

  if (meta === null) {
    const ttsDir = join(REPO, '.tmp-asr-cutpoint', 'tts');
    let audio = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        audio = await synthesize({ text, voice, dir: ttsDir });
        break;
      } catch (error) {
        if (attempt === 3) throw new Error(`TTS 合成失败（${attempt} 次）：${text} :: ${error?.message ?? error}`);
        await sleep(500 * attempt);
      }
    }
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', audio.file, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', wavPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    meta = {
      cacheVersion: CACHE_VERSION,
      text,
      voice,
      provider: audio.provider,
      sourceBytes: audio.bytes,
      wav: wavPath,
    };
  }

  const parsed = readWav(await readFile(wavPath), text);
  if (parsed.sampleRate !== SAMPLE_RATE || parsed.channels !== 1) {
    throw new Error(`缓存 WAV 格式不对：${wavPath}`);
  }
  const samples = conditionClip(parsed.samples);
  const span = measureClip(samples);
  meta.durationMs = parsed.durationMs;
  meta.onsetMs = span.onsetMs;
  meta.offsetMs = span.offsetMs;
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { ...meta, samples, span };
}

// ---------------------------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------------------------
function planTimeline(clipByText) {
  const events = [];
  const markers = [];
  let cursor = LEAD_MS;
  events.push({ kind: 'silence', ms: LEAD_MS, label: 'lead-in（保留 1.2 s 供 trim 对照前移）' });

  const pushSpeech = (text, label) => {
    const clip = clipByText.get(text);
    if (!clip) throw new Error(`缺少音频片段：${text}`);
    events.push({ kind: 'silence', ms: GAP_MS });
    cursor += GAP_MS;
    events.push({ kind: 'clip', text, placedStartMs: cursor, label });
    cursor += clip.durationMs;
  };

  for (const item of ORDER) {
    if (item.marker) {
      const spec = MARKER_SPECS.find((entry) => entry.key === item.marker);
      const clip = clipByText.get(spec.text);
      const placeStart = Math.round(spec.targetOnsetMs - clip.onsetMs);
      // Fill the wait with neutral speech instead of a long dead pause; largest clip that still fits.
      for (;;) {
        const best = FILLERS
          .map((text) => clipByText.get(text))
          .filter((filler) => filler && cursor + GAP_MS + filler.durationMs <= placeStart - 120)
          .sort((a, b) => b.durationMs - a.durationMs)[0];
        if (!best) break;
        pushSpeech(best.text, 'filler');
      }
      const gap = placeStart - cursor;
      if (gap < 0) {
        throw new Error(
          `时间预算不足：${spec.key} 需要 ${spec.targetOnsetMs} ms 开始，但前面的语音已到 ${Math.round(cursor)} ms；请缩短脚本或把目标后移`,
        );
      }
      if (gap > 0) {
        events.push({ kind: 'silence', ms: gap, label: `pad before ${spec.key}` });
        cursor = placeStart;
      }
      events.push({ kind: 'clip', text: spec.text, placedStartMs: cursor, label: `marker:${spec.key}` });
      markers.push({ spec, clip, placedStartMs: cursor });
      cursor += clip.durationMs;
    } else {
      pushSpeech(item.text, 'script');
    }
  }

  const totalMs = Math.max(TOTAL_MS, Math.ceil(cursor + 300)); // keep >= 300 ms of tail silence
  if (totalMs > 42_000) throw new Error(`时间超出 42 s：脚本已到 ${Math.round(cursor)} ms，请删减文本`);
  events.push({ kind: 'silence', ms: totalMs - cursor, label: 'tail pad' });
  return { events, markers, totalMs };
}

function assemble(events, clipByText, totalMs) {
  const out = new Float32Array(Math.round(totalMs * SAMPLES_PER_MS));
  for (const event of events) {
    if (event.kind !== 'clip') continue;
    const clip = clipByText.get(event.text);
    const start = Math.round(event.placedStartMs * SAMPLES_PER_MS);
    out.set(clip.samples, start);
  }
  return out;
}

function variantSamples(master, { offsetMs, trimMs }) {
  const lead = Math.round(offsetMs * SAMPLES_PER_MS);
  const trim = Math.round(trimMs * SAMPLES_PER_MS);
  const core = master.subarray(Math.min(trim, master.length));
  const out = new Float32Array(lead + core.length);
  out.set(core, lead);
  return out;
}

// ---------------------------------------------------------------------------------------------
// numbers/check helpers (mirrored in tools/asr-cutpoint-check.mjs — keep them in sync)
// ---------------------------------------------------------------------------------------------
const CN_DIGITS = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
  ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
]);
const CN_UNITS = new Map([['十', 10], ['百', 100], ['千', 1000]]);

function chineseToInt(run) {
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of run) {
    if (CN_DIGITS.has(char)) {
      number = CN_DIGITS.get(char);
    } else if (char === '万') {
      section = (section + number) * 10_000;
      total += section;
      section = 0;
      number = 0;
    } else if (char === '亿') {
      total = (total + section + number) * 100_000_000;
      section = 0;
      number = 0;
    } else if (CN_UNITS.has(char)) {
      section += (number === 0 ? 1 : number) * CN_UNITS.get(char);
      number = 0;
    }
  }
  return total + section + number;
}

/** Numbers in reading order, with Arabic digits and Chinese numerals treated the same. */
function extractNumbers(text) {
  const numbers = [];
  const pattern = /[〇零一二两三四五六七八九十百千万亿]+|\d+/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    if (/^\d+$/u.test(raw)) {
      numbers.push(Number(raw));
      continue;
    }
    // A bare 一/两 (第一、一遍) is a counter, not a measured number: skip units-less single chars.
    if (!/[十百千万亿]/u.test(raw) && raw.length < 2) continue;
    numbers.push(chineseToInt(raw));
  }
  return numbers;
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/gu, '')
    .replace(/[，。！？、；：,.!?;:'"“”‘’…—（）()\-]/gu, '')
    .toLowerCase();
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function expectedTextOf() {
  return ORDER.map((item) => (item.marker ? MARKER_SPECS.find((spec) => spec.key === item.marker).text : item.text)).join('');
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv);
  const ffmpeg = resolveFfmpeg(options.ffmpeg);
  await mkdir(options.out, { recursive: true });

  const texts = [...new Set([...ORDER.map((item) => (item.marker ? MARKER_SPECS.find((spec) => spec.key === item.marker).text : item.text)), ...FILLERS])];
  console.log(`[fixture] ffmpeg: ${ffmpeg}`);
  console.log(`[fixture] voice: ${options.voice}，需要 ${texts.length} 段 TTS（缓存命中则跳过合成）`);

  const clipByText = new Map();
  for (const text of texts) {
    const clip = await loadClip({ text, voice: options.voice, ffmpeg, force: options.force });
    clipByText.set(text, clip);
    console.log(
      `  + 「${text}」${Math.round(clip.durationMs)} ms，有声 ${Math.round(clip.onsetMs)}–${Math.round(clip.offsetMs)} ms`,
    );
  }

  const { events, markers, totalMs } = planTimeline(clipByText);
  const master = assemble(events, clipByText, totalMs);
  console.log(`[fixture] 主时间线：${(totalMs / 1000).toFixed(2)} s，${events.length} 个片段事件，${markers.length} 个定位词`);

  const versions = [];
  let failed = false;

  for (const variant of VARIANTS) {
    const samples = variantSamples(master, variant);
    const shiftMs = variant.offsetMs - variant.trimMs;
    const fileName = `${variant.name}.wav`;
    const buffer = encodeWav(samples);
    await writeFile(join(options.out, fileName), buffer);

    console.log(
      `\n[fixture] ${variant.name}：front +${variant.offsetMs} ms，trim ${variant.trimMs} ms → ${relative(REPO, join(options.out, fileName))} ` +
        `(${((buffer.length - 44) / 2 / SAMPLE_RATE).toFixed(2)} s, ${(buffer.length / 1024).toFixed(0)} KiB)`,
    );

    const markerEvidence = markers.map((marker) => {
      const evidence = analyzeMarker(samples, marker, shiftMs);
      const relation = evidence.relation === 'cross' ? '跨切点' : evidence.relation === 'before' ? '切点前' : '切点后';
      console.log(
        `  ${marker.spec.key}「${marker.spec.text}」cut ${(marker.spec.cutMs / 1000).toFixed(3)}s ` +
          `实测 ${(evidence.startMs / 1000).toFixed(3)}–${(evidence.endMs / 1000).toFixed(3)}s（${relation}，` +
          `前 ${evidence.marginBeforeMs} ms / 后 ${evidence.marginAfterMs} ms），` +
          `切点±30 ms 能量 ${evidence.cutEnergyDb.before.toFixed(1)} / ${evidence.cutEnergyDb.after.toFixed(1)} dBFS`,
      );
      if (evidence.voiced === false) console.log('    ! 该窗口内没有检测到有声帧，定位词可能被静音吞掉');
      if (Math.abs(evidence.driftMs) > 60) console.log(`    ! 实测起点与计划相差 ${Math.round(evidence.driftMs)} ms`);
      return {
        key: marker.spec.key,
        text: marker.spec.text,
        cutMs: marker.spec.cutMs,
        expectedRangeMs: [Math.round(evidence.expectedStartMs), Math.round(evidence.expectedEndMs)],
        measuredRangeMs: [Math.round(evidence.startMs), Math.round(evidence.endMs)],
        relation: evidence.relation,
        crosses: evidence.crosses,
        marginBeforeMs: evidence.marginBeforeMs,
        marginAfterMs: evidence.marginAfterMs,
        cutEnergyDb: { before: Number(evidence.cutEnergyDb.before.toFixed(1)), after: Number(evidence.cutEnergyDb.after.toFixed(1)) },
      };
    });

    // The base version must really cross both cuts; offsets are only useful if the base crosses.
    if (variant.offsetMs === 0 && variant.trimMs === 0) {
      for (const evidence of markerEvidence) {
        if (!evidence.crosses) {
          failed = true;
          console.log(`  ✗ ${evidence.key}「${evidence.text}」没有跨过 ${evidence.cutMs} ms 切点：` +
            `前 ${evidence.marginBeforeMs} ms / 后 ${evidence.marginAfterMs} ms（各需 >= 40 ms）`);
        }
        // A word that crosses is not enough: the cut must fall in voiced audio, not in the small
        // pause between its syllables ("恰好落在停顿里" would prove nothing).
        if (evidence.cutEnergyDb.before < -35 || evidence.cutEnergyDb.after < -35) {
          failed = true;
          console.log(`  ✗ ${evidence.key} 切点处能量过低（${evidence.cutEnergyDb.before} / ${evidence.cutEnergyDb.after} dBFS），` +
            '说明切点落在停顿里，测不到丢字');
        }
      }
    }

    versions.push({
      name: variant.name,
      file: fileName,
      offsetMs: variant.offsetMs,
      trimMs: variant.trimMs,
      shiftMs,
      note: variant.note,
      // Offsets never change the words, so every version carries the same expected transcript.
      expectedText: expectedTextOf(),
      durationMs: Math.round((samples.length * 1000) / SAMPLE_RATE),
      bytes: buffer.length,
      sha256: sha256(buffer),
      markers: markerEvidence,
    });
  }

  if (failed) {
    console.error('\n[fixture] 定位词没有真正跨切点，fixture 不可用；请检查 TTS 时长/脚本长度。');
    process.exit(1);
  }

  const expectedText = expectedTextOf();
  const normalized = normalizeText(expectedText);
  // Guard against a manifest whose checks no longer describe the script.
  const numbers = extractNumbers(expectedText);
  const veryCount = countOccurrences(normalized, '非常');
  if (JSON.stringify(numbers) !== JSON.stringify(CHECKS.numbers)) {
    throw new Error(`CHECKS.numbers 与脚本不一致：期望 ${JSON.stringify(CHECKS.numbers)}，实际 ${JSON.stringify(numbers)}`);
  }
  if (veryCount !== CHECKS.veryCount) {
    throw new Error(`CHECKS.veryCount 与脚本不一致：期望 ${CHECKS.veryCount}，实际 ${veryCount}`);
  }
  if (!normalized.includes(normalizeText(CHECKS.repetitionPair))) throw new Error('CHECKS.repetitionPair 不在脚本里');
  if (!normalized.includes(normalizeText(CHECKS.negation))) throw new Error('CHECKS.negation 不在脚本里');
  for (const marker of CHECKS.markers) {
    if (!normalized.includes(marker)) throw new Error(`CHECKS.markers 里的「${marker}」不在脚本里`);
  }

  const manifest = {
    schema: 1,
    kind: 'asr-cutpoint-fixture',
    generatedAt: new Date().toISOString(),
    generator: 'tools/asr-cutpoint-fixture.mjs',
    regenerate: 'node tools/asr-cutpoint-fixture.mjs',
    check: 'node tools/asr-cutpoint-check.mjs',
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    decodeCapSec: DECODE_CAP_SEC,
    cutPointsMs: MARKER_SPECS.map((spec) => spec.cutMs),
    voice: options.voice,
    provider: 'edge-tts',
    synthetic: true,
    disclaimer:
      '仅覆盖 TTS 清晰发音。真人录音（自然语速、连读、停顿）留作后续：用 ' +
      'node tools/asr-cutpoint-check.mjs --wav <file.wav> --expected "<整段文本>" 直接跑。',
    script: {
      order: ORDER.map((item) => (item.marker ? { marker: item.marker } : { text: item.text })),
      markers: MARKER_SPECS,
      fillers: FILLERS,
    },
    expectedText,
    checks: CHECKS,
    timeline: {
      totalMs,
      leadMs: LEAD_MS,
      gapMs: GAP_MS,
      markers: markers.map((marker) => ({
        key: marker.spec.key,
        text: marker.spec.text,
        cutMs: marker.spec.cutMs,
        placedStartMs: Math.round(marker.placedStartMs),
        clipOnsetMs: Math.round(marker.clip.onsetMs),
        clipOffsetMs: Math.round(marker.clip.offsetMs),
      })),
    },
    versions,
  };

  await writeFile(join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n[fixture] 汇总');
  for (const version of versions) {
    const parts = version.markers.map((marker) => {
      const relation = marker.relation === 'cross' ? '跨' : marker.relation === 'before' ? '前' : '后';
      return `${marker.text}=${relation}(${marker.measuredRangeMs[0] / 1000}–${marker.measuredRangeMs[1] / 1000}s)`;
    });
    console.log(`  ${version.name.padEnd(12)} +${String(version.offsetMs).padStart(4)}ms  ${version.durationMs} ms  ${parts.join('  ')}`);
  }
  console.log(`\n[fixture] 写入 ${relative(REPO, join(options.out, 'manifest.json'))}（${versions.length} 个版本）`);
}

main().catch((error) => {
  console.error(`\n[fixture] 失败：${error?.stack ?? error}`);
  process.exit(1);
});
