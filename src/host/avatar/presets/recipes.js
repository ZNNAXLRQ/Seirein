/**
 * Hand-authored symbolic choreography. These are NOT frames or transport input names.
 * No amplitudes: adapter resolves each operation using verified channels and current posture.
 * Each operation is required in this recipe; richer combinations are separate recipes.
 */
export const OPERATIONS = Object.freeze({
  'head-turn': ['headX'], 'head-lower': ['headY'], 'head-lift': ['headY'],
  'head-tilt': ['headZ'], 'head-center': ['headX', 'headZ'],
  'head-center-lite': ['headX'],
  'nod': ['headY'], 'double-nod': ['headY'], 'shake': ['headX'],
  // Same headX oscillator as `shake`, but a distinct operation: a slow, small idle sway with no
  // negation semantics. `shake` keeps its existing amplitude/duration and stays negation-only.
  'head-sway': ['headX'],
  'gaze-side': ['gazeX'], 'gaze-down': ['gazeY'], 'gaze-up': ['gazeY'],
  'gaze-target': ['gazeX', 'gazeY'], 'gaze-center': ['gazeX', 'gazeY'],
  'blink': ['eyeOpenL', 'eyeOpenR'], 'double-blink': ['eyeOpenL', 'eyeOpenR'],
  'brow-lift': ['browL', 'browR'], 'brow-knit': ['browL', 'browR'],
  'brow-one': ['browL', 'browR'], 'body-lean': ['bodyX'],
  'body-settle': ['bodyY'], 'body-tilt': ['bodyZ'], 'breath-cycle': ['breath'],
});

