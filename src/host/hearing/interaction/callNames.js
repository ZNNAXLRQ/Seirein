/**
 * Assistant call names — storage helpers for `settings.voice.callNames` (phase 1b).
 *
 * A call name is the spoken name the user says to address the assistant in call mode, e.g.
 * 「小满」. Each entry is `{id, text, enabled}`; the default list is empty, so call mode cannot be
 * entered until the user adds and enables at least one name. `id` is stable across edits and is
 * never derived from the text (it is the only thing the UI uses to address one row).
 *
 * Duplicate checking is cross-class on purpose: an assistant call name and a user self-name share
 * one namespace (phase 1a's `createSpeakerRegistry().findConflict`), so the same word can never be
 * both. `createCallNameStore` takes that lookup as an injected seam, which keeps this module free
 * of Host/file access and lets the same rules be tested without mounting the plugin.
 *
 * Every mutator is pure: it returns the next `callNames` array and never edits the input object.
 */

/** Longest accepted call name, in code points. */
export const CALL_NAME_MAX_CHARS = 32;

/** Most call names a single settings file may store. */
export const CALL_NAME_MAX_COUNT = 16;

/** Case- and width-insensitive identity, exactly as `callMode.js` compares names. */
const fold = (value) => String(value).normalize('NFKC').toLowerCase();

/** Trim and reject non-strings; internal whitespace is kept (a spoken name may contain a space). */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function charCount(value) {
  return [...String(value)].length;
}

/** Next unused `call-N` id. Stable enough for the settings list and collision-safe. */
function nextId(list) {
  const used = new Set(list.map((entry) => entry.id));
  let ordinal = list.length + 1;
  while (used.has(`call-${ordinal}`)) ordinal += 1;
  return `call-${ordinal}`;
}

/**
 * Normalize the stored value into a clean list. Blank/non-object rows and duplicate display
 * names are dropped (first row wins), a missing `enabled` defaults to enabled, and a missing or
 * duplicate `id` is repaired so the UI always has a key.
 *
 * @param {{callNames?: unknown}|null|undefined} voice - the `settings.voice` object
 * @returns {{id: string, text: string, enabled: boolean}[]}
 */
export function listCallNames(voice) {
  const raw = voice !== null && typeof voice === 'object' && Array.isArray(voice.callNames)
    ? voice.callNames
    : [];
  const seenKeys = new Set();
  const seenIds = new Set();
  const list = [];

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const text = cleanText(entry.text);
    if (text.length === 0) continue;
    const key = fold(text);
    if (key.length === 0 || seenKeys.has(key)) continue;
    seenKeys.add(key);

    const wanted = typeof entry.id === 'string' ? entry.id.trim() : '';
    const id = wanted.length > 0 && !seenIds.has(wanted) ? wanted : nextId(list);
    seenIds.add(id);
    list.push({ id, text, enabled: entry.enabled !== false });
  }

  return list;
}

/** Enabled names only, in stored order — what `detectAddress` and `createCallMode` consume. */
export function enabledCallNames(voice) {
  return listCallNames(voice).filter((entry) => entry.enabled === true).map((entry) => entry.text);
}

/**
 * Call-name CRUD over one `settings.voice` object.
 *
 * @param {{findConflict?: (name: string) => ({kind: string, name?: string, label?: string}|null)}} [options]
 */
export function createCallNameStore({ findConflict = () => null } = {}) {
  const conflictText = (text, conflict) => {
    if (conflict === null || conflict === undefined) return '';
    if (conflict.kind === 'speaker') {
      const label = typeof conflict.label === 'string' && conflict.label.length > 0
        ? conflict.label
        : '用户';
      return `「${text}」已用于用户自称「${label}」，称呼与自称不能重名`;
    }
    return `「${text}」已经是助手称呼`;
  };

  return {
    list(voice) {
      return listCallNames(voice);
    },

    enabled(voice) {
      return enabledCallNames(voice);
    },

    /**
     * Add one name. `enabled` is always true for a new entry.
     * Refusals: `empty-name`, `name-too-long`, `too-many-names`, `duplicate-name` (with the
     * conflicting entry or the cross-class speaker/assistant hit).
     */
    add(voice, rawText) {
      const text = cleanText(rawText);
      if (text.length === 0) {
        return { ok: false, reason: 'empty-name', error: '称呼不能为空' };
      }
      if (charCount(text) > CALL_NAME_MAX_CHARS) {
        return {
          ok: false,
          reason: 'name-too-long',
          error: `称呼最多 ${CALL_NAME_MAX_CHARS} 个字符`,
        };
      }

      const current = listCallNames(voice);
      if (current.length >= CALL_NAME_MAX_COUNT) {
        return {
          ok: false,
          reason: 'too-many-names',
          error: `最多只能保存 ${CALL_NAME_MAX_COUNT} 个称呼`,
        };
      }

      const key = fold(text);
      const same = current.find((entry) => fold(entry.text) === key);
      if (same !== undefined) {
        return {
          ok: false,
          reason: 'duplicate-name',
          conflict: { kind: 'call-name', id: same.id, name: same.text },
          error: `「${same.text}」已经是助手称呼`,
        };
      }

      const conflict = findConflict(text);
      if (conflict !== null && conflict !== undefined) {
        return {
          ok: false,
          reason: 'duplicate-name',
          conflict,
          error: conflictText(text, conflict),
        };
      }

      const item = { id: nextId(current), text, enabled: true };
      return { ok: true, item, callNames: [...current, item] };
    },

    /** Remove one row by id. Unknown ids are refused instead of silently succeeding. */
    remove(voice, id) {
      const current = listCallNames(voice);
      const wanted = typeof id === 'string' ? id.trim() : '';
      const item = current.find((entry) => entry.id === wanted);
      if (item === undefined) {
        return { ok: false, reason: 'unknown-name', error: '这个称呼不存在（可能已被删除）' };
      }
      return { ok: true, item, callNames: current.filter((entry) => entry.id !== wanted) };
    },

    /** Flip one row's enabled flag. A disabled name is ignored by entry and address detection. */
    toggle(voice, id, enabled) {
      const current = listCallNames(voice);
      const wanted = typeof id === 'string' ? id.trim() : '';
      const item = current.find((entry) => entry.id === wanted);
      if (item === undefined) {
        return { ok: false, reason: 'unknown-name', error: '这个称呼不存在（可能已被删除）' };
      }
      const nextEnabled = enabled !== false;
      const next = current.map((entry) => (
        entry.id === wanted ? { ...entry, enabled: nextEnabled } : entry
      ));
      return {
        ok: true,
        item: next.find((entry) => entry.id === wanted),
        changed: item.enabled !== nextEnabled,
        callNames: next,
      };
    },
  };
}
