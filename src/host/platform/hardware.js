/**
 * Hardware probe: pick ASR thread counts and decode limits from the actual machine instead of
 * hardcoding values that only suit one laptop.
 *
 * Rationale:
 *  - streaming (14M transducer) is cheap; 2–4 threads is plenty and leaves CPU for the rest;
 *  - the SenseVoice final pass is the expensive one, so it gets the larger share;
 *  - very long utterances are capped before re-decoding, because decode time scales with audio
 *    length (≈0.2× real time) and a 30 s utterance would cost seconds for little gain.
 */
import { cpus, totalmem } from 'node:os';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @returns {{cores: number, memoryGb: number, streamThreads: number, finalThreads: number,
 *            decodeCapSec: number, tier: 'low'|'mid'|'high'}}
 */
export function detectTuning() {
  const cores = cpus().length || 4;
  const memoryGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;

  const tier = cores >= 12 ? 'high' : cores >= 6 ? 'mid' : 'low';

  // Streaming: keep it light. Final pass: use more of the machine, but leave headroom.
  const streamThreads = clamp(Math.floor(cores / 6), 1, 4);
  const finalThreads = clamp(Math.floor(cores / 3), 2, 8);
  // Decode cap: slower machines must not spend seconds re-decoding long audio.
  const decodeCapSec = tier === 'high' ? 15 : tier === 'mid' ? 10 : 8;

  return { cores, memoryGb, streamThreads, finalThreads, decodeCapSec, tier };
}
