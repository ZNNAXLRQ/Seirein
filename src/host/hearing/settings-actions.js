/** Settings actions for microphone, ambient capture, speaker shadow and call mode. */


export const ACTIONS = Object.freeze([
  'hearing.start',
  'hearing.autoListen',
  'voice.speakerShadow',
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