// id | label | family | states | events | semantic condition | styles | ordered operations
// semantic=neutral is safe for an idle draw. Other rows require an explicit matching intent.
const rows = [
  ['idle-side', '侧看后停留', 'attention', 'idle,waiting,tired', 'idle', 'neutral', 'reserved,composed,cool', 'head-turn'],
  ['idle-tilt', '偏头安静停留', 'posture', 'idle,waiting,tired', 'idle', 'neutral', 'gentle,dreamy,shy', 'head-tilt'],
  ['idle-down', '低头短暂停留', 'posture', 'idle,waiting,tired', 'idle', 'neutral', 'reserved,earnest', 'head-lower'],
  ['idle-lift', '抬头舒展注意', 'posture', 'idle', 'idle', 'neutral', 'confident,cheerful', 'head-lift'],
  ['idle-center', '缓慢整理头部姿态', 'settle', 'idle,waiting,tired', 'idle,answer-end', 'neutral', 'composed,elegant', 'head-center'],
  ['idle-side-tilt', '转头后轻偏', 'posture', 'idle', 'idle', 'neutral', 'playful,curious', 'head-turn,head-tilt'],
  ['idle-tilt-side', '偏头后看向一侧', 'posture', 'idle', 'idle', 'neutral', 'dreamy,gentle', 'head-tilt,head-turn'],
  ['idle-eye-side', '仅眼神短暂移开', 'attention', 'idle,waiting,tired', 'idle', 'neutral', 'reserved,cool,shy', 'gaze-side'],
  ['idle-eye-down', '仅眼神下移', 'attention', 'idle,waiting,tired', 'idle', 'neutral', 'dreamy,composed', 'gaze-down'],
  ['idle-eye-up', '仅眼神上移', 'attention', 'idle', 'idle', 'neutral', 'curious,playful', 'gaze-up'],
  ['idle-eye-head', '先眼后头移开注意', 'attention', 'idle', 'idle', 'neutral', 'lively,curious', 'gaze-side,head-turn'],
  ['idle-head-eye', '先头后眼移开注意', 'attention', 'idle', 'idle', 'neutral', 'elegant,composed', 'head-turn,gaze-side'],
  ['idle-look-back', '眼神回到实际目标', 'attention', 'idle,waiting', 'idle', 'neutral', 'warm,earnest', 'gaze-target'],
  ['idle-blink', '自然眨眼', 'blink', 'idle,listening,thinking,waiting,tired', 'idle,user-speaking,thinking', 'neutral', 'common', 'blink'],
  ['idle-double-blink', '间隔双眨眼', 'blink', 'idle,waiting', 'idle', 'neutral', 'lively,playful', 'double-blink'],
  ['idle-blink-tilt', '眨眼后换偏头姿态', 'posture', 'idle', 'idle', 'neutral', 'gentle,cheerful', 'blink,head-tilt'],
  ['idle-lean', '身体侧向保持', 'body-posture', 'idle', 'idle', 'neutral', 'dreamy,confident', 'body-lean'],
  ['idle-body-tilt', '身体倾斜保持', 'body-posture', 'idle', 'idle', 'neutral', 'elegant,playful', 'body-tilt'],
  ['idle-body-settle', '身体放松落定', 'body-settle', 'idle,tired', 'idle,answer-end', 'neutral', 'composed,dreamy', 'body-settle'],
  ['idle-breath', '自然呼吸周期', 'breath', 'idle,listening,thinking,waiting,tired', 'idle,user-speaking,thinking', 'neutral', 'common', 'breath-cycle'],
  ['idle-body-head', '身体侧倾配头部平衡', 'body-posture', 'idle', 'idle', 'neutral', 'elegant,gentle', 'body-lean,head-tilt'],
  ['listen-turn', '转向声源方向', 'attention', 'listening', 'user-speaking', 'neutral', 'earnest,warm', 'head-turn'],
  ['listen-look', '注视说话目标', 'attention', 'listening', 'user-speaking', 'neutral', 'earnest,rational', 'gaze-target'],
  ['listen-tilt', '偏头聆听', 'posture', 'listening', 'user-speaking', 'neutral', 'gentle,curious', 'head-tilt'],
  ['listen-lower', '略低头保持聆听', 'posture', 'listening', 'user-speaking', 'neutral', 'reserved,earnest', 'head-lower'],
  ['listen-center', '回正并保持注意', 'settle', 'listening', 'user-speaking', 'neutral', 'composed,rational', 'head-center'],
  ['listen-eye-head', '先注视再转头聆听', 'attention', 'listening', 'user-speaking', 'neutral', 'warm,curious', 'gaze-target,head-turn'],
  ['listen-blink', '眨眼后继续注视', 'blink', 'listening', 'user-speaking', 'neutral', 'gentle,earnest', 'blink,gaze-target'],
  ['think-up', '视线上移思考', 'thought', 'thinking', 'thinking', 'neutral', 'curious,rational', 'gaze-up'],
  ['think-down', '视线下移思考', 'thought', 'thinking', 'thinking', 'neutral', 'reserved,earnest', 'gaze-down'],
  ['think-side', '短暂移开视线思考', 'thought', 'thinking', 'thinking', 'neutral', 'composed,cool', 'gaze-side'],
  ['think-tilt', '偏头后停顿思考', 'thought', 'thinking', 'thinking', 'neutral', 'curious,playful', 'head-tilt'],
  ['think-lower', '低头保持思考', 'thought', 'thinking', 'thinking', 'neutral', 'rational,reserved', 'head-lower'],
  ['think-blink-up', '眨眼后抬眼思考', 'thought', 'thinking', 'thinking', 'neutral', 'earnest,curious', 'blink,gaze-up'],
  ['wait-side', '等待中短暂侧看', 'attention', 'waiting', 'waiting', 'neutral', 'dreamy,cool', 'gaze-side'],
  ['wait-tilt', '等待中换偏头姿态', 'posture', 'waiting', 'waiting', 'neutral', 'playful,gentle', 'head-tilt'],
  ['wait-center', '等待中放松回正', 'settle', 'waiting', 'waiting', 'neutral', 'composed,reserved', 'head-center'],
  ['answer-attend', '开口前回看目标', 'attention', 'speaking', 'answer-start', 'neutral', 'warm,confident', 'gaze-target'],
  ['answer-center', '开口前整理头部姿态', 'settle', 'speaking', 'answer-start', 'neutral', 'rational,composed', 'head-center'],
  ['answer-tilt', '开口时保持偏头', 'posture', 'speaking', 'answer-start', 'neutral', 'gentle,playful', 'head-tilt'],
  ['speak-turn', '句间换转头方向', 'speech-beat', 'speaking', 'sentence-gap', 'neutral', 'lively,warm', 'head-turn'],
  ['speak-tilt', '句间换倾斜姿态', 'speech-beat', 'speaking', 'sentence-gap', 'neutral', 'gentle,elegant', 'head-tilt'],
  ['speak-blink', '句间自然眨眼', 'blink', 'speaking', 'sentence-gap', 'neutral', 'common', 'blink'],
  ['speak-return', '句间视线回看', 'attention', 'speaking', 'sentence-gap', 'neutral', 'earnest,warm', 'gaze-target'],
  ['end-center', '说完后自然回正', 'settle', 'idle,waiting', 'answer-end', 'neutral', 'composed,rational', 'head-center'],
  ['end-side', '说完后视线松开', 'attention', 'idle', 'answer-end', 'neutral', 'shy,reserved', 'gaze-side'],
  ['end-tilt', '说完后偏头保持', 'posture', 'idle', 'answer-end', 'neutral', 'gentle,playful', 'head-tilt'],
  ['tired-lower', '疲倦时低头休息', 'rest', 'tired', 'idle', 'neutral', 'dreamy,reserved', 'head-lower'],
  ['tired-blink', '疲倦时眨眼后停留', 'rest', 'tired', 'idle', 'neutral', 'common', 'blink,head-lower'],
  ['agree-nod', '单次认可点头', 'affirmation', 'listening,speaking', 'affirm', 'agreement', 'common', 'nod'],
  ['agree-double', '两次递减认可点头', 'affirmation', 'listening,speaking', 'affirm', 'agreement', 'warm,lively', 'double-nod'],
  ['agree-eye-nod', '看向目标后认可', 'affirmation', 'listening,speaking', 'affirm', 'agreement', 'earnest,composed', 'gaze-target,nod'],
  ['deny-shake', '明确否定摇头', 'negation', 'speaking', 'deny', 'disagreement', 'common', 'shake'],
  ['deny-look-shake', '注视目标后摇头', 'negation', 'speaking', 'deny', 'disagreement', 'confident,earnest', 'gaze-target,shake'],
  ['emphasis-nod', '重点处单次点头', 'emphasis', 'speaking', 'emphasize', 'emphasis', 'rational,confident', 'nod'],
  ['emphasis-lift', '重点处抬头落定', 'emphasis', 'speaking', 'emphasize', 'emphasis', 'confident,composed', 'head-lift'],
  ['emphasis-brow', '重点处轻抬眉', 'emphasis', 'speaking', 'emphasize', 'emphasis', 'lively,earnest', 'brow-lift'],
  ['confused-tilt', '困惑偏头', 'confusion', 'thinking,listening', 'confused', 'confusion', 'common', 'head-tilt'],
  ['confused-brow', '困惑时眉部变化', 'confusion', 'thinking,listening', 'confused', 'confusion', 'rational,earnest', 'brow-knit'],
  ['confused-combo', '偏头配单侧眉变化', 'confusion', 'thinking,listening', 'confused', 'confusion', 'curious,playful', 'head-tilt,brow-one'],
  ['surprise-lift', '惊讶抬头停顿', 'surprise', 'listening,speaking', 'surprised', 'surprise', 'lively,warm', 'head-lift'],
  ['surprise-brow', '惊讶抬眉', 'surprise', 'listening,speaking', 'surprised', 'surprise', 'common', 'brow-lift'],
  ['surprise-combo', '抬眉后抬头', 'surprise', 'listening,speaking', 'surprised', 'surprise', 'cheerful,playful', 'brow-lift,head-lift'],
  ['curious-tilt', '好奇偏头观察', 'curiosity', 'listening,thinking', 'curious', 'curiosity', 'curious,playful', 'head-tilt'],
  ['curious-eye-tilt', '注视后好奇偏头', 'curiosity', 'listening,thinking', 'curious', 'curiosity', 'curious,earnest', 'gaze-target,head-tilt'],
  ['reassure-tilt', '安抚时柔和偏头', 'reassurance', 'speaking', 'reassure', 'reassurance', 'gentle,warm', 'head-tilt'],
  ['reassure-look', '安抚时保持注视', 'reassurance', 'speaking', 'reassure', 'reassurance', 'composed,gentle', 'gaze-target'],
  ['apology-lower', '致歉时低头', 'apology', 'speaking', 'apologize', 'apology', 'earnest,shy', 'head-lower'],
  ['apology-return', '低头致歉后回看', 'apology', 'speaking', 'apologize', 'apology', 'warm,earnest', 'head-lower,gaze-target'],
  ['amused-tilt', '觉得有趣时偏头', 'amusement', 'speaking,listening', 'amused', 'amusement', 'playful,cheerful', 'head-tilt'],
  ['amused-blink', '觉得有趣时眨眼偏头', 'amusement', 'speaking,listening', 'amused', 'amusement', 'lively,playful', 'blink,head-tilt'],
  ['uncertain-side', '不确定时短暂移开视线', 'uncertainty', 'thinking,speaking', 'uncertain', 'uncertainty', 'shy,reserved', 'gaze-side'],
  ['uncertain-tilt', '不确定时偏头停留', 'uncertainty', 'thinking,speaking', 'uncertain', 'uncertainty', 'curious,earnest', 'head-tilt'],
  ['welcome-look', '迎接时看向目标', 'greeting', 'speaking', 'greet', 'greeting', 'warm,cheerful', 'gaze-target'],
  ['welcome-nod', '迎接时点头致意', 'greeting', 'speaking', 'greet', 'greeting', 'elegant,composed', 'nod'],
  ['farewell-nod', '告别时点头致意', 'farewell', 'speaking', 'farewell', 'farewell', 'gentle,elegant', 'nod'],
  ['farewell-tilt', '告别时偏头停留', 'farewell', 'speaking', 'farewell', 'farewell', 'playful,warm', 'head-tilt'],
  // Append only: preserve existing display ordinals as well as stable recipe ids.
  // A speech beat is not agreement. Never route this neutral nod through affirmation semantics.
  ['answer-nod', '开口节奏点头（不表示赞同）', 'speech-beat', 'speaking', 'answer-start', 'neutral', 'common,earnest', 'nod'],
  ['answer-turn', '开口时自然转头（不指向对象）', 'posture', 'speaking', 'answer-start', 'neutral', 'warm,lively', 'head-turn'],
  ['answer-center-lite', '开口时水平回归自然姿态', 'settle', 'speaking', 'answer-start', 'neutral', 'composed,rational', 'head-center-lite'],
  // Neutral headX sway: the left/right channel is deliberately distinct from idle-tilt's headZ,
  // so the two idle postures cannot collapse into the same axis. Appended to keep display ordinals.
  ['idle-sway', '左右轻摇', 'posture', 'idle,waiting,tired', 'idle', 'neutral', 'gentle,dreamy,composed', 'head-sway'],
];

