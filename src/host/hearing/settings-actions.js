/** Settings actions for microphone, ambient capture, speaker shadow and call mode. */

import {
  LEXICON_CATEGORIES,
  LEXICON_READING_MAX_CHARS,
  LEXICON_TEXT_MAX_CHARS,
  LEXICON_USAGE_MAX_CHARS,
} from '../speech/lexicon-store.js';
import { lexiconKey } from '../speech/lexicon-candidates.js';

export const ACTIONS = Object.freeze([
  'hearing.start',
  'hearing.autoListen',
  'voice.speakerShadow',
  /** Opt-in, short-lived diagnosis clips: the switch is `voice.audioRetention`, off by default. */
  'voice.audioRetention',
  'audio.retention.list',
  'audio.retention.delete',
  'audio.retention.export',
  /** Shared lexicon: candidates come from conversation, only an explicit confirm makes a word. */
  'lexicon.list',
  'lexicon.candidates',
  'lexicon.confirm',
  'lexicon.add',
  'lexicon.update',
  'lexicon.move',
  'lexicon.edit',
  'lexicon.reject',
  'lexicon.remove',
  'hearing.threshold',
  'hearing.device',
  'hearing.devices.refresh',
  'ambient.start',
  'ambient.autoListen',
  'ambient.stop',
  'call.mode',
  'call.names.add',
  'call.names.remove',
  'call.names.toggle',
  'hearing.stop',
]);

