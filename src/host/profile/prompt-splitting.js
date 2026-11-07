/** prompt-splitting — extracted from profileMaintain.js; no host entry dependency. */
import {
  PROFILE_CATEGORY_MAX_NAME,
  PROFILE_RECONCILE_SIMILARITY,
  SIDES,
  SPLIT_FRAMING,
  cleanText,
  promptKey,
} from './maintain-config.js';
import { parseJsonPayload } from './evidence.js';

/** Bare prompt line → `{text, category}`; a blank/heading/comment line returns null. */
export function parsePromptLine(value) {
  let text = cleanText(value);
  if (text.length === 0) return null;
  if (/^#{1,6}\s/u.test(text) || text.startsWith('>')) return null;
  text = text.replace(/^(?:[-*+]|\d+[.)])\s+/u, '').trim();
  let category = '';
  const bracketed = text.match(/^\[([^\]\n]{1,20})\]\s*(.+)$/u);
  if (bracketed !== null) {
    category = cleanText(bracketed[1]);
    text = cleanText(bracketed[2]);
  }
  text = text.replace(/[（(]\s*C\s*=\s*\d+\s*[,，]\s*E\s*=\s*\d+\s*[）)]\s*$/iu, '').trim();
  if (text.length === 0) return null;
  return { text, category };
}


/**
 * Split one settings-box text into entry lines. Duplicates and non-entry lines (headings,
 * comments, blanks) are counted as `ignored`; nothing is sent to a model here.
 */
export function parseReconcileLines(value) {
  const lines = [];
  const seen = new Set();
  let ignored = 0;
  for (const raw of String(value ?? '').split(/\r?\n/u)) {
    const parsed = parsePromptLine(raw);
    if (parsed === null) {
      ignored += 1;
      continue;
    }
    const key = promptKey(parsed.text);
    if (seen.has(key)) {
      ignored += 1;
      continue;
    }
    seen.add(key);
    lines.push(parsed);
  }
  return { lines, ignored };
}


