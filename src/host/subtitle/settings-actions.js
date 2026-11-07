/** Settings actions for subtitle configuration, regions and previews. */


export const ACTIONS = Object.freeze([
  'subtitle.select',
  'subtitle.config',
  'subtitle.region',
  'subtitle.preview',
  'subtitle.hide',
  'subtitle.fonts.refresh',
]);

export function createSubtitleSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'subtitle.select': {
        const opened = await (0, services.openContainer)('subtitle', 'subtitle.select');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'subtitle', error: opened.error ?? '字幕组件无法启用' };
        const overlay = (0, services.ensureSubtitle)();
        const region = await overlay.select();
        if (region === null) return { ok: false, error: '没有选择区域' };
        services.runtime.subtitle = { ...(0, services.subtitleSettings)(), enabled: true, region };
        (0, services.writeSettings)({ subtitle: services.runtime.subtitle });
        await services.log.emit('subtitle.region', { region });
        return { ok: true, region };
      }
      case 'subtitle.config': {
        if (body.enabled === true) {
          const opened = await (0, services.openContainer)('subtitle', 'subtitle.config.enable');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'subtitle', error: opened.error ?? '字幕组件无法启用' };
        } else if (services.features.enabled('subtitle') !== true && typeof body.enabled !== 'boolean') {
          // Editing the card's font/mode while the component is off is still a container action:
          // enable the parent first, never write a container-only change under a disabled parent.
          const opened = await (0, services.ensureComponent)('subtitle', 'subtitle.config');
          if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'subtitle', error: opened.error ?? '字幕组件无法启用' };
        }
        const current = (0, services.subtitleSettings)();
        const next = { ...current };
        if (typeof body.font === 'string' && body.font.trim().length > 0) next.font = body.font.trim();
        if (Number.isInteger(body.sizeMax)) next.sizeMax = Math.min(96, Math.max(12, body.sizeMax));
        if (body.colorMode === 'auto' || body.colorMode === 'manual') next.colorMode = body.colorMode;
        if (body.mode === 'region' || body.mode === 'bubble') next.mode = body.mode;
        if (Number.isInteger(body.holdMs)) next.holdMs = Math.min(10_000, Math.max(0, body.holdMs));
        if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
        services.runtime.subtitle = next;
        (0, services.writeSettings)({ subtitle: next });
        await services.log.emit('subtitle.config', { font: next.font, sizeMax: next.sizeMax, colorMode: next.colorMode, mode: next.mode, enabled: next.enabled });
        return { ok: true };
      }
      case 'subtitle.region': {
        const opened = await (0, services.openContainer)('subtitle', 'subtitle.region');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'subtitle', error: opened.error ?? '字幕组件无法启用' };
        const r = body.region ?? {};
        const region = {
          x: Math.round(Number(r.x ?? 0)),
          y: Math.round(Number(r.y ?? 0)),
          w: Math.round(Number(r.w ?? 0)),
          h: Math.round(Number(r.h ?? 0)),
        };
        if (region.w < 40 || region.h < 30) return { ok: false, error: '区域太小' };
        services.runtime.subtitle = { ...(0, services.subtitleSettings)(), enabled: true, region };
        (0, services.writeSettings)({ subtitle: services.runtime.subtitle });
        await services.log.emit('subtitle.region', { region });
        return { ok: true, region };
      }
      case 'subtitle.preview': {
        const opened = await (0, services.openContainer)('subtitle', 'subtitle.preview');
        if (!opened.ok) return { ok: false, code: 'FEATURE_DISABLED', feature: 'subtitle', error: opened.error ?? '字幕组件无法启用' };
        const shown = await (0, services.showSubtitle)(
          '这是一段字幕预览：字号会按你设定的上限显示，超出区域时才自动缩小。',
          6000,
        );
        return { ok: shown, error: shown ? '' : '字幕未开启或未选择区域' };
      }
      case 'subtitle.hide': {
        // Same generation rule as an interruption: a probe-late show cannot repaint after this.
        const generation = (0, services.nextSubtitleGeneration)();
        await services.subtitleOverlay?.hide({ generation });
        return { ok: true };
      }
      case 'subtitle.fonts.refresh': {
        // Force a fresh registry read: the picker must see a font installed after startup.
        const total = (await services.subtitleFontCatalog.refresh()).length;
        const snapshot = services.subtitleFontCatalog.snapshot();
        return { ok: true, fonts: snapshot.fonts, truncated: snapshot.truncated, total };
      }
  }
};
  return handler;
}
