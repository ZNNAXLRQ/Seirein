/**
 * Real-host reasoning-off probe: does `reasoningEffort: 'off'` reach the provider?
 *
 * This is the live evidence the deterministic tests cannot give. `test/lightweight.mjs`
 * proves the request *shape* against a fake stream; it cannot prove the DSH host passes the
 * control to a real provider or that the provider behaves differently. This script does:
 *
 *   1. boots a real DSH host runtime (the shipped `@deepseek-ai/dsh-base` composition) in a
 *      temporary `DSH_HOME`, with the user's existing managed credentials file mounted
 *      read-through (the file is never copied into the result),
 *   2. gets the host-registered `llm` service with `ctx.get('llm')` and calls
 *      `llm.stream(...)` twice on the SAME provider/model/system/prompt:
 *        A = `reasoningEffort: 'off'`
 *        B = no reasoning control (the provider default, High)
 *   3. records the exact request options it passed, the sanitized provider HTTP body
 *      (`thinking` / `output_config`, never headers), `firstTextMs`, `doneMs`, and the
 *      number of characters in reasoning/thinking frames,
 *   4. repeats A/B (`REASONING_ROUNDS`, default 3, order alternates) and compares medians,
 *   5. writes `%TEMP%/dsh-reasoning-live/result.json` and exits 0 only when the control was
 *      delivered AND the off group emitted zero reasoning frames. "A is faster but still reasons
 *      the same" and "reasoning merely dropped by half" are both failures, never success.
 *
 * The verdict reports independent readings, side by side:
 *   paramDelivered:   the `off` control is in the request object AND the provider body
 *                     (`thinking:{type:'disabled'}`),
 *   reasoningAbsent:  the off group's reasoning-frame characters are exactly zero,
 *   reasoningReduced: (description only) the off median is below half the baseline. A drop is
 *                     still reasoning: `reduced-not-absent` is reported and success stays false,
 *   latencyBetter:    the off group's median `firstTextMs` is lower (reference only).
 * Success is `paramDelivered && reasoningAbsent`; a drop, however large, never counts.
 * `REASONING_SELFTEST=1` runs the fake-data checks below offline (no host, no credentials).
 *
 * Run (the script re-executes itself under the DSH Electron Node so it can import the
 * shipped runtime from `app.asar`):
 *
 *   PowerShell:  $env:REASONING_LIVE='1'; node test/reasoning-off-live.mjs
 *   cmd.exe:     set REASONING_LIVE=1 && node test/reasoning-off-live.mjs
 *
 * Environment:
 *   REASONING_LIVE=1            required; without it the probe prints a skip reason
 *   REASONING_SELFTEST=1        run the offline fake-data verdict checks only (no host, no network)
 *   REASONING_ROUNDS=3          A/B rounds (clamped 1..10)
 *   REASONING_PROMPT=...        override the default reasoning prompt
 *   REASONING_SYSTEM=...        override the system prompt
 *   REASONING_PROVIDER=...      default: deepseek-account
 *   REASONING_MODEL=...         default: deepseek-flash
 *   REASONING_MAX_TOKENS=1024   per response (clamped 32..8192)
 *   REASONING_TIMEOUT_MS=120000 per call (clamped 10000..300000)
 *   REASONING_CREDENTIALS=...   managed credentials file; default <DSH_HOME>/.credentials.yaml
 *   DSH_DESKTOP_EXE=...         DeepSeek Harness executable when not on the default path
 *   DSH_ASAR=...                path to app.asar (or a dev checkout's dsh root) when needed
 *   DSH_REASONING_RESULT_DIR=... override the result directory (testing only)
 *
 * The probe never prints or copies the credential document or its token; it points the host's
 * normal credential service at the existing managed file. The provider HTTP body is reduced to
 * model/max_tokens/thinking/output_config/stream and a message count before it is recorded. The
 * probe does not modify product code, the repo's settings, or the running desktop host.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RESULT_DIR = process.env.DSH_REASONING_RESULT_DIR !== undefined
  && process.env.DSH_REASONING_RESULT_DIR.trim().length > 0
  ? resolve(process.env.DSH_REASONING_RESULT_DIR)
  : join(tmpdir(), 'dsh-reasoning-live');
const RESULT_FILE = join(RESULT_DIR, 'result.json');
const WORK_DIR = join(RESULT_DIR, 'work');
const LIVE = process.env.REASONING_LIVE === '1';

const DEFAULT_PROMPT = 'A farmer has 17 sheep. All but 9 run away. Then he buys 4 more sheep, '
  + 'and half of those new sheep run away. How many sheep does he have now? '
  + 'Think it through, then answer in one short sentence.';
const DEFAULT_SYSTEM = 'You are a careful assistant. Answer concisely.';
const READING_NOTE = 'reasoningReduced only describes a drop in reasoning characters; it is never '
  + 'success evidence. Only reasoningAbsent (zero reasoning frames) counts as reasoning off.';

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
const nowIso = () => new Date().toISOString();
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : value);
const clamp = (value, low, high, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
};
const median = (values) => {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
};
const errorText = (error) => {
  if (error === undefined || error === null) return '';
  if (typeof error === 'string') return error;
  const message = typeof error.message === 'string' ? error.message : String(error);
  return message.length > 400 ? `${message.slice(0, 400)}...` : message;
};

class BlockedError extends Error {
  constructor(message, steps = []) {
    super(message);
    this.name = 'BlockedError';
    this.steps = steps;
  }
}

/** Write the result document even when the probe fails before it has a verdict. */
async function writeResult(result) {
  await mkdir(RESULT_DIR, { recursive: true });
  result.finishedAt = result.finishedAt ?? nowIso();
  await writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function printSkip() {
  console.log('SKIP: reasoning-off-live is an opt-in, paid, real-provider probe.');
  console.log('It boots a real DSH host runtime, uses your managed DeepSeek credentials, and sends');
  console.log('real requests through the host-registered `llm.stream` service.');
  console.log('This is intentionally not part of the default regression: the deterministic tests in');
  console.log('test/lightweight.mjs cannot prove provider behavior, and an environment variable alone');
  console.log('proves nothing. Set REASONING_LIVE=1 to run it:');
  console.log('');
  console.log('  PowerShell:  $env:REASONING_LIVE=\'1\'; node test/reasoning-off-live.mjs');
  console.log('  cmd.exe:     set REASONING_LIVE=1 && node test/reasoning-off-live.mjs');
  console.log('');
  console.log('Requirements: the DSH desktop app is installed and signed in,');
  console.log('`<DSH_HOME>/.credentials.yaml` contains the DeepSeek account grant, and the');
  console.log('machine can reach api.deepseek.com. The result goes to:');
  console.log(`  ${RESULT_FILE}`);
  console.log('This skip is explicit: the live check is opt-in, not silently omitted.');
}

function resolveDesktopExe() {
  const candidates = [
    process.env.DSH_DESKTOP_EXE,
    'D:/Program Files/DeepseekHarness/DeepSeek Harness.exe',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
      : '',
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'DeepseekHarness', 'DeepSeek Harness.exe')
      : '',
  ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return candidates.find((entry) => existsSync(entry)) ?? null;
}

function printBlocked(title, block) {
  console.error(`BLOCKED: ${title}`);
  if (block instanceof BlockedError) {
    console.error(block.message);
    for (const step of block.steps) console.error(`  - ${step}`);
  } else {
    console.error(errorText(block));
  }
}

/**
 * Install a pass-through `fetch` recorder. The DeepSeek adapter captures `globalThis.fetch`
 * while the host boots, so this must be installed BEFORE `runProfile`. Only the request body
 * fields that prove the hop are retained; headers (and therefore the token) never are.
 */
function installFetchCapture() {
  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    return { records: [], restore() {} };
  }
  const records = [];
  globalThis.fetch = async function capturedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    let parsed = null;
    let parseError = '';
    if (typeof init?.body === 'string') {
      try {
        parsed = JSON.parse(init.body);
      } catch (error) {
        parseError = errorText(error);
      }
    }
    const record = {
      url,
      method,
      body: parsed === null || typeof parsed !== 'object' ? null : {
        model: parsed.model,
        max_tokens: parsed.max_tokens,
        stream: parsed.stream,
        thinking: parsed.thinking ?? null,
        output_config: parsed.output_config ?? null,
        hasReasoningKey: Object.hasOwn(parsed, 'reasoning'),
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : undefined,
      },
      ...parseError.length > 0 ? { bodyParseError: parseError } : {},
    };
    records.push(record);
    try {
      return await original.call(this, input, init);
    } catch (error) {
      record.error = errorText(error);
      throw error;
    }
  };
  return {
    records,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function providerMessages(records) {
  return records.filter((record) => record.method === 'POST' && record.url.endsWith('/messages'));
}

async function waitForService(ctx, name, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const service = ctx.get(name);
    if (service !== undefined && service !== null) return service;
    await sleep(100);
  }
  return undefined;
}

