/**
 * TTS warm-up status — read-only settings-page integration.
 *
 * Run: node --test test/tts-warmup-ui.mjs
 *
 * What this proves:
 *   1. the 「语音合成与候音」 card renders a read-only row from the existing
 *      `/assistant/status.tts.warmup` (no new poller, no retry action);
 *   2. the shipped pure formatter has stable text for unknown / ready / failed+retry / stale;
 *   3. a missing field reads as 「不可用」 and never throws on a broken shape.
 *
 * It deliberately does NOT claim any latency improvement: this is state visibility only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'client.js'), 'utf8');

// ---- the shipped pure formatter, evaluated without React/DOM --------------------------------
const from = clientSource.indexOf('    // ---- TTS 预热状态（只读展示）：');
const to = clientSource.indexOf('    // ---- TTS 预热状态（只读展示）结束', from);
assert.ok(from > 0 && to > from, 'client.js ships the TTS warm-up status block');
const block = clientSource.slice(from, to);
const {
  formatTtsWarmupStatus,
  ttsWarmupConfigSignature,
} = new Function(`${block}
return { formatTtsWarmupStatus, ttsWarmupConfigSignature };`)();

test('1. 静态接线：状态行读取现有 status.tts.warmup，不新增轮询/重试动作', () => {
  assert.match(clientSource, /'data-tts-warmup': 'status'/u, '状态行有稳定标记');
  assert.ok(clientSource.includes("'预热状态'"), '行 label 是「预热状态」');
  assert.match(clientSource, /formatTtsWarmupStatus\(warmup, \{ stale: configChanged \}\)/u,
    '行内容由纯格式化函数生成');
  assert.match(clientSource, /status\?\.tts\?\.warmup/u, '读取现有 /assistant/status 字段');
  assert.match(clientSource, /ttsWarmupConfigSignature\(status\?\.tts, status\?\.langs\)/u,
    '用现有模型/参考音频/语言配置判断旧状态');
  assert.match(clientSource, /stale（旧状态，已失效）/u, '切换配置后旧快照标 stale');
  assert.match(clientSource, /不宣称提速/u, '只读提示不把状态可见说成提速');
  assert.equal((clientSource.match(/setInterval\(load, 3000\)/gu) ?? []).length, 1,
    '全局轮询仍只有原有的那一个');
  assert.doesNotMatch(clientSource, /action: 'tts\.warmup/u, '没有新增预热动作/自动重试');
  assert.doesNotMatch(clientSource, /action: 'tts\.retry/u, '没有新增自动重试动作');
  console.log('1) static wiring: status row reads existing status.tts.warmup; poll=1; retry action=0');
});

test('2. 纯渲染：unknown / ready / failed+retry / stale 文本稳定', () => {
  const missing = formatTtsWarmupStatus(undefined);
  assert.equal(missing.available, false);
  assert.equal(missing.text, '不可用', '无字段显示「不可用」');

  const unknown = formatTtsWarmupStatus({ status: 'unknown' });
  assert.equal(unknown.available, true);
  assert.equal(unknown.label, '未知');
  assert.match(unknown.text, /未知/u);
  assert.match(unknown.text, /unknown/u);
  assert.match(unknown.text, /非 stale/u);

  const ready = formatTtsWarmupStatus({ status: 'ready', key: 'k', generation: 2, attempts: 0 });
  assert.equal(ready.status, 'ready');
  assert.match(ready.text, /就绪/u);
  assert.match(ready.text, /ready/u);
  assert.match(ready.text, /非 stale/u);

  const failed = formatTtsWarmupStatus({
    status: 'failed',
    key: 'k',
    attempts: 2,
    retryInMs: 15_000,
    lastErrorCode: 'TTS_FAILED',
    retryable: true,
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.text, /失败/u);
  assert.match(failed.text, /TTS_FAILED/u, '错误码可见');
  assert.match(failed.text, /15\.0s/u, '重试等待可见');
  assert.match(failed.text, /重试/u);

  const stale = formatTtsWarmupStatus({ status: 'ready', key: 'old', stale: true });
  assert.equal(stale.stale, true);
  assert.match(stale.text, /stale/u);
  assert.match(stale.text, /旧状态/u);

  const forced = formatTtsWarmupStatus({ status: 'ready', key: 'old' }, { stale: true });
  assert.equal(forced.stale, true, 'UI 观察到配置变化时可强制标 stale');
  assert.equal(formatTtsWarmupStatus({ status: 'ready' }, null).stale, false,
    'a null options object is tolerated');

  // A broken shape never throws and still reads as unavailable rather than inventing a state.
  for (const value of [null, 7, 'ready', [], { status: '' }, { status: 42 }]) {
    const view = formatTtsWarmupStatus(value);
    assert.equal(view.available, false, `broken shape ${JSON.stringify(value)} is unavailable`);
    assert.equal(view.text, '不可用');
  }

  console.log(`2) unknown="${unknown.text}" ready="${ready.text}" failed="${failed.text}"`);
});

test('3. 配置指纹只用于检测切换：模型/参考音频/语言任一变化都会改变签名', () => {
  const base = {
    gptSovits: {
      enabled: true,
      apiBase: 'http://127.0.0.1:9880',
      refAudioPath: 'D:\\voice\\a.wav',
      promptText: '参考',
      models: { gptModelPath: 'g.ckpt', sovitsModelPath: 's.pth' },
      modelsApplied: { at: 10, gptPath: 'g.ckpt', sovitsPath: 's.pth' },
      textLang: 'zh',
      promptLang: 'zh',
    },
  };
  const signature = ttsWarmupConfigSignature(base, { speech: 'zh' });
  assert.equal(ttsWarmupConfigSignature(base, { speech: 'zh' }), signature, '同一配置签名稳定');
  assert.notEqual(
    ttsWarmupConfigSignature({ gptSovits: { ...base.gptSovits, refAudioPath: 'D:\\voice\\b.wav' } }, { speech: 'zh' }),
    signature,
    '参考音频变化改变签名',
  );
  assert.notEqual(
    ttsWarmupConfigSignature({ gptSovits: { ...base.gptSovits, models: { gptModelPath: 'g2.ckpt', sovitsModelPath: 's.pth' } } }, { speech: 'zh' }),
    signature,
    '模型变化改变签名',
  );
  assert.notEqual(
    ttsWarmupConfigSignature(base, { speech: 'ja' }),
    signature,
    '语言变化改变签名',
  );
  console.log('3) config signature changes with model / reference audio / language');
});
