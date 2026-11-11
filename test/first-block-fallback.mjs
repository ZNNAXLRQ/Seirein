import assert from 'node:assert/strict';
import test from 'node:test';

import { planSpeechBlocks, splitFirstBlockChunks } from '../src/host/speech/tts.js';

const chars = (text) => [...String(text ?? '')].length;

test('first-block planner fallback keeps the ordinary safe splitter', (t) => {
  // 193 characters; the first safe comma is at 81, far outside the default target window, while a
  // second comma later gives the normal splitter a valid boundary.
  const text = '甲'.repeat(80) + '，' + '乙'.repeat(70) + '，' + '丙'.repeat(41);
  assert.equal(chars(text), 193);
  const firstPlan = splitFirstBlockChunks(text);
  assert.equal(firstPlan.chunked, false, 'the opening planner cannot reach the first comma');

  const chosen = planSpeechBlocks(text, { firstBlockPlan: firstPlan });
  assert.equal(chosen.usedFirstBlockPlan, false);
  assert.equal(chosen.fellBackToSafeChunks, true);
  assert.ok(chosen.blocks.length > 1, 'the ordinary safe splitter still splits the long unit');
  assert.equal(chosen.blocks.join(''), text, 'fallback is lossless');
  assert.ok(chars(chosen.blocks[0]) > 30, 'the fallback keeps the real safe boundary');
  t.diagnostic(`blocks=${chosen.blocks.map(chars).join(',')} fallback=${chosen.fellBackToSafeChunks}`);
});