export function createHearingSettingsActions(services) {
  /**
   * The one diagnosis-clip store. The Host owns it (one per plugin root); a live capture session
   * is the fallback, so the actions keep working even when only the session created the store.
   */
  const retentionStore = () => services.retentionStore ?? services.hearing?.retention ?? null;
  const RETENTION_UNAVAILABLE = Object.freeze({
    ok: false,
    code: 'AUDIO_RETENTION_UNAVAILABLE',
    error: '音频诊断保留尚未接线：需要 Host 提供 retention 存储',
  });
  /**
   * The shared lexicon store the Host owns (one per plugin root). Every action here is a thin
   * pass-through: the store decides the ambiguous/tombstone rules, and nothing is auto-confirmed
   * by listing or by a candidate arriving from a transcript. A speakerId is optional provenance;
   * it is never required to confirm.
   */
  const lexiconStore = () => services.lexiconStore ?? null;
  const LEXICON_UNAVAILABLE = Object.freeze({
    ok: false,
    code: 'LEXICON_UNAVAILABLE',
    error: '共享语言库尚未接线：需要 Host 提供 lexicon 存储',
  });
  const handler = async (body) => {
    switch (body.action) {
      case 'hearing.start': {
        // A container action opens its component first (and records the permission), then starts.
        const opened = await (0, services.openContainer)('hearing', 'hearing.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'hearing', error: opened.error ?? '听觉组件无法启用' };
        const result = await (0, services.startListening)(body.device);
        return {
          ok: result.ok,
          // The instance that actually opened: the card and the logs can name the same capture.
          ...(result.ok ? { instanceId: result.instanceId ?? '', device: result.device ?? '' } : {}),
          error: result.error ?? '',
          ...(result.ok ? {} : { code: 'START_FAILED', feature: 'hearing' }),
        };
      }
      case 'hearing.autoListen': {
        const enabled = body.enabled === true;
        const next = { ...(0, services.componentSettings)('hearing'), enabled: (0, services.componentSettings)('hearing').enabled !== false, autoListen: enabled };
        services.runtime.hearing = next;
        (0, services.writeSettings)({ hearing: next });
        if (enabled) services.hearingAutostart?.schedule();
        else services.hearingAutostart?.cancel();
        await services.log.emit('hearing.autoListen', { enabled, source: 'settings' });
        return { ok: true, autoListen: enabled };
      }
      case 'voice.speakerShadow': {
        // Observation switch only: persist, start the T1 download when needed, and restart a
        // running capture so the option reaches its `startHearing`. A failed download leaves the
        // shadow inactive; it never blocks capture or delivery.
        const enabled = body.enabled === true;
        const wasEnabled = (0, services.speakerShadowEnabled)();
        (0, services.writeSettings)({ voice: { ...(0, services.storedVoice)(), speakerShadow: enabled } });
        await services.log.emit(enabled ? 'speaker.enabled' : 'speaker.disabled', { source: 'settings' });
        if (enabled) (0, services.startSpeakerDownload)();
        (0, services.emitSpeakerStatus)(true);
        if (wasEnabled !== enabled && services.hearing !== null) {
          const device = services.hearing.device;
          await (0, services.stopListening)();
          await (0, services.startListening)(device);
        }
        return { ok: true, enabled, model: (0, services.speakerModelState)() };
      }
      case 'voice.audioRetention': {
        // Opt-in diagnosis clips, off by default. The switch is persisted first; a running store
        // follows it live, so an enabled capture starts keeping suspicious clips without a restart.
        // Turning it off stops new writes — nothing is deleted behind the user's back.
        const enabled = body.enabled === true;
        (0, services.writeSettings)({ voice: { ...(0, services.storedVoice)(), audioRetention: enabled } });
        const store = retentionStore();
        store?.setEnabled?.(enabled);
        await services.log.emit('hearing.audio.retention', { enabled, source: 'settings' });
        return { ok: true, enabled, limits: store?.limits ?? null, status: store?.status?.() ?? null };
      }
      case 'audio.retention.list': {
        // Entries only: time / utteranceId / rms / vad / text / reason / bytes. Never audio bytes.
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        return store.list();
      }
      case 'audio.retention.delete': {
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        if (body.all === true || body.id === 'all') return store.deleteAll();
        const id = String(body.id ?? '');
        if (id === '') return { ok: false, error: '需要 id 或 all=true' };
        return store.deleteOne(id);
      }
      case 'audio.retention.export': {
        // A file path for the settings page to play; the audio itself never travels in an event.
        const store = retentionStore();
        if (store === null) return RETENTION_UNAVAILABLE;
        const id = String(body.id ?? '');
        if (id === '') return { ok: false, error: '需要 id' };
        return store.exportPath(id);
      }
      case 'lexicon.list': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // Pending candidates stay visible even when already attributed: `unassigned` keeps the
        // unassigned area AND the assigned-but-unconfirmed corrections (each carries
        // `assigned:true`), so neither row is lost; `candidates` is the same full pending set.
        const candidates = store.listCandidates();
        return { ok: true, entries: store.listConfirmed(), unassigned: candidates, candidates };
      }
      case 'lexicon.candidates': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        return { candidates: store.listCandidates() };
      }
      case 'lexicon.confirm': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // speakerId is optional provenance: normalise a supplied identity (string or finite number)
        // and forward null when absent/blank, so an empty string never reaches the stored entry.
        const rawSpeakerId = body.speakerId;
        const speakerId = typeof rawSpeakerId === 'string'
          ? (rawSpeakerId.trim() === '' ? null : rawSpeakerId.trim())
          : (rawSpeakerId ?? null);
        const result = store.confirm({
          text: body.text ?? '',
          id: body.id,
          speakerId,
          canonical: body.canonical,
          context: body.context,
        });
        if (result.ok) {
          await services.log.emit('lexicon.confirmed', {
            id: result.entry?.id ?? '',
            kind: result.entry?.kind ?? '',
            assigned: result.entry?.assigned === true,
          });
        }
        return result;
      }
      case 'lexicon.add': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        // Manual add is confirmed immediately and always writes the public library unless the
        // caller explicitly names a valid slot. No speakerId/voiceprint is involved.
        const result = store.addEntry({
          text: body.text,
          canonical: body.canonical,
          category: body.category,
          usage: body.usage,
          reading: body.reading,
          library: body.library,
        });
        if (result.ok) {
          await services.log.emit('lexicon.added', {
            id: result.entry?.id ?? '',
            category: result.entry?.category ?? 'unknown',
            library: result.entry?.library ?? 'public',
          });
        }
        return result;
      }
      case 'lexicon.update': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = store.updateEntry({
          id: body.id,
          text: body.text,
          canonical: body.canonical,
          category: body.category,
          usage: body.usage,
          reading: body.reading,
        });
        if (result.ok) {
          await services.log.emit('lexicon.updated', {
            id: result.entry?.id ?? '',
            category: result.entry?.category ?? 'unknown',
            library: result.entry?.library ?? 'public',
          });
        }
        return result;
      }
      case 'lexicon.move': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = store.moveEntry({ id: body.id, library: body.library });
        if (result.ok) {
          await services.log.emit('lexicon.moved', {
            id: result.entry?.id ?? '',
            library: result.entry?.library ?? '',
          });
        }
        return result;
      }
      case 'lexicon.edit': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = store.edit({
          id: body.id,
          canonical: body.canonical,
          wrongForms: body.wrongForms,
          context: body.context,
        });
        if (result.ok) {
          await services.log.emit('lexicon.edited', {
            id: result.entry?.id ?? '',
            kind: result.entry?.kind ?? '',
          });
        }
        return result;
      }
      case 'lexicon.reject':
      case 'lexicon.remove': {
        const store = lexiconStore();
        if (store === null) return LEXICON_UNAVAILABLE;
        const result = body.action === 'lexicon.reject'
          ? store.reject({ text: body.text ?? '', id: body.id })
          : store.remove({ text: body.text ?? '', id: body.id });
        if (result.ok) {
          await services.log.emit(
            body.action === 'lexicon.reject' ? 'lexicon.rejected' : 'lexicon.removed',
            { id: result.entry?.id ?? '' },
          );
        }
        return result;
      }
      case 'hearing.threshold': {
        // Noise floor in dB: anything quieter than this counts as silence. Lower = more sensitive.
        const value = Number(body.db);
        if (!Number.isFinite(value) || value < -90 || value > -10) {
          return { ok: false, error: '阈值需在 -90 与 -10 之间' };
        }
        services.runtime.asrMinRmsDb = value;
        (0, services.writeSettings)({ asrMinRmsDb: value });
        await services.log.emit('hearing.threshold', { db: value });
        // Restart capture so the saved floor is in force from a NEW instance. The reply is the
        // restart's real outcome: a failed restart is a failed save, never `ok:true` + a quiet
        // `restarted:false` (the old bug: the settings page reported success while nothing ran).
        if (services.hearing === null) {
          services.thresholdRestart = { lastAt: new Date().toISOString(), ok: null, error: '' };
          return { ok: true, db: value, restarted: false, reason: 'not-running', minRmsDb: value };
        }
        const device = services.hearing.device;
        let restarted = null;
        try {
          await (0, services.stopListening)();
          restarted = await (0, services.startListening)(device);
        } catch (error) {
          restarted = { ok: false, error: error?.message ?? String(error) };
        }
        const restartedOk = restarted?.ok === true;
        const instanceId = restartedOk ? String(restarted.instanceId ?? '') : '';
        const error = restartedOk ? '' : (restarted?.error || '重启采集失败');
        services.thresholdRestart = { lastAt: new Date().toISOString(), ok: restartedOk, error };
        if (!restartedOk) {
          await services.log.emit('hearing.threshold.restart.failed', { db: value, device, error });
          return { ok: false, db: value, restarted: false, error, message: `重启失败：${error}` };
        }
        return {
          ok: true, db: value, restarted: true, instanceId, minRmsDb: value, message: '已生效（新实例）',
        };
      }
      case 'hearing.device': {
        const device = String(body.device ?? '');
        // A loopback endpoint would feed our own playback back: refuse it and keep the old setting.
        if (device !== '' && (0, services.isLoopbackName)(device)) {
          return { ok: false, error: 'MIC_LOOPBACK_REJECTED' };
        }
        services.runtime.asrDevice = device;
        (0, services.writeSettings)({ asrDevice: device });
        await services.log.emit('hearing.device', { device, source: 'settings' });
        return { ok: true };
      }
      case 'hearing.devices.refresh': {
        services.deviceCache = null;
        const devices = await (0, services.getDevices)();
        return { ok: true, devices, deviceList: (0, services.deviceRows)(devices) };
      }
      case 'ambient.start': {
        const opened = await (0, services.openContainer)('ambient', 'ambient.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'ambient', error: opened.error ?? '环境声音组件无法启用' };
        const result = await (0, services.startAmbient)(body.device);
        if (result.ok) services.ambientAutostart?.clearDeferred();
        return { ok: result.ok, device: result.device, source: result.source ?? '', error: result.error, ...(result.ok ? {} : { code: 'START_FAILED', feature: 'ambient' }) };
      }
      case 'ambient.autoListen': {
        const enabled = body.enabled === true;
        const next = { ...(0, services.componentSettings)('ambient'), enabled: (0, services.componentSettings)('ambient').enabled !== false, autoListen: enabled };
        services.runtime.ambient = next;
        (0, services.writeSettings)({ ambient: next });
        if (enabled) services.ambientAutostart?.schedule();
        else services.ambientAutostart?.cancel();
        await services.log.emit('ambient.autoListen', { enabled, source: 'settings' });
        return { ok: true, autoListen: enabled };
      }
      case 'ambient.stop': {
        await (0, services.stopAmbient)();
        return { ok: true };
      }
      case 'call.mode': {
        // 设置页手动切换：识别失败时的兜底。enter 仍要求至少一个启用中的称呼。
        const target = body.mode === 'call' ? 'call' : (body.mode === 'normal' ? 'normal' : '');
        if (target === '') return { ok: false, error: 'mode 必须是 call 或 normal' };
        return target === 'call' ? (0, services.enterCallMode)('settings') : (0, services.exitCallMode)('settings');
      }
      case 'call.names.add': {
        const result = services.callNameStore.add((0, services.storedVoice)(), body.text);
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason,
            error: result.error,
            conflict: result.conflict ?? null,
          };
        }
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.add', {
          id: result.item.id,
          enabled: result.item.enabled,
          chars: result.item.text.length,
        });
        return { ok: true, item: result.item, ...(0, services.callModeNames)() };
      }
      case 'call.names.remove': {
        const result = services.callNameStore.remove((0, services.storedVoice)(), body.id);
        if (!result.ok) return { ok: false, reason: result.reason, error: result.error };
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.remove', { id: result.item.id });
        return { ok: true, removed: result.item.id, ...(0, services.callModeNames)() };
      }
      case 'call.names.toggle': {
        const result = services.callNameStore.toggle((0, services.storedVoice)(), body.id, body.enabled);
        if (!result.ok) return { ok: false, reason: result.reason, error: result.error };
        (0, services.saveCallNames)(result.callNames);
        await services.log.emit('call.names.toggle', {
          id: result.item.id,
          enabled: result.item.enabled,
          changed: result.changed === true,
        });
        return { ok: true, item: result.item, ...(0, services.callModeNames)() };
      }
      case 'hearing.stop':
        await (0, services.stopListening)();
        return { ok: true };
  }
};
  return handler;
}

