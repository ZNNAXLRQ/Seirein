/**
 * Loopback 10 s fallback endpoint (rule 3).
 *
 * The system-sound lane has no natural speaker pauses, so the shipping 20 s maximum-utterance rule
 * is too long: one loopback final can then cover a whole scene. Only the loopback `startHearing`
 * call may tighten `rule3MinUtteranceLength` to 10 s. The microphone call, the shipping defaults and
 * the natural trailing-silence rules stay exactly as they were.
 *
 * The check is source/config level on purpose: it needs no audio device, recognizer or model. It
 * also pins the option name (`endpointRules`, the seam `startHearing` really destructures) so the
 * override can never silently become dead config.
 *
 * Run: node --test test/ambient-endpoint-10s.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HOST_SOURCE = await readFile(new URL('../src/host/index.js', import.meta.url), 'utf8');
const HEARING_SOURCE = await readFile(new URL('../src/host/hearing/hearing.js', import.meta.url), 'utf8');

/**
 * Extract one balanced `{...}` object literal starting at the first `{` after `marker`.
 *
 * Quotes and comments are skipped so punctuation inside them cannot unbalance the scan; template
 * interpolations are skipped with their template (their braces are balanced anyway).
 */
function extractObject(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `call site exists: ${marker}`);
  const call = source.indexOf('startHearing(', at);
  assert.ok(call >= 0, `startHearing call follows: ${marker}`);
  const open = source.indexOf('{', call);
  assert.ok(open >= 0, `object literal follows: ${marker}`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== '') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  assert.fail(`unterminated object literal after: ${marker}`);
}

const microphone = extractObject(HOST_SOURCE, 'spawn: ({ device }) => (device ? startHearing({');
const loopback = extractObject(HOST_SOURCE, 'return startHearing({');
assert.notEqual(microphone, loopback, 'the two call sites are distinct');

// ---------------------------------------------------------------------------
// 1. The loopback lane asks for the 10 s rule-3 fallback (and nothing else)
// ---------------------------------------------------------------------------

test('1. loopback startHearing passes rule3MinUtteranceLength: 10 and no other endpoint override', () => {
  assert.match(
    loopback,
    /endpointRules:\s*\{[^}]*\brule3MinUtteranceLength:\s*10\b[^}]*\}/,
    'the loopback session carries the 10 s rule-3 override',
  );
  assert.doesNotMatch(loopback, /\brule1MinTrailingSilence\s*:|\brule2MinTrailingSilence\s*:/,
    'natural trailing-silence rules stay at their shipping values');
  assert.doesNotMatch(loopback, /\bendpoint\s*:/,
    'no bare `endpoint:` alias: startHearing only destructures `endpointRules`, so that would be dead config');
  assert.match(loopback, /endpointProbe:/, 'the loopback call is the real ambient session');
});

// ---------------------------------------------------------------------------
// 2. The microphone lane never inherits the loopback fallback
// ---------------------------------------------------------------------------

test('2. microphone startHearing does not pass the 10 s rule-3 override', () => {
  assert.doesNotMatch(microphone, /\bendpointRules\b/,
    'the microphone lane passes no endpoint-rule override');
  assert.doesNotMatch(microphone, /\brule3MinUtteranceLength\b/,
    'the microphone lane never imports the loopback 10 s cap');
  assert.doesNotMatch(microphone, /\bendpoint\s*:/,
    'the microphone lane passes no bare endpoint option either');
  assert.match(microphone, /isVoicePlaying:/, 'the microphone call is the real capture session');
});

// ---------------------------------------------------------------------------
// 3. The override is effective: hearing accepts `endpointRules` and forwards it
// ---------------------------------------------------------------------------

test('3. hearing destructures endpointRules and forwards it to the recognizer', () => {
  assert.match(HEARING_SOURCE, /endpointRules = null/,
    'startHearing exposes the endpointRules seam used by the loopback call');
  assert.match(HEARING_SOURCE, /endpoint:\s*endpointRules\s*\?\?\s*\{\}/,
    'the override reaches createRecognizer instead of being ignored');
});

// ---------------------------------------------------------------------------
// 4. Shipping endpoint defaults and the existing endpoint contract are untouched
// ---------------------------------------------------------------------------

test('4. shipping endpoint rules and overrides keep their existing behaviour', async () => {
  const { DEFAULT_ENDPOINT_RULES, resolveEndpointRules } = await import('../src/host/hearing/hearing.js');
  // The same contract test/endpoint-sweep.mjs pins: the loopback override must not change it.
  assert.deepEqual(DEFAULT_ENDPOINT_RULES, {
    rule1MinTrailingSilence: 3.0,
    rule2MinTrailingSilence: 1.8,
    rule3MinUtteranceLength: 20,
  });
  assert.deepEqual(resolveEndpointRules(), DEFAULT_ENDPOINT_RULES);
  assert.deepEqual(resolveEndpointRules({}), DEFAULT_ENDPOINT_RULES);
  // The loopback config changes only rule 3; natural endpoints (rules 1/2) are unchanged.
  assert.deepEqual(resolveEndpointRules({ rule3MinUtteranceLength: 10 }), {
    ...DEFAULT_ENDPOINT_RULES,
    rule3MinUtteranceLength: 10,
  });
  assert.deepEqual(resolveEndpointRules({ rule2MinTrailingSilence: 0.3 }), {
    ...DEFAULT_ENDPOINT_RULES,
    rule2MinTrailingSilence: 0.3,
  });
  assert.deepEqual(resolveEndpointRules({ rule1MinTrailingSilence: 'nope' }), DEFAULT_ENDPOINT_RULES);
});
