/** devices — extracted from hearing.js; no host entry dependency. */
import { spawn } from 'node:child_process';

/**
 * List DirectShow audio capture devices by parsing ffmpeg's device dump.
 * A spawn failure (ENOENT, thrown synchronously or emitted as `error`) is reported through
 * `onError` and yields an empty list: enumerating devices must never crash the caller.
 */
export async function listDevices(ffmpegPath, { onError, spawnProcess = spawn } = {}) {
  const report = (error) => {
    onError?.(`ffmpeg 设备枚举失败: ${error?.message ?? error}`);
  };
  const output = await new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        windowsHide: true,
      });
    } catch (error) {
      report(error);
      resolve('');
      return;
    }
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    child.on('close', () => resolve(text));
    child.on('error', (error) => {
      report(error);
      resolve('');
    });
  });

  const devices = [];
  for (const line of output.split('\n')) {
    const match = line.match(/"([^"]+)"\s+\(audio\)/u);
    if (match !== null) devices.push(match[1]);
  }
  return devices;
}


/**
 * Names that only ever belong to a loopback/monitor endpoint — a capture of what the speakers are
 * playing (Stereo Mix, virtual cables, VoiceMeeter), not a physical microphone. This is deliberately
 * a whitelist: an unfamiliar name is a microphone, so USB/headset/Realtek/array mics are never
 * rejected just because the string mentions audio hardware.
 */
const LOOPBACK_STRONG = [
  /\bstereo\s*mix\b/iu, // "Stereo Mix (Realtek(R) Audio)"
  /立体声混音/u, // its localized name
  /输出混音/u,
  /\bwave\s*out\s*mix\b/iu,
  /\bwave\s*mix\b/iu,
  /\bwhat\s*u\s*hear\b/iu,
  /\bloopback\b/iu, // "Loopback", "Loopback Audio"
  /回环/u,
  /\bcable\s*(?:output|input)\b/iu, // VB-Audio CABLE Output / CABLE Input
  /\bvb[-\s]?audio\b/iu,
  /\bvoicemeeter\b/iu, // VoiceMeeter Output/Input (VAIO)
  /\bvirtual\s*(?:audio\s*)?cable\b/iu,
];

/** Loose hints: only a loopback when the endpoint is not named as a microphone ("监听耳机麦克风"). */
const LOOPBACK_SOFT = [/\bmonitor\b/iu, /监听/u, /混音/u];

const MICROPHONE_MARKERS = [
  /\bmicrophone\b/iu,
  /\bmic\b/iu,
  /\bheadset\b/iu,
  /\barray\b/iu,
  /\bline\s*in\b/iu,
  /麦克风/u,
  /话筒/u,
  /耳麦/u,
  /阵列/u,
];


/** Whether a DirectShow capture name is a system-audio loopback rather than a real microphone. */
export function isLoopbackDevice(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text.length === 0) return false;
  if (LOOPBACK_STRONG.some((pattern) => pattern.test(text))) return true;
  if (!LOOPBACK_SOFT.some((pattern) => pattern.test(text))) return false;
  return !MICROPHONE_MARKERS.some((pattern) => pattern.test(text));
}


/**
 * Resolve the microphone endpoint from an enumeration.
 * - An explicitly requested loopback is refused (`MIC_LOOPBACK_REJECTED`): the saved setting is the
 *   caller's to keep, but this capture must not open a replay endpoint.
 * - With no usable request the first non-loopback device wins; an enumeration that only offers
 *   loopbacks fails closed (`MIC_LOOPBACK_ONLY`) instead of silently feeding our own playback back.
 * @returns {{device: string, loopback: boolean, error: ''|'MIC_LOOPBACK_REJECTED'|'MIC_LOOPBACK_ONLY'}}
 */
export function selectMicrophoneDevice(devices, requested = '') {
  const names = Array.isArray(devices)
    ? devices.filter((name) => typeof name === 'string' && name.length > 0)
    : [];
  const wanted = typeof requested === 'string' ? requested.trim() : '';
  if (wanted.length > 0 && isLoopbackDevice(wanted)) {
    return { device: '', loopback: true, error: 'MIC_LOOPBACK_REJECTED' };
  }
  if (wanted.length > 0) return { device: wanted, loopback: false, error: '' };
  const normal = names.find((name) => !isLoopbackDevice(name));
  if (normal !== undefined) return { device: normal, loopback: false, error: '' };
  return {
    device: '',
    loopback: names.length > 0,
    error: names.length > 0 ? 'MIC_LOOPBACK_ONLY' : '',
  };
}

export { LOOPBACK_STRONG, LOOPBACK_SOFT, MICROPHONE_MARKERS };
