/**
 * Host timing helpers: the companion "day" stamp, the C2 time-zone conversions and the latency
 * observation fields.
 *
 * Everything here is a pure calculation: no `apply` state, no config read, no event and no I/O
 * beyond reading the clock passed in by the caller. The functions used to live at the top of
 * index.js and are still re-exported from there, so the public host surface is unchanged.
 */

import { voiceLatencyObservations } from '../session/delivery/dispatch.js';

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * The companion's "day" starts at 04:00 local time, so a 02:00 conversation still belongs to
 * the previous date. Uses the computer clock; no timezone configuration.
 * @param {Date} at
 * @param {number} rolloverHour - local hour that opens a new day (default 04:00).
 */
export function dayStampFor(at = new Date(), rolloverHour = 4) {
  const shifted = new Date(at.getTime());
  if (shifted.getHours() < rolloverHour) shifted.setDate(shifted.getDate() - 1);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return {
    date: `${y}-${m}-${d}`,
    weekday: WEEKDAY_NAMES[shifted.getDay()],
    // Session id keeps ASCII so the on-disk path stays clean; the title shows the weekday.
    sessionId: `seirein-${y}-${m}-${d}`,
    title: `${y}-${m}-${d} ${WEEKDAY_NAMES[shifted.getDay()]}`,
  };
}

// ---- C2 time zone ---------------------------------------------------------
// Every C2 date (the per-line label, the archive from/to boundaries and the fuzzy-expression
// mapping) uses this one zone. It is deliberately independent of the host's clock: default
// Asia/Shanghai, configurable via `c2.timeZone`.
export const C2_DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export const C2_DEFAULT_FUZZY_DAYS = 3;
const C2_DAY_MS = 86_400_000;
const c2TimeZones = new Map();

/** A usable IANA zone name, or the default; an invalid config never throws. */
export function resolveC2TimeZone(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) return C2_DEFAULT_TIME_ZONE;
  if (c2TimeZones.has(text)) return c2TimeZones.get(text);
  let resolved = C2_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text }).format(0);
    resolved = text;
  } catch {
    /* invalid zone: keep the default */
  }
  c2TimeZones.set(text, resolved);
  return resolved;
}

function c2Formatter(timeZone) {
  let formatter = c2TimeZones.get(`fmt:${timeZone}`);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    c2TimeZones.set(`fmt:${timeZone}`, formatter);
  }
  return formatter;
}

/** Wall-clock parts of one instant in the C2 zone. */
export function zonedParts(at, timeZone = C2_DEFAULT_TIME_ZONE) {
  const tz = resolveC2TimeZone(timeZone);
  const date = at instanceof Date ? at : new Date(at);
  const parts = c2Formatter(tz).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute'), second: pick('second'), timeZone: tz };
}

