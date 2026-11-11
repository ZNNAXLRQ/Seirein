import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSpeechLevels } from '../src/host/avatar/motion-controller.js';

const range = (levels) => ({ min: Math.min(...levels), max: Math.max(...levels) });

test('text mouth envelope is smaller and keeps vowel/openness contrast', () => {
  const japanese = buildSpeechLevels('あいうえお', 1000, 100);
  const j = range(japanese);
  assert.ok(j.max <= 0.6, `Japanese mouth stays below full open (${j.max})`);
  assert.ok(j.max - j.min >= 0.12, `kana vowel rows differ (${j.min}..${j.max})`);

  const chinese = buildSpeechLevels('你好，世界！', 1000, 100);
  const c = range(chinese);
  assert.ok(c.max <= 0.45, `Han fallback stays narrow (${c.max})`);
  assert.ok(c.min < c.max, 'punctuation/characters are not one constant aperture');
});

test('punctuation closes the aperture and empty text stays closed', () => {
  const levels = buildSpeechLevels('あ。', 1000, 100);
  assert.ok(levels.some((value) => value <= 0.1), `punctuation has a near-closed slice (${levels})`);
  assert.deepEqual(buildSpeechLevels('', 300, 100), [0, 0, 0]);
});