// ---------------------------------------------------------------------------------------------
// P-139 stage 3 — replaceable action variants
// ---------------------------------------------------------------------------------------------
//
// A recipe keeps ONE identity (and one recipe-level anti-repeat bucket); its variants only change
// HOW the same symbolic choreography is delivered. They never add operations, channels or
// semantics, so a variant can never turn a neutral idle into an affirmation.
//
// `amount` scales the operation amplitude, `duration` scales its active phase, `hold` scales the
// post-active hold. The bias fields (-1..1) only let the selector prefer a variant from the
// persona dimensions; they are not amplitudes themselves.
const variant = (id, label, amount, duration, hold, biases = {}) => Object.freeze({
  id,
  label,
  amount,
  duration,
  hold,
  extent: Math.max(-1, Math.min(1, Number(biases.extent) || 0)),
  holdBias: Math.max(-1, Math.min(1, Number(biases.holdBias) || 0)),
  speedBias: Math.max(-1, Math.min(1, Number(biases.speedBias) || 0)),
  textureBias: Math.max(-1, Math.min(1, Number(biases.textureBias) || 0)),
});

/** Delivery variants for nodding choreography. */
export const NOD_ACTION_VARIANTS = Object.freeze([
  variant('nod-small', '轻点', 0.88, 1.06, 1.10, { extent: -0.7, holdBias: 0.5, speedBias: -0.4, textureBias: 0.2 }),
  variant('nod-deep', '深点', 1.14, 0.98, 1.04, { extent: 0.9, holdBias: 0.3, speedBias: -0.2, textureBias: 0.5 }),
  variant('nod-quick', '快点', 1.00, 0.82, 0.78, { extent: 0.2, holdBias: -0.8, speedBias: 0.9, textureBias: 0.6 }),
]);

