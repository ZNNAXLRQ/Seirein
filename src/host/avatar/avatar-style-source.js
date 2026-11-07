import { resolveAvatarStyleText } from '../shared/text.js';
import { personaStyleVersion } from './avatarRuntime.js';

// ---- avatar motion style: which text the style is derived from -------------------------------
// The style must describe the persona that is ACTUALLY injected. The settings box is that text
// after a trial/save/writeback; the compiled profile snapshot is only the fallback while the box
// is still empty. A snapshot also carries the user-profile section, which is never persona
// material, so it is dropped before the text reaches the style builder.
export const AVATAR_STYLE_SOURCE_EVENT = 'avatar.style.source';

/**
 * Fresh-on-every-call source reader. A save/trial/writeback is visible on the next refresh (no
 * cached snapshot), and `avatar.style.source` is emitted only when the resolved text changes, so
 * the 60 s housekeeping tick cannot flood the event log.
 */
export function createAvatarStyleTextSource({ readBox = () => '', readSnapshot = () => '', onEvent = null } = {}) {
  let lastKey = '';
  return () => {
    let boxText = '';
    try {
      boxText = readBox();
    } catch {
      boxText = '';
    }
    let snapshotText = '';
    try {
      snapshotText = readSnapshot();
    } catch {
      snapshotText = '';
    }
    const resolved = resolveAvatarStyleText({ boxText, snapshotText });
    const key = `${resolved.kind}:${personaStyleVersion(resolved.text)}`;
    if (key !== lastKey) {
      lastKey = key;
      try {
        onEvent?.(AVATAR_STYLE_SOURCE_EVENT, { kind: resolved.kind, chars: resolved.chars });
      } catch {
        /* diagnostics must never break the style refresh */
      }
    }
    return resolved;
  };
}
