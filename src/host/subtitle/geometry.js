/** geometry — extracted from index.js; no host entry dependency. */
import * as subtitleModule from './subtitle.js';

const normalizeGeometry = typeof subtitleModule.normalizeGeometry === 'function'
  ? subtitleModule.normalizeGeometry
  : (value) => {
    if (value === null || typeof value !== 'object') return null;
    const left = Number(value.left ?? value.x);
    const top = Number(value.top ?? value.y);
    const width = Number(value.width ?? value.w);
    const height = Number(value.height ?? value.h);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) };
  };

export { normalizeGeometry };
