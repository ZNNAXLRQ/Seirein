/**
 * Microphone device policy: replay endpoints (Stereo Mix, virtual cables, VoiceMeeter) must never be
 * opened as the microphone, because the assistant would then hear its own playback.
 *
 * The classifier is a whitelist — a name that is not a known loopback is a microphone — so ordinary
 * USB / headset / Realtek / array microphones stay selectable.
 *
 * Run: node --test test/asr-devices.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoopbackDevice, selectMicrophoneDevice } from '../src/host/hearing/hearing.js';

const MIX = '立体声混音 (Realtek(R) Audio)';
const STEREO_MIX = 'Stereo Mix (Realtek)';
const CABLE = 'CABLE Output (VB-Audio Virtual Cable)';
const MIC = 'Microphone (Realtek(R) Audio)';
const HEADSET = '耳机麦克风阵列';
const USB_MIC = '麦克风 (USB Audio Device)';

// ---------------------------------------------------------------------------
// isLoopbackDevice: the names seen on real Windows machines
// ---------------------------------------------------------------------------

test('立体声混音 (Realtek) is a loopback endpoint', () => {
  assert.equal(isLoopbackDevice(MIX), true);
});

test('Stereo Mix (Realtek) is a loopback endpoint (case-insensitive)', () => {
  assert.equal(isLoopbackDevice(STEREO_MIX), true);
  assert.equal(isLoopbackDevice('STEREO MIX (REALTEK)'), true);
});

test('CABLE Output (VB-Audio Virtual Cable) is a loopback endpoint', () => {
  assert.equal(isLoopbackDevice(CABLE), true);
  assert.equal(isLoopbackDevice('CABLE Input (VB-Audio Virtual Cable)'), true);
  assert.equal(isLoopbackDevice('VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)'), true);
});

test('Microphone (Realtek(R) Audio) is not a loopback endpoint', () => {
  assert.equal(isLoopbackDevice(MIC), false);
});

test('耳机麦克风阵列 is not a loopback endpoint', () => {
  assert.equal(isLoopbackDevice(HEADSET), false);
});

test('麦克风 (USB Audio Device) is not a loopback endpoint', () => {
  assert.equal(isLoopbackDevice(USB_MIC), false);
  assert.equal(isLoopbackDevice('USB Audio Device'), false);
});

test('a soft monitor hint never overrides an explicit microphone name', () => {
  // "监听耳机麦克风" mentions monitoring but names a microphone: it must stay selectable.
  assert.equal(isLoopbackDevice('监听耳机麦克风'), false);
  // Bare monitor endpoints still classify as loopback.
  assert.equal(isLoopbackDevice('Monitor (Realtek(R) Audio)'), true);
  assert.equal(isLoopbackDevice('回环输入 (Virtual Audio Cable)'), true);
});

test('empty and non-string names are never loopback', () => {
  assert.equal(isLoopbackDevice(''), false);
  assert.equal(isLoopbackDevice(undefined), false);
  assert.equal(isLoopbackDevice(null), false);
});

// ---------------------------------------------------------------------------
// Default selection: skip loopbacks, fail closed when nothing else exists
// ---------------------------------------------------------------------------

test('default selection skips the loopback and picks the real microphone', () => {
  const picked = selectMicrophoneDevice([CABLE, MIC], '');
  assert.equal(picked.device, MIC);
  assert.equal(picked.error, '');
  assert.equal(picked.loopback, false);
});

test('only loopbacks present → MIC_LOOPBACK_ONLY, nothing selected', () => {
  const picked = selectMicrophoneDevice([MIX, CABLE], '');
  assert.equal(picked.device, '');
  assert.equal(picked.error, 'MIC_LOOPBACK_ONLY');
  assert.equal(picked.loopback, true);
});

test('explicitly selecting a loopback → MIC_LOOPBACK_REJECTED', () => {
  const picked = selectMicrophoneDevice([MIX, MIC], MIX);
  assert.equal(picked.device, '');
  assert.equal(picked.error, 'MIC_LOOPBACK_REJECTED');
  assert.equal(picked.loopback, true);
  // Even when the loopback is the only device, the explicit request stays rejected.
  assert.equal(selectMicrophoneDevice([MIX], MIX).error, 'MIC_LOOPBACK_REJECTED');
});

test('an explicit real microphone is honoured over the first device', () => {
  const picked = selectMicrophoneDevice([MIX, MIC, USB_MIC], USB_MIC);
  assert.equal(picked.device, USB_MIC);
  assert.equal(picked.error, '');
});

test('an empty enumeration reports no error code (the host keeps its generic error)', () => {
  const picked = selectMicrophoneDevice([], '');
  assert.equal(picked.device, '');
  assert.equal(picked.error, '');
});
