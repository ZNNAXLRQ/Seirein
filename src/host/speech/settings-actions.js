/** Settings actions for playback, TTS models, language and waiting speech. */
import { ACK_DELAY_MAX_MS } from './ack-speech.js';
import { ACK_DELAY_MIN_MS } from './ack-speech.js';
import { applyGptSovitsModels } from './tts.js';
import { resolveGptSovitsTimeout } from './tts.js';

export const ACTIONS = Object.freeze([
  'voice.ack',
  'voice.ack.delay',
  'voice.claim',
  'voice.requeue',
  'voice.mute',
  'voice.inputInterruptsReply',
  'voice.playback',
  'tts.config',
  'gptSovits.applyModels',
  'langs.set',
]);

/** Inputs that make a warm-up reusable; a change needs a new identity warm-up. */
function warmupInputsChanged(before, after) {
  const old = before !== null && typeof before === 'object' ? before : {};
  const value = (source, key) => String(source?.[key] ?? '');
  for (const key of ['apiBase', 'refAudioPath', 'promptText', 'promptLang', 'textLang',
    'promptLangPinned', 'textLangPinned']) {
    if (value(old, key) !== value(after, key)) return true;
  }
  for (const key of ['gptModelPath', 'sovitsModelPath']) {
    if (value(old.models, key) !== value(after.models, key)) return true;
  }
  return false;
}

