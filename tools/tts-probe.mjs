/**
 * Probe: can we get RIFF/WAV out of the Edge Read Aloud endpoint, and how long is it?
 * Run: node tools/tts-probe.mjs [text]
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import pkg from 'msedge-tts';

const { MsEdgeTTS } = pkg;

const text = process.argv[2] ?? '你好，我是你的助手。';
const dir = join(process.cwd(), '.tmp-tts');
await mkdir(dir, { recursive: true });

for (const format of ['riff-24khz-16bit-mono-pcm', 'audio-24khz-48kbitrate-mono-mp3']) {
  const started = Date.now();
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('zh-CN-XiaoxiaoNeural', format);
    const { audioStream } = await tts.toStream(text);
    const file = join(dir, `probe.${format.startsWith('riff') ? 'wav' : 'mp3'}`);
    await pipeline(audioStream, createWriteStream(file));
    const info = await stat(file);
    const head = (await readFile(file)).subarray(0, 12);
    console.log(
      `${format}: ${info.size} bytes in ${Date.now() - started} ms; magic="${head.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}"`,
    );
  } catch (error) {
    console.log(`${format}: FAILED ${error?.message ?? error}`);
  }
}
