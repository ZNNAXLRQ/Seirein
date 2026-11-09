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
 * The lane label every ambient perception result carries. `ambientSourceOf()` above answers a
 * different question (which endpoint was captured); `source` on an utterance answers which lane
 * heard it. The microphone lane keeps `'mic'` and is never relabeled by this module.
 */
export const AMBIENT_SOURCE = 'ambient';

/**
 * Source labels of one ambient utterance: `source` is the lane, `endpoint` keeps the capture
 * endpoint classification (`'loopback'` = system playback replay, `'mic'` = real surroundings).
 * @param {string} endpoint - result of `ambientSourceOf(...).source`
 * @returns {{source: 'ambient', endpoint: 'mic'|'loopback'}}
 */
export function ambientUtteranceLabels(endpoint) {
  return { source: AMBIENT_SOURCE, endpoint: endpoint === 'loopback' ? 'loopback' : 'mic' };
}

/**
 * Public projection of one stored ambient utterance for `assistant_ambient` poll entries.
 * Only the bounded fields the tool returns are copied; the lane label is always `'ambient'`.
 * @param {{text?: string, at?: number, durationMs?: number, endpoint?: string, source?: string}} [entry]
 * @returns {{text: string, at: number, durationMs: number, source: 'ambient', endpoint: 'mic'|'loopback'}}
 */
export function ambientPollEntry(entry = {}) {
  const at = Number(entry.at);
  const durationMs = Number(entry.durationMs);
  return {
    text: typeof entry.text === 'string' ? entry.text : '',
    at: Number.isFinite(at) && at > 0 ? at : 0,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    // Stored rows already carry `endpoint`; the old `source` was the endpoint before P-57.
    ...ambientUtteranceLabels(entry.endpoint ?? entry.source),
  };
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
