/** Dispatch exact action names; handlers own their feature dependencies. */
export function createSettingsRouter(groups) {
  const routes = new Map();
  for (const { actions, handle } of groups) {
    for (const action of actions) {
      if (routes.has(action)) throw new Error('Duplicate settings action: ' + action);
      routes.set(action, handle);
    }
  }
  return async (body) => {
    const handle = routes.get(body.action);
    return handle ? handle(body) : { ok: false, error: 'unknown action: ' + String(body.action) };
  };
}
