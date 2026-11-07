/**
 * C1/C3 module-side contract: perception freshness and ambient source classification.
 *
 * No process, screen or audio capture is touched: the helpers are pure, and the one integration
 * (shrinkShot) reads a tiny in-memory PNG from a temp directory and never invokes ffmpeg.
 *
 * Run: node --test test/perception-freshness.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OBSERVATION_TTL_MS, freshnessOf, readObservation, shrinkShot,
} from '../src/host/vision/sight.js';
import {
  ambientObservation, ambientSourceEvent, ambientSourceOf,
} from '../src/host/hearing/ambient.js';

const NOW = 1_700_000_000_000;

test('freshnessOf：29.9s 新鲜、30s 到期、30.1s 过期，阈值可配置', () => {
  assert.equal(OBSERVATION_TTL_MS, 30_000, '默认阈值为 30 秒');
  assert.deepEqual(freshnessOf(NOW - 29_900, NOW), { at: NOW - 29_900, ageMs: 29_900, stale: false });
  assert.deepEqual(freshnessOf(NOW - 30_000, NOW), { at: NOW - 30_000, ageMs: 30_000, stale: true });
  assert.deepEqual(freshnessOf(NOW - 30_100, NOW), { at: NOW - 30_100, ageMs: 30_100, stale: true });

  // 同一个 10s 前的结果：5s 阈值下过期，30s 阈值下仍新鲜。
  assert.equal(freshnessOf(NOW - 10_000, NOW, 5_000).stale, true);
  assert.equal(freshnessOf(NOW - 10_000, NOW, 30_000).stale, false);

  // 时钟回拨被夹到 0，不会产生负数年龄；无法证明时间的观察一律 stale。
  assert.deepEqual(freshnessOf(NOW + 2_000, NOW), { at: NOW + 2_000, ageMs: 0, stale: false });
  assert.deepEqual(freshnessOf(undefined, NOW), { at: null, ageMs: null, stale: true });
});

test('读取过期观察：stale=true、ageMs 正确，并附带可丢弃的提示', () => {
  const stored = { file: 'shot.png', bytes: 10, at: NOW - 45_000 };
  const read = readObservation(stored, { now: NOW });
  assert.equal(read.stale, true);
  assert.equal(read.ageMs, 45_000);
  assert.equal(read.at, NOW - 45_000);
  assert.equal(read.file, 'shot.png', '读取保留原有字段');
  assert.match(read.hint, /45 秒/, '提示带上真实年龄');

  const fresh = readObservation({ at: NOW - 1_000 }, { now: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, 1_000);
  assert.equal(fresh.hint, '', '新鲜结果不带过期提示');
});

test('缩图不改写观察时间：shrinkShot 结果仍按原始 at 判定过期', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perception-freshness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'shot.png');
  const data = Buffer.from('PNGDATA-small');
  await writeFile(file, data);

  const shrunken = await shrinkShot({ file, at: NOW - 40_000 }, { maxBytes: 1024 });
  assert.ok(shrunken !== null);
  assert.equal(shrunken.at, NOW - 40_000, 'at 随 ...shot 保留');
  assert.equal(shrunken.bytes, data.length);
  assert.equal(readObservation(shrunken, { now: NOW }).stale, true);
});

test('环境音来源：回环设备为 loopback，普通麦克风为 mic', () => {
  const loopback = 'CABLE Output (VB-Audio Virtual Cable)';
  assert.deepEqual(ambientSourceOf(loopback), { source: 'loopback', device: loopback });
  assert.deepEqual(
    ambientSourceOf(' 立体声混音 (Realtek(R) Audio) '),
    { source: 'loopback', device: '立体声混音 (Realtek(R) Audio)' },
    '本地化回环名同样识别，并去掉首尾空格',
  );

  const mic = 'Microphone (Realtek(R) Audio)';
  assert.deepEqual(ambientSourceOf(mic), { source: 'mic', device: mic });
  // 软提示（监听）+ 麦克风标记：仍是真实麦克风，不能当成系统播放。
  assert.deepEqual(ambientSourceOf('监听耳机麦克风'), { source: 'mic', device: '监听耳机麦克风' });
  assert.deepEqual(ambientSourceOf(''), { source: 'mic', device: '' });
});

test('ambient.source 事件 payload 为 {source, device}', () => {
  assert.deepEqual(ambientSourceEvent('CABLE Output'), {
    type: 'ambient.source',
    payload: { source: 'loopback', device: 'CABLE Output' },
  });
  assert.deepEqual(ambientSourceEvent('Microphone (USB Audio)'), {
    type: 'ambient.source',
    payload: { source: 'mic', device: 'Microphone (USB Audio)' },
  });
});

test('环境音观察同时携带来源与时效', () => {
  const observation = ambientObservation(
    { text: '电影里的台词', at: NOW - 31_000 },
    { device: 'CABLE Output', now: NOW },
  );
  assert.equal(observation.text, '电影里的台词');
  assert.equal(observation.source, 'loopback');
  assert.equal(observation.device, 'CABLE Output');
  assert.equal(observation.at, NOW - 31_000);
  assert.equal(observation.ageMs, 31_000);
  assert.equal(observation.stale, true);
  assert.match(observation.hint, /阈值 30 秒/);

  const fresh = ambientObservation({ text: '现在的声音', at: NOW - 2_000 }, { device: 'CABLE Output', now: NOW });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, 2_000);
});
