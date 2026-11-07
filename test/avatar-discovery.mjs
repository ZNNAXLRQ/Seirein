/**
 * P-55 — capability discovery must be bound to the model/connection it probed.
 *
 * The bug: `discoverCapabilities()` had one module cache (no model key) and the host kept a single
 * in-flight promise. A discovery for model A that resolved after a switch to B then overwrote the
 * new model's map — and `force` even joined A's pending promise, so B could never be discovered.
 *
 * Pinned here (all deterministic, no VTS):
 *   1. A in flight → switch to B → A resolves late → dropped, B's map adopted;
 *   2. duplicate calls for one identity share one promise (one request);
 *   3. force joins an in-flight request of the same identity, but a different identity is a new
 *      request even while the first is pending;
 *   4. the cache is keyed by model/connection identity (B never reads A's map);
 *   5. disconnect/disable (current identity null) drops the in-flight result and writes no cache.
 *
 * Run: node test/avatar-discovery.mjs
 */
import { discoverCapabilities, cachedCapabilities, resetCapabilities, snapshot } from '../src/host/avatar/avatarMotion.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Model A exposes head + mouth; model B only mouth: their maps are distinguishable. */
const POOL_A = {
  defaultParameters: [
    { name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 },
    { name: 'FaceAngleX', min: -30, max: 30, defaultValue: 0 },
  ],
  customParameters: [],
};
const POOL_B = {
  defaultParameters: [{ name: 'MouthOpen', min: 0, max: 1, defaultValue: 0 }],
  customParameters: [],
};

const IDENTITY_A = { modelId: 'model-A', modelGeneration: 0, connectionGeneration: 0 };
const IDENTITY_B = { modelId: 'model-B', modelGeneration: 1, connectionGeneration: 0 };
/** Same model/connection, but a different identity object (and generation) after a reconnect. */
const IDENTITY_A2 = { modelId: 'model-A', modelGeneration: 1, connectionGeneration: 1 };

let events = [];
const log = {
  emit: async (type, payload) => {
    events.push({ type, payload: payload ?? {} });
  },
};
const eventsOf = (type, modelId) => events.filter((event) => event.type === type
  && (modelId === undefined || event.payload.modelId === modelId));
const resetAll = () => {
  resetCapabilities();
  events = [];
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1) The original failure: A's late answer must not become the map of B.
test('1. A 在途 → 切 B → A 迟到被丢弃，B 结果被采用', async () => {
  resetAll();
  const gateA = deferred();
  const calls = { A: 0, B: 0 };
  let current = IDENTITY_A;

  const pendingA = discoverCapabilities({
    identity: IDENTITY_A,
    currentIdentity: () => current,
    log,
    listInputParameters: () => {
      calls.A += 1;
      return gateA.promise;
    },
  });
  // The model is switched while A's InputParameterListRequest is still unanswered.
  current = IDENTITY_B;
  const resultB = await discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    log,
    listInputParameters: async () => {
      calls.B += 1;
      return POOL_B;
    },
  });
  gateA.resolve(POOL_A);
  const resultA = await pendingA;

  const dropped = eventsOf('avatar.discovery.dropped');
  console.log(`  [1] requests A=${calls.A} B=${calls.B} A.stale=${resultA.stale} B.mapped=${resultB.mapped.join(',')}`
    + ` dropped=${dropped.length} droppedModel=${dropped[0]?.payload.modelId} cacheA=${cachedCapabilities(IDENTITY_A) === null ? 'null' : 'present'}`);

  if (resultA.stale !== true) throw new Error('A result was not marked stale');
  if (cachedCapabilities(IDENTITY_A) !== null) throw new Error('A wrote its map to the cache after the switch');
  if (cachedCapabilities(IDENTITY_B)?.mapped.join(',') !== 'mouth') throw new Error('B did not adopt its own map');
  if (snapshot().mapped.includes('headX')) throw new Error('the stale A map (headX) is the current snapshot');
  if (dropped.length !== 1
    || dropped[0].payload.reason !== 'stale-identity'
    || dropped[0].payload.modelId !== 'model-A') {
    throw new Error(`avatar.discovery.dropped is wrong: ${JSON.stringify(dropped)}`);
  }
  if (eventsOf('avatar.discovery.done', 'model-A').length !== 0) throw new Error('a dropped result emitted done');
  if (eventsOf('avatar.discovery.done', 'model-B').length !== 1) throw new Error('B did not emit done');
  if (eventsOf('avatar.discovery.start', 'model-A').length !== 1) throw new Error('A did not emit start');
});