/** One measured call. Never throws: a failure is data for the verdict. */
async function runPhase({ phase, round, llm, capture, options, timeoutMs }) {
  capture.records.length = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  const started = performance.now();
  let text = '';
  let reasoningChars = 0;
  let firstTextMs = null;
  let doneMs = null;
  let finishKind = '';
  let finishFailure = '';
  let streamError = '';
  let finishMissing = false;

  const requestOptions = {
    provider: options.provider,
    model: options.model,
    system: options.system,
    messages: options.messages,
    maxTokens: options.maxTokens,
    ...Object.hasOwn(options, 'reasoningEffort') ? { reasoningEffort: options.reasoningEffort } : {},
  };
  const hasThinkingKey = Object.hasOwn(options, 'thinking');
  const hasReasoningKey = Object.hasOwn(options, 'reasoning');

  try {
    for await (const chunk of llm.stream({ ...options, signal: controller.signal })) {
      const type = String(chunk?.type ?? '').toLowerCase();
      if (type === 'text-delta') {
        const delta = String(chunk?.text ?? '');
        if (delta.length > 0) {
          text += delta;
          if (firstTextMs === null) firstTextMs = performance.now() - started;
        }
        continue;
      }
      if (/^(reasoning|thinking|thought|analysis|redacted)/u.test(type)) {
        reasoningChars += String(chunk?.text ?? chunk?.delta ?? '').length;
        continue;
      }
      if (type === 'finish') {
        const reason = chunk?.reason;
        finishKind = String(reason?.kind ?? reason ?? '');
        finishFailure = errorText(reason?.failure);
        doneMs = performance.now() - started;
      }
    }
  } catch (error) {
    streamError = errorText(error);
  } finally {
    clearTimeout(timer);
  }

  if (doneMs === null) {
    doneMs = performance.now() - started;
    finishMissing = true;
  }
  if (finishKind === 'error' || finishKind === 'aborted') {
    streamError = streamError.length > 0 ? streamError : (finishFailure || finishKind);
  }
  const successful = streamError.length === 0
    && text.trim().length > 0
    && finishKind !== 'error'
    && finishKind !== 'aborted'
    && finishMissing === false;
  const providerRequests = providerMessages(capture.records).map((record) => ({
    url: record.url,
    body: record.body,
    error: record.error ?? '',
  }));

  return {
    round,
    phase,
    requestOptions,
    requestHasThinkingKey: hasThinkingKey,
    requestHasReasoningKey: hasReasoningKey,
    providerRequests,
    reasoningChars,
    firstTextMs: firstTextMs === null ? null : round1(firstTextMs),
    doneMs: round1(doneMs),
    textChars: text.length,
    textPreview: text.slice(0, 120),
    finishKind,
    finishFailure,
    finishMissing,
    streamError,
    successful,
  };
}

