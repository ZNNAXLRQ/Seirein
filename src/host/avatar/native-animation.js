/**
 * Native VTS animation sampler.
 *
 * VTS hotkey animations are not Seirein presets: they are external model motions with their own
 * names and timing. This sampler keeps that pool and its history separate from the Seirein preset
 * selector, so the two never share an anti-repeat record. It only chooses a name; the host remains
 * the one place that talks to VTS.
 */

/** Hard skip for the immediately previous native animation; older repeats get a soft penalty. */
export function createNativeAnimationScheduler({
  pool = [],
  random = Math.random,
  historyLimit = 8,
} = {}) {
  const history = [];
  let cleanPool = [...new Set((Array.isArray(pool) ? pool : [])
    .map((name) => String(name ?? '').trim())
    .filter((name) => name.length > 0))];

  const counts = () => {
    const map = new Map();
    for (const name of history) map.set(name, (map.get(name) ?? 0) + 1);
    return map;
  };
  const record = (name) => {
    const value = String(name ?? '').trim();
    if (value.length === 0) return null;
    history.push(value);
    while (history.length > Math.max(2, historyLimit)) history.shift();
    return value;
  };

  return {
    pool: () => [...cleanPool],
    history: () => [...history],
    setPool(names) {
      cleanPool = [...new Set((Array.isArray(names) ? names : [])
        .map((name) => String(name ?? '').trim())
        .filter((name) => name.length > 0))];
      return [...cleanPool];
    },
    /** Pick one name; null when the pool is empty. The previous choice is excluded if possible. */
    pick() {
      if (cleanPool.length === 0) return null;
      const recent = history[history.length - 1];
      const candidates = cleanPool.length > 1 && recent !== undefined
        ? cleanPool.filter((name) => name !== recent)
        : cleanPool;
      const c = counts();
      const weighted = candidates.map((name) => ({
        name,
        // Same-name repeats decay strongly; exact immediate repeats were already excluded.
        weight: 1 / (1 + 3 * (c.get(name) ?? 0)),
      }));
      const total = weighted.reduce((sum, row) => sum + row.weight, 0);
      let roll = Math.max(0, Math.min(1 - Number.EPSILON, Number(random()) || 0)) * total;
      for (const row of weighted) {
        roll -= row.weight;
        if (roll <= 0) return record(row.name);
      }
      return record(weighted[weighted.length - 1].name);
    },
    record,
    clear() {
      history.length = 0;
    },
  };
}
