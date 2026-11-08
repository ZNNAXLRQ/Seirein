/**
 * Black-frame judgement for one vision frame.
 *
 * The OBS virtual camera can report itself active before it produces pixels: a capture taken in
 * that window is a perfectly valid, tiny, uniform black PNG. Delivering it as "what is on screen"
 * is worse than failing, so every capture and storyboard frame is judged before delivery.
 *
 * No ffmpeg is involved: the PNG's IDAT is inflated and its scanlines are unfiltered (bit depth 8,
 * non-interlaced, gray/RGB/alpha) before the luma mean/std are measured. A frame that cannot be
 * decoded is never called black — an unknown image is a capture problem the capture layer already
 * reports, and inventing a verdict here would refuse real frames (and every test double).
 *
 * Three independent rules mark a frame as a suspected black / not-yet-live frame:
 *   1. near-black pixels: dark and almost no variance (the camera's startup frame);
 *   2. two consecutive identical frames whose bytes are abnormally small (a repeated no-signal
 *      frame; a real screen capture that small is essentially impossible);
 *   3. the same identical, small frame held across a real wait (the source never advanced).
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/** A screen-quality PNG under 10 KB is suspicious: the 1280x720 startup frame was ~4.3 KB. */
export const BLACK_FRAME_SMALL_BYTES = 10 * 1024;
/** Luma (0..255) at or below this mean counts as "near black". */
export const BLACK_FRAME_MAX_MEAN = 12;
/** Luma standard deviation at or below this counts as "no variance" (one colour). */
export const BLACK_FRAME_MAX_STD = 4;
/** Identical frames separated by at least this long mean the source never advanced. */
export const BLACK_FRAME_SAME_MS = 900;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
/** Bound the row decode so a pathological header can never allocate without limit. */
const PNG_MAX_PIXELS = 40_000_000;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Read IHDR and the concatenated IDAT bytes; null for anything this decoder cannot trust. */
function pngChunks(data) {
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) return null;
    if (type === 'IHDR') {
      if (length !== 13) return null;
      header = {
        width: data.readUInt32BE(start),
        height: data.readUInt32BE(start + 4),
        bitDepth: data[start + 8],
        colorType: data[start + 9],
        interlace: data[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(data.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (header === null || idat.length === 0) return null;
  return { header, idat: Buffer.concat(idat) };
}

/**
 * Luma statistics of one PNG, or null when its pixels cannot be proven.
 * @param {Buffer} data PNG bytes
 * @returns {{width: number, height: number, pixels: number, mean: number, std: number,
 *   min: number, max: number} | null}
 */
export function pngLumaStats(data) {
  if (!Buffer.isBuffer(data) || data.length < PNG_SIGNATURE.length) return null;
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const parsed = pngChunks(data);
  if (parsed === null) return null;
  const { width, height, bitDepth, colorType, interlace } = parsed.header;
  const channels = PNG_CHANNELS[colorType];
  // Only the layout ffmpeg and dsh-see-now actually emit is decoded; anything else is unknown.
  if (channels === undefined || bitDepth !== 8 || interlace !== 0) return null;
  const pixels = width * height;
  if (pixels <= 0 || pixels > PNG_MAX_PIXELS) return null;
  let raw;
  try {
    raw = inflateSync(parsed.idat);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  let previous = null;
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    if (filter > 4) return null;
    const row = raw.subarray(cursor + 1, cursor + 1 + stride);
    cursor += stride + 1;
    // Reverse the per-scanline filter in place; `left`/`up` must be the reconstructed values.
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous === null ? 0 : previous[i];
      const upLeft = previous === null || i < channels ? 0 : previous[i - channels];
      let value = row[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      row[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const base = x * channels;
      const luma = channels <= 2
        ? row[base]
        : 0.299 * row[base] + 0.587 * row[base + 1] + 0.114 * row[base + 2];
      sum += luma;
      sumSq += luma * luma;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
    }
    previous = row;
  }
  const mean = sum / pixels;
  const variance = Math.max(0, sumSq / pixels - mean * mean);
  return { width, height, pixels, mean, std: Math.sqrt(variance), min, max };
}

/**
 * Judge one captured frame against the previous frame of the same source.
 *
 * The returned `frame` is the fingerprint to keep as `previous` for the next capture; it is only
 * ever produced for a decodable PNG, so two undecodable test doubles are never compared.
 *
 * @param {{data: Buffer, at?: number, previous?: object|null}} input
 * @returns {{black: boolean, reason: string, bytes: number, frame: object} | null}
 *   null when the image cannot be decoded: an unknown picture is never called black.
 */
export function assessFrame({ data, at = Date.now(), previous = null } = {}) {
  const stats = pngLumaStats(data);
  if (stats === null) return null;
  const digest = createHash('sha256').update(data).digest('hex');
  const frame = { digest, bytes: data.length, at, stats };
  let reason = '';
  if (stats.mean <= BLACK_FRAME_MAX_MEAN && stats.std <= BLACK_FRAME_MAX_STD) {
    reason = 'near-black';
  } else if (previous !== null && previous.digest === digest && data.length < BLACK_FRAME_SMALL_BYTES) {
    reason = Number.isFinite(previous.at) && Number.isFinite(at) && at - previous.at >= BLACK_FRAME_SAME_MS
      ? 'identical-small-stale'
      : 'duplicate-small';
  }
  return { black: reason !== '', reason, bytes: data.length, frame };
}