// 2) Same identity + concurrent calls: one promise, one request.
test('2. 同一模型重复调用 → 复用同一 promise（只发一次请求）', async () => {
  resetAll();
  const gate = deferred();
  let calls = 0;
  const list = () => {
    calls += 1;
    return gate.promise;
  };
  const identity = { ...IDENTITY_A };
  const first = discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    log,
    listInputParameters: list,
  });
  const second = discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    log,
    listInputParameters: list,
  });
  const same = first === second;
  gate.resolve(POOL_A);
  const [left, right] = await Promise.all([first, second]);
  const cached = await discoverCapabilities({
    identity,
    currentIdentity: () => identity,
    log,
    listInputParameters: list,
  });

  console.log(`  [2] samePromise=${same} requests=${calls} sameResult=${left === right}`
    + ` cached=${cached.fromCache === true} mapped=${cached.mapped.join(',')}`);

  if (!same) throw new Error('duplicate calls did not share the exact in-flight promise');
  if (left !== right) throw new Error('the shared promise did not resolve to one result');
  if (calls !== 1) throw new Error(`expected 1 request, saw ${calls}`);
  if (cached.fromCache !== true) throw new Error('the completed map was not served from the cache');
  if (calls !== 1) throw new Error('the cache hit triggered another request');
});

// 3) force never joins a different identity, but does join its own in-flight request.
test('3. force 与在途同身份 → 仍复用；不同身份 → 新请求', async () => {
  resetAll();
  let current = IDENTITY_A;
  const gateA = deferred();
  const gateB = deferred();
  const calls = { A: 0, B: 0 };

  const pendingA = discoverCapabilities({
    identity: IDENTITY_A,
    currentIdentity: () => current,
    log,
    listInputParameters: () => {
      calls.A += 1;
      return gateA.promise;
    },
  });
  const forcedSame = discoverCapabilities({
    identity: IDENTITY_A,
    currentIdentity: () => current,
    force: true,
    log,
    listInputParameters: () => {
      calls.A += 1;
      return gateA.promise;
    },
  });
  // A different identity must start its own request even though A is still pending.
  current = IDENTITY_B;
  const pendingB = discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    force: true,
    log,
    listInputParameters: () => {
      calls.B += 1;
      return gateB.promise;
    },
  });
  const forcedBSame = discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    force: true,
    log,
    listInputParameters: () => {
      calls.B += 1;
      return gateB.promise;
    },
  });

  gateA.resolve(POOL_A);
  gateB.resolve(POOL_B);
  const [resultA, resultB] = await Promise.all([forcedSame, forcedBSame]);

  console.log(`  [3] forceSamePromise=${forcedSame === pendingA} forceBSamePromise=${forcedBSame === pendingB}`
    + ` requests A=${calls.A} B=${calls.B} A.stale=${(await pendingA).stale} B.mapped=${resultB.mapped.join(',')}`);

  if (forcedSame !== pendingA) throw new Error('force did not reuse the same-identity in-flight promise');
  if (forcedBSame !== pendingB) throw new Error('force did not reuse B\'s in-flight promise');
  if (calls.A !== 1 || calls.B !== 1) throw new Error(`unexpected request counts A=${calls.A} B=${calls.B}`);
  if (resultB.mapped.join(',') !== 'mouth') throw new Error('B was not adopted');
  if ((await pendingA).stale !== true) throw new Error('A did not drop after the identity changed');
});

