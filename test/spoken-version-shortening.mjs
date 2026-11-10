/**
 * Spoken-version shortening contract.
 *
 * The real complaint: the spoken version was almost the body (turn 43: 181→170, turn 46:
 * 343→327) while `voice.spoken.version` still said `source:'condensed', adopted:true`. The old
 * validation only rejected a candidate LONGER than the body, and the guide only said "length is a
 * result"; nothing executed that rule.
 *
 * This file pins the new pure policy:
 *   1. a long body has a SOFT 40–65% target and a >85% too-long gate;
 *   2. a valid but near-copy candidate triggers ONE stronger retry (blocking/typed lanes), and a
 *      still-long retry is adopted with `tooLong:true` instead of being reported as clean;
 *   3. explicit "详细/完整列举" rounds are exempt: no target, no retry, no too-long flag;
 *   4. the text-free recent-N ledger carries bodyChars/spokenChars/ratio/savedChars/truncated/
 *      tooLong/reason for direct before/after comparison, never the full body or spoken text;
 *   5. the prompt itself carries the soft target and the stronger retry instruction.
 *
 * Run: node --test test/spoken-version-shortening.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  createSpokenVersionLedger,
  evaluateSpokenVersion,
  requestsDetailedSpoken,
  spokenVersionMetrics,
  spokenVersionTargetChars,
  spokenVersionVerdict,
  SPOKEN_TARGET_MAX_RATIO,
  SPOKEN_TARGET_MIN_RATIO,
  SPOKEN_TOO_LONG_MIN_BODY,
  SPOKEN_TOO_LONG_RATIO,
} from '../src/host/speech/spokenPipeline.js';

const guideSource = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');

test('1. a long body gets a soft 40–65% target; a 45% rewrite is in-target and not too long', (t) => {
  const body = '正'.repeat(200);
  const spoken = '口'.repeat(90);
  const metrics = spokenVersionMetrics({ bodyText: body, spokenText: spoken });
  assert.equal(metrics.bodyChars, 200);
  assert.equal(metrics.spokenChars, 90);
  assert.equal(metrics.ratio, 0.45);
  assert.equal(metrics.savedChars, 110);
  assert.equal(metrics.targetApplies, true);
  assert.equal(metrics.targetMin, 80);
  assert.equal(metrics.targetMax, 130);
  assert.equal(metrics.inTarget, true);
  assert.equal(metrics.shortened, true);
  assert.equal(metrics.truncationSource, 'none');
  assert.equal(metrics.tooLong, false);
  assert.equal(metrics.reason, '');
  assert.deepEqual(spokenVersionTargetChars(200), {
    bodyChars: 200, min: 80, max: 130,
    minRatio: SPOKEN_TARGET_MIN_RATIO, maxRatio: SPOKEN_TARGET_MAX_RATIO,
  });
  assert.deepEqual(spokenVersionTargetChars(181), {
    bodyChars: 181, min: 72, max: 118,
    minRatio: SPOKEN_TARGET_MIN_RATIO, maxRatio: SPOKEN_TARGET_MAX_RATIO,
  });
  assert.equal(spokenVersionTargetChars(SPOKEN_TOO_LONG_MIN_BODY), null,
    'a body at/below the long-body threshold gets no target');
  assert.equal(spokenVersionTargetChars(300, { explicitDetail: true }), null,
    'a detail request gets no target');
  t.diagnostic(`ratio=${metrics.ratio} target=${metrics.targetMin}-${metrics.targetMax} inTarget=${metrics.inTarget}`);
});

test('2. a near-copy (181→170, the real turn-43 shape) triggers exactly one retry, then reports too-long', (t) => {
  const body = '正'.repeat(181);
  const near = '口'.repeat(170);
  const first = evaluateSpokenVersion({ bodyText: body, spokenText: near, attempt: 1, maxAttempts: 2 });
  assert.equal(first.ratio, 0.939);
  assert.equal(first.savedChars, 11);
  assert.equal(first.tooLong, true);
  assert.equal(first.reason, 'too-long');
  assert.equal(first.retry, true);
  assert.equal(first.verdict, 'retry-too-long');

  const finalAttempt = evaluateSpokenVersion({ bodyText: body, spokenText: near, attempt: 2, maxAttempts: 2 });
  assert.equal(finalAttempt.retry, false, 'at most one retry');
  assert.equal(finalAttempt.tooLong, true);
  assert.equal(finalAttempt.shortened, false);
  assert.equal(finalAttempt.verdict, 'adopted-unchanged');

  const improved = evaluateSpokenVersion({
    bodyText: body, spokenText: '口'.repeat(110), attempt: 2, maxAttempts: 2,
  });
  assert.equal(improved.tooLong, false);
  assert.equal(improved.retry, false);
  assert.equal(improved.shortened, true);
  assert.equal(improved.verdict, 'adopted-shortened');
  assert.equal(improved.savedChars, 71);

  // The real turn-45 shape: 137→134 is only 3 chars shorter; it must not pass as clean.
  const turn45 = evaluateSpokenVersion({
    bodyText: '正'.repeat(137), spokenText: '口'.repeat(134), attempt: 1, maxAttempts: 2,
  });
  assert.equal(turn45.ratio, 0.978);
  assert.equal(turn45.savedChars, 3);
  assert.equal(turn45.tooLong, true);
  assert.equal(turn45.retry, true);
  t.diagnostic(
    `first ratio=${first.ratio} retry=${first.retry}; final tooLong=${finalAttempt.tooLong}; `
    + `improved ratio=${improved.ratio} saved=${improved.savedChars}; turn45 ratio=${turn45.ratio} retry=${turn45.retry}`,
  );
});

test('3. an explicit detail / complete-enumeration request is exempt; negated detail is not', (t) => {
  assert.equal(requestsDetailedSpoken('把要点逐条完整列举'), true);
  assert.equal(requestsDetailedSpoken('详细说明一下'), true);
  assert.equal(requestsDetailedSpoken('全部列出来'), true);
  assert.equal(requestsDetailedSpoken('不要省略，详细说'), true);
  assert.equal(requestsDetailedSpoken('别省略，逐条列'), true);
  assert.equal(requestsDetailedSpoken('简单说说'), false);
  assert.equal(requestsDetailedSpoken('推荐哪个'), false);
  assert.equal(requestsDetailedSpoken('不详细说，直接给结论'), false);
  assert.equal(requestsDetailedSpoken('不用详细，短一点'), false);
  assert.equal(requestsDetailedSpoken('不用说得太详细'), false);
  assert.equal(requestsDetailedSpoken('不必太详细'), false);

  const metrics = spokenVersionMetrics({
    bodyText: '正'.repeat(343),
    spokenText: '口'.repeat(327),
    explicitDetail: true,
  });
  assert.equal(metrics.ratio, 0.953);
  assert.equal(metrics.targetApplies, false);
  assert.equal(metrics.tooLong, false, 'a requested detailed version is allowed to stay long');
  assert.equal(metrics.shortened, false, '327/343 is not a successful compression');
  assert.equal(metrics.reason, 'explicit-detail');
  const evaluation = evaluateSpokenVersion({
    bodyText: '正'.repeat(343), spokenText: '口'.repeat(327), explicitDetail: true,
    attempt: 1, maxAttempts: 2,
  });
  assert.equal(evaluation.retry, false);
  assert.equal(evaluation.verdict, 'explicit-detail');
  t.diagnostic(`detail ratio=${metrics.ratio} targetApplies=${metrics.targetApplies} tooLong=${metrics.tooLong} negatedDetail=notExempt`);
});

test('4. recent-N ledger keeps only metrics and is readable for comparison', (t) => {
  const ledger = createSpokenVersionLedger({ limit: 3 });
  for (let turn = 1; turn <= 5; turn += 1) {
    ledger.record({
      turn,
      purpose: 'answer',
      replyVersion: 1,
      source: 'condensed',
      bodyChars: 200,
      spokenChars: 80 + turn,
      ratio: (80 + turn) / 200,
      savedChars: 120 - turn,
      truncated: turn === 5,
      truncationSource: turn === 5 ? 'model' : 'none',
      shortened: turn !== 5,
      tooLong: false,
      reason: '',
      retried: turn > 1,
      verdict: turn === 5 ? 'adopted-unchanged' : 'adopted-shortened',
      ms: turn * 10,
      at: 1_700_000_000_000 + turn,
    });
  }
  const recent = ledger.recent();
  assert.equal(recent.length, 3, 'bounded by limit');
  assert.deepEqual(recent.map((row) => row.turn), [3, 4, 5], 'oldest first, only the last N');
  const last = recent.at(-1);
  for (const field of [
    'bodyChars', 'spokenChars', 'ratio', 'savedChars', 'truncated', 'truncationSource',
    'shortened', 'tooLong', 'reason',
  ]) {
    assert.equal(field in last, true, `recent row carries ${field}`);
  }
  assert.equal(last.truncated, true);
  assert.equal(last.truncationSource, 'model');
  assert.equal(last.shortened, false);
  assert.equal(last.savedChars, 115);
  assert.equal('bodyText' in last, false);
  assert.equal('spokenText' in last, false);
  assert.equal('text' in last, false);
  assert.deepEqual(ledger.snapshot(), { limit: 3, count: 3, recent });
  t.diagnostic(`recentTurns=${recent.map((row) => row.turn).join(',')} rowsTextFree=yes`);
});

test('5. the prompt carries the soft target and one stronger shortening retry', (t) => {
  const guideStart = guideSource.indexOf('const SPOKEN_VERSION_GUIDE = `');
  const guideEnd = guideSource.indexOf('`;', guideStart);
  assert.notEqual(guideStart, -1, 'SPOKEN_VERSION_GUIDE is declared');
  assert.notEqual(guideEnd, -1, 'SPOKEN_VERSION_GUIDE is a template literal');
  const guide = guideSource.slice(guideStart, guideEnd);

  for (const marker of [
    '正文超过 120 字',
    '40%–65%',
    '不是硬截断',
    '否定、条件、数字、时间、风险',
    '用户本轮明确要求详细、完整列举或全部朗读',
    '不在句子中间截断',
    '宁可略长',
  ]) {
    assert.ok(guide.includes(marker), `guide carries "${marker}"`);
  }
  assert.ok(guideSource.includes('【本次长度参考】'), 'the request carries a per-body length hint');
  assert.ok(guideSource.includes('【更强缩短重试】'), 'the retry instruction exists');
  assert.ok(guideSource.includes('SPOKEN_VERSION_MAX_ATTEMPTS'), 'the retry stays bounded');
  assert.ok(!guide.includes('硬性上限'), 'the target is soft, never a hard cap');
  t.diagnostic(`guideChars=${guide.length} softTarget=40-65 retry=one`);
});

test('6. a shortened sample keeps the key facts and ends naturally', (t) => {
  const body = '结论：不要直接重装系统。当前错误码是 0x80070005，过去 24 小时出现了 3 次。下一步是明早 9 点前备份。'.repeat(3);
  const spoken = '结论：不要直接重装系统。错误码 0x80070005，24 小时内出现 3 次，明早 9 点前先备份。';
  const metrics = spokenVersionMetrics({ bodyText: body, spokenText: spoken });
  assert.ok(metrics.ratio < SPOKEN_TARGET_MAX_RATIO + 0.05, `ratio=${metrics.ratio} is much shorter`);
  assert.equal(metrics.tooLong, false);
  for (const fact of ['不要', '0x80070005', '3 次', '明早 9 点']) {
    assert.ok(spoken.includes(fact), `the shortened sample keeps "${fact}"`);
  }
  assert.ok(spoken.endsWith('。'), 'the short version ends at a natural sentence close');
  t.diagnostic(`body=${metrics.bodyChars} spoken=${metrics.spokenChars} ratio=${metrics.ratio} factsKept=4`);
});

test('7. empty/short bodies and the truncated flag stay honest', (t) => {
  const empty = spokenVersionMetrics({ bodyText: '', spokenText: '任意' });
  assert.equal(empty.ratio, null, 'no ratio without a body');
  assert.equal(empty.targetApplies, false);
  assert.equal(empty.tooLong, false);
  const short = spokenVersionMetrics({ bodyText: '现在三点。', spokenText: '现在三点。', source: 'original' });
  assert.equal(short.ratio, 1);
  assert.equal(short.tooLong, false, 'the short-reply skip rule is unchanged');
  const truncated = spokenVersionMetrics({
    bodyText: '正'.repeat(200), spokenText: '口'.repeat(60), truncated: true,
    truncationSource: 'model',
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.truncationSource, 'model');
  assert.equal(truncated.shortened, true);
  const budgetCut = spokenVersionMetrics({
    bodyText: '正'.repeat(200), spokenText: '口'.repeat(60), truncated: true,
    truncationSource: 'budget',
  });
  assert.equal(budgetCut.truncationSource, 'budget', 'the playback budget is distinguishable');
  const logOnly = spokenVersionMetrics({
    bodyText: '正'.repeat(200), spokenText: '口'.repeat(60), truncated: false,
    truncationSource: 'log',
  });
  assert.equal(logOnly.truncated, false);
  assert.equal(logOnly.truncationSource, 'none', 'the 200-char log copy never truncates the version');
  const fallback = spokenVersionMetrics({
    bodyText: '正'.repeat(200), spokenText: '正'.repeat(200), source: 'full-fallback',
  });
  assert.equal(fallback.tooLong, false, 'a full fallback is not a "too-long adoption"');
  assert.equal(fallback.shortened, false);
  assert.equal(spokenVersionVerdict(fallback), 'fallback-full');
  assert.equal(SPOKEN_TOO_LONG_RATIO, 0.85);
  t.diagnostic(`emptyRatio=${empty.ratio} shortTooLong=${short.tooLong} fallbackVerdict=fallback-full truncation=model/budget/log`);
});
