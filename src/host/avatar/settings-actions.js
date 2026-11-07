/** Settings actions for Live2D, transparent backends and geometry editing. */


export const ACTIONS = Object.freeze([
  'avatarLayer.start',
  'layer.edit.enter',
  'avatarLayer.adjust.start',
  'layer.edit.exit',
  'avatarLayer.adjust.finish',
  'avatarLayer.stop',
  'avatarLayer.edit',
  'avatarLayer.set',
  'spoutLayer.start',
  'spoutLayer.stop',
  'spoutLayer.status',
  'layer.backend',
  'live2d.connect',
  'live2d.hotkey',
  'live2d.expression',
  'avatar.capabilities.refresh',
  'transparent.start',
  'transparent.stop',
]);

export function createAvatarSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'avatarLayer.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const result = await layer.start();
        await services.log.emit('avatarLayer.start', result);
        return { ok: result.ok, ...layer.snapshot() };
      }
      case 'layer.edit.enter':
      case 'avatarLayer.adjust.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'layer.edit.enter');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        return await services.layerEdit.enter();
      }
      case 'layer.edit.exit':
      case 'avatarLayer.adjust.finish': {
        return await services.layerEdit.exit();
      }
      case 'avatarLayer.stop': {
        await services.avatarLayerController?.stop();
        await services.log.emit('avatarLayer.stop', {});
        if (services.transparentChild === null && services.spoutLayer.snapshot().running !== true) (0, services.keepAvatarGeometry)();
        return { ok: true };
      }
      case 'avatarLayer.edit': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.edit');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const snapshot = await layer.setEditMode(body.enabled === true);
        if (snapshot?.geometry) {
          if (snapshot.editMode === true) (0, services.publishEditGeometry)(snapshot.geometry);
          else if (snapshot.running === true) services.subtitleGeometry.set(snapshot.geometry, 'wpf');
        }
        return { ok: true, ...snapshot };
      }
      case 'avatarLayer.set': {
        const opened = await (0, services.ensureComponent)('avatar', 'avatarLayer.set');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const layer = (0, services.ensureAvatarLayer)();
        const snapshot = await layer.setGeometry(body.geometry ?? {});
        if (snapshot?.running === true && snapshot.geometry) services.subtitleGeometry.set(snapshot.geometry, 'wpf');
        return { ok: true, ...snapshot };
      }
      case 'spoutLayer.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'spoutLayer.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        // Optional path from the settings card: persist first so a restart keeps the choice.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        // The receiver watchdog is a latency budget, not a constant: persist an override when the
        // caller supplies one (ms), and let spoutLayer clamp it.
        const receiverTimeoutMs = Number(body.receiverTimeoutMs);
        if (Number.isFinite(receiverTimeoutMs) && receiverTimeoutMs >= 1000 && receiverTimeoutMs <= 120_000) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), receiverTimeoutMs: Math.round(receiverTimeoutMs) };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const result = await services.spoutLayer.start();
        await services.log.emit('spoutLayer.start', {
          ok: result.ok,
          code: result.code ?? '',
          pid: result.pid ?? 0,
          phase: result.readyPhase ?? '',
        });
        // Spout publishes the same unified record as WPF; the bubble never depends on WPF here.
        if (result.ok === true) (0, services.observeAvatarGeometry)({ editing: false });
        return result;
      }
      case 'spoutLayer.stop': {
        // An editing session leaves edit mode first, so its final rectangle is not lost. The
        // display is not autostarted: it is about to be stopped.
        await (0, services.leaveSpoutEditForStop)();
        const result = await services.spoutLayer.stop();
        await services.log.emit('spoutLayer.stop', {
          stopped: result.stopped === true,
          killed: result.killed === true,
          how: result.how ?? '',
          elapsedMs: result.elapsedMs ?? 0,
        });
        (0, services.keepAvatarGeometry)();
        return result;
      }
      case 'spoutLayer.status': {
        // "检测" button: persist the typed path, then run the full check (含 --version 探活).
        // Read-only for the running process: this never starts or stops the layer.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const probe = await services.spoutLayer.validateConfigured();
        return { ok: true, probe, ...services.spoutLayer.snapshot() };
      }
      case 'layer.backend': {
        const opened = await (0, services.ensureComponent)('avatar', 'layer.backend');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        // Persist a typed Spout path first (same rule as spoutLayer.start/status), then switch
        // with single ownership: availability check → stop old → confirmed exit → start new.
        const exe = typeof body.electronExecutable === 'string' ? body.electronExecutable.trim() : '';
        if (exe.length > 0) {
          services.runtime.spoutLayer = { ...(services.runtime.spoutLayer ?? {}), electronExecutable: exe };
          (0, services.writeSettings)({ spoutLayer: services.runtime.spoutLayer });
        }
        const result = await services.layerSwitch.set(body.backend);
        await services.log.emit('layer.backend', {
          ok: result.ok === true,
          backend: result.backend ?? '',
          code: result.code ?? '',
          error: result.error ?? '',
        });
        return result;
      }
      case 'live2d.connect': {
        const opened = await (0, services.ensureComponent)('avatar', 'live2d.connect');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const result = await (0, services.vtsConnect)();
        return {
          ok: result.ok === true,
          ready: services.vts?.ready === true,
          socketOpen: services.vts?.connected === true,
          model: services.vts?.model?.modelName ?? '',
          modelId: services.vts?.modelId ?? '',
          hotkeys: (services.vts?.hotkeys ?? []).map((entry) => entry.name),
          expressions: (services.vts?.expressions ?? []).map((entry) => entry.name),
          error: result.error ?? '',
        };
      }
      case 'live2d.hotkey': {
        try {
          const opened = await (0, services.ensureComponent)('avatar', 'live2d.hotkey');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
          const client = (0, services.vtsClient)();
          if (!client.ready) await (0, services.vtsConnect)();
          const name = await client.triggerHotkey(body.name ?? '');
          await services.log.emit('live2d.action', { action: 'hotkey', name, source: 'settings' });
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'live2d.expression': {
        try {
          const opened = await (0, services.ensureComponent)('avatar', 'live2d.expression');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
          const client = (0, services.vtsClient)();
          if (!client.ready) await (0, services.vtsConnect)();
          const name = await client.triggerExpression(body.name ?? '');
          await services.log.emit('live2d.action', { action: 'expression', name, source: 'settings' });
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'avatar.capabilities.refresh': {
        // Re-probe VTS: which input parameters exist decides which channels can be driven at all.
        // Kept gated (not auto-enabled): this is a host diagnostic, so a disabled component gets
        // a machine-readable refusal instead of silently turning itself on.
        if (!services.features.enabled('avatar')) {
          return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: '形象组件已关闭：请先在「组件开关」里启用形象' };
        }
        const client = (0, services.vtsClient)();
        if (!client.ready) {
          const connected = await (0, services.vtsConnect)();
          if (!connected.ok) return { ok: false, error: connected.error ?? '未连接 VTube Studio' };
        }
        const result = await (0, services.discoverAvatarCapabilities)({ force: true, reason: 'settings' });
        return {
          ok: result.ok === true,
          mapped: result.mapped ?? [],
          verified: result.verified ?? [],
          unmapped: result.unmapped ?? [],
          channels: result.channels ?? [],
          inputs: result.inputs ?? {},
          model: result.model ?? null,
          error: result.error ?? '',
        };
      }
      case 'transparent.start': {
        const opened = await (0, services.ensureComponent)('avatar', 'transparent.start');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'avatar', error: opened.error ?? '形象组件无法启用' };
        const result = await (0, services.startTransparentLayer)({
          left: body.left,
          top: body.top,
          width: body.width,
          height: body.height,
        });
        return { ok: true, ...result };
      }
      case 'transparent.stop':
        await (0, services.stopTransparentLayer)();
        return { ok: true, running: false };
  }
};
  return handler;
}
