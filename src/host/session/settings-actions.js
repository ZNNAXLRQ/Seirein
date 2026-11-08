/** Settings actions for conversation continuity, workspace scope and fast-path history. */
import { UNGROUPED_DOMAIN } from './inference/fastpath.js';
import { groupByDomain } from './inference/fastpath.js';
import { normalizeTurnDomain } from './inference/fastpath.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

export const ACTIONS = Object.freeze([
  'client.hello',
  'client.ping',
  'rollover.ack',
  'rollover.check',
  'rollover.force',
  'scope.set',
  'fastpath.test',
  'fastpath.voice',
  'conversation.list',
  'conversation.delete',
  'fastpath.history',
  'fastpath.clear',
]);

export function createSessionSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'client.hello': {
        // Diagnostics: proves which client bundle the page actually loaded.
        const version = typeof body.version === 'string' ? body.version : '';
        await services.log.emit('client.hello', { version });
        return { ok: true, host: services.PLUGIN_VERSION };
      }
      case 'client.ping': {
        // Page presence is diagnostic only, kept for older bundles. It no longer routes voice:
        // a focused GUI changes the subtitle/playback surface, never the voice delivery target.
        return { ok: true };
      }
      case 'rollover.ack': {
        // The web UI opened the new dated session and typed the digest in.
        services.pendingRollover = null;
        services.runtime.pendingRollover = null;
        (0, services.writeSettings)({ pendingRollover: null });
        return { ok: true };
      }
      case 'rollover.check': {
        await (0, services.checkRollover)();
        return { ok: true, rollover: services.pendingRollover };
      }
      case 'rollover.force': {
        // Rebuild today's continuity digest on demand. This only writes the stored value: the
        // target assistant session's first request reads it at `agent/pre-step`, so no turn is
        // opened here and no message is delivered to any session.
        const day = (0, services.dayStamp)();
        const digest = (0, services.buildRolloverDigest)();
        (0, services.writeSettings)({ dayDigest: { date: day.date, digest } });
        (0, services.writeMemoryState)({ lastRollover: day.date });
        services.pendingRollover = null;
        services.runtime.pendingRollover = null;
        (0, services.writeSettings)({ pendingRollover: null });
        await services.log.emit('session.rollover', { date: day.date, forced: true, chars: digest.length, mode: 'prompt' });
        return { ok: true, date: day.date, chars: digest.length, digest, sessionId: day.sessionId, title: day.title };
      }
      case 'scope.set': {
        // Optional containment: persona/memory only for sessions inside one directory.
        const current = (0, services.workspaceScope)();
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled;
        let path = current.path;
        if (typeof body.path === 'string') {
          const raw = body.path.trim();
          if (raw.length === 0) return { ok: false, error: '作用域路径不能为空' };
          if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(raw)) return { ok: false, error: '需要绝对路径' };
          let normalized = resolve(raw).replace(/[\\/]+$/u, '');
          // A drive root keeps its separator, otherwise "D:" would mean "cwd on D:".
          if (/^[A-Za-z]:$/u.test(normalized)) normalized = `${normalized}\\`;
          path = normalized;
        }
        const next = { enabled, path };
        services.runtime.workspaceScope = next;
        (0, services.writeSettings)({ workspaceScope: next });
        await services.log.emit('workspace.scope', next);
        return { ok: true, workspaceScope: next };
      }
      case 'fastpath.test': {
        if (!services.features.enabled('fastpath')) return { ok: false, error: '快路组件已关闭' };
        const text = String(body.text ?? '').trim();
        if (text.length === 0) return { ok: false, error: '请输入一句话' };
        try {
          const result = await services.fastPath.ask(text);
          return {
            ok: true,
            reply: result.reply,
            provider: result.provider,
            model: result.model,
            ms: result.ms,
          };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'fastpath.voice': {
        if (!services.features.enabled('fastpath')) return { ok: false, error: '快路组件已关闭' };
        if (!services.features.enabled('voice')) return { ok: false, error: '语音合成组件已关闭' };
        const text = String(body.text ?? '').trim();
        if (text.length === 0) return { ok: false, error: '请输入一句话' };
        try {
          const result = await (0, services.runFastReply)(text);
          if (result === null) return { ok: false, error: '没有产生回复（看事件日志）' };
          return {
            ok: true,
            reply: result.reply,
            provider: result.provider,
            model: result.model,
            ms: result.ms,
          };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      }
      case 'conversation.list': {
        return { ok: true, items: services.fastPath.list({ query: body.query, limit: body.limit }) };
      }
      case 'conversation.delete': {
        const ts = Number(body.ts);
        const role = String(body.role ?? '');
        const removed = services.fastPath.remove({ ts, role });
        if (removed > 0) await services.log.emit('conversation.delete', { ts, role, removed });
        return { ok: true, removed };
      }
      case 'fastpath.history': {
        // Read-only grouped review, SCOPED: only this workspace's ID, its configured default and
        // explicitly allowed domains are readable, so another workspace's group never appears.
        // Legacy '' rows belong to no scope and stay visible as 「未分组」(`label` is display-only).
        const scope = (0, services.fastpathScope)();
        const readable = new Set([UNGROUPED_DOMAIN, ...scope.allowed]);
        const filterDomain = typeof body.domain === 'string' ? normalizeTurnDomain(body.domain) : null;
        const entries = services.fastPath.readAll()
          .filter((entry) => readable.has(entry.domain))
          .filter((entry) => filterDomain === null || entry.domain === filterDomain)
          .map((entry) => ({
            ts: Number(entry.ts ?? 0),
            role: entry.role,
            text: entry.text,
            provider: typeof entry.provider === 'string' ? entry.provider : '',
            model: typeof entry.model === 'string' ? entry.model : '',
            ms: Number(entry.ms ?? 0),
            domain: entry.domain,
            domainLabel: entry.domainLabel ?? '',
          }))
          .reverse();
        const groups = Object.entries(groupByDomain(entries))
          .map(([domain, rows]) => ({
            domain,
            label: rows.find((row) => row.domainLabel.length > 0)?.domainLabel ?? '',
            count: rows.length,
            entries: rows,
          }));
        return { ok: true, groups, total: entries.length };
      }
      case 'fastpath.clear': {
        // Delete only the requested domain; every other line (and its raw JSON) is kept as-is.
        if (typeof body.domain !== 'string') return { ok: false, error: '请指定要清空的域' };
        const domain = normalizeTurnDomain(body.domain);
        // A non-empty but unusable name must not silently become the ungrouped bucket.
        if (body.domain.trim().length > 0 && domain === '') return { ok: false, error: '域不合法' };
        // The same scope rule as reading: a group this workspace cannot read is not deletable
        // either (otherwise a caller could clear another workspace's history by ID).
        const scope = (0, services.fastpathScope)();
        if (domain !== UNGROUPED_DOMAIN && !scope.allowed.includes(domain)) {
          await services.log.emit('fastpath.domain.rejected', { domain, reason: 'out-of-scope' });
          return { ok: false, error: '域不在当前工作区作用域' };
        }
        let removed = 0;
        try {
          const lines = readFileSync(services.fastPath.file, 'utf8').split('\n').filter(Boolean);
          const kept = lines.filter((line) => {
            let entry;
            try {
              entry = JSON.parse(line);
            } catch {
              return true;
            }
            if (entry === null || typeof entry !== 'object') return true;
            if (normalizeTurnDomain(entry.domain) !== domain) return true;
            removed += 1;
            return false;
          });
          if (removed > 0) {
            writeFileSync(services.fastPath.file, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
            services.fastPath.history = services.fastPath.loadHistory();
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') return { ok: false, error: error?.message ?? String(error) };
        }
        if (removed > 0) await services.log.emit('fastpath.clear', { domain, removed });
        return { ok: true, domain, removed };
      }
  }
};
  return handler;
}