function compareRequestShapes(offOptions, defaultOptions) {
  const failures = [];
  if (offOptions.reasoningEffort !== 'off') {
    failures.push(`A requestOptions.reasoningEffort is ${JSON.stringify(offOptions.reasoningEffort)}, expected "off"`);
  }
  if (defaultOptions.reasoningEffort !== undefined) {
    failures.push('B requestOptions unexpectedly carries reasoningEffort');
  }
  for (const [label, options] of [['A', offOptions], ['B', defaultOptions]]) {
    if (Object.hasOwn(options, 'thinking')) failures.push(`${label} requestOptions has a thinking key`);
    if (Object.hasOwn(options, 'reasoning')) failures.push(`${label} requestOptions has a reasoning key`);
  }
  const offBase = { ...offOptions };
  delete offBase.reasoningEffort;
  if (!isDeepStrictEqual(offBase, defaultOptions)) {
    failures.push('A and B requestOptions differ in a field other than reasoningEffort');
  }
  return failures;
}

function compareProviderBodies(offRequests, defaultRequests, model) {
  const failures = [];
  const caveats = [];
  if (offRequests.length === 0) failures.push('A produced no POST /messages request');
  if (defaultRequests.length === 0) failures.push('B produced no POST /messages request');
  for (const request of offRequests) {
    const body = request.body;
    if (body?.model !== model) failures.push(`A provider body model is ${JSON.stringify(body?.model)}, expected ${JSON.stringify(model)}`);
    if (body?.thinking?.type !== 'disabled') failures.push('A provider body does not carry thinking.type="disabled"');
    if (body?.output_config?.effort !== undefined) failures.push('A provider body unexpectedly carries output_config.effort');
    if (body?.hasReasoningKey === true) failures.push('A provider body carries a reasoning key');
  }
  for (const request of defaultRequests) {
    const body = request.body;
    if (body?.model !== model) failures.push(`B provider body model is ${JSON.stringify(body?.model)}, expected ${JSON.stringify(model)}`);
    if (body?.thinking?.type !== 'enabled') failures.push('B provider body does not carry thinking.type="enabled"');
    const effort = body?.output_config?.effort;
    if (typeof effort !== 'string' || effort.length === 0) {
      failures.push('B provider body does not carry output_config.effort (the default reasoning control)');
    } else if (effort !== 'high') {
      caveats.push(`B provider body used output_config.effort=${JSON.stringify(effort)}; this build expects the default "high"`);
    }
  }
  return { failures, caveats };
}

/**
 * The `off` control must be visible in BOTH places that prove the hop: the request object handed
 * to `llm.stream` and the provider HTTP body. A latency change is never part of this reading.
 */
function deriveParamDelivered(offRounds) {
  const rounds = Array.isArray(offRounds) ? offRounds : [];
  const requestOff = rounds.length > 0
    && rounds.every((round) => round?.requestOptions?.reasoningEffort === 'off');
  const requests = rounds.flatMap((round) => round?.providerRequests ?? []);
  const bodyDisabled = requests.length > 0
    && requests.every((request) => request?.body?.thinking?.type === 'disabled');
  return {
    paramDelivered: requestOff && bodyDisabled,
    requestOff,
    bodyDisabled,
    requestCount: requests.length,
  };
}

/**
 * Independent readings. `reasoningReduced` only describes "less reasoning" (it is also true for
 * zero, which is a decrease like any other); only `reasoningAbsent` (strictly zero reasoning-frame
 * characters) is success evidence. A group that still emits half the baseline is still reasoning,
 * so it is `reduced-not-absent`, never success.
 */
function judgeReasoningOff({ offMedian, defaultMedian, paramDelivered }) {
  const offChars = offMedian?.reasoningChars;
  const baseChars = defaultMedian?.reasoningChars;
  const baselineHadReasoning = Number.isFinite(baseChars) && baseChars > 0;
  const reasoningAbsent = offChars === 0;
  // Kept for the result schema, but now strict: only zero frames count as "gone".
  const reasoningGone = reasoningAbsent;
  const reasoningReduced = Number.isFinite(offChars) && Number.isFinite(baseChars)
    && offChars < baseChars * 0.5;
  const reasoningDrop = Number.isFinite(offChars) && Number.isFinite(baseChars)
    ? baseChars - offChars
    : null;
  const reasoningRatio = baselineHadReasoning && Number.isFinite(offChars)
    ? Math.round((offChars / baseChars) * 1000) / 1000
    : null;
  const latencyDrop = Number.isFinite(offMedian?.firstTextMs) && Number.isFinite(defaultMedian?.firstTextMs)
    ? defaultMedian.firstTextMs - offMedian.firstTextMs
    : null;
  const latencyBetter = Number.isFinite(latencyDrop) && latencyDrop > 0;
  const ratioText = reasoningRatio === null ? 'n/a' : `${reasoningRatio}x`;
  const reasoningNote = reasoningAbsent
    ? (baselineHadReasoning
      ? 'off group emitted zero reasoning characters (absent)'
      : 'off group emitted zero reasoning characters, but the baseline did too (not attributable to off)')
    : (reasoningReduced
      ? `off group reasoning characters fell to ${ratioText} the baseline (reduced, still present)`
      : `off group reasoning characters stayed at ${ratioText} the baseline (present)`);
  const unmet = [];
  if (paramDelivered !== true) unmet.push('paramDelivered');
  if (reasoningAbsent !== true) unmet.push('reasoningAbsent');
  return {
    paramDelivered: paramDelivered === true,
    reasoningAbsent,
    reasoningReduced,
    reasoningGone,
    latencyBetter,
    offReasoningZero: reasoningAbsent,
    reasoningBaselineChars: Number.isFinite(baseChars) ? baseChars : null,
    reasoningOffChars: Number.isFinite(offChars) ? offChars : null,
    reasoningRatio,
    reasoningDrop,
    reasoningNote,
    latencyDrop,
    latencyBaselineMs: Number.isFinite(defaultMedian?.firstTextMs) ? defaultMedian.firstTextMs : null,
    latencyOffMs: Number.isFinite(offMedian?.firstTextMs) ? offMedian.firstTextMs : null,
    unmet,
  };
}

