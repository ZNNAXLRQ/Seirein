/** Settings HTTP endpoints and privacy-gated cache-image delivery. */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJsonBody } from './request.js';
import { resolve } from 'node:path';
import { sep } from 'node:path';


export function createSettingsRoutes(services) {
  const handler = (scope) => {
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/assistant/status',
        handler: async (_req, res) => {
          const body = JSON.stringify(await (0, services.buildStatus)());
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(body);
        },
      }),
    );
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/assistant/shot',
        handler: async (req, res) => {
          const fail = (status) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false }));
          };
          try {
            const generation = services.visionGeneration;
            if (services.vision.mode === 'privacy' || services.visionChanging || services.visionDisposed) return fail(403);
            const url = new URL(req.url ?? '/', 'http://localhost');
            const raw = url.searchParams.get('path') ?? '';
            const base = join(services.root, 'cache');
            const target = resolve(raw);
            // Only serve files under the plugin cache; never an arbitrary path from the page.
            if (!target.startsWith(base + sep)) return fail(403);
            if (services.visionFiles.get(raw) !== generation && services.visionFiles.get(target) !== generation) return fail(403);
            const data = await readFile(target);
            if (services.vision.mode === 'privacy' || services.visionChanging || services.visionDisposed || generation !== services.visionGeneration) return fail(403);
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
            res.end(data);
            return undefined;
          } catch {
            return fail(404);
          }
        },
      }),
    );
    scope.effect(() =>
      scope.webServer.register({
        kind: 'exact',
        path: '/assistant/action',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'POST only' }));
            return;
          }
          const body = await readJsonBody(req);
          const result = await (0, services.handleUiAction)(body);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        },
      }),
    );
  };
  return handler;
}
