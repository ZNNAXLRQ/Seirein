/** Settings actions for component switches, dependency startup, diagnostics and hotkeys. */
import { DEFAULT_HOTKEYS } from '../../platform/hotkeys.js';
import { HOTKEY_ACTIONS } from '../../platform/hotkeys.js';
import { parseBinding } from '../../platform/hotkeys.js';

export const ACTIONS = Object.freeze([
  'pick.file',
  'autostart.set',
  'autostart.pick',
  'autostart.run',
  'hotkey.set',
  'hotkey.reset',
  'feature.set',
  'diagnostics.query',
]);

export function createRuntimeSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'pick.file': {
        const kind = body.kind === 'audio' || body.kind === 'model' || body.kind === 'script'
          ? body.kind
          : 'exe';
        const picked = await (0, services.pickFile)({ kind });
        if (picked.error !== '') {
          await services.log.emit('pick.file.failed', { kind, error: picked.error });
          return { ok: false, path: '', error: picked.error };
        }
        await services.log.emit('pick.file', { kind, path: picked.path });
        return { ok: true, kind, path: picked.path, cancelled: picked.path.length === 0 };
      }
      case 'autostart.set': {
        const isTarget = services.AUTOSTART_TARGETS.some((entry) => entry.target === body.target);
        if (!isTarget) return { ok: false, error: 'unknown target' };
        const saved = (0, services.autostartSettings)();
        const current = saved[body.target];
        const updated = {
          ...current,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        };
        if (typeof body.autoClose === 'boolean') updated.autoClose = body.autoClose;
        if (body.target === 'gptsovits') {
          for (const key of ['pythonPath', 'scriptPath', 'workDir']) {
            if (typeof body[key] === 'string') updated[key] = body[key];
          }
          if (body.port !== undefined) {
            const port = Number(body.port);
            if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
              return { ok: false, error: '端口需要在 1–65535 之间' };
            }
            updated.port = port;
          }
        } else if (typeof body.path === 'string') {
          updated.path = body.path;
        }
        const next = { ...saved, [body.target]: updated };
        services.runtime.autostart = next;
        (0, services.writeSettings)({ autostart: next });
        await services.log.emit('autostart.set', {
          target: body.target,
          enabled: updated.enabled,
          path: body.target === 'gptsovits' ? updated.scriptPath : updated.path,
          source: 'settings',
        });
        return { ok: true, autostart: (0, services.autostartStatus)() };
      }
      case 'autostart.pick': {
        if (body.target !== 'obs' && body.target !== 'vts') return { ok: false, path: '', error: 'unknown target' };
        const picked = await (0, services.pickCompanionPath)(body.target);
        if (picked.error !== '') {
          await services.log.emit('autostart.pick.failed', { target: body.target, error: picked.error });
          return { ok: false, path: '', error: picked.error };
        }
        // Empty path means the user cancelled the dialog, which is not an error.
        await services.log.emit('autostart.pick', { target: body.target, path: picked.path });
        return { ok: true, target: body.target, path: picked.path, cancelled: picked.path.length === 0 };
      }
      case 'autostart.run': {
        // Manual one-shot for testing the configured paths; same code path as plugin launch.
        const wanted = services.AUTOSTART_TARGETS.filter(
          (entry) => typeof body.target !== 'string' || entry.target === body.target,
        );
        const results = [];
        for (const { target } of wanted) {
          if (!services.features.enabled(services.AUTOSTART_COMPONENT[target])) {
            results.push({ target, started: false, running: false, error: '所属组件已关闭' });
            continue;
          }
          results.push(await (0, services.startCompanion)(target));
        }
        return { ok: true, results, autostart: (0, services.autostartStatus)() };
      }
      case 'hotkey.set': {
        const targetName = body.name;
        if (typeof targetName !== 'string' || !HOTKEY_ACTIONS.includes(targetName)) {
          return { ok: false, error: `unknown hotkey: ${String(targetName)}` };
        }
        try {
          parseBinding(body.combo);
        } catch (error) {
          return { ok: false, error: error.message };
        }
        services.hotkeyState.bindings = { ...services.hotkeyState.bindings, [targetName]: body.combo };
        (0, services.saveBindings)(services.hotkeyState.bindings);
        services.poller.refresh(services.hotkeyState.bindings);
        await services.log.emit('hotkey.bindings', { name: targetName, combo: body.combo, source: 'settings' });
        return { ok: true };
      }
      case 'hotkey.reset':
        services.hotkeyState.bindings = { ...DEFAULT_HOTKEYS };
        (0, services.saveBindings)(services.hotkeyState.bindings);
        services.poller.refresh(services.hotkeyState.bindings);
        await services.log.emit('hotkey.bindings', { reset: true, source: 'settings' });
        return { ok: true };
      case 'feature.set': {
        try {
          if (body.id === 'voice' && body.enabled !== true) (0, services.cancelFastReply)('voice-disabled');
          const next = await services.features.set(body.id, body.enabled === true, { reason: `settings:${String(body.id)}` });
          await services.log.emit('feature.set', { id: body.id, enabled: next, source: 'settings' });
          return { ok: true, enabled: next };
        } catch (error) {
          return {
            ok: false,
            code: 'FEATURE_TRANSITION_FAILED',
            error: error?.message ?? String(error),
            enabled: services.features.enabled(String(body.id)) === true,
            hookError: services.features.lastHookError,
          };
        }
      }
      case 'diagnostics.query': {
        // Read-only, bounded, whitelisted probes. Disabled by default; see diagnosticsEnabled().
        return services.diagnostics.query({ probe: body.probe, limit: body.limit });
      }
  }
};
  return handler;
}