/** 0..1 edit-distance similarity on the normalized line (labels are short, so this is cheap). */
export function promptSimilarity(left, right) {
  const a = [...promptKey(left)];
  const b = [...promptKey(right)];
  if (a.length === 0 || b.length === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}


/**
 * Line-level diff of one side against the previous mapping. Exact text → unchanged; a line within
 * `threshold` → the same line edited; the remaining current/saved lines → added/removed. Order is
 * irrelevant on purpose: only a real text change can move a line.
 *
 * @returns {{unchanged: object[], updated: object[], added: object[], removed: object[]}} entries
 *   carry the current line `index` so the caller can rebuild the mapping in the box's order.
 */
export function reconcilePromptLines(current, saved, threshold = PROFILE_RECONCILE_SIMILARITY) {
  const unchanged = [];
  const updated = [];
  const added = [];
  const removed = [];
  const usedCurrent = new Set();
  const usedSaved = new Set();
  for (let index = 0; index < current.length; index += 1) {
    const key = promptKey(current[index].text);
    const match = saved.findIndex((line, savedIndex) => !usedSaved.has(savedIndex) && promptKey(line.text) === key);
    if (match < 0) continue;
    usedCurrent.add(index);
    usedSaved.add(match);
    unchanged.push({ index, entryId: saved[match].entryId, text: current[index].text, category: current[index].category });
  }
  const pairs = [];
  for (let index = 0; index < current.length; index += 1) {
    if (usedCurrent.has(index)) continue;
    for (let savedIndex = 0; savedIndex < saved.length; savedIndex += 1) {
      if (usedSaved.has(savedIndex)) continue;
      const similarity = promptSimilarity(current[index].text, saved[savedIndex].text);
      if (similarity >= threshold) pairs.push({ index, savedIndex, similarity });
    }
  }
  pairs.sort((left, right) => right.similarity - left.similarity || left.index - right.index || left.savedIndex - right.savedIndex);
  for (const pair of pairs) {
    if (usedCurrent.has(pair.index) || usedSaved.has(pair.savedIndex)) continue;
    usedCurrent.add(pair.index);
    usedSaved.add(pair.savedIndex);
    updated.push({
      index: pair.index,
      entryId: saved[pair.savedIndex].entryId,
      text: current[pair.index].text,
      category: current[pair.index].category,
      similarity: pair.similarity,
    });
  }
  for (let index = 0; index < current.length; index += 1) {
    if (!usedCurrent.has(index)) added.push({ index, text: current[index].text, category: current[index].category });
  }
  for (let savedIndex = 0; savedIndex < saved.length; savedIndex += 1) {
    if (!usedSaved.has(savedIndex)) removed.push({ entryId: saved[savedIndex].entryId, text: saved[savedIndex].text });
  }
  return { unchanged, updated, added, removed };
}


/** Strip one fragment's framing words (`你是一名…` / `用户是…`) without touching its content. */
export function stripFramingWords(value, side = 'agent') {
  const patterns = SPLIT_FRAMING[side === 'user' ? 'user' : 'agent'];
  let text = cleanText(value);
  let changed = true;
  while (changed && text.length > 0) {
    changed = false;
    for (const pattern of patterns) {
      const next = text.replace(pattern, '').trim();
      if (next.length > 0 && next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  return text.replace(/^[：:，,、。\s]+/u, '').trim();
}


/**
 * Split-model output → `{entries, categories}`. Accepts an array, `{entries, categories}` or JSON
 * text. A payload with no list throws: the caller must keep the old library instead of clearing it.
 */
export function parseSplitPayload(value) {
  const pick = (candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate !== null && typeof candidate === 'object') {
      for (const key of ['entries', 'fragments', 'items', 'persona']) {
        if (Array.isArray(candidate[key])) return candidate[key];
      }
    }
    return null;
  };
  const categoriesOf = (candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    for (const key of ['categories', 'category_ops', 'categoryOps']) {
      if (Array.isArray(candidate[key])) return candidate[key];
    }
    return [];
  };
  const direct = pick(value);
  if (direct !== null) return { entries: direct, categories: categoriesOf(value) };
  const parsed = parseJsonPayload(value, 'profile split: splitter returned non-JSON text');
  const list = pick(parsed);
  if (list === null) throw new Error('profile split: splitter returned no entry list');
  return { entries: list, categories: categoriesOf(parsed) };
}


/** The entry list of one split payload (kept as the narrow public API of the splitter). */
export function parseSplitEntries(value) {
  return parseSplitPayload(value).entries;
}


/**
 * Split-model output → `[{text, side, fromSide, category}]`. The target side comes from the
 * fragment itself (a fragment in the persona box may be routed to the user side and vice versa);
 * `fallbackSide` is only used when the model did not say. Framing words are dropped per side, and
 * a fragment may exist on exactly one side: a duplicate — even across sides — is dropped here.
 */
export function normalizeSplitEntries(value, side = 'agent') {
  const fallback = SIDES.includes(cleanText(side)) ? cleanText(side) : 'agent';
  const entries = [];
  const seen = new Set();
  let ignored = 0;
  for (const item of Array.isArray(value) ? value : []) {
    const raw = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : { text: item };
    const which = SIDES.includes(cleanText(raw.side)) ? cleanText(raw.side) : fallback;
    const text = stripFramingWords(raw.text ?? raw.content ?? raw.value, which);
    if (text.length === 0) {
      ignored += 1;
      continue;
    }
    const key = promptKey(text);
    if (seen.has(key)) {
      ignored += 1;
      continue;
    }
    seen.add(key);
    const from = cleanText(raw.from ?? raw.fromSide ?? raw.sourceSide);
    entries.push({
      text,
      side: which,
      fromSide: SIDES.includes(from) ? from : '',
      category: cleanText(raw.category ?? raw.type ?? '').slice(0, PROFILE_CATEGORY_MAX_NAME),
    });
  }
  return { entries, ignored };
}


/**
 * The prompt the default splitter sends. Both settings boxes are read and handed over together,
 * and the model decides EVERY fragment's side itself (semantics, not the box it was typed in):
 * a persona-behaviour preference or an explicit lasting request is agent material, while the
 * user's own facts/habits/experiences and self-clarifications stay user material. The host owns
 * scores/ranks, so no number may enter through this path.
 */
export function buildSplitPrompt({ agent = '', user = '', side = null, text = '', categories = [] } = {}) {
  const boxes = side === 'agent' || side === 'user'
    ? { agent: side === 'agent' ? cleanText(text) : '', user: side === 'user' ? cleanText(text) : '' }
    : { agent: cleanText(agent), user: cleanText(user) };
  const known = (Array.isArray(categories) ? categories : [])
    .map((row) => {
      const description = cleanText(row?.description);
      return `- [${cleanText(row?.parent)}] ${cleanText(row?.name)}${description.length > 0 ? `：${description}` : ''}`;
    })
    .join('\n');
  return [
    '下面有「助手人设」和「用户画像」两个文本框。请把两段文字一起拆成若干条独立、可单独理解的碎片，并逐条决定它归哪一侧。',
    '只输出一个 JSON 对象：{"entries":[{"text":"...","side":"agent|user","from":"agent|user","category":"..."}]}。',
    '分侧依据（按语义判断，不看原文写在哪一个框里）：',
    '- side=agent：用户对「角色/助手该怎么表现」的偏好——性格、说话方式、互动方式、处事方式；以及用户明确对助手提出的长期要求（「以后都这样」）。',
    '  例：「用户喜欢温婉可爱的角色」→ side=agent，category=人设参考；「以后说话都温柔点」→ side=agent。',
    '- side=user：用户自身的事实、习惯、经历，以及用户对自己言行的澄清。',
    '  例：「用户喜欢喝无糖茶」→ side=user，category=饮食；「说某角色可爱只是观剧时的即时反应，不代表…」→ side=user，category=娱乐。',
    '- 用户的自述/澄清一律 user，不得改写成「你不要…」这类助手规则；当次指令（「这次简短点」）不算长期偏好，不要写成 agent 条目。',
    '- 归属不明时保留 from 那一侧，不迁移、不强化。',
    '- from 填这句话原来所在的框；side 与 from 不同就是跨侧移动（画像里的句子可以归 agent，反之亦然）。',
    '- 同一句话只能归属一侧、只出现一次，不得两侧重复保留。',
    '拆分要求：',
    '- 一句话里包含两种不同倾向时拆成两条（例如「妹系美少女角色，说话带撒娇感」→ 角色一条、说话方式一条）。',
    '- 去掉「你是一名」「你的人设是」「用户喜欢」这类框架词，只保留倾向本身，碎片要能独立成句。',
    `- 口吻：side=agent 一律第二人称「你……」，不得用「用户」指代；side=user 一律第三人称「用户……」，不得出现「我/我们/我的/咱/咱们」；引号里的原话保持原样。`,
    '- category 先复用下面的现有分类（parent 必须与 side 一致；大小写与空格差异算同一个），确实没有合适的才新增。',
    '- 新增分类写在 "categories" 里：{"op":"add","name":"...","parent":"agent|user","description":"一句话"}；',
    '- 改描述用 {"op":"update","name":"...","description":"..."}；改名用 {"op":"update","name":"...","rename":"..."}；',
    '- 确认无引用才可 {"op":"delete","name":"..."}；有引用请并到已有分类：{"op":"update","name":"...","mergeInto":"..."}。',
    `- 分类名不超过 ${PROFILE_CATEGORY_MAX_NAME} 字；每条碎片都必须落到一个具体分类上，不允许空分类。`,
    '- 不要输出分数、C/E、rank、置信度或任何 0-100 的数值。',
    known.length > 0
      ? `现有分类（优先复用；parent 必须与 side 一致）：\n${known}`
      : '现有分类：无，请为每条碎片新增一个分类。',
    `助手人设框：\n${boxes.agent.length > 0 ? boxes.agent : '（空）'}`,
    `用户画像框：\n${boxes.user.length > 0 ? boxes.user : '（空）'}`,
  ].join('\n');
}


/**
 * The one-shot reclassification prompt. Every entry is presented with its id, current side and
 * current category; the category stack is presented with the side each name belongs to. The model
 * may only return entries that are genuinely mis-filed, and may only reuse an existing category
 * whose parent matches the target side. It writes nothing; the host validates every suggestion.
 */
export function buildReclassifyPrompt({ entries = [], categories = [] } = {}) {
  const known = (Array.isArray(categories) ? categories : [])
    .map((row) => {
      const description = cleanText(row?.description);
      return `- [${cleanText(row?.parent)}] ${cleanText(row?.name)}${description.length > 0 ? `：${description}` : ''}`;
    })
    .join('\n');
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => `[${cleanText(entry?.id)}] (${cleanText(entry?.side)}/${cleanText(entry?.category) || '未分类'}) ${cleanText(entry?.text)}`)
    .join('\n');
  return [
    '下面是已经入库的人设/画像条目。请逐条复核：分类是否合适？侧（agent=助手人设，user=用户画像）是否合适？',
    '只对确实不合适、需要调整的条目给出建议；合适的一律不要返回。',
    '只输出一个 JSON 对象：{"changes":[{"entryId":"...","side":"agent|user","category":"...","reason":"一句话"}]}。',
    '规则：',
    '- category 必须从下方现有分类里选，且 parent 必须与 side 一致；不要新增、改名或删除分类。',
    '- 只在语义确实属于另一侧时才换 side：助手该怎么表现/说话/相处 → agent；用户自身事实、习惯、经历与对自己言行的澄清 → user。',
    '- 用户的自述/澄清不得改写成「你不要…」这类助手规则；「这次简短点」这类当次指令不是长期偏好。',
    '- 归属不明时不要返回该条目（保留现有侧，不迁移、不强化）。',
    '- 分类只是归档位置，不要因为分类名不同就建议换 side。',
    '- 不要输出分数、C/E、rank、置信度或任何 0-100 的数值；不要改写条目原文。',
    '- entryId 必须原样引用方括号里的 id，不得编造。',
    known.length > 0 ? `现有分类（parent 必须与 side 一致）：\n${known}` : '现有分类：无，此时不要返回任何 changes。',
    `全部条目：\n${list.length > 0 ? list : '（空）'}`,
  ].join('\n');
}


/** Reclassification output → the raw change list; a payload with no list throws. */
export function parseReclassifyPayload(value) {
  const pick = (candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate !== null && typeof candidate === 'object') {
      for (const key of ['changes', 'reclassify', 'entries', 'items']) {
        if (Array.isArray(candidate[key])) return candidate[key];
      }
    }
    return null;
  };
  let list = pick(value);
  if (list === null) {
    list = pick(parseJsonPayload(value, 'profile reclassify: model returned non-JSON text'));
    if (list === null) throw new Error('profile reclassify: model returned no change list');
  }
  return list;
}