/** Delivery variants for head-roll / tilt choreography. */
export const TILT_ACTION_VARIANTS = Object.freeze([
  variant('tilt-narrow', '窄倾', 0.90, 1.05, 1.12, { extent: -0.5, holdBias: 0.5, speedBias: -0.3, textureBias: 0.2 }),
  variant('tilt-wide', '宽倾', 1.15, 1.10, 1.16, { extent: 0.9, holdBias: 0.7, speedBias: -0.5, textureBias: 0.6 }),
  variant('tilt-quick', '快倾', 1.00, 0.84, 0.80, { extent: 0.1, holdBias: -0.8, speedBias: 0.9, textureBias: 0.5 }),
]);

/** Delivery variants for gaze-only attention choreography. */
export const GAZE_ACTION_VARIANTS = Object.freeze([
  variant('gaze-short', '短瞥', 0.88, 0.86, 0.76, { extent: -0.4, holdBias: -0.6, speedBias: 0.7, textureBias: 0.3 }),
  variant('gaze-hold', '久停', 1.05, 1.14, 1.30, { extent: 0.5, holdBias: 0.9, speedBias: -0.6, textureBias: 0.4 }),
  variant('gaze-soft', '轻移', 1.00, 1.00, 1.10, { extent: 0.0, holdBias: 0.3, speedBias: 0.0, textureBias: 0.1 }),
]);

