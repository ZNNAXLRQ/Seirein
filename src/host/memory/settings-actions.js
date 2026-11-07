/** Settings actions for memory maintenance, archives and fixed resources. */
import { normalizeAutoMemory } from './store.js';

export const ACTIONS = Object.freeze([
  'memory.maintain',
  'memory.compact',
  'memory.auto',
  'memory.archive.list',
  'memory.archive.delete',
  'resource.set',
  'resource.get',
  'resource.delete',
]);

export function createMemorySettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'memory.maintain': {
        const result = await (0, services.runMemoryMaintain)();
        return { ok: true, ...result };
      }
      case 'memory.compact': {
        const result = services.memory.compact({ targetRatio: 0.85 });
        await services.log.emit('memory.compact', result);
        return { ok: true, ...result };
      }
      case 'memory.auto': {
        // Partial update: only the keys the settings card sends are touched.
        const next = normalizeAutoMemory({
          ...(0, services.autoMemorySettings)(),
          ...(body.auto !== null && typeof body.auto === 'object' ? body.auto : {}),
        });
        (0, services.writeSettings)({ autoMemory: next });
        await services.log.emit('memory.auto.config', next);
        return { ok: true, autoMemory: next };
      }
      case 'memory.archive.list': {
        const items = services.memory.listArchive({
          query: typeof body.query === 'string' ? body.query : '',
          limit: Number.isInteger(body.limit) ? Math.min(100, Math.max(1, body.limit)) : 30,
          offset: Number.isInteger(body.offset) ? Math.max(0, body.offset) : 0,
        });
        return { ok: true, items };
      }
      case 'memory.archive.delete': {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
        const result = services.memory.deleteArchived(ids);
        await services.log.emit('memory.archive.delete', { ids: ids.length, deleted: result.deleted });
        return { ok: true, ...result };
      }
      case 'resource.set': {
        if (typeof body.key !== 'string' || body.key.trim().length === 0) {
          return { ok: false, error: 'key 不能为空' };
        }
        if (typeof body.value !== 'string') return { ok: false, error: 'value 不能为空' };
        const saved = await services.resources.set({
          key: body.key.trim(),
          value: body.value,
          kind: typeof body.kind === 'string' ? body.kind : 'note',
          title: typeof body.title === 'string' ? body.title : '',
          tags: typeof body.tags === 'string' ? body.tags : '',
          secret: body.secret === true,
        });
        await services.log.emit('resource.set', {
          key: saved.key,
          kind: saved.kind,
          secret: saved.secret,
          source: 'settings',
        });
        return { ok: true };
      }
      case 'resource.get': {
        const row = await services.resources.get(body.key, { reveal: body.reveal === true });
        if (row === null) return { ok: false, error: 'not found' };
        return {
          ok: true,
          resource: {
            key: row.key,
            kind: row.kind,
            title: row.title,
            tags: row.tags,
            secret: row.secret,
            value: row.value,
          },
        };
      }
      case 'resource.delete': {
        const removed = services.resources.forget(body.key);
        await services.log.emit('resource.forget', { key: body.key, removed, source: 'settings' });
        return { ok: true, removed };
      }
  }
};
  return handler;
}
