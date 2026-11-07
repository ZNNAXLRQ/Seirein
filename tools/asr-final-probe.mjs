/**
 * Offline final-pass probe: decode a 16 kHz mono WAV with SenseVoice and print the text.
 * Compare with tools/asr-probe.mjs (streaming 14M) to see the accuracy gain.
 *
 * Usage: node tools/asr-final-probe.mjs <file.wav> [modelDir]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createFinalRecognizer } from '../src/host/hearing/hearing.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/asr-final-probe.mjs <file.wav> [modelDir]');
  process.exit(2);
}
const modelDir =
  process.argv[3] ??
  join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-assistant', 'models', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17');

const wav = readFileSync(file);
if (wav.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not a RIFF/WAV file');
let offset = 12;
let dataStart = -1;
let dataLength = 0;
while (offset + 8 <= wav.length) {
  const id = wav.toString('latin1', offset, offset + 4);
  const size = wav.readUInt32LE(offset + 4);
  if (id === 'data') {
    dataStart = offset + 8;
    dataLength = size;
    break;
  }
  offset += 8 + size + (size % 2);
}
if (dataStart < 0) throw new Error('no data chunk');

const samples = new Float32Array(Math.floor(dataLength / 2));
for (let index = 0; index < samples.length; index += 1) samples[index] = wav.readInt16LE(dataStart + index * 2) / 32768;

const started = Date.now();
const recognizer = createFinalRecognizer(modelDir);
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples });
recognizer.decode(stream);
const result = recognizer.getResult(stream);
console.log(`sensevoice (${Date.now() - started} ms): ${result.text}`);