/** Delivery variants for head-turn choreography. */
export const TURN_ACTION_VARIANTS = Object.freeze([
  variant('turn-small', '小转', 0.86, 1.05, 1.02, { extent: -0.6, holdBias: 0.2, speedBias: -0.2, textureBias: 0.2 }),
  variant('turn-wide', '大转', 1.15, 1.10, 1.14, { extent: 0.9, holdBias: 0.6, speedBias: -0.4, textureBias: 0.5 }),
  variant('turn-quick', '快转', 1.00, 0.84, 0.80, { extent: 0.1, holdBias: -0.7, speedBias: 0.9, textureBias: 0.6 }),
]);

/** Neutral delivery variants for blink / brow / settle / breath / sway choreography. */
export const NEUTRAL_ACTION_VARIANTS = Object.freeze([
  variant('soft', '轻缓', 0.90, 1.10, 1.18, { extent: -0.6, holdBias: 0.8, speedBias: -0.6, textureBias: 0.2 }),
  variant('clear', '清晰', 1.00, 1.00, 1.00, { extent: 0.0, holdBias: 0.0, speedBias: 0.0, textureBias: 0.0 }),
  variant('defined', '利落', 1.12, 0.90, 0.84, { extent: 0.9, holdBias: -0.6, speedBias: 0.8, textureBias: 0.8 }),
]);

/** Pick the variant family from the recipe's own operations (data, never a recipe id). */
function actionVariantsFor(operations) {
  if (operations.some(operation => operation === 'nod' || operation === 'double-nod')) return NOD_ACTION_VARIANTS;
  if (operations.some(operation => operation === 'head-tilt')) return TILT_ACTION_VARIANTS;
  if (operations.some(operation => operation.startsWith('gaze-'))) return GAZE_ACTION_VARIANTS;
  if (operations.some(operation => operation === 'head-turn' || operation === 'shake')) return TURN_ACTION_VARIANTS;
  return NEUTRAL_ACTION_VARIANTS;
}

const split = text => text.split(',');
/**
 * A recipe whose every step is a centre/recenter operation is a "settle" action: it only makes
 * sense when the observed pose is actually away from the natural baseline. The flag (and the
 * threshold) is recipe metadata, so the selector never needs to hard-code recipe ids such as
 * `idle-center`; the operation names are the semantic source of truth.
 */
const SETTLE_OPERATIONS = new Set(['head-center', 'head-center-lite', 'gaze-center']);
const SETTLE_OFFSET_THRESHOLD = 0.06;
export const RECIPES = Object.freeze(rows.map(([id, label, family, states, events, semantic, styles, operations]) => {
  const steps = split(operations);
  const settle = steps.length > 0 && steps.every(op => SETTLE_OPERATIONS.has(op));
  const settleChannels = settle
    ? Object.freeze([...new Set(steps.flatMap(op => OPERATIONS[op] ?? []))])
    : null;
  return Object.freeze({
    id, label, family, states: Object.freeze(split(states)), events: Object.freeze(split(events)),
    semantic, styles: Object.freeze(split(styles)), operations: Object.freeze(steps),
    requires: Object.freeze([...new Set(steps.flatMap(op => OPERATIONS[op]))]),
    requiresTarget: steps.includes('gaze-target'),
    requiresDirection: steps.includes('head-turn') && states === 'listening',
    /**
     * Replaceable delivery variants of THIS recipe. They share one recipe id (so recipe-level
     * anti-repeat still holds) but let two draws of the same recipe look different. Frozen data,
     * never another preset entry, so family probability is not inflated by the variant count.
     */
    actionVariants: actionVariantsFor(steps),
    /** Settle/recenter metadata consumed by the selector's idle hard filter. */
    settle,
    ...(settle ? { offsetThreshold: SETTLE_OFFSET_THRESHOLD, settleChannels } : {}),
  });
}));
