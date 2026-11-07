#!/usr/bin/env node
/**
 * Checker for the "a word straddles the 15 s / 30 s ASR decode cut" question.
 *
 * For every version in `test/fixtures/asr-cutpoint/manifest.json` (or a user WAV given with
 * `--wav`) this runs three decodes of the *same* audio:
 *
 *  1. whole-file baseline — one SenseVoice decode, no segmentation;
 *  2. production path — `startHearing()` from `src/host/hearing/hearing.js` with `decodeCapSec=15` and the
 *     overlapping segmentation (`asrSegmentOverlapMs`, default 800 ms) driven through its injectable
 *     seams (fake ffmpeg child + fake streaming recognizer), so the real `decodeSegmented()` /
 *     `joinSegmentedTexts()` run. Every planned decode job (segments + the per-joint referee) is
 *     matched against the sample range actually fed to the recognizer;
 *  3. the pre-fix path — the same production code with `asrSegmentOverlapMs=0`, i.e. exactly the old
 *     hard cut, so the report can show "before → after" for every version.
 *
 * Then it compares marker words (exact occurrence counts), numbers, negation, the repeated phrase
 * (exact count of 非常), the closing phrase, the join-fallback count and new duplication. A marker
 * that merely survives once is not enough: extra occurrences (duplicated seams) fail the version.
 *
 * Usage:
 *   node tools/asr-cutpoint-check.mjs                          # all fixture versions
 *   node tools/asr-cutpoint-check.mjs --self-check             # static only, no model needed
 *   node tools/asr-cutpoint-check.mjs --verbose
 *   node tools/asr-cutpoint-check.mjs --overlap 1200           # wider shared audio
 *   node tools/asr-cutpoint-check.mjs --wav talk.wav --expected "整段文本" --marker 橙子 --marker 雷达
 *
 * Options:
 *   --fixture <dir>   fixture dir (default test/fixtures/asr-cutpoint)
 *   --model <dir>     SenseVoice dir (default %LOCALAPPDATA%/dsh-assistant/models/<sense-voice>, $ASR_FINAL_MODEL_DIR)
 *   --cap <sec>       decode piece length (default: manifest.decodeCapSec or 15)
 *   --overlap <ms>    shared audio between pieces (default: manifest.segmentOverlapMs or 800; 0 = old hard cut)
 *   --wav <file>      use an external 16 kHz mono WAV instead of the fixture
 *   --expected <text> expected full transcript for --wav (enables the text checks)
 *   --marker <text>   marker word to look for, repeatable (default: manifest markers)
 *   --cut <ms>        cut point for an ad-hoc WAV marker, repeatable (default 15000,30000,...)
 *   --self-check      static validation only (files, hashes, durations, crossing ranges)
 *   --require-model   exit 2 instead of 0 when the model is missing (CI)
 *   --json            print a machine-readable result at the end
 *   --verbose         print baseline + per-segment texts for every version
 *
 * Exit codes: 0 pass/skip, 1 a version lost text the baseline heard or gained a duplicate,
 *             2 usage/model required, 3 fixture or self-check problem.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SEGMENT_OVERLAP_MS,
  createFinalRecognizer,
  finalModelReady,
  joinSegmentedTexts,
  planSegmentedDecodes,
  segmentOverlapSamples,
  startHearing,
} from '../src/host/hearing/hearing.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 16_000;
const DEFAULT_FIXTURE = join(REPO, 'test', 'fixtures', 'asr-cutpoint');
const SENSE_VOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

// ---------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    model: '',
    cap: 0,
    overlap: null,
    wav: '',
    expected: '',
    markers: [],
    cuts: [],
    selfCheck: false,
    requireModel: false,
    json: false,
    verbose: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`);
      index += 1;
      return value;
    };
    if (arg === '--fixture') options.fixture = resolve(next());
    else if (arg === '--model') options.model = next();
    else if (arg === '--cap') options.cap = Number(next());
    else if (arg === '--overlap') options.overlap = Number(next());
    else if (arg === '--wav') options.wav = resolve(next());
    else if (arg === '--expected') options.expected = next();
    else if (arg === '--marker') options.markers.push(next());
    else if (arg === '--cut') options.cuts.push(Number(next()));
    else if (arg === '--self-check') options.selfCheck = true;
    else if (arg === '--require-model') options.requireModel = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/asr-cutpoint-check.mjs [--fixture <dir>] [--model <dir>] [--cap <sec>]');
      console.log('       [--overlap <ms>] [--wav <file> [--expected <text>] [--marker <text>]... [--cut <ms>]...]');
      console.log('       [--self-check] [--require-model] [--json] [--verbose]');
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(options.cap) || (options.cap !== 0 && options.cap <= 0)) {
    throw new Error('--cap 需要正数（秒）');
  }
  if (options.overlap !== null && (!Number.isFinite(options.overlap) || options.overlap < 0)) {
    throw new Error('--overlap 需要非负整数（毫秒）');
  }
  if (options.cuts.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('--cut 需要正数（毫秒）');
  return options;
}

// ---------------------------------------------------------------------------------------------
// WAV / text helpers
// ---------------------------------------------------------------------------------------------
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
    samples[index] = buffer.readInt16LE(dataStart + index * 2 * fmt.channels) / 32768;
  }
  return { ...fmt, samples, durationMs: Math.round((frames * 1000) / fmt.sampleRate) };
}

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
    if (CN_DIGITS.has(char)) number = CN_DIGITS.get(char);
    else if (char === '万') {
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

/** Numbers in reading order; Arabic digits and Chinese numerals compare equal. */
function extractNumbers(text) {
  const numbers = [];
  const pattern = /[〇零一二两三四五六七八九十百千万亿]+|\d+/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    if (/^\d+$/u.test(raw)) numbers.push(Number(raw));
    else if (/[十百千万亿]/u.test(raw) || raw.length >= 2) numbers.push(chineseToInt(raw));
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
  return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

const displayWidth = (text) => {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(char) ? 2 : 1;
  }
  return width;
};
const pad = (text, width) => `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;

// ---------------------------------------------------------------------------------------------
// expected-text checks
// ---------------------------------------------------------------------------------------------
function buildChecks(source = {}) {
  return {
    numbers: Array.isArray(source.numbers) ? source.numbers : [],
    negation: typeof source.negation === 'string' ? source.negation : '',
    veryCount: Number.isFinite(source.veryCount) ? source.veryCount : 0,
    // The manifest names this `repetitionPair`; an ad-hoc WAV passes no pair at all.
    pair: typeof source.pair === 'string' ? source.pair : typeof source.repetitionPair === 'string' ? source.repetitionPair : '',
    markers: Array.isArray(source.markers) ? source.markers : [],
    tail: typeof source.tail === 'string' ? source.tail : '',
  };
}

/**
 * Occurrence checks. When `expectedText` is known every count is compared *exactly* (a marker that
 * appears twice is a duplicated seam, not a success); without it the old "present at all" rule is
 * used and the table reports `-`.
 *
 * @returns {{items: Array<{key: string, label: string, ok: boolean, actual: number, wanted: number,
 *                          detail: string}>, normalized: string}}
 */
function evaluateText(text, checks, { expectedText = '' } = {}) {
  const normalized = normalizeText(text);
  const expectedNormalized = normalizeText(expectedText);
  const hasExpected = expectedNormalized.length > 0;
  const wantedCount = (fragment) => (hasExpected ? countOccurrences(expectedNormalized, normalizeText(fragment)) : -1);
  const items = [];

  for (const marker of checks.markers) {
    const needle = normalizeText(marker);
    const actual = countOccurrences(normalized, needle);
    const wanted = wantedCount(marker);
    const ok = wanted > 0 ? actual === wanted : actual >= 1;
    items.push({
      key: `marker:${marker}`,
      label: marker,
      ok,
      actual,
      wanted,
      detail: ok ? '' : `出现 ${actual} 次（期望 ${wanted > 0 ? wanted : '≥1'}）`,
    });
  }

  if (checks.numbers.length > 0) {
    const actual = extractNumbers(text);
    const ok = JSON.stringify(actual) === JSON.stringify(checks.numbers);
    items.push({
      key: 'numbers',
      label: '数字',
      ok,
      actual: actual.length,
      wanted: checks.numbers.length,
      detail: ok ? '' : `期望 [${checks.numbers.join(',')}] 实际 [${actual.join(',')}]`,
    });
  }

  if (checks.negation.length > 0) {
    const actual = countOccurrences(normalized, normalizeText(checks.negation));
    const wanted = wantedCount(checks.negation);
    const ok = wanted > 0 ? actual === wanted : actual >= 1;
    items.push({
      key: 'negation',
      label: '否定词',
      ok,
      actual,
      wanted,
      detail: ok ? '' : `「${checks.negation}」出现 ${actual} 次（期望 ${wanted > 0 ? wanted : '≥1'}）`,
    });
  }

  if (checks.veryCount > 0) {
    const count = countOccurrences(normalized, '非常');
    const pairOk = checks.pair.length === 0 || normalized.includes(normalizeText(checks.pair));
    const ok = count === checks.veryCount && pairOk;
    items.push({
      key: 'repetition',
      label: '重复词',
      ok,
      actual: count,
      wanted: checks.veryCount,
      detail: ok ? '' : `「非常」x${count}（必须 =${checks.veryCount}）${pairOk ? '' : ' 且重复段被拆开/合并'}`,
    });
  }

  if (checks.tail.length > 0) {
    const actual = countOccurrences(normalized, normalizeText(checks.tail));
    const wanted = wantedCount(checks.tail);
    const ok = wanted > 0 ? actual === wanted : actual >= 1;
    items.push({
      key: 'tail',
      label: '尾句',
      ok,
      actual,
      wanted,
      detail: ok ? '' : `「${checks.tail}」出现 ${actual} 次（期望 ${wanted > 0 ? wanted : '≥1'}）`,
    });
  }

  return { items, normalized };
}

/**
 * New duplication, independent of ASR wording: an immediately repeated block (≥2 chars) that the
 * expected transcript does not contain. A fallback join keeps both texts, so the repeated seam shows
 * up here as `橙子橙子` / `…最后重复一遍最后重复一遍…` and fails the version.
 *
 * @returns {{checked: boolean, blocks: string[]}}
 */
function findNewDuplication(segmentedText, expectedText) {
  const normalized = normalizeText(segmentedText);
  const expectedNormalized = normalizeText(expectedText);
  if (expectedNormalized.length === 0) return { checked: false, blocks: [] };
  const blocks = [];
  // `(.{2,40})\1` on normalized text: adjacent repeated block of 2..40 chars.
  for (const match of normalized.matchAll(/(.{2,40})\1/gu)) {
    if (!expectedNormalized.includes(match[0])) blocks.push(match[0]);
  }
  return { checked: true, blocks };
}

/**
 * One version's verdict. `FAIL` when a check misses/mismatches or a new duplicate appears; a version
 * that only survived because a joint could not be verified is reported as `PASS(回退)` — text is safe
 * but the join was not proven, so it is not counted as a real fix.
 *
 * @returns {{verdict: string, failures: object[], regressions: object[], bothMissing: object[],
 *            recovered: object[], duplication: {checked: boolean, blocks: string[]},
 *            markerHit: number, markerTotal: number}}
 */
function evaluateVersion({ baselineText, segmentedText, legacyText = '', checks, expectedText = '', fallbackCount = 0 }) {
  const segEval = evaluateText(segmentedText, checks, { expectedText });
  const baseEval = evaluateText(baselineText, checks, { expectedText });
  const legacyEval = evaluateText(legacyText, checks, { expectedText });
  const duplication = findNewDuplication(segmentedText, expectedText);

  const failures = segEval.items.filter((item) => !item.ok);
  const regressions = baseEval.items.filter((item) => item.ok && !segEval.items.find((entry) => entry.key === item.key)?.ok);
  const bothMissing = baseEval.items.filter((item) => !item.ok && !segEval.items.find((entry) => entry.key === item.key)?.ok);
  const recovered = segEval.items.filter((item) => item.ok && !baseEval.items.find((entry) => entry.key === item.key)?.ok);

  const markerTotal = checks.markers.length;
  const markerHit = checks.markers.filter((marker) => segEval.items.find((item) => item.key === `marker:${marker}`)?.ok).length;

  let verdict;
  if (segEval.items.length === 0) verdict = '仅文本';
  else if (failures.length > 0 || duplication.blocks.length > 0) verdict = 'FAIL';
  else if (failures.length === 0 && bothMissing.length > 0 && failures.length === bothMissing.length) verdict = 'SKIP(基线也缺)';
  else if (fallbackCount > 0) verdict = 'PASS(回退)';
  else verdict = 'PASS';

  return {
    verdict,
    failures,
    regressions,
    bothMissing,
    recovered,
    duplication,
    markerHit,
    markerTotal,
    segEval,
    baseEval,
    legacyEval,
    legacyFailures: legacyEval.items.filter((item) => !item.ok),
  };
}

// ---------------------------------------------------------------------------------------------
// production seam: real startHearing() + real decodeSegmented()/joinSegmentedTexts()
// ---------------------------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

/** Streaming stand-in; the endpoint fires once the configured amount of audio has arrived. */
function fakeStreaming(endpointAtSamples) {
  return {
    createStream: () => ({
      samples: 0,
      acceptWaveform({ samples }) {
        this.samples += samples.length;
      },
    }),
    isReady: () => false,
    decode: () => {},
    getResult: () => ({ text: '' }),
    isEndpoint: (stream) => stream.samples >= endpointAtSamples,
    reset(stream) {
      stream.samples = 0;
    },
  };
}

function pcmBuffer(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return pcm;
}

/**
 * Run the production segmented final pass for one WAV.
 *
 * The instrumented recognizer records the exact samples handed to every `createStream()` call, so the
 * run is checked against `planSegmentedDecodes()`: same number of decodes, same ranges, and the final
 * text must equal `joinSegmentedTexts()` over those pieces.
 *
 * @returns {Promise<{text: string, refined: boolean, joinFallback: boolean, fallbackCount: number,
 *                    segments: object[], joints: object[], elapsedMs: number, decodes: number,
 *                    decodedAudioMs: number}>}
 */
export async function runProductionSegmented({ finalRecognizer, samples, decodeCapSec, overlapMs = DEFAULT_SEGMENT_OVERLAP_MS }) {
  const segmentSamples = Math.floor(SAMPLE_RATE * decodeCapSec);
  const plan = planSegmentedDecodes(samples.length, segmentSamples, segmentOverlapSamples(overlapMs));
  const child = new FakeChild();
  const updates = [];
  const pieces = [];
  let streamCount = 0;

  const instrumented = {
    createStream() {
      const inner = finalRecognizer.createStream();
      const stream = {
        inner,
        index: streamCount,
        accepted: null,
        acceptWaveform({ sampleRate, samples: chunk }) {
          this.accepted = { length: chunk.length, byteOffset: chunk.byteOffset };
          inner.acceptWaveform({ sampleRate, samples: chunk });
        },
      };
      streamCount += 1;
      return stream;
    },
    decode(stream) {
      finalRecognizer.decode(stream.inner);
    },
    getResult(stream) {
      const result = finalRecognizer.getResult(stream.inner);
      pieces.push({ index: stream.index, ...stream.accepted, text: result.text ?? '' });
      return result;
    },
  };

  const hearing = startHearing({
    ffmpegPath: 'ffmpeg-not-used',
    modelDir: 'models-not-used',
    finalModelDir: '',
    device: 'fixture',
    decodeCapSec,
    asrSegmentOverlapMs: overlapMs,
    recognizer: fakeStreaming(samples.length),
    finalRecognizer: instrumented,
    spawnProcess: () => child,
    onUpdate: (event) => updates.push(event),
  });

  const started = Date.now();
  child.stdout.write(pcmBuffer(samples));
  const deadline = started + 30_000;
  while (!updates.some((event) => typeof event.final === 'string')) {
    if (Date.now() > deadline) {
      hearing.stop();
      throw new Error('生产分段路径 30 s 内没有产出 final（seam 没有触发 endpoint？）');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const elapsedMs = Date.now() - started;
  hearing.stop();

  const finalEvent = updates.find((event) => typeof event.final === 'string');

  // Every planned decode must have happened, in plan order, on exactly the planned audio.
  if (pieces.length !== plan.jobs.length) {
    throw new Error(`生产路径调用了 ${pieces.length} 次离线识别，计划是 ${plan.jobs.length} 次`);
  }
  const decoded = plan.jobs.map((job, index) => {
    const { startSample, endSample } = job.kind === 'segment' ? job.piece : job.joint;
    const piece = pieces[index];
    if (piece.length !== endSample - startSample || piece.byteOffset / 4 !== startSample) {
      throw new Error(
        `第 ${index} 次识别喂了 [${
          piece.byteOffset / 4
        }..${piece.byteOffset / 4 + piece.length})，计划是 [${startSample}..${endSample})（${job.kind}）`,
      );
    }
    return {
      kind: job.kind,
      index: job.kind === 'segment' ? job.piece.index : job.joint.index,
      startSample,
      endSample,
      text: piece.text,
    };
  });

  const joined = joinSegmentedTexts(decoded);
  if (joined.text !== finalEvent.final) {
    throw new Error(`生产拼接与 joinSegmentedTexts 结果不一致：\n  event: ${finalEvent.final}\n  join:  ${joined.text}`);
  }
  if (finalEvent.joinFallback !== undefined && finalEvent.joinFallback !== joined.joinFallback) {
    throw new Error('final 事件的 joinFallback 与拼接诊断不一致');
  }

  const fallbackCount = joined.joints.filter((joint) => joint.fallback).length;
  const decodedAudioMs = Math.round(
    decoded.reduce((sum, piece) => sum + (piece.endSample - piece.startSample), 0) / 16,
  );

  return {
    text: finalEvent.final,
    refined: finalEvent.refined === true,
    joinFallback: joined.joinFallback,
    fallbackCount,
    segments: joined.segments.map((segment) => ({
      index: segment.index,
      startMs: Math.round((segment.startSample * 1000) / SAMPLE_RATE),
      endMs: Math.round((segment.endSample * 1000) / SAMPLE_RATE),
      text: segment.text,
    })),
    joints: joined.joints.map((joint) => ({
      index: joint.index,
      refereeText: joint.refereeText,
      fallback: joint.fallback,
      reason: joint.reason,
      path: joint.path,
      trimChars: joint.trimChars,
      tailLength: joint.tailLength,
      headLength: joint.headLength,
    })),
    elapsedMs,
    decodes: decoded.length,
    decodedAudioMs,
  };
}

function decodeWhole(finalRecognizer, samples) {
  const started = Date.now();
  const stream = finalRecognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  finalRecognizer.decode(stream);
  const text = finalRecognizer.getResult(stream).text ?? '';
  return { text, elapsedMs: Date.now() - started };
}

// ---------------------------------------------------------------------------------------------
// fixture loading / static self-check
// ---------------------------------------------------------------------------------------------
async function loadFixture(fixtureDir) {
  const manifestPath = join(fixtureDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`找不到 ${relative(REPO, manifestPath)}，先运行 node tools/asr-cutpoint-fixture.mjs`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.kind !== 'asr-cutpoint-fixture' || !Array.isArray(manifest.versions) || manifest.versions.length === 0) {
    throw new Error('manifest.json 不是 asr-cutpoint-fixture 格式');
  }
  return { manifest, fixtureDir, manifestPath };
}

/** Static validation: files, header, duration, checksum, marker ranges. Never needs a model. */
async function runSelfCheck(fixtureDir, manifest) {
  const problems = [];
  const notes = [];
  const base = manifest.versions.find((version) => version.offsetMs === 0 && version.trimMs === 0) ?? manifest.versions[0];

  for (const version of manifest.versions) {
    const file = join(fixtureDir, version.file);
    if (!existsSync(file)) {
      problems.push(`${version.name}: 缺少 ${version.file}（生成文件不入库，先运行 node tools/asr-cutpoint-fixture.mjs）`);
      continue;
    }
    const buffer = await readFile(file);
    let wav;
    try {
      wav = readWav(buffer, version.file);
    } catch (error) {
      problems.push(`${version.name}: ${error.message}`);
      continue;
    }
    if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) {
      problems.push(`${version.name}: 需要 16 kHz 单声道（实际 ${wav.sampleRate} Hz / ${wav.channels} ch）`);
    }
    if (Math.abs(wav.durationMs - version.durationMs) > 2) {
      problems.push(`${version.name}: manifest 时长 ${version.durationMs} ms，文件 ${wav.durationMs} ms`);
    }
    if (buffer.length !== version.bytes) {
      problems.push(`${version.name}: manifest 字节 ${version.bytes}，文件 ${buffer.length}`);
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (version.sha256 && hash !== version.sha256) {
      problems.push(`${version.name}: sha256 不一致（fixture 被改动过？）`);
    }
    for (const marker of version.markers) {
      if (version.shiftMs !== undefined) {
        const baseMarker = base.markers.find((entry) => entry.key === marker.key);
        if (baseMarker) {
          const expectedShift = marker.measuredRangeMs[0] - baseMarker.measuredRangeMs[0];
          if (Math.abs(expectedShift - version.shiftMs) > 20) {
            problems.push(`${version.name}/${marker.key}: 位移 ${expectedShift} ms 与声明的 ${version.shiftMs} ms 不符`);
          }
        }
      }
      if (version === base) {
        const spec = manifest.script.markers.find((entry) => entry.key === marker.key);
        if (!marker.crosses) problems.push(`基准版本 ${marker.key}「${marker.text}」没有跨切点`);
        if (spec && Array.isArray(spec.windowMs)) {
          const [start, end] = marker.measuredRangeMs;
          if (start < spec.windowMs[0] || end > spec.windowMs[1]) {
            problems.push(`${marker.key}: 实测 ${start}-${end} ms 超出窗口 ${spec.windowMs.join('-')}`);
          }
        }
        if (Math.max(marker.cutEnergyDb.before, marker.cutEnergyDb.after) < -35) {
          problems.push(`${marker.key}: 切点落在低能量处（${marker.cutEnergyDb.before}/${marker.cutEnergyDb.after} dBFS）`);
        }
      } else if (marker.crosses) {
        notes.push(`${version.name}/${marker.key} 也跨切点（预期基础版本才跨）`);
      }
    }
    if (version.offsetMs > 0) {
      const expectedDuration = base.durationMs + version.offsetMs - version.trimMs;
      if (Math.abs(wav.durationMs - expectedDuration) > 2) {
        problems.push(`${version.name}: 时长 ${wav.durationMs} ms，按基准+偏移应为 ${expectedDuration} ms`);
      }
    }
  }

  // The manifest's own expected text must satisfy its own checks.
  const selfEval = evaluateText(manifest.expectedText, buildChecks(manifest.checks), { expectedText: manifest.expectedText });
  for (const item of selfEval.items) {
    if (!item.ok) problems.push(`expectedText 自身不满足检查 ${item.key}：${item.detail}`);
  }
  for (const marker of manifest.checks.markers ?? []) {
    if (countOccurrences(normalizeText(manifest.expectedText), normalizeText(marker)) !== 1) {
      problems.push(`expectedText 里定位词「${marker}」应恰好出现 1 次，实际 ${countOccurrences(normalizeText(manifest.expectedText), normalizeText(marker))} 次`);
    }
  }

  console.log(`[self-check] ${relative(REPO, join(fixtureDir, 'manifest.json'))}：${manifest.versions.length} 个版本，${manifest.versions.reduce((sum, version) => sum + version.markers.length, 0)} 个定位词`);
  for (const version of manifest.versions) {
    const parts = version.markers.map((marker) => {
      const relation = marker.relation === 'cross' ? '跨切点' : marker.relation === 'before' ? '切点前' : '切点后';
      return `${marker.text}=${relation} ${marker.measuredRangeMs[0]}–${marker.measuredRangeMs[1]}ms`;
    });
    console.log(`  ${pad(version.name, 12)} ${pad(`+${version.offsetMs}ms`, 8)} ${pad(`trim ${version.trimMs}ms`, 11)} ${parts.join('  ')}`);
  }
  for (const note of notes) console.log(`  · ${note}`);

  if (problems.length > 0) {
    console.error(`\n[self-check] 失败 ${problems.length} 项：`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    return { ok: false, problems };
  }
  console.log('[self-check] ok：文件头/时长/校验和/切点范围全部一致');
  return { ok: true, problems: [] };
}

// ---------------------------------------------------------------------------------------------
// ad-hoc WAV (a real human recording, or any user file)
// ---------------------------------------------------------------------------------------------
function adHocFixtureFromArgs(options) {
  if (options.wav === '') return null;
  const markers = options.markers.map((text, index) => ({
    key: `marker${index + 1}`,
    text,
    cutMs: options.cuts[index] ?? options.cuts[0] ?? 15_000,
    expectedRangeMs: [],
    measuredRangeMs: [],
    relation: 'unknown',
    crosses: null,
    marginBeforeMs: null,
    marginAfterMs: null,
    cutEnergyDb: null,
  }));
  const checks = buildChecks({
    numbers: options.expected ? extractNumbers(options.expected) : [],
    negation: '',
    veryCount: options.expected ? countOccurrences(normalizeText(options.expected), '非常') : 0,
    pair: '',
    markers: options.markers,
    tail: '',
  });
  return {
    adHoc: true,
    manifest: {
      kind: 'asr-cutpoint-fixture',
      decodeCapSec: options.cap || 15,
      cutPointsMs: markers.map((marker) => marker.cutMs),
      expectedText: options.expected,
      checks,
      versions: [
        {
          name: 'user-wav',
          file: options.wav,
          offsetMs: 0,
          trimMs: 0,
          shiftMs: 0,
          durationMs: 0,
          markers,
        },
      ],
    },
    fixtureDir: dirname(options.wav),
    manifestPath: options.wav,
  };
}

// ---------------------------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------------------------
function formatResult(result) {
  if (result.ok) return '命中';
  return `缺失(${result.detail})`;
}

function describeMarkerLocation(version, marker, capMs) {
  const cutMs = marker.cutMs ?? capMs;
  const [startMs, endMs] = marker.measuredRangeMs.length === 2 ? marker.measuredRangeMs : [null, null];
  if (startMs === null) return `（切点 ${cutMs / 1000}s）`;
  return `（实测 ${(startMs / 1000).toFixed(2)}–${(endMs / 1000).toFixed(2)}s，跨越 ${(cutMs / 1000).toFixed(3)}s）`;
}

function printFailure({ version, evaluation, baseline, segmented, capMs }) {
  console.error(`\n✗ ${version.name}：分段结果不达标`);
  for (const failure of evaluation.failures) {
    if (failure.key.startsWith('marker:')) {
      const marker = version.markers.find((entry) => `marker:${entry.text}` === failure.key);
      console.error(`  · 定位词 ${marker ? `「${marker.text}」${describeMarkerLocation(version, marker, capMs)}` : failure.label}：${failure.detail}`);
    } else {
      console.error(`  · ${failure.label}：${failure.detail}`);
    }
  }
  if (evaluation.duplication.blocks.length > 0) {
    console.error(`  · 重复检测：出现了期望文本里没有的连续重复块 ${evaluation.duplication.blocks.map((block) => JSON.stringify(block)).join('、')}`);
  }
  console.error('  分段明细：');
  for (const segment of segmented.segments) {
    console.error(`    第${segment.index}段 [${(segment.startMs / 1000).toFixed(2)}–${(segment.endMs / 1000).toFixed(2)}s] ${JSON.stringify(segment.text)}`);
  }
  if (segmented.joints.length > 0) {
    console.error('  拼接点（裁判解码 → 裁掉下一段头部的字数）：');
    for (const joint of segmented.joints) {
      const verdict = joint.fallback ? `回退(${joint.reason})` : `裁 ${joint.trimChars} 字 via ${joint.path}`;
      console.error(`    拼接点${joint.index} 裁判=${JSON.stringify(joint.refereeText)} ${verdict}`);
    }
  }
  console.error(`  整段基线：${JSON.stringify(baseline.text)}`);
  console.error(`  分段拼接：${JSON.stringify(segmented.text)}`);
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv);
  const adHoc = adHocFixtureFromArgs(options);
  const fixture = adHoc ?? await loadFixture(options.fixture);
  const { manifest, fixtureDir, manifestPath } = fixture;
  const capMs = Math.round((options.cap || manifest.decodeCapSec || 15) * 1000);
  const manifestOverlapMs = Number.isFinite(manifest.segmentOverlapMs) ? manifest.segmentOverlapMs : DEFAULT_SEGMENT_OVERLAP_MS;
  const overlapMs = options.overlap === null ? manifestOverlapMs : options.overlap;

  // Static validation first: it is cheap and catches stale/missing fixture files before a model load.
  let selfCheck = { ok: true, problems: [] };
  if (!adHoc) {
    selfCheck = await runSelfCheck(fixtureDir, manifest);
    if (!selfCheck.ok) process.exitCode = 3;
  } else {
    console.log(`[check] 外部 WAV：${relative(REPO, options.wav)}${options.expected ? '（带期望文本）' : '（无期望文本，只报告文本与耗时）'}`);
  }

  if (options.selfCheck) {
    return { ok: selfCheck.ok, results: [], manifestPath };
  }

  // Model availability: a missing model skips recognition, it is not a failure.
  const modelDir = options.model || process.env.ASR_FINAL_MODEL_DIR
    || join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-assistant', 'models', SENSE_VOICE_DIR);
  const missing = ['model.int8.onnx', 'tokens.txt'].filter((name) => !existsSync(join(modelDir, name)));
  const sherpaPresent = existsSync(join(REPO, 'node_modules', 'sherpa-onnx-node'));
  if (missing.length > 0 || !sherpaPresent || !finalModelReady(modelDir)) {
    console.log('\n[check] 跳过识别：缺少 SenseVoice 模型或 sherpa-onnx-node，不误报失败。');
    console.log(`  模型目录：${modelDir}`);
    if (missing.length > 0) console.log(`  缺少文件：${missing.join(', ')}`);
    if (!sherpaPresent) console.log('  缺少依赖：node_modules/sherpa-onnx-node（在仓库内执行 pnpm install）');
    console.log('  补模型：设置页「语音识别」下载，或把 sense-voice 2024-07-17 解压到上述目录；');
    console.log('          也可以用 --model <dir> 或 ASR_FINAL_MODEL_DIR 指定。');
    if (adHoc) console.log(`  外部 WAV：${relative(REPO, options.wav)}（无法静态校验，先确认是 16 kHz 单声道）`);
    else console.log('  静态自检结果见上面的 [self-check] 输出（文件头/时长/校验和/切点范围）。');
    if (options.requireModel) {
      console.error('\n[check] --require-model：模型不可用，按 CI 要求退出 2');
      process.exit(2);
    }
    return { ok: selfCheck.ok, skipped: true, results: [], manifestPath };
  }

  console.log(`[check] 模型：${modelDir}`);
  const cutsText = (manifest.cutPointsMs ?? []).map((value) => value / 1000).join('/');
  console.log(`[check] decodeCapSec=${capMs / 1000}，分段重叠=${overlapMs}ms${cutsText ? `，切点=${cutsText}s` : ''}，${manifest.versions.length} 个版本\n`);

  const finalRecognizer = createFinalRecognizer(modelDir);
  // Warm up so the first measured decode does not pay for lazy initialisation; timings stay comparable.
  decodeWhole(finalRecognizer, new Float32Array(SAMPLE_RATE));
  const checks = adHoc ? manifest.checks : buildChecks(manifest.checks);
  const expectedText = options.expected || manifest.expectedText || '';
  const rows = [];
  const results = [];

  for (const version of manifest.versions) {
    // resolve() (not join()) so an ad-hoc --wav absolute path is used as-is.
    const file = resolve(fixtureDir, version.file);
    if (!existsSync(file)) {
      console.error(`[check] 跳过 ${version.name}：文件不存在 ${relative(REPO, file)}`);
      continue;
    }
    const buffer = await readFile(file);
    const wav = readWav(buffer, version.file);
    if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 1) throw new Error(`${version.file}: 需要 16 kHz 单声道 WAV`);

    const baseline = decodeWhole(finalRecognizer, wav.samples);
    const after = await runProductionSegmented({ finalRecognizer, samples: wav.samples, decodeCapSec: capMs / 1000, overlapMs });
    const before = overlapMs > 0
      ? await runProductionSegmented({ finalRecognizer, samples: wav.samples, decodeCapSec: capMs / 1000, overlapMs: 0 })
      : null;

    if (!after.refined) console.log(`[check] 注意：${version.name} 的 final 未标记 refined（离线结果未被采用）`);

    const evaluation = evaluateVersion({
      baselineText: baseline.text,
      segmentedText: after.text,
      legacyText: before?.text ?? after.text,
      checks,
      expectedText,
      fallbackCount: after.fallbackCount,
    });

    const numbersItem = evaluation.segEval.items.find((item) => item.key === 'numbers');
    const negationItem = evaluation.segEval.items.find((item) => item.key === 'negation');
    const repetitionItem = evaluation.segEval.items.find((item) => item.key === 'repetition');
    const legacyMarkers = before === null
      ? `${evaluation.markerHit}/${evaluation.markerTotal}`
      : `${before.segments.length === 0 ? 0 : evaluateVersion({ baselineText: baseline.text, segmentedText: before.text, checks, expectedText }).markerHit}/${evaluation.markerTotal}`;

    rows.push({
      version: version.name,
      offset: `${version.offsetMs - version.trimMs >= 0 ? '+' : ''}${version.offsetMs - version.trimMs}ms`,
      markers: evaluation.markerTotal > 0 ? `${evaluation.markerHit}/${evaluation.markerTotal}` : '-',
      numbers: numbersItem ? (numbersItem.ok ? '是' : '否') : '-',
      negation: negationItem ? (negationItem.ok ? '是' : '否') : '-',
      repetition: repetitionItem ? (repetitionItem.ok ? '是' : '否') : '-',
      legacyMarkers,
      fallback: String(after.fallbackCount),
      duplication: evaluation.duplication.checked ? (evaluation.duplication.blocks.length === 0 ? '无' : `有(${evaluation.duplication.blocks.length})`) : '-',
      baselineMs: baseline.elapsedMs,
      segmentedMs: after.elapsedMs,
      decodes: after.decodes,
      verdict: evaluation.verdict,
    });

    results.push({
      version: version.name,
      verdict: evaluation.verdict,
      baselineText: baseline.text,
      segmentedText: after.text,
      legacyText: before?.text ?? '',
      segments: after.segments,
      joints: after.joints,
      fallbackCount: after.fallbackCount,
      duplication: evaluation.duplication,
      failures: evaluation.failures.map((item) => ({ key: item.key, detail: item.detail })),
      regressions: evaluation.regressions.map((item) => item.key),
      bothMissing: evaluation.bothMissing.map((item) => item.key),
      recovered: evaluation.recovered.map((item) => item.key),
      legacyMarkerHit: legacyMarkers,
      markerHit: evaluation.markerHit,
      markerTotal: evaluation.markerTotal,
      baselineMs: baseline.elapsedMs,
      legacyMs: before?.elapsedMs ?? 0,
      segmentedMs: after.elapsedMs,
      decodes: after.decodes,
      decodedAudioMs: after.decodedAudioMs,
      utteranceMs: Math.round((wav.samples.length * 1000) / SAMPLE_RATE),
      wavBytes: buffer.length,
    });

    if (options.verbose || evaluation.verdict === 'FAIL' || after.fallbackCount > 0) {
      console.log(`\n[${version.name}] 整段：${JSON.stringify(baseline.text)}`);
      if (before !== null) console.log(`  修复前(重叠 0)：${JSON.stringify(before.text)}`);
      for (const segment of after.segments) {
        console.log(`  第${segment.index}段 [${(segment.startMs / 1000).toFixed(2)}–${(segment.endMs / 1000).toFixed(2)}s] ${JSON.stringify(segment.text)}`);
      }
      for (const joint of after.joints) {
        const action = joint.fallback ? `回退(${joint.reason})` : `裁 ${joint.trimChars} 字 via ${joint.path}`;
        console.log(`  拼接点${joint.index} 裁判=${JSON.stringify(joint.refereeText)} ${action}`);
      }
      console.log(`  修复后(重叠 ${overlapMs}ms)：${JSON.stringify(after.text)}`);
    }
    if (evaluation.verdict === 'FAIL') {
      printFailure({ version, evaluation, baseline: { text: baseline.text }, segmented: after, capMs });
    }
    if (evaluation.bothMissing.length > 0) {
      console.log(`\n[${version.name}] 基线也缺：${evaluation.bothMissing.map((item) => item.label).join('、')}（非切点问题，不判失败）`);
    }
  }

  // ---- before/after comparison ----
  console.log('\n修复前（无重叠）→ 修复后（重叠 + 裁判对齐）对照');
  const compareColumns = [['版本', 12], ['修复前定位词', 14], ['修复后定位词', 14], ['修复前结论', 16], ['修复后结论', 16]];
  console.log(compareColumns.map(([title, width]) => pad(title, width)).join(''));
  for (const result of results) {
    const legacyVerdict = result.legacyText === ''
      ? '（未跑）'
      : evaluateVersion({ baselineText: result.baselineText, segmentedText: result.legacyText, checks, expectedText }).verdict;
    console.log([
      pad(result.version, 12),
      pad(result.legacyMarkerHit, 14),
      pad(`${result.markerHit}/${result.markerTotal}`, 14),
      pad(legacyVerdict, 16),
      pad(result.verdict, 16),
    ].join(''));
  }

  // ---- table ----
  console.log('\n结果');
  const columns = [
    ['版本', 12], ['偏移', 8], ['定位词', 8], ['数字', 6], ['否定词', 8], ['重复词', 8],
    ['修复前', 8], ['fallback', 10], ['重复检测', 10], ['整段(ms)', 10], ['分段(ms)', 10], ['分段次数', 10], ['结论', 14],
  ];
  console.log(columns.map(([title, width]) => pad(title, width)).join(''));
  for (const row of rows) {
    console.log([
      pad(row.version, 12), pad(row.offset, 8), pad(row.markers, 8), pad(row.numbers, 6), pad(row.negation, 8),
      pad(row.repetition, 8), pad(row.legacyMarkers, 8), pad(row.fallback, 10), pad(row.duplication, 10),
      pad(String(row.baselineMs), 10), pad(String(row.segmentedMs), 10), pad(String(row.decodes), 10), pad(row.verdict, 14),
    ].join(''));
  }

  const failed = results.filter((result) => result.verdict === 'FAIL');
  const fallbacked = results.filter((result) => result.verdict === 'PASS(回退)');
  const skipped = results.filter((result) => result.verdict.startsWith('SKIP'));
  const passed = results.filter((result) => result.verdict === 'PASS');
  const textOnly = results.filter((result) => result.verdict === '仅文本');
  const totalBaselineMs = results.reduce((sum, result) => sum + result.baselineMs, 0);
  const totalLegacyMs = results.reduce((sum, result) => sum + result.legacyMs, 0);
  const totalSegmentedMs = results.reduce((sum, result) => sum + result.segmentedMs, 0);
  const totalDecodedAudioMs = results.reduce((sum, result) => sum + result.decodedAudioMs, 0);
  const totalUtteranceMs = results.reduce((sum, result) => sum + result.utteranceMs, 0);
  const ratio = (value, base) => (base > 0 ? Math.round((value / base) * 100) / 100 : 0);
  const summary = {
    capSec: capMs / 1000,
    overlapMs,
    versions: results.length,
    passed: passed.length,
    passedByFallback: fallbacked.length,
    failed: failed.length,
    skippedBaseline: skipped.length,
    textOnly: textOnly.length,
    totalFallbacks: results.reduce((sum, result) => sum + result.fallbackCount, 0),
    totalDuplicationBlocks: results.reduce((sum, result) => sum + result.duplication.blocks.length, 0),
    totalBaselineMs,
    totalLegacyMs,
    totalSegmentedMs,
    totalDecodes: results.reduce((sum, result) => sum + result.decodes, 0),
    totalDecodedAudioMs,
    totalUtteranceMs,
    // Extra audio the referee decodes cost: 2*overlap per joint, plus the piece overlap.
    decodedAudioRatio: ratio(totalDecodedAudioMs, totalUtteranceMs),
    overheadRatio: ratio(totalSegmentedMs, totalBaselineMs),
    legacyRatio: ratio(totalSegmentedMs, totalLegacyMs),
    results,
  };

  console.log(`\n[check] 通过 ${passed.length}，靠回退保字 ${fallbacked.length}，失败 ${failed.length}，基线也缺（跳过判定）${skipped.length}，仅文本 ${textOnly.length}`);
  console.log(`[check] 拼接回退合计 ${summary.totalFallbacks} 次，新增重复块 ${summary.totalDuplicationBlocks} 个`);
  console.log(`[check] 离线识别 ${summary.totalDecodes} 次（整段基线 ${results.length} 次 + 分段 ${summary.totalDecodes - results.length} 次）`);
  console.log(`[check] 解码音频 ${totalDecodedAudioMs} ms / 语音 ${totalUtteranceMs} ms（${summary.decodedAudioRatio}×，裁判与重叠部分）`);
  console.log(`[check] 耗时：整段 ${totalBaselineMs} ms，修复前分段 ${totalLegacyMs} ms，修复后分段 ${totalSegmentedMs} ms（相对整段 ${summary.overheadRatio}×，相对旧分段 ${summary.legacyRatio}×）`);
  if (failed.length > 0) {
    console.error('[check] 结论：分段结果丢字、次数不符或出现重复 → 退出 1');
    process.exitCode = 1;
  } else if (textOnly.length === results.length && results.length > 0) {
    console.log('[check] 结论：只记录了整段/分段文本与耗时（没有期望文本或检查项，不做判定）。');
  } else if (fallbacked.length > 0) {
    console.log('[check] 结论：定位词全部保住且无重复，但有拼接点靠回退保字（联合裁决未能确认）：这类版本不算真正修复，见上表 fallback 列。');
  } else if (skipped.length > 0) {
    console.log('[check] 结论：没有发现"整段有、分段无"的丢失；部分版本连基线也缺（见上），需要更强模型或真人录音复核。');
  } else {
    console.log('[check] 结论：五个版本全部 PASS，切点不再丢字，也没有引入重复。');
  }

  if (options.json) console.log(`\n${JSON.stringify(summary, null, 2)}`);
  return { ok: failed.length === 0, skipped: false, results, summary, manifestPath };
}

const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[check] 失败：${error?.stack ?? error}`);
    process.exit(1);
  });
}

export { buildChecks, evaluateText, evaluateVersion, findNewDuplication, normalizeText, parseArgs };
