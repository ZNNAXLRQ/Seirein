/**
 * Ambient audio: the system-playback capture lane.
 *
 * Module-side helpers only (the Host still wires the ASR session in index.js). They answer the
 * two questions the perception layer must not guess:
 *  - is this endpoint a loopback replay of what the speakers play, or a real microphone?
 *  - when this utterance was captured, is it still current?
 *
 * Freshness is shared with vision observations (`sight.js`) so both lanes age by the same rule.
 */
import { isLoopbackDevice } from './hearing.js';
import { OBSERVATION_TTL_MS, readObservation } from '../vision/sight.js';

/**
 * Classify one DirectShow capture endpoint.
 * `isLoopbackDevice()` is hearing.js's whitelist: an unfamiliar name counts as a microphone, so
 * only known replay endpoints (Stereo Mix, VB-Cable, VoiceMeeter, …) become `'loopback'`.
 * @param {string} device - DirectShow capture name
 * @returns {{source: 'mic'|'loopback', device: string}}
 */
export function ambientSourceOf(device) {
  const name = typeof device === 'string' ? device.trim() : '';
  return { source: isLoopbackDevice(name) ? 'loopback' : 'mic', device: name };
}

/**
 * The `ambient.source` event the Host records when a capture session starts.
 * The payload is exactly `{source, device}` so the log alone distinguishes "system playback"
 * from "real surroundings".
 * @param {string} device
 * @returns {{type: 'ambient.source', payload: {source: 'mic'|'loopback', device: string}}}
 */
export function ambientSourceEvent(device) {
  const { source, device: name } = ambientSourceOf(device);
  return { type: 'ambient.source', payload: { source, device: name } };
}

/**
 * One ambient utterance as a perception result: source label plus `{at, ageMs, stale, hint}`.
 * `entry.at` is the capture time; an utterance without one reads as stale rather than current.
 * @param {{text?: string, at?: number, device?: string}} [entry]
 * @param {{device?: string, now?: number, ttlMs?: number}} [options]
 */
export function ambientObservation(entry = {}, { device = entry.device ?? '', now = Date.now(), ttlMs = OBSERVATION_TTL_MS } = {}) {
  const { source, device: name } = ambientSourceOf(device);
  return {
    ...readObservation({ text: typeof entry.text === 'string' ? entry.text : '', at: entry.at }, { now, ttlMs }),
    source,
    device: name,
  };
}
