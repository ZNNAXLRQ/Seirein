/**
 * Dev helper: ensure a scene exists in OBS (default: the privacy scene), then print the scene list.
 * Usage: node tools/obs-seed.mjs [sceneName] [--port 4455] [--password xxx]
 */
import { connectObs } from '../src/host/vision/obs.js';

const args = process.argv.slice(2);
const sceneName = args[0] && !args[0].startsWith('--') ? args[0] : '隐私';
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4455;
const passwordIndex = args.indexOf('--password');
const password = passwordIndex >= 0 ? args[passwordIndex + 1] : '';

const client = await connectObs({ port, password });
try {
  const list = await client.request('GetSceneList');
  const names = (list.scenes ?? []).map((entry) => entry.sceneName);
  if (!names.includes(sceneName)) {
    await client.request('CreateScene', { sceneName });
    console.log(`created scene: ${sceneName}`);
  } else {
    console.log(`scene already exists: ${sceneName}`);
  }
  const after = await client.request('GetSceneList');
  console.log('scenes:', (after.scenes ?? []).map((entry) => entry.sceneName).join(' | '));
  console.log('current:', after.currentProgramSceneName);
} finally {
  client.close();
}
