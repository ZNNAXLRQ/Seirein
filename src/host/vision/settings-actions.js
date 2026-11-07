/** Settings actions for privacy, observation modes, OBS scenes and snapshots. */


export const ACTIONS = Object.freeze([
  'watch.stop',
  'privacy.toggle',
  'vision.mode',
  'vision.scenes',
  'vision.snapshot',
]);

export function createVisionSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'watch.stop':
        await (0, services.invalidateVision)();
        return { ok: true };
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
  }
};
  return handler;
}
