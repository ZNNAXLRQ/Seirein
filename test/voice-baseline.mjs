import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('baseline counts pairs outside the statistics window as paired', () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-baseline-'));
  const file = join(root, 'events.jsonl');
  const rows = [];
  for (let index = 0; index < 7; index += 1) {
    const deliveryMessageId = `delivery-${index}`;
    const common = { sessionId: 'session', deliveryMessageId };
    rows.push({
      type: 'voice.pipeline.timeline',
      payload: { ...common, bodyReadyMs: 1000, firstAudioMs: 2000, firstChunkSynthMs: 1800 },
    });
    rows.push({ type: 'voice.latency', payload: { ...common, totalMs: 3000 } });
  }
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
  try {
    const output = execFileSync(process.execPath, [
      join(process.cwd(), 'tools', 'voice-baseline.mjs'), file, '5',
    ], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.lanes.reply.pairedSamples, 5);
    assert.equal(result.lanes.reply.pairedSamplesAll, 7);
    assert.equal(result.lanes.reply.pairedOutsideWindow, 2);
    assert.equal(result.lanes.reply.unpairedPipeline, 0);
    assert.equal(result.lanes.reply.unpairedLatency, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
