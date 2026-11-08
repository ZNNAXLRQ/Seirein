/** Affinity vocabulary, never hard personality bans. No style owns an amplitude. */
export const STYLES = Object.freeze([
  ['common', '通用', '自然均衡'], ['gentle', '温柔', '舒缓、关照、柔和接续'],
  ['lively', '活泼', '灵动、积极、丰富变化'], ['reserved', '内敛', '克制、留白、少量明确动作'],
  ['composed', '沉稳', '从容、稳定、清晰停留'], ['playful', '俏皮', '轻巧、机灵、互动感'],
  ['shy', '腼腆', '短暂移开注意后回看'], ['confident', '自信', '明确、直接、舒展'],
  ['elegant', '优雅', '连贯、整洁、缓慢收尾'], ['curious', '好奇', '关注变化、探索、仔细聆听'],
  ['rational', '理性', '清晰节奏、有条理、少冗余'], ['warm', '热情', '主动回应、亲切、投入'],
  ['dreamy', '悠然', '缓慢漂移、长停留、松弛'], ['earnest', '认真', '专注、明确回应、稳定注意'],
  ['cool', '清冷', '简练、安静、短而明确'], ['cheerful', '明朗', '轻快、开放、自然回望'],
].map(([id, shortName, description]) => Object.freeze({ id, shortName, description })));

export const STYLE_BY_ID = new Map(STYLES.map(style => [style.id, style]));
