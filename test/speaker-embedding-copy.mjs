import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSpeakerEmbedder } from '../src/host/hearing/speakerVoice.js';

test('embedder always hands sherpa a fresh ordinary ArrayBuffer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'seirein-embedder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = join(root, 'speaker.onnx');
  await writeFile(model, 'fake model placeholder');
  let seen = null;
  const embedder = createSpeakerEmbedder({
    modelPath: model,
    extractorFactory: () => ({
      dim: 3,
      createStream() {
        return { acceptWaveform(input) { this.samples = input.samples; } };
      },
      isReady() { return true; },
      compute(stream) {
        seen = stream.samples;
        return new Float32Array([1, 0, 0]);
      },
    }),
  });
  assert.ok(embedder !== null);
  // A Buffer-backed view is exactly the shape that used to produce
  // "External buffers are not allowed" inside the native extractor.
  const backing = Buffer.alloc(16_000 * 4);
  const external = new Float32Array(backing.buffer, backing.byteOffset, backing.byteLength / 4);
  external[0] = 2;
  external[1] = Number.NaN;
  external[2] = -2;
  const vector = embedder.embed(external);
  assert.ok(vector instanceof Float32Array);
  assert.notEqual(seen, external, 'the native call never receives the external view');
  assert.ok(seen.buffer instanceof ArrayBuffer, 'the native call receives an ordinary ArrayBuffer');
  assert.equal(seen.byteOffset, 0);
  assert.equal(seen[0], 1, 'out-of-range positive samples are clamped');
  assert.equal(seen[1], 0, 'non-finite samples become zero');
  assert.equal(seen[2], -1, 'out-of-range negative samples are clamped');
});
