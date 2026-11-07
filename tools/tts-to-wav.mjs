/**
 * Helper: synthesize a sentence with the Edge TTS path, convert it to 16 kHz mono WAV with
 * ffmpeg, and print the WAV path (used by tools/asr-probe.mjs).
 *
 * Usage: node tools/tts-to-wav.mjs ["文本"]
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { synthesize } from '../src/host/speech/tts.js';

const ffmpeg = process.env.ASSISTANT_FFMPEG ?? join(process.env.USERPROFILE ?? '', '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const text = process.argv[2] ?? '你好，我是你的助手，现在测试语音识别。';
const dir = join(process.cwd(), '.tmp-asr');

const audio = await synthesize({ text, dir });
const wav = join(dir, 'speech.wav');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', audio.file, '-ar', '16000', '-ac', '1', wav]);
console.log(wav);