/**
 * Chinese/English labels accepted by `/word` and shown by the form/listing. The canonical stored
 * values are the English enum ids in `LEXICON_CATEGORIES`; labels are only an input/display alias.
 */
export const LEXICON_CATEGORY_LABELS = Object.freeze({
  person: '人名',
  character: '角色',
  work: '作品',
  place: '地点',
  term: '术语',
  expression: '特殊表达',
  meme: '梗',
  unknown: '未知',
});

const CATEGORY_ALIASES = new Map();
for (const category of LEXICON_CATEGORIES) {
  CATEGORY_ALIASES.set(category, category);
  CATEGORY_ALIASES.set(LEXICON_CATEGORY_LABELS[category], category);
}
// Friendly synonyms beyond the canonical labels.
for (const [alias, category] of [
  ['人物', 'person'],
  ['人名', 'person'],
  ['角色', 'character'],
  ['作品', 'work'],
  ['地点', 'place'],
  ['地方', 'place'],
  ['术语', 'term'],
  ['专有名词', 'term'],
  ['表达', 'expression'],
  ['特殊表达', 'expression'],
  ['梗', 'meme'],
  ['网络梗', 'meme'],
  ['其他', 'unknown'],
  ['未知', 'unknown'],
]) {
  if (!CATEGORY_ALIASES.has(alias)) CATEGORY_ALIASES.set(alias, category);
}

