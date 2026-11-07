/**
 * Visual probe for the subtitle overlay: show a sample line, screenshot it, then stop.
 * Usage: node tools/subtitle-probe.mjs
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SubtitleOverlay } from '../src/host/subtitle/subtitle.js';
import { capture } from '../src/host/vision/sight.js';

const dir = await mkdtemp(join(tmpdir(), 'dsh-subtitle-'));
const shots = join(dir, 'shots');
await mkdir(shots, { recursive: true });

const overlay = new SubtitleOverlay({
  dir,
  scriptPath: resolve('src/host/subtitle/overlay.ps1'),
});

await overlay.show(
  '这是一句用来验证字幕叠加层的示例文字，它应当自动适应下面的区域大小，超出时会自动缩小字号。',
  { x: 320, y: 620, w: 1000, h: 140 },
);
await new Promise((r) => setTimeout(r, 1600));

const shot = await capture({ dir: shots });
console.log('overlay running:', overlay.running);
console.log('screenshot:', shot.file);
console.log('overlay error:', overlay.lastError || '(none)');
console.log('workdir:', dir);

await overlay.stop();
