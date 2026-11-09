/**
 * VTS quiet-authorization policy (pure helpers + host wiring; no real VTube Studio, no popup).
 *
 * The rejected design was "grant-timeout → retry every 2 minutes forever". The accepted contract:
 *   - automatic re-authorization is OFF by default (`vtsAuthAutoRetryMs` defaults to 0);
 *   - an opt-in cooldown plus a per-mount budget (default 1, hard cap 2) bounds any popup attempts;
 *   - a popup that is still open (`authorizePending:true`) is never duplicated;
 *   - `token-invalid` / needs-user stops automatic requests and keeps only the user button;
 *   - `grant-timeout` is reported as incomplete and is never re-requested by a cooldown;
 *   - an ordinary disconnect keeps the normal probe/connect path (saved-token reconnect + backoff).
 *
 * Client-level late-response and token-persistence guarantees are covered by
 * `test/vts-auth-state.mjs` (tests 5, 7 and 12) and `test/vts-authorize.mjs`; this suite asserts the
 * Host does not accidentally reintroduce the silent popup loop around them.
 *
 * Run: node --test test/vts-auth-auto-retry.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  planVtsQuietAuth,
  shouldAutoReauthorize,
  VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS,
  VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP,
  VTS_AUTH_AUTO_RETRY_MS,
  vtsAuthPhase,
} from '../src/host/avatar/auto-connect.js';

const OPT_IN_MS = 120_000;
const quietStatus = (overrides = {}) => ({
  state: 'requesting-grant',
  authenticated: false,
  needsAuth: false,
  authError: '',
  lastAuthAt: 1_000,
  authorizePending: false,
  ...overrides,
});

test('1. 默认关闭：常量为 0，默认预算 1 次，硬上限 2 次', () => {
  assert.equal(VTS_AUTH_AUTO_RETRY_MS, 0, 'automatic re-authorization is opt-in only');
  assert.equal(VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS, 1, 'one automatic grant by default');
  assert.equal(VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP, 2, 'never more than two automatic grants');
});

test('2. shouldAutoReauthorize：静默状态 + 冷却边界，畸形输入一律 false', () => {
  const base = {
    state: 'requesting-grant',
    authorizePending: false,
    lastAuthAt: 1_000,
    now: 1_000 + OPT_IN_MS,
    cooldownMs: OPT_IN_MS,
  };
  assert.equal(shouldAutoReauthorize(base), true, 'exact cooldown boundary is eligible');
  assert.equal(shouldAutoReauthorize({ ...base, state: 'token-invalid' }), true,
    'the pure predicate still exposes both quiet states; the Host applies the stricter policy');
  assert.equal(shouldAutoReauthorize({ ...base, state: 'ready' }), false);
  assert.equal(shouldAutoReauthorize({ ...base, state: 'disconnected' }), false);
  assert.equal(shouldAutoReauthorize({ ...base, authorizePending: true }), false);
  assert.equal(shouldAutoReauthorize({ ...base, now: base.now - 1 }), false, 'cooldown not elapsed');
  assert.equal(shouldAutoReauthorize({ ...base, lastAuthAt: 0 }), false, 'never authorized');
  assert.equal(shouldAutoReauthorize({ ...base, lastAuthAt: undefined }), false);
  assert.equal(shouldAutoReauthorize({ ...base, lastAuthAt: Number.NaN }), false);
  assert.equal(shouldAutoReauthorize({ ...base, lastAuthAt: Number.POSITIVE_INFINITY }), false);
  assert.equal(shouldAutoReauthorize({ ...base, now: Number.NaN }), false);
  assert.equal(shouldAutoReauthorize({ ...base, cooldownMs: 0 }), false, '0 disables the predicate');
  assert.equal(shouldAutoReauthorize({ ...base, cooldownMs: -1 }), false);
  assert.equal(shouldAutoReauthorize({ ...base, cooldownMs: Number.NaN }), false);
  assert.equal(shouldAutoReauthorize({ ...base, cooldownMs: undefined }), false,
    'the default cooldown is 0 (OFF)');
  assert.equal(shouldAutoReauthorize(), false);
  assert.equal(shouldAutoReauthorize(null), false);
  assert.equal(shouldAutoReauthorize('requesting-grant'), false);
});

test('3. 默认配置（cooldown 0）即使时间再久也不授权', () => {
  const decision = planVtsQuietAuth({
    status: quietStatus({ lastAuthAt: 1_000 }),
    cooldownMs: VTS_AUTH_AUTO_RETRY_MS,
    attempts: 0,
    maxAttempts: 1,
    lastAuthAt: 1_000,
    now: Date.now(),
  });
  assert.deepEqual(decision, { handled: true, reason: 'auto-retry-disabled', authorize: false });
});

test('4. 策略：弹窗仍在 → 不重复；超时 → 不因冷却再弹；拒绝 → 只留用户按钮', () => {
  const now = 10_000_000;
  const pendingTimeout = planVtsQuietAuth({
    status: quietStatus({ authError: 'grant-timeout', needsAuth: true, authorizePending: true }),
    cooldownMs: 1,
    attempts: 0,
    maxAttempts: 2,
    lastAuthAt: 1_000,
    now,
  });
  assert.equal(pendingTimeout.reason, 'auth-pending');
  assert.equal(pendingTimeout.authorize, false, 'an existing popup must never be duplicated');

  const timedOut = quietStatus({ authError: 'grant-timeout', needsAuth: true, authorizePending: false });
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = planVtsQuietAuth({
      status: timedOut,
      cooldownMs: 1,
      attempts: 0,
      maxAttempts: 2,
      lastAuthAt: 1_000,
      now: now + tick * 1_000_000,
    });
    assert.equal(decision.reason, 'auth-incomplete', 'a timeout stays incomplete after any cooldown');
    assert.equal(decision.authorize, false);
  }

  const rejected = quietStatus({ state: 'token-invalid', needsAuth: true, authError: 'token-invalid' });
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = planVtsQuietAuth({
      status: rejected,
      cooldownMs: 1,
      attempts: 0,
      maxAttempts: 2,
      lastAuthAt: 1_000,
      now: now + tick * 1_000_000,
    });
    assert.equal(decision.reason, 'auth-user-action-required', 'explicit rejection is user-only');
    assert.equal(decision.authorize, false);
  }
});

test('5. 策略：opt-in 冷却 + 在途 + 每静默周期预算（默认 1，硬上限 2）', () => {
  const status = quietStatus();
  const options = {
    status,
    cooldownMs: 1_000,
    attempts: 0,
    lastAuthAt: 1_000,
    now: 10_000,
  };
  assert.deepEqual(planVtsQuietAuth({ ...options, maxAttempts: 1 }),
    { handled: true, reason: 'auth-retry', authorize: true });
  assert.equal(planVtsQuietAuth({ ...options, now: 1_500 }).reason, 'auth-cooldown');
  assert.equal(planVtsQuietAuth({ ...options, inFlight: true }).reason, 'auth-retry-in-flight');
  assert.equal(planVtsQuietAuth({ ...options, attempts: 1, maxAttempts: 1 }).reason,
    'auth-retry-exhausted');
  assert.equal(planVtsQuietAuth({ ...options, attempts: 2, maxAttempts: 99 }).reason,
    'auth-retry-exhausted', 'the hard cap clamps 99 down to 2');
  assert.equal(planVtsQuietAuth({ ...options, attempts: 1, maxAttempts: 99, now: 1_500 }).reason,
    'auth-cooldown', 'attempt 2 still obeys its own cooldown');
});

test('6. 策略：普通断线不走静默分支，保留 token 重连/退避路径', () => {
  for (const state of ['disconnected', 'error', 'connecting', 'ready']) {
    const decision = planVtsQuietAuth({
      status: quietStatus({ state, needsAuth: false, authError: '' }),
      cooldownMs: OPT_IN_MS,
      attempts: 0,
      lastAuthAt: 1_000,
      now: 1_000 + OPT_IN_MS,
    });
    assert.equal(decision.handled, false, `${state} must keep the normal probe/connect path`);
    assert.equal(decision.authorize, false);
  }
});

test('7. 可见状态：超时/拒绝/弹窗/普通断线/就绪各自映射', () => {
  assert.equal(vtsAuthPhase({ state: 'requesting-grant', authError: 'grant-timeout', needsAuth: true,
    authorizePending: true }), 'authorization-incomplete', 'timeout wins over pending');
  assert.equal(vtsAuthPhase({ state: 'token-invalid', needsAuth: true, authError: 'token-invalid' }),
    'needs-reauthorization');
  assert.equal(vtsAuthPhase({ state: 'requesting-grant', authorizePending: true, needsAuth: false }),
    'authorization-pending');
  assert.equal(vtsAuthPhase({ state: 'error', needsAuth: false }), 'reconnecting');
  assert.equal(vtsAuthPhase({ state: 'disconnected', needsAuth: false }), 'reconnecting');
  assert.equal(vtsAuthPhase({ state: 'ready', authenticated: true, needsAuth: false }), 'ready');
  assert.equal(vtsAuthPhase({ state: 'connecting', needsAuth: false }), 'connecting');
  assert.equal(vtsAuthPhase(null), 'unknown');
  assert.equal(vtsAuthPhase({ state: 'error', needsAuth: true, authError: 'token-revoked' }),
    'needs-reauthorization');
});

/** Remove comments so source-order assertions cannot match doc prose. */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/(^|[^:])\/\/[^\n\r]*/gu, '$1');

