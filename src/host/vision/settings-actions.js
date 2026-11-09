/** Settings actions for privacy, observation modes, OBS scenes and snapshots. */


export const ACTIONS = Object.freeze([
  'watch.stop',
  'privacy.toggle',
  'vision.mode',
  'vision.scenes',
  'vision.snapshot',
  'vision.watch.start',
  'vision.watch.stop',
  // P-187 阶段 5：设置页「主动回应」开关，只持久化，下一轮 evaluate 直接读新值。
  'vision.proactive',
]);

export function createVisionSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'watch.stop':
        await (0, services.stopWatch)('settings-watch-stop');
        return { ok: true, virtualCam: services.virtualCamOn };
      case 'vision.watch.start': {
        if (services.vision.mode === 'privacy') {
          return { ok: false, locked: true, error: '隐私模式已开启：需要用户手动退出隐私后才能开始观看' };
        }
        const opened = await (0, services.ensureComponent)('vision', 'vision.watch');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'vision', error: opened.error ?? '视觉组件无法启用' };
        const requested = body.source === 'obs' ? 'obs' : body.source === 'desktop' ? 'desktop' : '';
        if (requested !== '') {
          const target = requested === 'obs' ? 'scene' : 'watch';
          const switched = await (0, services.applyVisionMode)(
            target,
            requested === 'obs' ? String(body.scene ?? '') : '',
            { by: 'user' },
          );
          if (!switched.ok) return { ...switched, virtualCam: services.virtualCamOn };
        }
        await (0, services.ensureVisionModeDependencies)(services.vision.mode, 'vision.watch.start');
        try {
          const session = await (0, services.startWatcher)((0, services.visionToken)());
          return {
            ok: true,
            running: true,
            capturing: true,
            engine: session.engine,
            source: services.vision.mode === 'scene' ? 'obs' : 'desktop',
            scene: services.vision.scene,
            virtualCam: services.virtualCamOn,
          };
        } catch (error) {
          return {
            ok: false,
            running: false,
            capturing: false,
            source: services.vision.mode === 'scene' ? 'obs' : 'desktop',
            scene: services.vision.scene,
            virtualCam: services.virtualCamOn,
            error: error?.message ?? String(error),
          };
        }
      }
      case 'vision.watch.stop': {
        await (0, services.stopWatch)('settings');
        return { ok: true, running: false, capturing: false, virtualCam: services.virtualCamOn };
      }
      case 'privacy.toggle': {
        const target = services.vision.mode === 'privacy' ? 'watch' : 'privacy';
        const opened = await (0, services.ensureComponent)('vision', 'vision.privacy');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'vision', error: opened.error ?? '视觉组件无法启用' };
        await (0, services.ensureVisionModeDependencies)(target, 'vision.privacy');
        const result = await (0, services.applyVisionMode)(target, '', { by: 'user' });
        return { ...result, virtualCam: services.virtualCamOn };
      }
      case 'vision.mode': {
        if (typeof body.mode !== 'string') return { ok: false, error: '缺少 mode' };
        const opened = await (0, services.ensureComponent)('vision', 'vision.mode');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'vision', error: opened.error ?? '视觉组件无法启用' };
        await (0, services.ensureVisionModeDependencies)(body.mode, 'vision.mode');
        const result = await (0, services.applyVisionMode)(body.mode, body.scene, { by: 'user' });
        return { ...result, virtualCam: services.virtualCamOn };
      }
      case 'vision.scenes': {
        const scenes = await (0, services.refreshObsScenes)({ timeoutMs: 800 });
        return { ok: true, scenes };
      }
      case 'vision.snapshot': {
        const opened = await (0, services.ensureComponent)('vision', 'vision.snapshot');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'vision', error: opened.error ?? '视觉组件无法启用' };
        try {
          const shot = await (0, services.captureForAgent)('settings-test');
          (0, services.assertVisionToken)(services.capturedTokens.get(shot));
          return { ok: true, file: shot.file };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'vision.proactive': {
        // 契约：enabled 必须是布尔；rate 可省略（0–100 整数），省略时沿用当前值，缺省 100。
        // 只写 settings.json，不重启任何采集/运行时。
        try {
          if (typeof body.enabled !== 'boolean') {
            return { ok: false, error: 'enabled 必须是布尔值' };
          }
          const settings = (0, services.readSettings)() ?? {};
          const stored = settings.proactive !== null && typeof settings.proactive === 'object'
            && !Array.isArray(settings.proactive)
            ? settings.proactive
            : {};
          // 旧客户端只传 enabled：rate 必须保持当前值，不能被写成 undefined。
          let rate = Number.isInteger(stored.rate) && stored.rate >= 0 && stored.rate <= 100
            ? stored.rate
            : 100;
          if (body.rate !== undefined) {
            if (typeof body.rate !== 'number' || !Number.isInteger(body.rate)
              || body.rate < 0 || body.rate > 100) {
              return { ok: false, error: 'rate 必须是 0–100 的整数' };
            }
            rate = body.rate;
          }
          (0, services.writeSettings)({
            proactive: { ...stored, enabled: body.enabled, rate },
          });
          return { ok: true, enabled: body.enabled, rate };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
  }
};
  return handler;
}