/** `YYYY-MM-DD` in the C2 zone (never UTC): a 01:30 Beijing moment keeps its Beijing date. */
export function zonedDateStamp(at, timeZone = C2_DEFAULT_TIME_ZONE) {
  const parts = zonedParts(at, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Offset of the zone at one instant: local wall-clock minus UTC, in ms. */
function zonedOffsetMs(stamp, timeZone) {
  const parts = zonedParts(stamp, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(stamp / 1000) * 1000;
}

/** UTC instant of a local wall-clock time (two passes absorb a DST edge). */
function zonedWallTime(year, month, day, hour, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour);
  let stamp = wall - zonedOffsetMs(wall, timeZone);
  stamp = wall - zonedOffsetMs(stamp, timeZone);
  return stamp;
}

function addLocalDays({ year, month, day }, count) {
  const date = new Date(Date.UTC(year, month - 1, day) + count * C2_DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** `[local 00:00, next local 00:00)` as ISO, the exact window a natural-day question asks for. */
function localDayWindow({ year, month, day }, timeZone) {
  const from = zonedWallTime(year, month, day, 0, timeZone);
  const next = addLocalDays({ year, month, day }, 1);
  const to = zonedWallTime(next.year, next.month, next.day, 0, timeZone);
  return { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
}

/** ISO weekday 1..7 (Monday..Sunday) of a local calendar date. */
function localIsoDay({ year, month, day }) {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
}

const C2_FUZZY_PATTERN = /(最近几天|这几天|这两天|两天前|几天前|前段时间|前阵子|那阵子|最近|近期|近来)/u;
const C2_WEEKDAY_PATTERN = /(上|本|这)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u;
const C2_LAST_WEEK_PATTERN = /(?:上|上个)(?:周|星期|礼拜)/u;
const C2_THIS_WEEK_PATTERN = /(?:本|这个|这)(?:周|星期|礼拜)/u;

/**
 * Parse a past-time expression into one explicit `{fromIso, toIso}` window. This is the C2
 * fallback heuristic, not the model's only way in: every boundary is local midnight in the
 * configured zone, never UTC. Unparseable text returns null so the caller can record
 * `reason: 'no-range'` instead of querying the archive with the whole question.
 * @returns {{fromIso: string, toIso: string, label: string, kind: 'day'|'week'|'fuzzy',
 *            day?: string, days?: number}|null}
 */
export function detectArchiveRange(query, {
  now = Date.now(),
  timeZone = C2_DEFAULT_TIME_ZONE,
  fuzzyDays = C2_DEFAULT_FUZZY_DAYS,
} = {}) {
  const text = typeof query === 'string' ? query : '';
  if (text.trim().length === 0) return null;
  const tz = resolveC2TimeZone(timeZone);
  const stamp = typeof now === 'function' ? Number(now()) : (now instanceof Date ? now.getTime() : Number(now));
  if (!Number.isFinite(stamp)) return null;
  const today = zonedParts(stamp, tz);
  const todayParts = { year: today.year, month: today.month, day: today.day };
  const days = Math.min(90, Math.max(1, Math.floor(Number(fuzzyDays) || C2_DEFAULT_FUZZY_DAYS)));
  const dayWindow = (offset, label) => {
    const parts = addLocalDays(todayParts, offset);
    const window = localDayWindow(parts, tz);
    return {
      ...window,
      kind: 'day',
      label,
      day: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    };
  };
  const weekStart = (offsetWeeks) => addLocalDays(todayParts, -(localIsoDay(todayParts) - 1) + offsetWeeks * 7);
  const weekWindow = (offsetWeeks, label) => {
    const startParts = weekStart(offsetWeeks);
    const endParts = addLocalDays(startParts, 7);
    return {
      fromIso: new Date(zonedWallTime(startParts.year, startParts.month, startParts.day, 0, tz)).toISOString(),
      toIso: new Date(zonedWallTime(endParts.year, endParts.month, endParts.day, 0, tz)).toISOString(),
      kind: 'week',
      label,
    };
  };

  if (/(昨晚|昨天晚上)/u.test(text)) {
    const startParts = addLocalDays(todayParts, -1);
    const from = zonedWallTime(startParts.year, startParts.month, startParts.day, 18, tz);
    const to = zonedWallTime(todayParts.year, todayParts.month, todayParts.day, 6, tz);
    return { fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(), kind: 'day', label: '昨晚' };
  }
  if (/(昨天|昨日|昨儿)/u.test(text)) return dayWindow(-1, '昨天');
  if (/(前天|前日)/u.test(text)) return dayWindow(-2, '前天');
  if (C2_WEEKDAY_PATTERN.test(text)) {
    const match = C2_WEEKDAY_PATTERN.exec(text);
    const offsetWeeks = match[1] === '上' ? -1 : 0;
    const index = '一二三四五六日天'.indexOf(match[2]);
    const weekday = index === 7 ? 7 : index + 1;
    const target = addLocalDays(weekStart(offsetWeeks), weekday - 1);
    const window = localDayWindow(target, tz);
    return {
      ...window,
      kind: 'day',
      label: `${offsetWeeks === -1 ? '上周' : '本周'}${match[2]}`,
      day: `${target.year}-${String(target.month).padStart(2, '0')}-${String(target.day).padStart(2, '0')}`,
    };
  }
  if (C2_LAST_WEEK_PATTERN.test(text)) return weekWindow(-1, '上周');
  if (C2_THIS_WEEK_PATTERN.test(text)) return weekWindow(0, '本周');
  if (C2_FUZZY_PATTERN.test(text)) {
    const startParts = addLocalDays(todayParts, -(days - 1));
    return {
      fromIso: new Date(zonedWallTime(startParts.year, startParts.month, startParts.day, 0, tz)).toISOString(),
      toIso: new Date(stamp).toISOString(),
      kind: 'fuzzy',
      label: `最近 ${days} 天`,
      days,
    };
  }
  if (/(今天|今日|今儿)/u.test(text)) return dayWindow(0, '今天');
  return null;
}

/** Human wording for the status line: a day is "YYYY-MM-DD 全天", a week is its span. */
export function describeArchiveRange(range, timeZone = C2_DEFAULT_TIME_ZONE) {
  if (range === null || typeof range !== 'object') return '未限定时间窗';
  if (range.kind === 'fuzzy') return `最近 ${Number(range.days) || C2_DEFAULT_FUZZY_DAYS} 天`;
  if (range.kind === 'week') {
    const end = new Date(Date.parse(range.toIso) - 1);
    return `${zonedDateStamp(Date.parse(range.fromIso), timeZone)} 至 ${zonedDateStamp(end, timeZone)} 整周`;
  }
  return `${zonedDateStamp(Date.parse(range.fromIso), timeZone)} 全天`;
}

/**
 * Map one turn's additive observations for the `voice.latency` event.
 *
 * `firstSpawnToPlayerReadyMs` measures player creation -> the child's `spawn` event: evidence that
 * the PLAYER PROCESS is ready, not that PCM was decoded, submitted or heard. The old
 * `firstSpawnToPcmMs` name is therefore dropped (tts.js no longer reports a PCM instant) and the
 * legacy observation slot is not emitted. An unmeasured value stays null, never 0.
 *
 * @param {object} [stages] the same row handed to `voiceLatencyEvent`
 * @returns {{firstSpawnToPlayerReadyMs: number|null, ttsSlotWaitMs: number|null,
 *   translateQueueWaitMs: number|null, firstAudibleMs: number|null,
 *   firstAudibleLane: string|null, firstAudibleUnknown?: string}}
 */
export function voiceLatencyObservationFields(stages = {}) {
  const fields = voiceLatencyObservations(stages);
  delete fields.firstSpawnToPcmMs;
  const ready = stages?.firstSpawnToPlayerReadyMs;
  const readyMs = ready === undefined || ready === null || ready === '' ? Number.NaN : Number(ready);
  fields.firstSpawnToPlayerReadyMs = Number.isFinite(readyMs) && readyMs >= 0
    ? Math.round(readyMs)
    : null;
  return fields;
}
