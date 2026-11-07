/**
 * End-to-end probe for scene mode: start OBS's virtual camera, grab one frame through
 * sight.captureDevice (ffmpeg dshow), then restore the camera to its previous state.
 *
 * Usage: node tools/vision-scene-probe.mjs [sceneName]
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import { connectObs } from '../src/host/vision/obs.js';
import { captureDevice } from '../src/host/vision/sight.js';

const ffmpegPath = join(homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe');
const sceneName = process.argv[2] ?? '';
const dir = join(import.meta.dirname, '..', '.tmp-scene');

const client = await connectObs({ port: 4455 });

try {
  const list = await client.request('GetSceneList');
  const names = (list.scenes ?? []).map((entry) => entry.sceneName);
  console.log('current scene:', list.currentProgramSceneName);
  console.log('scenes:', names.join(' | '));

  if (sceneName.length > 0) {
    if (!names.includes(sceneName)) throw new Error(`scene not found: ${sceneName}`);
    await client.request('SetCurrentProgramScene', { sceneName });
    console.log('switched to:', sceneName);
  }

  const before = await client.request('GetVirtualCamStatus');
  if (before.outputActive !== true) {
    await client.request('StartVirtualCam');
    console.log('virtual camera: started');
  } else {
    console.log('virtual camera: already running');
  }

  // The camera takes a moment to produce its first frame after StartVirtualCam.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const shot = await captureDevice({ dir, ffmpegPath });
  const info = await stat(shot.file);
  console.log('captured:', shot.file, `${shot.width}x${shot.height}`, `${info.size} bytes`);

  if (before.outputActive !== true) {
    await client.request('StopVirtualCam');
    console.log('virtual camera: stopped (restored)');
  }
} finally {
  client.close();
}