/**
 * Machine-readable outcome. `reduced-not-absent` is a failure code, not a weaker success:
 * a drop can never stand in for "no reasoning frames were observed".
 */
function verdictCode(judgement) {
  if (judgement?.paramDelivered !== true) return 'param-not-delivered';
  if (judgement?.reasoningAbsent === true) return 'absent';
  if (judgement?.reasoningReduced === true) return 'reduced-not-absent';
  return 'present';
}

/**
 * The only success rule: parameter delivered AND zero reasoning frames. `reasoningReduced`
 * and `latencyBetter` are not inputs here, so neither can make a run succeed.
 */
function verdictSuccess(judgement, invalid = []) {
  return invalid.length === 0
    && judgement?.paramDelivered === true
    && judgement?.reasoningAbsent === true;
}

/** Offline checks for the verdict rules; `REASONING_SELFTEST=1` runs this before any host work. */
function runSelfCheck() {
  const cases = [];
  const check = (name, ok, detail) => cases.push({ name, ok: ok === true, detail });
  const fakeOffRounds = (requestOptions, body) => [{ phase: 'off', requestOptions, providerRequests: [{ body }] }];

  const delivered = deriveParamDelivered(fakeOffRounds(
    { provider: 'p', model: 'm', reasoningEffort: 'off' },
    { model: 'm', thinking: { type: 'disabled' } },
  ));
  check('paramDelivered=true when request=off and provider thinking=disabled', delivered.paramDelivered === true, delivered);
  const bodyEnabled = deriveParamDelivered(fakeOffRounds(
    { provider: 'p', model: 'm', reasoningEffort: 'off' },
    { model: 'm', thinking: { type: 'enabled' } },
  ));
  check('paramDelivered=false when the provider body still says thinking=enabled', bodyEnabled.paramDelivered === false, bodyEnabled);
  const requestMissing = deriveParamDelivered(fakeOffRounds(
    { provider: 'p', model: 'm' },
    { model: 'm', thinking: { type: 'disabled' } },
  ));
  check('paramDelivered=false when requestOptions has no reasoningEffort', requestMissing.paramDelivered === false, requestMissing);

  // 1000 -> 300: a real drop, but reasoning frames still arrived. A drop is not an observation
  // of "no reasoning", so success must stay false with the dedicated reduced-not-absent code.
  const reducedNotAbsent = judgeReasoningOff({
    offMedian: { reasoningChars: 300, firstTextMs: 700 },
    defaultMedian: { reasoningChars: 1000, firstTextMs: 1000 },
    paramDelivered: true,
  });
  check('1000 -> 300 chars: reduced but not absent -> success false (reduced-not-absent)',
    reducedNotAbsent.reasoningReduced === true
      && reducedNotAbsent.reasoningAbsent === false
      && reducedNotAbsent.reasoningGone === false
      && reducedNotAbsent.unmet.includes('reasoningAbsent')
      && verdictCode(reducedNotAbsent) === 'reduced-not-absent'
      && verdictSuccess(reducedNotAbsent) === false,
    { success: verdictSuccess(reducedNotAbsent), code: verdictCode(reducedNotAbsent), ...reducedNotAbsent });

  // 1000 -> 0: zero reasoning frames. Success even though the first token arrived later.
  const absentAndSlower = judgeReasoningOff({
    offMedian: { reasoningChars: 0, firstTextMs: 1200 },
    defaultMedian: { reasoningChars: 1000, firstTextMs: 1000 },
    paramDelivered: true,
  });
  check('1000 -> 0 chars: reasoning absent -> success true even when slower',
    absentAndSlower.reasoningAbsent === true
      && absentAndSlower.reasoningGone === true
      && absentAndSlower.latencyBetter === false
      && absentAndSlower.unmet.length === 0
      && verdictCode(absentAndSlower) === 'absent'
      && verdictSuccess(absentAndSlower) === true,
    { success: verdictSuccess(absentAndSlower), code: verdictCode(absentAndSlower), ...absentAndSlower });

  // No drop at all: the baseline reasoning simply repeated, off only got faster.
  const fastButNotGone = judgeReasoningOff({
    offMedian: { reasoningChars: 1000, firstTextMs: 500 },
    defaultMedian: { reasoningChars: 1000, firstTextMs: 1000 },
    paramDelivered: true,
  });
  check('FAST BUT REASONING NOT GONE -> success must be false',
    fastButNotGone.paramDelivered === true
      && fastButNotGone.latencyBetter === true
      && fastButNotGone.reasoningReduced === false
      && fastButNotGone.reasoningAbsent === false
      && verdictCode(fastButNotGone) === 'present'
      && verdictSuccess(fastButNotGone) === false,
    { success: verdictSuccess(fastButNotGone), code: verdictCode(fastButNotGone), ...fastButNotGone });

  // Not a drop (< half): description flag must stay false as well.
  const barelyLower = judgeReasoningOff({
    offMedian: { reasoningChars: 700, firstTextMs: 1000 },
    defaultMedian: { reasoningChars: 1000, firstTextMs: 1000 },
    paramDelivered: true,
  });
  check('1000 -> 700 chars: not reduced, not absent -> success false',
    barelyLower.reasoningReduced === false
      && barelyLower.reasoningAbsent === false
      && verdictSuccess(barelyLower) === false,
    { success: verdictSuccess(barelyLower), ...barelyLower });

  const goneNotDelivered = judgeReasoningOff({
    offMedian: { reasoningChars: 0, firstTextMs: 300 },
    defaultMedian: { reasoningChars: 1000, firstTextMs: 1000 },
    paramDelivered: false,
  });
  check('reasoning absent but param not delivered -> not success',
    goneNotDelivered.reasoningAbsent === true
      && goneNotDelivered.unmet.includes('paramDelivered')
      && verdictCode(goneNotDelivered) === 'param-not-delivered'
      && verdictSuccess(goneNotDelivered) === false,
    { success: verdictSuccess(goneNotDelivered), code: verdictCode(goneNotDelivered), ...goneNotDelivered });

  for (const entry of cases) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} :: ${JSON.stringify(entry.detail)}`);
  }
  const passed = cases.filter((entry) => entry.ok === true).length;
  console.log(`self-check: ${passed}/${cases.length} passed ` +
    '(success requires paramDelivered && reasoningAbsent; reasoningReduced and latencyBetter are description only)');
  process.exitCode = passed === cases.length ? 0 : 1;
}

async function main() {
  const startedAt = nowIso();
  const rounds = clamp(process.env.REASONING_ROUNDS, 1, 10, 3);
  const provider = String(process.env.REASONING_PROVIDER ?? 'deepseek-account').trim() || 'deepseek-account';
  const model = String(process.env.REASONING_MODEL ?? 'deepseek-flash').trim() || 'deepseek-flash';
  const prompt = String(process.env.REASONING_PROMPT ?? DEFAULT_PROMPT);
  const system = String(process.env.REASONING_SYSTEM ?? DEFAULT_SYSTEM);
  const maxTokens = clamp(process.env.REASONING_MAX_TOKENS, 32, 8192, 1024);
  const timeoutMs = clamp(process.env.REASONING_TIMEOUT_MS, 10_000, 300_000, 120_000);
  const realHome = String(process.env.DSH_HOME ?? '').trim().length > 0
    ? resolve(process.env.DSH_HOME.trim())
    : join(homedir(), '.dsh');
  const credentialsPath = process.env.REASONING_CREDENTIALS !== undefined
    && process.env.REASONING_CREDENTIALS.trim().length > 0
    ? resolve(process.env.REASONING_CREDENTIALS)
    : join(realHome, '.credentials.yaml');

  const result = {
    schemaVersion: 1,
    probe: 'reasoning-off-live',
    live: true,
    startedAt,
    finishedAt: null,
    resultPath: RESULT_FILE,
    runtime: {
      dsh: null,
      profile: 'reasoning-live-probe',
      home: '<temporary DSH_HOME>',
      realHome,
      credentialsFile: credentialsPath,
      provider,
      model,
      modelInfo: null,
    },
    config: { rounds, prompt, system, maxTokens, timeoutMs },
    readingNote: READING_NOTE,
    assertions: {
      offSupported: false,
      requestShapeFailures: [],
      providerShapeFailures: [],
      providerEvidence: false,
      measuredCallsSuccessful: false,
      paramDelivered: false,
      reasoningReduced: false,
      reasoningAbsent: false,
      reasoningGone: false,
      latencyBetter: false,
    },
    warmup: null,
    rounds: [],
    medians: {},
    verdict: null,
    caveats: [],
    fatal: null,
  };

  let exitCode = 1;
  let shutdown = null;
  let capture = null;
  let stage = 'preflight';

  const finish = async () => {
    result.finishedAt = nowIso();
    try {
      await writeResult(result);
    } catch (error) {
      console.error(`ERROR: could not write ${RESULT_FILE}: ${errorText(error)}`);
      exitCode = 1;
    }
    return exitCode;
  };

  try {
    if (!existsSync(credentialsPath)) {
      throw new BlockedError(
        `The managed credentials file does not exist: ${credentialsPath}`,
        [
          'Start the DeepSeek Harness desktop app and sign in to the DeepSeek account.',
          'The probe points the host at this file; it never prints or copies the token.',
          'If the account lives in another DSH home, pass REASONING_CREDENTIALS=<path>.',
        ],
      );
    }

    const appRoot = process.env.DSH_ASAR !== undefined && process.env.DSH_ASAR.trim().length > 0
      ? resolve(process.env.DSH_ASAR)
      : join(dirname(process.execPath), 'resources', 'app.asar');
    // `DSH_ASAR` may name an app.asar (contains `dsh/`) or a development checkout's dsh root.
    const dshRoot = existsSync(join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js'))
      ? join(appRoot, 'dsh')
      : appRoot;
    const profileBootPath = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js');
    const appBootPath = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
    if (!existsSync(profileBootPath) || !existsSync(appBootPath)) {
      throw new BlockedError(
        `The DSH runtime was not found under ${dshRoot}`,
        [
          'Run this script with the DSH Electron Node: it re-executes itself automatically.',
          'If the desktop app is installed elsewhere, set DSH_DESKTOP_EXE to its executable.',
          'If you are testing a development checkout, set DSH_ASAR to its app.asar (or dsh root).',
        ],
      );
    }
    result.runtime.dsh = {
      version: JSON.parse(readFileSync(join(dshRoot, 'package.json'), 'utf8')).version,
      appRoot,
      dshRoot,
    };

    // The temporary profile composition. `dsh-base` supplies the registered `llm` service,
    // the DeepSeek account provider, the credential provider, and authorization.
    await rm(WORK_DIR, { recursive: true, force: true });
    const tempHome = join(WORK_DIR, 'home');
    const profileDir = join(tempHome, 'profiles', result.runtime.profile);
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-reasoning-live-probe',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2)}\n`, 'utf8');
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      '# The live probe needs no config watcher; everything else is the shipped base.',
      '- id: hmr',
      '  disabled: true',
      '',
    ].join('\n'), 'utf8');
    const overlayPath = join(WORK_DIR, 'overlay.yml');
    await writeFile(overlayPath, [
      '# Read-through the user-managed credentials; never copy or print them.',
      '- id: credentials',
      '  config:',
      `    path: ${JSON.stringify(credentialsPath.replaceAll('\\', '/'))}`,
      '',
    ].join('\n'), 'utf8');

    process.env.DSH_HOME = tempHome;
    process.env.DSH_TELEMETRY_DISABLED = '1';

    stage = 'boot';
    capture = installFetchCapture();
    const { runProfile } = await import(pathToFileURL(profileBootPath).href);
    const { loadLayeredEnv } = await import(pathToFileURL(appBootPath).href);
    const booted = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: result.runtime.profile,
      patchFiles: [overlayPath],
      args: [],
    });
    shutdown = booted.shutdown;
    const ctx = booted.ctx;

    stage = 'llm-service';
    const llm = await waitForService(ctx, 'llm');
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new BlockedError(
        'The booted DSH host did not register the `llm` service.',
        [
          'Check that the profile composition includes @deepseek-ai/dsh-base.',
          'Run the script under the DSH Electron Node (it does this automatically).',
        ],
      );
    }
    if (typeof llm.resolveModelInfo !== 'function') {
      throw new BlockedError('The `llm` service does not expose resolveModelInfo().', []);
    }

    stage = 'model-info';
    const info = await llm.resolveModelInfo(provider, model, AbortSignal.timeout(60_000));
    const efforts = Array.isArray(info?.reasoning?.efforts)
      ? info.reasoning.efforts.map((entry) => String(entry?.id ?? ''))
      : [];
    result.runtime.modelInfo = {
      provider: info?.provider ?? null,
      id: info?.id ?? null,
      name: info?.name ?? null,
      reasoningEfforts: efforts,
      defaultEffort: info?.reasoning?.defaultEffort ?? null,
    };
    result.assertions.offSupported = efforts.includes('off');
    if (!result.assertions.offSupported) {
      throw new BlockedError(
        `Model ${provider}/${model} does not advertise reasoning effort "off" (advertised: ${efforts.join(', ') || 'none'}).`,
        [
          'Set REASONING_MODEL to a model whose reasoning.efforts includes "off".',
          'The probe intentionally refuses to claim a result when the route cannot turn reasoning off.',
        ],
      );
    }

    const makeOptions = (phase) => {
      const options = {
        provider,
        model,
        system,
        maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      };
      if (phase === 'off') options.reasoningEffort = 'off';
      return options;
    };

    stage = 'warmup';
    console.log(`host: DSH ${result.runtime.dsh.version} | profile=${result.runtime.profile} | ${provider}/${model}`);
    console.log(`model info: efforts=[${efforts.join(',')}] default=${result.runtime.modelInfo.defaultEffort}`);
    console.log('warmup: one small real request so the model listing and connection are warm');
    result.warmup = await runPhase({
      phase: 'warmup',
      round: 0,
      llm,
      capture,
      options: {
        provider,
        model,
        system: 'Reply with exactly: ok',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: ok' }] }],
        reasoningEffort: 'off',
      },
      timeoutMs: Math.min(timeoutMs, 60_000),
    });
    console.log(`warmup: text=${JSON.stringify(result.warmup.textPreview)} reasoningChars=${result.warmup.reasoningChars} `
      + `firstTextMs=${result.warmup.firstTextMs} doneMs=${result.warmup.doneMs} error=${JSON.stringify(result.warmup.streamError)}`);
    if (result.warmup.successful !== true) {
      throw new BlockedError(
        `Warmup failed before the measured rounds: ${result.warmup.streamError || 'no text/finish'}.`,
        [
          'Verify that the DSH desktop app is signed in and can reach api.deepseek.com.',
          'Check that the managed credentials belong to the account that can use this model.',
          'Set REASONING_TIMEOUT_MS higher on a slow network, or REASONING_PROMPT simpler.',
        ],
      );
    }

    stage = 'measure';
    for (let round = 1; round <= rounds; round += 1) {
      const order = round % 2 === 1 ? ['off', 'default'] : ['default', 'off'];
      for (const phase of order) {
        const measured = await runPhase({
          phase,
          round,
          llm,
          capture,
          options: makeOptions(phase),
          timeoutMs,
        });
        result.rounds.push(measured);
        const firstProvider = measured.providerRequests[0]?.body ?? null;
        console.log(`round ${round} ${phase.padEnd(7)}: reasoningChars=${String(measured.reasoningChars).padStart(4)} `
          + `firstTextMs=${String(measured.firstTextMs).padStart(8)} doneMs=${String(measured.doneMs).padStart(8)} `
          + `provider.thinking=${JSON.stringify(firstProvider?.thinking ?? null)} `
          + `provider.effort=${JSON.stringify(firstProvider?.output_config?.effort ?? null)} `
          + `error=${JSON.stringify(measured.streamError)}`);
        await sleep(250);
      }
    }

    const byPhase = {
      off: result.rounds.filter((entry) => entry.phase === 'off'),
      default: result.rounds.filter((entry) => entry.phase === 'default'),
    };
    result.assertions.measuredCallsSuccessful = result.rounds.every((entry) => entry.successful === true);
    result.medians = Object.fromEntries(Object.entries(byPhase).map(([phase, entries]) => [phase, {
      reasoningChars: median(entries.map((entry) => entry.reasoningChars)),
      firstTextMs: round1(median(entries.map((entry) => entry.firstTextMs))),
      doneMs: round1(median(entries.map((entry) => entry.doneMs))),
      samples: entries.length,
    }]));

    // Compare the request objects that were actually recorded for the rounds, not a rebuilt
    // copy: the proof must describe what was handed to `llm.stream`.
    const offOptions = result.rounds.find((entry) => entry.phase === 'off')?.requestOptions ?? makeOptions('off');
    const defaultOptions = result.rounds.find((entry) => entry.phase === 'default')?.requestOptions ?? makeOptions('default');
    result.assertions.requestShapeFailures = compareRequestShapes(offOptions, defaultOptions);
    const providerShape = compareProviderBodies(
      result.rounds.filter((entry) => entry.phase === 'off').flatMap((entry) => entry.providerRequests),
      result.rounds.filter((entry) => entry.phase === 'default').flatMap((entry) => entry.providerRequests),
      model,
    );
    result.assertions.providerShapeFailures = providerShape.failures;
    const roundsWithoutProviderRequest = result.rounds
      .filter((entry) => entry.providerRequests.length === 0)
      .map((entry) => `round ${entry.round} ${entry.phase}`);
    if (roundsWithoutProviderRequest.length > 0) {
      result.assertions.providerShapeFailures.push(
        `no captured POST /messages request for: ${roundsWithoutProviderRequest.join(', ')}`,
      );
    }
    result.caveats.push(...providerShape.caveats);
    const offProviderCount = byPhase.off.reduce((sum, entry) => sum + entry.providerRequests.length, 0);
    const defaultProviderCount = byPhase.default.reduce((sum, entry) => sum + entry.providerRequests.length, 0);
    result.assertions.providerEvidence = offProviderCount > 0 && defaultProviderCount > 0;
    result.assertions.providerRequestCounts = { off: offProviderCount, default: defaultProviderCount };

    const offMedian = result.medians.off;
    const defaultMedian = result.medians.default;
    const delivery = deriveParamDelivered(byPhase.off);
    const judgement = judgeReasoningOff({
      offMedian,
      defaultMedian,
      paramDelivered: delivery.paramDelivered,
    });
    result.assertions.paramDelivered = judgement.paramDelivered;
    result.assertions.reasoningReduced = judgement.reasoningReduced;
    result.assertions.reasoningAbsent = judgement.reasoningAbsent;
    result.assertions.reasoningGone = judgement.reasoningGone;
    result.assertions.latencyBetter = judgement.latencyBetter;
    result.assertions.paramDelivery = delivery;
    if (judgement.reasoningBaselineChars === 0) {
      result.caveats.push('the default (baseline) group emitted no reasoning frames either; a zero in the off group is not evidence that "off" removed them');
    }

    const invalid = [];
    if (result.assertions.offSupported !== true) invalid.push('the route does not advertise "off"');
    if (result.assertions.requestShapeFailures.length > 0) invalid.push('the request options are not the required A/B shape');
    if (result.assertions.providerEvidence !== true) invalid.push('no provider POST /messages request was captured');
    if (result.assertions.providerShapeFailures.length > 0) invalid.push('the provider body is not the required off/default shape');
    if (result.assertions.measuredCallsSuccessful !== true) invalid.push('one or more measured calls failed');

    const unmetText = judgement.unmet.join(' + ');
    const code = verdictCode(judgement);
    // The one and only success rule: parameter delivered AND zero reasoning frames.
    const success = verdictSuccess(judgement, invalid);
    let verdict;
    if (invalid.length > 0) {
      verdict = {
        status: 'inconclusive',
        code,
        success,
        message: `Inconclusive: ${invalid.join('; ')}. (unmet: ${unmetText || 'none'})`,
        note: READING_NOTE,
        ...judgement,
      };
    } else if (judgement.unmet.length > 0) {
      verdict = {
        status: judgement.paramDelivered === false ? 'inconclusive' : 'not-observed',
        code,
        success,
        message: `Not success: unmet ${unmetText}. paramDelivered=${judgement.paramDelivered}, `
          + `reasoningAbsent=${judgement.reasoningAbsent}, reasoningReduced=${judgement.reasoningReduced} `
          + '(description only), latencyBetter=${judgement.latencyBetter} (reference only).',
        note: READING_NOTE,
        ...judgement,
      };
    } else {
      verdict = {
        status: 'supported',
        code,
        success,
        message: 'Supported: the "off" control was delivered to the request and the provider body, '
          + 'and the off group emitted zero reasoning frames.',
        note: READING_NOTE,
        ...judgement,
      };
    }
    result.verdict = verdict;

    const requestSummary = (options) => ({
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort ?? null,
      hasThinkingKey: Object.hasOwn(options, 'thinking'),
      hasReasoningKey: Object.hasOwn(options, 'reasoning'),
    });
    console.log('');
    console.log(`request A (off)    : ${JSON.stringify(requestSummary(offOptions))}`);
    console.log(`request B (default): ${JSON.stringify(requestSummary(defaultOptions))}`);
    console.log(`medians: off reasoningChars=${offMedian?.reasoningChars} firstTextMs=${offMedian?.firstTextMs} doneMs=${offMedian?.doneMs}`);
    console.log(`medians: default reasoningChars=${defaultMedian?.reasoningChars} firstTextMs=${defaultMedian?.firstTextMs} doneMs=${defaultMedian?.doneMs}`);
    console.log(`request shape: ${result.assertions.requestShapeFailures.length === 0 ? 'OK' : result.assertions.requestShapeFailures.join('; ')}`);
    console.log(`provider shape: ${result.assertions.providerShapeFailures.length === 0 ? 'OK' : result.assertions.providerShapeFailures.join('; ')}`);
    console.log(`provider requests: off=${offProviderCount} default=${defaultProviderCount}`);
    console.log(`paramDelivered  : ${judgement.paramDelivered} `
      + `(request.reasoningEffort=off: ${delivery.requestOff}; provider.thinking.type=disabled: ${delivery.bodyDisabled}; `
      + `off POST /messages: ${delivery.requestCount})`);
    console.log(`reasoningReduced: ${judgement.reasoningReduced} `
      + `(off reasoningChars=${judgement.reasoningOffChars} vs baseline=${judgement.reasoningBaselineChars} `
      + `ratio=${judgement.reasoningRatio}; description only, never success evidence)`);
    console.log(`reasoningAbsent : ${judgement.reasoningAbsent} `
      + `(${judgement.reasoningNote}; strict: exactly zero reasoning frames)`);
    console.log(`latencyBetter   : ${judgement.latencyBetter} `
      + `(off firstTextMs=${judgement.latencyOffMs} vs baseline=${judgement.latencyBaselineMs}; reference only)`);
    console.log(`unmet           : ${judgement.unmet.length > 0 ? judgement.unmet.join(', ') : 'none'} `
      + '(success requires paramDelivered && reasoningAbsent)');
    console.log(`VERDICT: ${verdict.status.toUpperCase()} [${code}] - ${verdict.message}`);
    console.log(READING_NOTE);
    exitCode = verdict.success === true ? 0 : 1;
  } catch (error) {
    result.fatal = {
      stage,
      message: errorText(error),
      steps: error instanceof BlockedError ? error.steps : [],
    };
    result.verdict = result.verdict ?? {
      status: 'inconclusive',
      success: false,
      message: `Inconclusive: ${result.fatal.message}`,
    };
    printBlocked(`reasoning-off-live stopped at ${stage}`, error);
    if (!(error instanceof BlockedError) && typeof error?.stack === 'string') {
      console.error(error.stack);
    }
    exitCode = 1;
  } finally {
    if (capture !== null) {
      try {
        capture.restore();
      } catch (error) {
        result.caveats.push(`restoring fetch failed: ${errorText(error)}`);
      }
    }
    if (shutdown !== null) {
      try {
        await shutdown.shutdown(exitCode);
      } catch (error) {
        result.caveats.push(`host shutdown failed: ${errorText(error)}`);
      }
    }
    try {
      await rm(WORK_DIR, { recursive: true, force: true });
    } catch (error) {
      result.caveats.push(`temporary profile cleanup failed: ${errorText(error)}`);
    }
    await finish();
    console.log(`result: ${RESULT_FILE}`);
    process.exitCode = exitCode;
  }
}

