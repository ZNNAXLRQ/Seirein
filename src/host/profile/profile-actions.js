/** Settings actions for the persona/profile library. */
/** The settings page never receives more than this many profile rows (truncated flag follows). */
export const PROFILE_STATUS_ENTRY_LIMIT = 200;

/**
 * 「暂停自动整理」: data/settings.json wins; an absent key keeps the weekly schedule on.
 * Exported so the settings action, the scheduler and tests read the exact same rule.
 */
export function profileAutoMaintainEnabled(settings = {}) {
  const stored = settings?.profile;
  if (stored === null || typeof stored !== 'object') return true;
  return stored.autoMaintain !== false;
}

/** The organizer owns the library while it runs (or is queued): reclassify never queues behind it. */
export function profileReclassifyBusy(maintainer) {
  const state = maintainer?.status?.() ?? {};
  return state.running === true || state.queued === true;
}

/**
 * Settings「重新分类」preview: a read-only plan over the current library, trimmed to the wire
 * shape the card renders. Exported so the action handler and its tests share one busy rule.
 */
export async function profileReclassifyPreview(maintainer) {
  if (profileReclassifyBusy(maintainer)) return { ok: false, status: 'busy' };
  const plan = await maintainer.planReclassify();
  if (plan?.ok !== true) return plan ?? { ok: false, error: 'profile reclassify: no plan', changes: [], items: [] };
  return {
    ok: true,
    total: Number(plan.total ?? 0) || 0,
    items: Array.isArray(plan.items) ? plan.items : [],
    changes: Array.isArray(plan.changes) ? plan.changes : [],
    noise: Number(plan.noise ?? 0) || 0,
    inBoxOnly: Number(plan.inBoxOnly ?? 0) || 0,
    version: plan.version ?? null,
  };
}

/**
 * Settings「重新分类」apply: a per-row selection `{moves, deletes}` (the new contract) or the
 * legacy whole-plan `{changes}`. The maintainer aborts with `version-conflict` before writing when
 * the library moved; an id that no longer exists is reported in `skipped`, never thrown.
 */
export function profileReclassifyApply(maintainer, body = {}) {
  if (profileReclassifyBusy(maintainer)) return { ok: false, status: 'busy' };
  if (Array.isArray(body.moves) || Array.isArray(body.deletes)) {
    return maintainer.applyReclassifySelection(
      { moves: body.moves ?? [], deletes: body.deletes ?? [] },
      { expectedVersion: body.version ?? null },
    );
  }
  const plan = {
    changes: Array.isArray(body.changes) ? body.changes : [],
    version: body.version ?? null,
  };
  return maintainer.applyReclassify(plan, { expectedVersion: plan.version });
}

/**
 * 「分类管理」actions: list / rename / merge / delete over the category stack. Every write is one
 * transaction in the maintainer; a delete only drops the category relation, never an entry.
 */
export function profileCategoryAction(maintainer, op, body = {}) {
  if (op === 'list') return { ok: true, categories: maintainer.categoryManageList() };
  if (op === 'create') return maintainer.createCategory(body);
  if (op === 'rename') return maintainer.renameCategory(body);
  if (op === 'merge') return maintainer.mergeCategories(body);
  if (op === 'delete') return maintainer.deleteCategory(body);
  return { ok: false, error: `unknown profile category action: ${String(op)}` };
}

/**
 * 「库编辑」actions: list / update / setCategory / delete over the entry library. Each write is
 * one maintainer transaction; the entry list carries the current 框内/仅库 mark.
 */
export function profileEntryAction(maintainer, op, body = {}) {
  if (op === 'list') return { ok: true, entries: maintainer.entryList() };
  if (op === 'update') return maintainer.updateEntryText({ id: body.id, text: body.text });
  if (op === 'setCategory') return maintainer.setEntryCategory({ id: body.id, category: body.category });
  if (op === 'delete') return maintainer.deleteEntry({ id: body.id });
  return { ok: false, error: `unknown profile entry action: ${String(op)}` };
}