export function createSpeechSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'voice.ack': {
        // Kept for older bundles: they peeked at the queue and cleared it afterwards.
        services.pendingVoice.shift();
        return { ok: true, remaining: services.pendingVoice.length };
      }
      case 'voice.ack.delay': {
        // 候音等待：settings.voice.ackDelayMs（毫秒），夹在 500–15000；非法输入直接拒绝。
        const raw = typeof body.ms === 'number'
          ? body.ms
          : (typeof body.ms === 'string' && body.ms.trim() !== '' ? Number(body.ms) : Number.NaN);
        if (!Number.isFinite(raw)) return { ok: false, error: '候音等待需为数字（毫秒，500–15000）' };
        const ms = Math.min(ACK_DELAY_MAX_MS, Math.max(ACK_DELAY_MIN_MS, Math.round(raw)));
        const savedVoice = (0, services.readSettings)().voice;
        (0, services.writeSettings)({
          voice: { ...(savedVoice !== null && typeof savedVoice === 'object' ? savedVoice : {}), ackDelayMs: ms },
        });
        await services.log.emit('voice.ack.delay.set', { ms });
        return { ok: true, ackDelayMs: ms };
      }
      case 'voice.claim': {
        // Atomic hand-off: exactly one page gets the transcript, so two pollers cannot both send it.
        const next = services.pendingVoice.shift();
        return next ? { ok: true, text: next.text, remaining: services.pendingVoice.length } : { ok: true, text: '' };
      }
      case 'voice.requeue': {
        const text = typeof body.text === 'string' ? body.text : '';
        // Only give a line back once: repeated requeue is what turns a failure into a flood.
        const attempts = services.voiceAttempts.get(text) ?? 0;
        if (attempts >= 2) {
          services.voiceAttempts.delete(text);
          await services.log.emit('voice.dropped', { chars: text.length, attempts });
          return { ok: true, remaining: services.pendingVoice.length, dropped: true };
        }
        services.voiceAttempts.set(text, attempts + 1);
        if (text.trim().length > 0) services.pendingVoice.unshift({ text, at: Date.now() });
        return { ok: true, remaining: services.pendingVoice.length, dropped: false };
      }
      case 'voice.mute': {
        const muted = body.muted === true;
        (0, services.writeSettings)({ voiceMuted: muted });
        if (muted) (0, services.cancelFastReply)('muted');
        await services.log.emit('voice.mute', { muted });
        return { ok: true, muted };
      }
      case 'voice.inputInterruptsReply': {
        // 用户输入是否立即打断当前播报：只接受真正的布尔值，写入 settings.voice 并保留同一层
        // 其它字段（候音等待、分块、低证据门等）。缺省 true 表示保持历史上的立即打断行为。
        const value = body.enabled ?? body.value;
        if (typeof value !== 'boolean') {
          return { ok: false, error: '用户输入打断当前回复需为布尔值（true / false）' };
        }
        const saved = ((0, services.readSettings)() ?? {}).voice;
        const voice = saved !== null && typeof saved === 'object' ? saved : {};
        (0, services.writeSettings)({ voice: { ...voice, inputInterruptsReply: value } });
        await services.log.emit('voice.inputInterruptsReply.set', { enabled: value });
        return { ok: true, inputInterruptsReply: value, enabled: value };
      }
      case 'voice.playback': {
        // Child switch of voice: does not touch features.json and does not select a provider.
        const enabled = body.enabled === true;
        if (enabled) {
          const opened = await (0, services.ensureComponent)('voice', 'voice.playback');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'voice', error: opened.error ?? '语音合成组件无法启用' };
        }
        const next = { ...(0, services.componentSettings)('voice'), enabled };
        services.runtime.voice = next;
        (0, services.writeSettings)({ voice: next });
        if (!enabled) {
          services.speechLedger.cancelAll('playback-disabled');
          (0, services.invalidateSpeech)();
          (0, services.cancelPlayback)('playback-disabled');
        }
        await services.log.emit('voice.playback.set', { enabled, source: 'settings' });
        return { ok: true, enabled };
      }
      case 'tts.config': {
        // Provider selection is voice's child, not the component: toggling it never writes
        // features.json. Turning the provider ON is a container action, so voice opens first.
        if (body.enabled === true) {
          const opened = await (0, services.ensureComponent)('voice', 'tts.provider.enable');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'voice', error: opened.error ?? '语音合成组件无法启用' };
        }
        // Partial update: only the keys the settings card sends are touched.
        const wasEnabled = services.runtime.gptSovits?.enabled === true;
        const previous = (0, services.gptSovitsSettings)();
        const previousSafe = previous !== null && typeof previous === 'object' ? previous : {};
        const next = { ...previousSafe, models: { ...(previousSafe.models ?? {}) } };
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
        if (typeof body.apiBase === 'string') next.apiBase = body.apiBase.trim();
        if (typeof body.refAudioPath === 'string') next.refAudioPath = body.refAudioPath.trim();
        if (typeof body.promptText === 'string') next.promptText = body.promptText;
        // Timeout: clamp to 5–120 s, default 30 s. Accepts numbers and numeric form strings.
        if (body.timeoutMs !== undefined) next.timeoutMs = resolveGptSovitsTimeout({ timeoutMs: body.timeoutMs });
        // An empty value clears the pin, so text_lang/prompt_lang follow langs.speech again.
        if (typeof body.promptLang === 'string') {
          const value = body.promptLang.trim().toLowerCase();
          next.promptLangPinned = services.LANGS.includes(value);
          next.promptLang = next.promptLangPinned ? value : '';
        }
        if (typeof body.textLang === 'string') {
          const value = body.textLang.trim().toLowerCase();
          next.textLangPinned = services.LANGS.includes(value);
          next.textLang = next.textLangPinned ? value : '';
        }
        // A path edit only persists the path: the card marks it dirty and 「应用模型」 is the
        // one and only load trigger (`gptSovits.applyModels`), so no implicit load here.
        if (body.models !== null && typeof body.models === 'object') {
          for (const key of ['gptModelPath', 'sovitsModelPath']) {
            if (typeof body.models[key] === 'string') next.models[key] = body.models[key].trim();
          }
        }
        if (next.apiBase.length === 0) next.apiBase = services.DEFAULT_GPT_SOVITS.apiBase;
        // Derived fields are recomputed on read; never persist them.
        const stored = { ...next };
        delete stored.effectiveTextLang;
        delete stored.effectivePromptLang;
        // The explicit-apply record survives ordinary settings edits.
        const applied = services.runtime.gptSovits?.applied;
        if (applied !== undefined) stored.applied = applied;
        services.runtime.gptSovits = stored;
        (0, services.writeSettings)({ gptSovits: stored });
        await services.log.emit('tts.config', {
          enabled: next.enabled,
          apiBase: next.apiBase,
          hasRefAudio: next.refAudioPath.length > 0,
          promptChars: next.promptText.length,
          timeoutMs: next.timeoutMs,
          hasGptModel: next.models.gptModelPath.length > 0,
          hasSovitsModel: next.models.sovitsModelPath.length > 0,
          source: 'settings',
        });
        // First enable, or a changed warm-up identity input, loads the new model/reference before
        // the next real sentence. Unchanged saves are left alone; the tts layer also short-circuits
        // a `ready` identity, so a duplicate trigger can never warm twice.
        if (next.enabled && (!wasEnabled || warmupInputsChanged(previous, next))) {
          (0, services.scheduleGptWarmup)(0);
        }
        if (typeof body.enabled === 'boolean' && next.enabled !== wasEnabled) {
          await services.log.emit('voice.provider.set', {
            provider: next.enabled ? 'gptsovits' : 'edge',
            enabled: next.enabled,
            source: 'settings',
          });
          // The provider is the only user of the API server: releasing it here closes a
          // plugin-owned server, but never the voice component, playback or the feature state.
          if (!next.enabled) {
            await services.dependencyRegistry.release('voice', 'gptsovits', {
              autoClose: (0, services.autostartSettings)().gptsovits.autoClose !== false,
            });
          } else if (services.features.enabled('voice')) {
            await (0, services.acquireComponentDependencies)('voice', { reason: 'provider-enabled' });
          }
        }
        return { ok: true, gptSovits: (0, services.gptSovitsSettings)() };
      }
      case 'gptSovits.applyModels': {
        const opened = await (0, services.ensureComponent)('voice', 'gptSovits.applyModels');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'voice', error: opened.error ?? '语音合成组件无法启用' };
        // Explicit load: switch both weights, then warm the new model. This is the only place
        // that calls set_gpt_weights/set_sovits_weights; a saved path alone never loads.
        // Let a sounding sentence finish first instead of cancelling it as a side effect; only a
        // clip still playing after the bounded wait is interrupted, recorded as apply-models.
        const interrupted = await (0, services.waitForPlaybackIdle)();
        let result;
        try {
          result = await applyGptSovitsModels();
        } catch (error) {
          if (error?.name === 'AbortError') return { ok: false, cancelled: true, error: error.message };
          throw error;
        }
        const applied = {
          gptOk: result.gpt?.ok === true,
          sovitsOk: result.sovits?.ok === true,
          at: Date.now(),
          warmupMs: Number.isFinite(result.warmupMs) ? result.warmupMs : null,
          gptPath: result.gpt?.path ?? '',
          sovitsPath: result.sovits?.path ?? '',
        };
        const base = services.runtime.gptSovits !== null && typeof services.runtime.gptSovits === 'object'
          ? services.runtime.gptSovits
          : (0, services.gptSovitsSettings)();
        const stored = { ...base, applied };
        delete stored.effectiveTextLang;
        delete stored.effectivePromptLang;
        services.runtime.gptSovits = stored;
        (0, services.writeSettings)({ gptSovits: stored });
        if (result.ok) {
          await services.log.emit('tts.gptsovits.models.applied', {
            gptOk: applied.gptOk, sovitsOk: applied.sovitsOk, warmupMs: applied.warmupMs,
          });
        } else {
          const failed = result.stage === 'sovits' ? result.sovits : result.gpt;
          await services.log.emit('tts.gptsovits.models.failed', {
            stage: result.stage, status: failed?.status ?? 0, body: failed?.body ?? '',
          });
        }
        return {
          ...result,
          modelsApplied: {
            gptOk: applied.gptOk, sovitsOk: applied.sovitsOk, at: applied.at, warmupMs: applied.warmupMs,
          },
          modelsDirty: (0, services.modelsAreDirty)((0, services.gptSovitsSettings)()),
          modelsAppliedAt: applied.at,
          interrupted,
          interruptReason: interrupted ? 'apply-models' : '',
          message: interrupted ? '切换权重前等待当前播报结束超时，已打断这一句' : '',
        };
      }
      case 'langs.set': {
        const current = (0, services.langSettings)();
        const next = {
          speech: services.LANGS.includes(body.speech) ? body.speech : current.speech,
          subtitle: services.LANGS.includes(body.subtitle) ? body.subtitle : current.subtitle,
        };
        services.runtime.langs = next;
        (0, services.writeSettings)({ langs: next });
        await services.log.emit('langs.set', next);
        // A speech language changes text_lang/prompt_lang, so it is part of the warm-up identity.
        if (next.speech !== current.speech && services.runtime.gptSovits?.enabled === true) {
          (0, services.scheduleGptWarmup)(0);
        }
        return { ok: true, langs: next };
      }
  }
};
  return handler;
}