/** Extract one function body by its declaration prefix, balancing braces. */
function extractBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing declaration: ${signature}`);
  // Skip the parameter list first: a default `{}` parameter must not be mistaken for the body.
  let bodyOpen = -1;
  const paren = source.indexOf('(', start);
  if (paren >= 0) {
    let parenDepth = 0;
    for (let index = paren; index < source.length; index += 1) {
      if (source[index] === '(') parenDepth += 1;
      else if (source[index] === ')') {
        parenDepth -= 1;
        if (parenDepth === 0) {
          bodyOpen = source.indexOf('{', index + 1);
          break;
        }
      }
    }
  }
  if (bodyOpen < 0) bodyOpen = source.indexOf('{', start);
  assert.notEqual(bodyOpen, -1, `missing body: ${signature}`);
  let depth = 0;
  for (let index = bodyOpen; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unbalanced body: ${signature}`);
}

test('8. Host 接线：tick 先读 authStatus 并走静默策略，不直接 vtsConnect', async () => {
  const source = stripComments(await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8'));
  for (const name of [
    'planVtsQuietAuth',
    'VTS_AUTH_AUTO_RETRY_MS',
    'VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS',
    'VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP',
    'vtsAuthPhase',
  ]) {
    assert.ok(source.includes(name), `index.js imports/uses ${name}`);
  }

  const cooldownFn = extractBlock(source, 'const vtsAuthAutoRetryCooldownMs = () =>');
  assert.match(cooldownFn, /config\?\.avatar\?\.vtsAuthAutoRetryMs/u);
  assert.match(cooldownFn, /return VTS_AUTH_AUTO_RETRY_MS/u, 'unset uses the default (0 = OFF)');
  assert.match(cooldownFn, /value <= 0\) return 0/u, 'explicit <= 0 stays OFF');

  const maxFn = extractBlock(source, 'const vtsAuthAutoRetryMaxAttempts = () =>');
  assert.match(maxFn, /config\?\.avatar\?\.vtsAuthAutoRetryMaxAttempts/u);
  assert.match(maxFn, /VTS_AUTH_AUTO_RETRY_MAX_ATTEMPTS_CAP/u);
  assert.match(maxFn, /Math\.max\(1, value\)/u);

  const statusFn = extractBlock(source, 'const vtsAuthStatus = () =>');
  assert.match(statusFn, /authPhase: vtsAuthPhase\(status\)/u);
  assert.match(statusFn, /autoRetry: \{/u);
  assert.match(statusFn, /enabled: cooldownMs > 0/u);
  assert.match(statusFn, /attempts: vtsAuthAutoRetryAttempts/u);
  assert.match(statusFn, /inFlight: vtsAuthRetryInFlight === true/u);

  const preflight = extractBlock(source, 'const vtsAuthQuietPreflight = () =>');
  const authAt = preflight.indexOf('client.authStatus()');
  const planAt = preflight.indexOf('planVtsQuietAuth({');
  const authorizeAt = preflight.indexOf("vtsAuthorize({ reason: 'auto-retry' })");
  assert.ok(authAt >= 0, 'the tick reads client.authStatus() before deciding');
  assert.ok(planAt > authAt, 'the policy sees that projection');
  assert.ok(authorizeAt > planAt, 'only an authorize decision may call vtsAuthorize');
  assert.equal((preflight.match(/vtsAuthorize\(/gu) ?? []).length, 1, 'one auto authorize call site');
  assert.match(preflight, /decision\.handled !== true/u);
  assert.match(preflight, /decision\.authorize !== true/u);
  assert.match(preflight, /vts\.auth\.auto-retry/u);
  assert.match(preflight, /vtsAuthRetryInFlight = true/u);
  assert.match(preflight, /vtsAuthAutoRetryAttempts \+= 1/u);
  assert.ok(preflight.indexOf('vtsAuthAutoRetryAttempts += 1') < authorizeAt,
    'the budget is charged before the popup starts');
  assert.match(preflight, /finally\(\(\) => \{ vtsAuthRetryInFlight = false; \}\)/u);
  assert.equal(/vtsConnect\s*\(/u.test(preflight), false, 'the quiet path never dials vtsConnect');

  const tick = extractBlock(source, 'const runVtsAutoTick = () =>');
  const preflightAt = tick.indexOf('vtsAuthQuietPreflight()');
  const runAt = tick.indexOf('vtsAutoConnect.run()');
  assert.ok(preflightAt >= 0 && runAt > preflightAt, 'preflight runs before the probe/connect');
  assert.match(tick, /if \(quiet !== null\) return quiet;/u);
  assert.equal(/vtsConnect\s*\(/u.test(tick), false);

  const finish = extractBlock(source, 'const vtsFinishAutoAuthorize = async');
  assert.match(finish, /result\?\.ok !== true/u, 'a failed auto grant does not attach');
  assert.match(finish, /vtsAuthAutoRetryAttempts = 0/u, 'success clears the budget');
  assert.match(finish, /vtsMountRevision !== mountAt/u, 'an unmounted grant is dropped');
  assert.match(finish, /shutdown\.closing === true/u);
  assert.match(finish, /features\.enabled\('avatar'\) !== true/u);
  assert.match(finish, /vtsConnect\(\)/u, 'success reuses the ready branch for runtime attachment');
});

test('9. Host 源码：token-invalid/超时/默认关闭都先于 auto authorize 返回', async () => {
  const source = stripComments(await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8'));
  const planner = stripComments(await readFile(
    new URL('../src/host/avatar/auto-connect.js', import.meta.url),
    'utf8',
  ));
  const planFn = extractBlock(planner, 'export function planVtsQuietAuth');
  const pendingAt = planFn.indexOf("reason: 'auth-pending'");
  const timeoutAt = planFn.indexOf("reason: 'auth-incomplete'");
  const userAt = planFn.indexOf("reason: 'auth-user-action-required'");
  const disabledAt = planFn.indexOf("reason: 'auto-retry-disabled'");
  const exhaustedAt = planFn.indexOf("reason: 'auth-retry-exhausted'");
  const retryAt = planFn.indexOf("authorize: true");
  assert.ok(pendingAt >= 0 && pendingAt < retryAt);
  assert.ok(timeoutAt >= 0 && timeoutAt < retryAt);
  assert.ok(userAt >= 0 && userAt < retryAt);
  assert.ok(disabledAt >= 0 && disabledAt < retryAt);
  assert.ok(exhaustedAt >= 0 && exhaustedAt < retryAt);

  const preflight = extractBlock(source, 'const vtsAuthQuietPreflight = () =>');
  assert.match(preflight, /if \(client\.ready === true\)/u, 'ready never enters the quiet policy');
  assert.match(preflight, /planVtsQuietAuth\(\{/u);
});
