/**
 * Offline ASR probe: feed a 16 kHz mono WAV through the streaming recognizer and print results.
 * Validates the model and the decoder loop without touching the microphone.
 *
 * Usage: node tools/asr-probe.mjs <file.wav> [modelDir]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createRecognizer } from '../src/host/hearing/hearing.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/asr-probe.mjs <file.wav> [modelDir]');
  process.exit(2);
}
const modelDir =
  process.argv[3] ?? join(process.env.LOCALAPPDATA ?? homedir(), 'dsh-assistant', 'models', 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23');

const wav = readFileSync(file);
if (wav.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not a RIFF/WAV file');
// Minimal WAV parse: find the `data` chunk.
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

const recognizer = createRecognizer(modelDir);
const stream = recognizer.createStream();

// Feed in 100 ms slices, like the live capture path does.
const bytesPerSlice = 16000 * 2 * 0.1;
let last = '';
const finals = [];
for (let cursor = dataStart; cursor < dataStart + dataLength; cursor += bytesPerSlice) {
  const end = Math.min(cursor + bytesPerSlice, dataStart + dataLength);
  const slice = wav.subarray(cursor, end);
  const samples = new Float32Array(Math.floor(slice.length / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = slice.readInt16LE(index * 2) / 32768;
  stream.acceptWaveform({ sampleRate: 16000, samples });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  if (result.text !== last) {
    last = result.text;
    process.stdout.write(`\r${result.text}                    `);
  }
  if (recognizer.isEndpoint(stream)) {
    if (result.text.trim().length > 0) finals.push(result.text.trim());
    recognizer.reset(stream);
    last = '';
  }
}
// 3 s of silence so the endpoint rule fires and the last utterance is finalized.
stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(16000 * 3) });
while (recognizer.isReady(stream)) recognizer.decode(stream);
if (recognizer.isEndpoint(stream)) {
  const text = recognizer.getResult(stream).text.trim();
  if (text.length > 0) finals.push(text);
}
const tail = finals.length > 0 ? finals[finals.length - 1] : recognizer.getResult(stream).text.trim();
if (tail.length > 0 && !finals.includes(tail)) finals.push(tail);

console.log(`\n--- finals ---\n${finals.join('\n') || '(none)'}`);