export const WORD_COMMAND_USAGE = '/word "词或短语" <类别> "用法" [读音]';
const WORD_CATEGORY_HINT = LEXICON_CATEGORIES
  .map((category) => `${LEXICON_CATEGORY_LABELS[category]}=${category}`)
  .join('、');

/**
 * Split `/word` input on whitespace while honoring "double", 'single', “curly”, 「corner」 and
 * 『corner』 quotes, so a usage phrase may contain spaces without becoming extra arguments.
 *
 * @param {unknown} rawInput everything after `/word`
 * @returns {{ok: true, tokens: string[]}|{ok: false, error: string}}
 */
export function tokenizeWordCommand(rawInput) {
  const source = typeof rawInput === 'string' ? rawInput : '';
  const tokens = [];
  let current = '';
  let started = false;
  let close = '';
  const closingOf = (char) => ({
    '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』',
  })[char] ?? '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (close !== '') {
      if (char === close) {
        close = '';
        continue;
      }
      if (char === '\\' && (source[index + 1] === close || source[index + 1] === '\\')) {
        current += source[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    const closing = closingOf(char);
    if (closing !== '') {
      close = closing;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (close !== '') return { ok: false, error: '引号没有闭合，请检查参数。' };
  if (started) tokens.push(current);
  return { ok: true, tokens };
}

/**
 * Parse the `/word` arguments. Category and usage are REQUIRED and are never guessed: an
 * incomplete call tells the user exactly what is missing. Reading is optional (auto-generation
 * may leave it blank, and the user can add it later).
 *
 * @param {unknown} rawInput everything after `/word`
 * @returns {{ok: true, value: {text: string, category: string, usage: string, reading: string}}
 *   | {ok: false, error: string}}
 */
export function parseWordCommand(rawInput) {
  const tokenized = tokenizeWordCommand(rawInput);
  if (tokenized.ok !== true) return tokenized;
  const tokens = tokenized.tokens;
  if (tokens.length === 0) {
    return { ok: false, error: `缺少词、类别和用法。用法：${WORD_COMMAND_USAGE}` };
  }
  if (tokens.length > 4) {
    return { ok: false, error: `参数过多。用法：${WORD_COMMAND_USAGE}（含空格的用法请加引号）` };
  }
  const [text, categoryInput, usage, reading = ''] = tokens;
  const display = String(text ?? '').trim();
  if (display.length === 0) return { ok: false, error: '词或短语不能为空。' };
  if ([...display].length > LEXICON_TEXT_MAX_CHARS) {
    return { ok: false, error: `词或短语最多 ${LEXICON_TEXT_MAX_CHARS} 个字符。` };
  }
  if (categoryInput === undefined || categoryInput.trim() === '') {
    return { ok: false, error: `缺少类别。可用类别：${WORD_CATEGORY_HINT}` };
  }
  const category = CATEGORY_ALIASES.get(categoryInput.trim())
    ?? CATEGORY_ALIASES.get(categoryInput.trim().toLowerCase());
  if (category === undefined) {
    return { ok: false, error: `类别「${categoryInput}」无效。可用类别：${WORD_CATEGORY_HINT}` };
  }
  if (usage === undefined || String(usage).trim() === '') {
    return { ok: false, error: `缺少用法说明。用法：${WORD_COMMAND_USAGE}` };
  }
  const usageText = String(usage).trim();
  if ([...usageText].length > LEXICON_USAGE_MAX_CHARS) {
    return { ok: false, error: `用法说明最多 ${LEXICON_USAGE_MAX_CHARS} 个字符。` };
  }
  const readingText = String(reading ?? '').trim();
  if ([...readingText].length > LEXICON_READING_MAX_CHARS) {
    return { ok: false, error: `读音最多 ${LEXICON_READING_MAX_CHARS} 个字符。` };
  }
  return {
    ok: true,
    value: { text: display, category, usage: usageText, reading: readingText },
  };
}

/**
 * Build the `/word` command definition for the DSH commands service. Only the public library is
 * written; a successful result names the editable entry id. The caller registers it with
 * `ctx.get('commands')?.register(definition)` (guarded because the service is optional).
 *
 * @param {{store?: object|null, log?: object|null}} [options]
 * @returns {{name: string, description: string, input: {hint: string},
 *   handler: (invocation: {rawInput?: string}) => Promise<object>}}
 */
export function createWordCommandDefinition({ store = null, log = null } = {}) {
  return Object.freeze({
    name: 'word',
    description: '添加一条共享词库词条（公共库，可直接在设置页编辑）',
    input: { hint: '词或短语 类别 "用法" [读音]' },
    async handler(invocation) {
      const parsed = parseWordCommand(invocation?.rawInput ?? '');
      if (parsed.ok !== true) return { kind: 'error', text: parsed.error };
      if (store === null || typeof store.addEntry !== 'function') {
        return { kind: 'error', text: '共享词库尚未接线：宿主没有 lexicon 存储。' };
      }
      const added = store.addEntry({ ...parsed.value, library: 'public' });
      if (added?.ok !== true) {
        if (added?.reason === 'exists') {
          let existingId = '';
          try {
            const key = lexiconKey(parsed.value.text);
            const existing = store.list().find((entry) => entry?.key === key
              || (typeof entry?.canonical === 'string' && entry.canonical.length > 0 && lexiconKey(entry.canonical) === key));
            existingId = typeof existing?.id === 'string' ? existing.id : '';
          } catch {
            /* the duplicate message is still useful without an id */
          }
          return {
            kind: 'error',
            text: `词条已存在${existingId === '' ? '' : `（ID ${existingId}）`}；请到设置页编辑，而不是重复添加。`,
          };
        }
        return { kind: 'error', text: `添加失败：${added?.reason ?? 'unknown'}` };
      }
      try {
        void log?.emit?.('lexicon.command.word', {
          id: added.entry?.id ?? '',
          category: added.entry?.category ?? 'unknown',
          library: 'public',
        })?.catch?.(() => {});
      } catch {
        /* logging must never fail the command */
      }
      const label = LEXICON_CATEGORY_LABELS[added.entry?.category] ?? added.entry?.category ?? '未知';
      return {
        kind: 'success',
        text: `已加入公共词库：「${added.entry?.canonical || added.entry?.text || parsed.value.text}」（${label}）· ID ${added.entry?.id ?? ''}。可在 设置 → 记忆与人设 → 共享词库 中编辑或移动。`,
      };
    },
  });
}

/**
 * The optional "本人" speaker id used as provenance for the shared lexicon: `voice.selfSpeakerId`
 * from settings.json (written by the user or a later voiceprint registration) wins; otherwise a
 * speaker-shadow `match` supplies it; otherwise there is no identity. This is never a confirmation
 * gate — the lexicon is shared, and an entry may be confirmed with no speaker id at all. Pure, so
 * the Host can project it from a settings snapshot and the live shadow verdict without extra state.
 *
 * @param {{settings?: object, shadow?: object|null}} [evidence]
 * @returns {{speakerId: string|null, source: 'setting'|'shadow'|null}}
 */
export function resolveSelfSpeakerId({ settings = {}, shadow = null } = {}) {
  const saved = settings?.voice?.selfSpeakerId;
  if (typeof saved === 'string' && saved.trim() !== '') {
    return { speakerId: saved.trim(), source: 'setting' };
  }
  if (shadow?.decision === 'match'
    && typeof shadow?.speakerId === 'string'
    && shadow.speakerId.trim() !== '') {
    return { speakerId: shadow.speakerId.trim(), source: 'shadow' };
  }
  return { speakerId: null, source: null };
}

/**
 * The hearing block of `/assistant/status`, projected over the live capture instance.
 *
 * `base` is the status builder's own block (kept as-is). The session owns the evidence the card
 * needs: `instanceId` (which capture session is running) and `minRmsDb` (the floor it resolves
 * *now* — a live getter, so a saved value is visible even before a restart lands). The last
 * threshold-save restart is kept here too, because the action reply is transient while a failed
 * restart must stay visible; `ok: null` means "no restart attempted" (capture was not running).
 * `fallbackMinRmsDb` is the floor the next `startHearing` would begin with while stopped.
 */
export function projectHearingStatus(base, { session = null, restart = null, fallbackMinRmsDb = -50 } = {}) {
  let live = Number.NaN;
  try {
    if (typeof session?.minRmsDb === 'function') live = Number(session.minRmsDb());
  } catch {
    /* a status read must never fail because a session probe did */
  }
  const fallback = Number(fallbackMinRmsDb);
  return {
    ...(base ?? {}),
    instanceId: typeof session?.instanceId === 'string' ? session.instanceId : '',
    minRmsDb: Number.isFinite(live) ? live : (Number.isFinite(fallback) ? fallback : -50),
    thresholdRestart: restart ?? { lastAt: null, ok: null, error: '' },
  };
}