// 4) The cache is keyed by identity, so B can never read A's completed map.
test('4. 缓存：A 完成后切 B → B 不命中 A 的缓存（重新发现）', async () => {
  resetAll();
  let current = IDENTITY_A;
  let calls = 0;
  const list = async (pool) => {
    calls += 1;
    return pool;
  };

  const resultA = await discoverCapabilities({
    identity: IDENTITY_A,
    currentIdentity: () => current,
    log,
    listInputParameters: () => list(POOL_A),
  });
  current = IDENTITY_B;
  const resultB = await discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    log,
    listInputParameters: () => list(POOL_B),
  });
  const afterB = calls;
  const cachedB = await discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    log,
    listInputParameters: () => list(POOL_B),
  });
  const afterCacheHit = calls;
  // Dropping B's entry must force a fresh probe for B, not resurrect A.
  resetCapabilities(IDENTITY_B);
  const resultB2 = await discoverCapabilities({
    identity: IDENTITY_B,
    currentIdentity: () => current,
    log,
    listInputParameters: () => list(POOL_B),
  });

  console.log(`  [4] requests A/B=${afterB} cacheHitB=${cachedB.fromCache === true}`
    + ` B.mapped=${resultB.mapped.join(',')} afterInvalidate=${calls === afterCacheHit + 1}`
    + ` cacheA=${cachedCapabilities(IDENTITY_A) !== null ? 'present' : 'null'}`
    + ` A.mapped=${resultA.mapped.join(',')} B2.mapped=${resultB2.mapped.join(',')}`);

  if (resultA.mapped.includes('headX') !== true) throw new Error('A did not map headX');
  if (afterB !== 2) throw new Error(`B reused A's cache (requests=${afterB})`);
  if (resultB.mapped.includes('headX')) throw new Error('B\'s map was A\'s');
  if (cachedB.fromCache !== true || afterCacheHit !== afterB) throw new Error('B\'s completed map was not cached');
  if (calls !== afterCacheHit + 1) throw new Error('invalidating B did not force a fresh probe');
  if (cachedCapabilities(IDENTITY_A) === null) throw new Error('invalidating B also dropped A unnecessarily');
});

// 5) Disconnect / component disable: the current identity is null, so nothing may commit.
test('5. 停用/断开 → 在途结果被丢弃，不写缓存', async () => {
  resetAll();
  const gate = deferred();
  let current = IDENTITY_A;
  let calls = 0;

  const pending = discoverCapabilities({
    identity: IDENTITY_A,
    currentIdentity: () => current,
    log,
    listInputParameters: () => {
      calls += 1;
      return gate.promise;
    },
  });
  // Disable / socket loss: no usable identity until a new connection generation appears.
  current = null;
  gate.resolve(POOL_A);
  const result = await pending;

  const dropped = eventsOf('avatar.discovery.dropped');
  console.log(`  [5] requests=${calls} stale=${result.stale} cache=${cachedCapabilities(IDENTITY_A) === null ? 'null' : 'present'}`
    + ` snapshotDiscovered=${snapshot().discovered} dropped=${dropped.length} done=${eventsOf('avatar.discovery.done').length}`);

  if (result.stale !== true) throw new Error('the result committed while disconnected');
  if (cachedCapabilities(IDENTITY_A) !== null) throw new Error('a disconnected result was cached');
  if (snapshot().discovered !== false) throw new Error('the stale map is the current snapshot');
  if (dropped.length !== 1) throw new Error('no dropped event for the disconnected result');
  if (eventsOf('avatar.discovery.done').length !== 0) throw new Error('a disconnected result emitted done');
  // A later connection is a new identity: its discovery starts from scratch (no stale cache hit).
  const calledBefore = calls;
  current = IDENTITY_A2;
  await discoverCapabilities({
    identity: IDENTITY_A2,
    currentIdentity: () => current,
    log,
    listInputParameters: async () => {
      calls += 1;
      return POOL_A;
    },
  });
  if (calls !== calledBefore + 1) throw new Error('the reconnected identity did not probe again');
});

const failures = [];
for (const entry of tests) {
  const started = Date.now();
  try {
    await entry.fn();
    console.log(`PASS  ${entry.name}  (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name: entry.name, error });
    console.error(`FAIL  ${entry.name}\n      ${error?.message ?? error}`);
  }
}

console.log(`\n${tests.length - failures.length} passed, ${failures.length} failed, ${tests.length} total`);
if (failures.length > 0) process.exitCode = 1;