if (process.env.REASONING_SELFTEST === '1') {
  runSelfCheck();
} else if (!LIVE) {
  printSkip();
} else if (process.versions.electron === undefined) {
  // Plain Node cannot import modules from `app.asar`; re-exec under the DSH Electron Node.
  const desktopExe = resolveDesktopExe();
  if (desktopExe === null) {
    const blocked = new BlockedError(
      'Could not find the DeepSeek Harness executable to reach the shipped DSH runtime.',
      [
        'Install the DSH desktop app, or set DSH_DESKTOP_EXE to "…/DeepSeek Harness.exe".',
        'Then run: $env:REASONING_LIVE=\'1\'; node test/reasoning-off-live.mjs',
        'Alternatively run this script under ELECTRON_RUN_AS_NODE=1 with that executable.',
      ],
    );
    printBlocked('reasoning-off-live needs the DSH Electron runtime', blocked);
    process.exitCode = 1;
    await writeResult({
      schemaVersion: 1,
      probe: 'reasoning-off-live',
      live: true,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      resultPath: RESULT_FILE,
      fatal: { stage: 'runtime', message: blocked.message, steps: blocked.steps },
      verdict: { status: 'inconclusive', success: false, message: blocked.message },
      caveats: [],
    }).catch((error) => { console.error(`ERROR: could not write ${RESULT_FILE}: ${errorText(error)}`); });
  } else {
    const child = spawnSync(desktopExe, [SCRIPT_PATH], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    if (child.error !== undefined) {
      console.error(`ERROR: could not start ${desktopExe}: ${errorText(child.error)}`);
      process.exitCode = 1;
    } else {
      process.exitCode = child.status ?? 1;
    }
  }
} else {
  await main();
}
