/**
 * Static regression for the ASR cutpoint fixture (no model, no TTS, no ffmpeg).
 *
 * It proves the committed fixture is internally consistent and that the base version really puts
 * both marker words across the 15 s / 30 s cuts — otherwise `tools/asr-cutpoint-check.mjs` would
 * be measuring a pause instead of a word and could report a misleading PASS.
 *
 * Run: node --test test/asr-cutpoint.mjs
 * Regenerate the fixture with: node tools/asr-cutpoint-fixture.mjs
 *
 * The .wav takes are generated and gitignored, so a fresh clone only carries the manifest: the
 * WAV validation skips (per file) instead of failing. Every manifest-only check still runs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'asr-cutpoint');
const MANIFEST = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));

/** Minimal 16 kHz mono 16-bit PCM WAV reader. */
function readWav(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF', 'RIFF magic');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE', 'WAVE magic');
  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
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
      dataStart = body;
      dataLength = Math.min(size, buffer.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  assert.ok(fmt, 'fmt chunk');
  assert.ok(dataStart >= 0, 'data chunk');
  return { ...fmt, dataLength, durationMs: Math.round((dataLength / (2 * fmt.channels) / fmt.sampleRate) * 1000) };
}

const versions = MANIFEST.versions;
const base = versions.find((version) => version.offsetMs === 0 && version.trimMs === 0);

test('manifest describes a 15 s fixture with the required offset versions', () => {
  assert.equal(MANIFEST.kind, 'asr-cutpoint-fixture');
  assert.equal(MANIFEST.decodeCapSec, 15);
  assert.deepEqual(MANIFEST.cutPointsMs, [15000, 30000]);
  assert.equal(MANIFEST.synthetic, true, 'the set is TTS-only and must say so');
  assert.ok(MANIFEST.expectedText.length > 50, 'expected transcript is present');
  assert.ok(MANIFEST.disclaimer.includes('真人录音'), 'limitations are recorded in the manifest');

  const names = versions.map((version) => version.name);
  for (const required of ['offset-0.0', 'offset-0.3', 'offset-0.6', 'offset-0.9', 'trim-0.45']) {
    assert.ok(names.includes(required), `missing version ${required}`);
  }
  assert.ok(base, 'a zero-offset base version exists');
  assert.equal(versions.length, 5);
});

test('every version keeps the expected transcript and a valid 16 kHz mono WAV', (t) => {
  for (const version of versions) {
    assert.equal(version.expectedText, MANIFEST.expectedText, `${version.name} keeps the expected text`);
    const file = join(DIR, version.file);
    // The .wav files are generated (gitignored), so a fresh clone has only the manifest. Skip
    // instead of failing; checking per file means one missing take does not hide the others.
    if (!existsSync(file)) {
      t.skip(`fixture missing: ${version.file}; rebuild with node tools/asr-cutpoint-fixture.mjs`);
      return;
    }
    const buffer = readFileSync(file);
    const wav = readWav(buffer);
    assert.equal(wav.format, 1, 'PCM');
    assert.equal(wav.channels, 1, `${version.name} mono`);
    assert.equal(wav.sampleRate, 16000, `${version.name} 16 kHz`);
    assert.equal(wav.bitsPerSample, 16, `${version.name} 16-bit`);
    assert.equal(wav.durationMs, version.durationMs, `${version.name} duration matches manifest`);
    assert.equal(buffer.length, version.bytes, `${version.name} byte size matches manifest`);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), version.sha256, `${version.name} checksum`);
    assert.ok(buffer.length < 2 * 1024 * 1024, `${version.name} stays under 2 MiB`);
  }
});

test('the base version puts both marker words across a real cut point', () => {
  assert.equal(base.markers.length, 2);
  for (const marker of base.markers) {
    assert.equal(marker.relation, 'cross', `${marker.text} crosses its cut`);
    assert.equal(marker.crosses, true);
    assert.ok(marker.marginBeforeMs >= 40, `${marker.text} has voiced audio before the cut`);
    assert.ok(marker.marginAfterMs >= 40, `${marker.text} has voiced audio after the cut`);
    // -30 dBFS is well above silence: the cut is inside a syllable, not in an inter-word pause.
    assert.ok(Math.max(marker.cutEnergyDb.before, marker.cutEnergyDb.after) > -35, `${marker.text} cut is voiced`);
    const expectedCut = marker.key === 'marker1' ? 15000 : 30000;
    assert.equal(marker.cutMs, expectedCut);
  }
});

test('offset versions shift the same words before/after the cut, as declared', () => {
  const baseByKey = new Map(base.markers.map((marker) => [marker.key, marker]));
  for (const version of versions) {
    for (const marker of version.markers) {
      const baseMarker = baseByKey.get(marker.key);
      const shift = marker.measuredRangeMs[0] - baseMarker.measuredRangeMs[0];
      assert.ok(Math.abs(shift - version.shiftMs) <= 20, `${version.name}/${marker.key} shifts by ${version.shiftMs} ms (got ${shift})`);
      if (version === base) continue;
      assert.equal(marker.crosses, false, `${version.name}/${marker.key} must not cross`);
    }
  }
  assert.ok(versions.filter((version) => version.offsetMs > 0).every((version) => version.markers.every((marker) => marker.relation === 'after')));
  const trimmed = versions.find((version) => version.name === 'trim-0.45');
  assert.ok(trimmed.markers.every((marker) => marker.relation === 'before'), 'the trim control moves words before the cut');
});

test('expected text carries every thing the check compares', () => {
  const text = MANIFEST.expectedText;
  for (const fragment of ['第三十七号房间不是四十二号', '一万二千五百', '非常非常重要，非常非常重要', '全部内容']) {
    assert.ok(text.includes(fragment), `expected text contains ${fragment}`);
  }
  for (const marker of MANIFEST.checks.markers) assert.ok(text.includes(marker), `expected text contains marker ${marker}`);
  assert.deepEqual(MANIFEST.checks.numbers, [37, 42, 12500, 37, 12500]);
  assert.equal(MANIFEST.checks.negation, '不是');
  assert.equal(MANIFEST.checks.veryCount, 5);
});
