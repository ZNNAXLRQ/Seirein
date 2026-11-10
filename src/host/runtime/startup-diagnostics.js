/**
 * startup-diagnostics — keep the FIRST startup rejection/exception traceable.
 *
 * DSH's fail-loud disposes the root context on an unhandled rejection. The host then logs a
 * secondary error ("installPlatformSessionPublisher cannot create effect on inactive context"),
 * which hides the original failure. This module attaches passive listeners that only hand a
 * bounded summary to the caller's logger; it never calls preventDefault, never exits, and never
 * consumes the event. Node still runs every other listener (including DSH's fail-loud one).
 */

const MESSAGE_MAX_CHARS = 500;
const STACK_MAX_CHARS = 2000;
const TEXT_MAX_CHARS = 500;
const MAX_OBJECT_KEYS = 8;
const MAX_ARRAY_ITEMS = 4;
const MAX_DEPTH = 2;
const MAX_FUNCTION_NAME_CHARS = 80;

/** Bounds are exported so callers/tests can assert without duplicating magic numbers. */
export const STARTUP_DIAGNOSTIC_LIMITS = Object.freeze({
  messageChars: MESSAGE_MAX_CHARS,
  stackChars: STACK_MAX_CHARS,
  textChars: TEXT_MAX_CHARS,
});

const SENSITIVE_KEY = /pass(?:word)?|secret|token|api[-_]?key|auth(?:orization)?|cookie|credential|session|private/iu;

/** Clip a value to `max` characters; an unprintable value degrades to an empty string. */
function clip(value, max) {
  if (value === null || value === undefined) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    return '';
  }
  return text.length > max ? text.slice(0, max) : text;
}

/** Read one printable field without letting a getter/toString failure escape. */
function readText(owner, key) {
  try {
    const value = owner[key];
    return value === null || value === undefined ? '' : clip(value, Number.MAX_SAFE_INTEGER);
  } catch {
    return '';
  }
}

function isError(value) {
  try {
    return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
  } catch {
    return false;
  }
}

function constructorName(value) {
  try {
    const name = value?.constructor?.name;
    return typeof name === 'string' && name.length > 0 ? name : 'Object';
  } catch {
    return 'Object';
  }
}

function reasonTypeOf(value) {
  try {
    if (value === null) return 'null';
    if (isError(value)) return 'error';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  } catch {
    return 'unknown';
  }
}

/**
 * A bounded, credential-safe description for non-Error rejection reasons.
 *
 * Only own enumerable data properties are read (getters are never invoked), sensitive keys are
 * replaced with `[redacted]`, cycles become `[circular]`, and both depth and width are capped.
 * The final string is clipped again, so a huge object can never flood the event log.
 */
function describeReason(value, depth = 0, seen = new WeakSet()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return clip(value, TEXT_MAX_CHARS);
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
  if (type === 'undefined') return 'undefined';
  if (type === 'symbol') return clip(value.toString(), TEXT_MAX_CHARS);
  if (type === 'function') {
    let name = '';
    try {
      name = value.name;
    } catch {
      // a hostile function proxy has no safe name; the type label is still useful
    }
    return `[function ${clip(name || 'anonymous', MAX_FUNCTION_NAME_CHARS)}]`;
  }
  if (type !== 'object') return `[${type}]`;

  let tracked = false;
  try {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    tracked = true;

    if (depth >= MAX_DEPTH) return `[${constructorName(value)}]`;

    if (Array.isArray(value)) {
      const length = Number(value.length);
      const count = Number.isFinite(length) && length > 0 ? Math.min(Math.floor(length), MAX_ARRAY_ITEMS) : 0;
      const shown = [];
      for (let index = 0; index < count; index += 1) {
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        } catch {
          descriptor = undefined;
        }
        shown.push(descriptor !== undefined && 'value' in descriptor
          ? describeReason(descriptor.value, depth + 1, seen)
          : '[getter]');
      }
      const suffix = Number.isFinite(length) && length > count ? ', …' : '';
      return clip(`[array(${Number.isFinite(length) ? length : 0}) ${shown.join(', ')}${suffix}]`, TEXT_MAX_CHARS);
    }

    const parts = [];
    let more = '';
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (parts.length >= MAX_OBJECT_KEYS) {
        more = ', …';
        break;
      }
      if (SENSITIVE_KEY.test(key)) {
        parts.push(`${key}:[redacted]`);
        continue;
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        descriptor = undefined;
      }
      parts.push(`${key}:${descriptor !== undefined && 'value' in descriptor
        ? describeReason(descriptor.value, depth + 1, seen)
        : '[getter]'}`);
    }
    return clip(`{${parts.join(', ')}${more}}`, TEXT_MAX_CHARS);
  } catch {
    return `[${constructorName(value)}]`;
  } finally {
    // Shared-but-acyclic references still render; only a path back to an ancestor is a cycle.
    if (tracked) seen.delete(value);
  }
}

/**
 * Build the flat, bounded payload written to the event log. Error fields keep the original
 * name/message/stack prefix; every non-Error reason gets one safe description instead.
 */
export function summarizeStartupReason(value) {
  const summary = {
    reasonType: reasonTypeOf(value),
    name: '',
    message: '',
    stack: '',
    reasonText: '',
    messageTruncated: false,
    stackTruncated: false,
  };

  if (summary.reasonType === 'error') {
    const name = readText(value, 'name');
    const message = readText(value, 'message');
    const stack = readText(value, 'stack');
    summary.name = clip(name, MESSAGE_MAX_CHARS);
    summary.message = clip(message, MESSAGE_MAX_CHARS);
    summary.stack = clip(stack, STACK_MAX_CHARS);
    summary.messageTruncated = message.length > MESSAGE_MAX_CHARS;
    summary.stackTruncated = stack.length > STACK_MAX_CHARS;
    return summary;
  }

  summary.reasonText = clip(describeReason(value), TEXT_MAX_CHARS);
  return summary;
}

/** Run a logger callback without letting the diagnostic replace the original failure. */
function report(handler, value) {
  if (typeof handler !== 'function') return;
  try {
    const pending = handler(summarizeStartupReason(value));
    if (pending !== null && (typeof pending === 'object' || typeof pending === 'function')
      && typeof pending.then === 'function') {
      Promise.resolve(pending).catch(() => {});
    }
  } catch {
    // A broken diagnostics sink must never throw from inside process event handling.
  }
}

/**
 * Attach the two passive process listeners and return an idempotent uninstall function.
 *
 * `proc` is injectable for tests; production callers pass only the two callbacks and use the
 * real process object. Removing the listeners always uses the same function references.
 */
export function installStartupDiagnostics({
  onRejection,
  onException,
  proc = globalThis.process,
} = {}) {
  if (proc === null || proc === undefined
    || typeof proc.on !== 'function' || typeof proc.removeListener !== 'function') {
    return () => {};
  }

  const rejectionListener = (reason) => { report(onRejection, reason); };
  const exceptionListener = (error) => { report(onException, error); };
  proc.on('unhandledRejection', rejectionListener);
  proc.on('uncaughtException', exceptionListener);

  let installed = true;
  return function uninstall() {
    if (!installed) return;
    installed = false;
    try {
      proc.removeListener('unhandledRejection', rejectionListener);
    } catch {
      // already gone / a test double without working removal — nothing to unwind
    }
    try {
      proc.removeListener('uncaughtException', exceptionListener);
    } catch {
      // already gone / a test double without working removal — nothing to unwind
    }
  };
}
