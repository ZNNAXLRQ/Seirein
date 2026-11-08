window.__ModuleLoader__.load({
  id: '@local/dsh-assistant',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    // Bump together with package.json. Shown in the UI so a stale browser bundle is obvious.
    const CLIENT_VERSION = '0.98.9';

    const MUTED = '#6b7280';
    const BORDER = '#d8dce3';
    const ACCENT = '#3b5bdb';
    const DANGER = '#c92a2a';

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      card: { border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, background: '#fff' },
      title: { fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#111827' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0' },
      label: { fontSize: 13, color: '#111827' },
      value: { fontSize: 13, color: MUTED },
      btn: { fontSize: 13, padding: '5px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: '#111827', cursor: 'pointer' },
      btnPrimary: { fontSize: 13, padding: '5px 12px', borderRadius: 8, border: '1px solid transparent', background: ACCENT, color: '#fff', cursor: 'pointer' },
      btnActive: { fontSize: 13, padding: '5px 12px', borderRadius: 8, border: `1px solid ${ACCENT}`, background: '#eef2ff', color: ACCENT, cursor: 'pointer', fontWeight: 600 },
      btnDanger: { fontSize: 12, padding: '4px 10px', borderRadius: 8, border: `1px solid ${DANGER}`, background: '#fff', color: DANGER, cursor: 'pointer' },
      off: { opacity: 0.45, cursor: 'not-allowed' },
      input: { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: '#111827' },
      area: { width: '100%', boxSizing: 'border-box', minHeight: 90, fontSize: 13, padding: 8, borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: '#111827', resize: 'vertical' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 },
      hint: { fontSize: 12, color: MUTED, marginTop: 6 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: MUTED },
      badge: { display: 'inline-block', fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${BORDER}`, color: MUTED, marginLeft: 6 },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 },
      dialog: { width: 520, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', background: '#fff', color: '#111827', borderRadius: 12, padding: 18, border: `1px solid ${BORDER}`, boxShadow: '0 16px 48px rgba(0,0,0,0.25)' },
      toast: { position: 'fixed', right: 24, bottom: 24, zIndex: 4000, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, background: '#fff', color: '#111827', border: `1px solid ${BORDER}`, boxShadow: '0 8px 28px rgba(0,0,0,0.22)', fontSize: 13 },
    };

    /** The global hotkeys the host ships; anything else in status is ignored. */
    const HOTKEY_ACTIONS = ['mic', 'vision', 'layerEdit', 'ambient'];

    const HOTKEY_LABEL = {
      mic: '麦克风静音 / 恢复',
      vision: '隐私场景（视觉）切换',
      layerEdit: '形象编辑模式',
      ambient: '环境声音',
    };

    const KIND_OPTIONS = ['source', 'endpoint', 'convention', 'credential', 'note'];

    function card(title, ...children) {
      return h('div', { style: styles.card }, h('div', { style: styles.title }, title), ...children);
    }

    function line(label, value) {
      return h('div', { style: styles.row }, h('span', { style: styles.label }, label), h('span', { style: styles.value }, value));
    }

    /**
     * 「最近听到」行：默认只露最近 1 条，展开露最近 3 条（旧→新）。每条按字符截断到 40 字
     * （全角算 1 字，Array.from 按码点计数），超出补 `…`；行内文本再 nowrap + ellipsis，绝不撑高。
     * 空列表沿用 `—`，只有 2 条及以上才给「展开 / 收起」；展开与否是 Panel 的局部 state。
     */
    function ambientRecentRow(h, { recent, expanded, onToggle }) {
      const list = Array.isArray(recent) ? recent : [];
      if (list.length === 0) return line('最近听到', '—');
      const clip = (text) => {
        const chars = Array.from(String(text ?? ''));
        return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
      };
      const shown = (expanded ? list.slice(-3) : list.slice(-1)).map(clip);
      return h('div', { style: styles.row },
        h('span', { style: styles.label }, '最近听到'),
        h('span', { style: { ...styles.value, flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          shown.map((text, index) => h('span', {
            key: index,
            style: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          }, text))),
        list.length > 1
          ? h('button', {
            style: { ...styles.btn, flexShrink: 0, whiteSpace: 'nowrap' },
            onClick: () => onToggle(!expanded),
          }, expanded ? '收起' : '展开')
          : null,
      );
    }

    const fmtTokens = (value) => {
      const n = Number(value ?? 0);
      return n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(Math.round(n));
    };

    /**
     * The newest voice round's translation line for the latency card: `320ms（缓存）`, `450ms`,
     * or `—` when that round did not translate (same language). Never a fabricated 0.
     */
    const fmtTranslateLatency = (latency) => {
      const cached = latency?.translateCached === true;
      const ms = Number(latency?.translateMs);
      if (cached) return `${Number.isFinite(ms) ? Math.round(ms) : 0}ms（缓存）`;
      return Number.isFinite(ms) && ms > 0 ? `${Math.round(ms)}ms` : '—';
    };

    const NUMPAD_CODE = {
      NumpadMultiply: 'NumMultiply', NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
      NumpadDecimal: 'NumDecimal', NumpadDivide: 'NumDivide',
    };

    function normalizeKey(event) {
      // event.key cannot separate the numpad from the main row (with NumLock on, both report
      // "1"), so the physical code names the numpad first; every other key keeps the old path.
      const code = typeof event.code === 'string' ? event.code : '';
      const numpadDigit = /^Numpad([0-9])$/u.exec(code);
      if (numpadDigit !== null) return `Num${numpadDigit[1]}`;
      if (NUMPAD_CODE[code] !== undefined) return NUMPAD_CODE[code];
      const key = event.key;
      if (key === ' ') return 'Space';
      if (/^F\d{1,2}$/u.test(key)) return key.toUpperCase();
      if (key.length === 1) return key.toUpperCase();
      const named = {
        Escape: 'Esc', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      };
      return named[key] ?? null;
    }

    /**
     * Daily rollover bridge, always-on: poll the host for the new day's continuity digest and
     * type it into a fresh session's composer. Voice transcripts never come through here — the
     * host delivers them to the dated session directly (typing is this page's only voice-free job).
     *
     * The interval handle lives on `window.__seireinPoll`, not in this closure: reloading the
     * plugin evaluates the factory again, and the new generation must stop the old interval.
     */
    const POLL_KEY = '__seireinPoll';
    const POLL_MS = 1500;
    const ROLLOVER_LOCK_KEY = 'seirein.rollover.claim';
    const ROLLOVER_LOCK_MS = 10000;

    /** Stop whatever poller an earlier generation installed. Idempotent; safe when none runs. */
    function stopPolling() {
      if (typeof window === 'undefined') return;
      const previous = window[POLL_KEY];
      if (previous === null || previous === undefined) return;
      // Invalidate the generation first: every tick re-checks `cancelled` after each await, and
      // aborting the controller rejects the request that is already in flight.
      previous.cancelled = true;
      previous.controller?.abort();
      // A composer SEND this generation deferred must never click after the stop: drop its
      // pending timers now rather than letting them fire and discover the cancellation.
      previous.cancelSend?.();
      if (previous.timer !== null && previous.timer !== undefined) clearInterval(previous.timer);
      for (const entry of previous.listeners ?? []) {
        entry.target?.removeEventListener?.(entry.type, entry.handler, entry.options);
      }
      if (Array.isArray(previous.listeners)) previous.listeners.length = 0;
      previous.timer = null;
      window[POLL_KEY] = null;
    }

    /** Monotonic poll generation; seeded from the live handle so a reload keeps counting up. */
    let pollGeneration = 0;

    /** Install exactly one poller on this page, replacing any older one. */
    function startPolling() {
      if (typeof window === 'undefined') return null;
      // Read the generation before stopPolling drops the handle, so a reload continues the count.
      const previousGeneration = Number(window[POLL_KEY]?.generation);
      if (Number.isFinite(previousGeneration)) {
        pollGeneration = Math.max(pollGeneration, previousGeneration);
      }
      stopPolling();
      const handle = {
        version: CLIENT_VERSION,
        generation: (pollGeneration += 1),
        cancelled: false,
        controller: new AbortController(),
        timer: null,
        listeners: [],
        // Set while a deferred composer SEND owns live timers; stopPolling() calls it to drop them.
        cancelSend: null,
      };
      window[POLL_KEY] = handle;

      /**
       * Type `text` into the chat composer and submit; false when no composer is mounted.
       * `isActive` is this generation's liveness check: the deferred SEND — both its timers and
       * the click itself — consults it, so a stopPolling() between the fill and the click clears
       * the pending timers and resolves false instead of sending into a dead generation.
       */
      const typeIntoComposer = (text, isActive = () => true) => {
        // Anchor on the send button: DSH always renders `button[aria-label="发送消息"]` inside the
        // composer card, and the card also contains the real contenteditable input. Searching
        // from the button avoids the settings textareas entirely.
        const sendButton = document.querySelector('button[aria-label="发送消息"]')
          ?? [...document.querySelectorAll('button')]
            .find((node) => /发送消息|send message/i.test(node.getAttribute('aria-label') ?? ''));
        const scope = sendButton?.closest('[class*="card"]')?.parentElement
          ?? sendButton?.parentElement?.parentElement
          ?? document.body;
        const target = scope.querySelector('[contenteditable="true"]')
          ?? [...scope.querySelectorAll('textarea')].find((node) => node.offsetParent !== null);
        if (target === null || target === undefined) return false;
        target.focus();
        if (target.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(target, text);
          target.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Rich-text editors keep their own model; execCommand fires the events they listen to.
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(target);
          selection?.removeAllRanges();
          selection?.addRange(range);
          const inserted = typeof document.execCommand === 'function'
            && document.execCommand('insertText', false, text);
          if (!inserted) {
            target.textContent = text;
            target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
          }
        }
        // Resolve only once the editor actually emptied itself (i.e. the message was sent); an
        // unsent draft must not be acknowledged, or a following line would overwrite it.
        const emptied = () => {
          const current = (target.textContent ?? target.value ?? '').trim();
          return current.length === 0;
        };
        return new Promise((resolve) => {
          // SEND is deferred by two timers. Keep their ids so cancellation can drop them before
          // they fire, and settle exactly once: only a send the editor confirms may resolve true.
          const pending = new Set();
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            handle.cancelSend = null;
            for (const timer of pending) clearTimeout(timer);
            pending.clear();
            resolve(value);
          };
          // stopPolling() invokes this: the generation is gone, so its SEND never happens.
          handle.cancelSend = () => finish(false);
          if (!isActive()) {
            finish(false);
            return;
          }
          const submit = () => {
            if (settled) return;
            if (!isActive()) {
              finish(false);
              return;
            }
            // From here on the SEND is dispatched: a late stop can no longer unsend it.
            handle.cancelSend = null;
            if (sendButton !== undefined && !sendButton.disabled) {
              sendButton.click();
            } else {
              for (const type of ['keydown', 'keypress', 'keyup']) {
                target.dispatchEvent(new KeyboardEvent(type, {
                  key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
                }));
              }
            }
            // Only the editor can prove the send landed; a surviving draft stays unacknowledged.
            setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve(emptied());
            }, 350);
          };
          const first = setTimeout(() => {
            pending.delete(first);
            if (!isActive()) {
              finish(false);
              return;
            }
            if (sendButton !== undefined && !sendButton.disabled) {
              submit();
              return;
            }
            target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            const retry = setTimeout(() => {
              pending.delete(retry);
              if (!isActive()) {
                finish(false);
                return;
              }
              submit();
            }, 140);
            pending.add(retry);
          }, 120);
          pending.add(first);
        });
      };

      // Returns the parsed reply, or undefined when the host is unreachable/restarting.
      const action = async (body) => {
        try {
          const response = await fetch('/assistant/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(body),
            // Cancelled with the generation: a stopped poller must not keep talking to the host.
            signal: handle.controller.signal,
          });
          return await response.json();
        } catch {
          return undefined;
        }
      };

      // Announce the bundle once the host answers; at page load the routes may not be ready yet.
      let helloed = false;
      let inFlight = false;

      /**
       * One rollover may be retried by one page only. Ask the host first; hosts older than R13 have
       * no `rollover.claim` action, so fall back to a timestamp lock that reloads and sibling tabs
       * share. Returns false when another page already owns this rollover.
       */
      const claimRollover = async () => {
        const claim = await action({ action: 'rollover.claim' });
        // The generation may have stopped while the host was answering: do not claim for it.
        if (handle.cancelled || window[POLL_KEY] !== handle) return false;
        if (claim?.ok === true) return claim.claimed !== false;
        // localStorage is shared by every tab (sessionStorage is per-tab and could not dedupe a
        // second tab, the case this lock exists for); fall back to sessionStorage if it throws.
        try {
          const store = window.localStorage ?? window.sessionStorage;
          const now = Date.now();
          const last = Number(store.getItem(ROLLOVER_LOCK_KEY) ?? 0);
          if (Number.isFinite(last) && now - last < ROLLOVER_LOCK_MS) return false;
          store.setItem(ROLLOVER_LOCK_KEY, String(now));
          return true;
        } catch {
          return true; // storage blocked: heal the day rather than skip it forever
        }
      };

      const tick = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
          const response = await fetch('/assistant/status', {
            cache: 'no-store',
            signal: handle.controller.signal,
          });
          // Every await re-checks the generation: a stopped or replaced poller owns no page action.
          if (handle.cancelled || window[POLL_KEY] !== handle) return;
          if (!response.ok) return;
          const data = await response.json();
          if (handle.cancelled || window[POLL_KEY] !== handle) return;
          if (!helloed) {
            helloed = true;
            void action({ action: 'client.hello', version: CLIENT_VERSION });
          }
          // Presence ping only. Voice delivery NEVER depends on it: transcripts always go to the
          // dated Seirein session, so a focused page cannot pull voice into this composer.
          void action({ action: 'client.ping', version: CLIENT_VERSION });

          // Daily rollover: claim it first (one page only), then open a fresh session and type.
          if (!(data.rollover && typeof data.rollover.digest === 'string')) return;
          if (handle.cancelled || window[POLL_KEY] !== handle) return;
          if (!(await claimRollover())) return;
          if (handle.cancelled || window[POLL_KEY] !== handle) return;
          const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
          const targetWorkspace = data.workspace?.id ?? '';
          if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
            try {
              // Open the Seirein workspace first, otherwise the session lands in whatever
              // workspace happens to be active (usually 默认工作区).
              if (targetWorkspace) await uiWorkspace.openWorkspace(targetWorkspace);
              if (handle.cancelled || window[POLL_KEY] !== handle) return;
              uiWorkspace.startSession(targetWorkspace || undefined);
            } catch (error) {
              // The host dropped the old diag action (b860f84); keep the diagnosis local.
              console.warn('[seirein] rollover: startSession failed', error);
            }
          } else {
            const fresh = [...document.querySelectorAll('button, a, [role="button"]')]
              .find((node) => node instanceof HTMLElement && node.offsetParent !== null
                && /新会话|New session/i.test(node.textContent ?? ''));
            fresh?.click();
          }
          // The composer defers its SEND by 120/140ms: hand it the same generation gate this loop
          // uses, so a stop in that window aborts the send instead of clicking into a dead page.
          const isActive = () => !handle.cancelled && window[POLL_KEY] === handle;
          // The composer mounts asynchronously; retry instead of giving up after one shot.
          let typed = false;
          for (let attempt = 0; attempt < 20 && !typed; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            // Each retry round re-checks: a cancelled generation stops typing immediately.
            if (handle.cancelled || window[POLL_KEY] !== handle) return;
            typed = await typeIntoComposer(data.rollover.digest, isActive);
            // The outer check still runs after the await: a cancelled generation never acks.
            // `typed !== true` (no composer yet) falls through to the retry round instead of
            // returning, which is what the 20x300ms loop exists for; only a true send acks.
            if (!isActive()) return;
          }
          if (typed) void action({ action: 'rollover.ack' });
          // The rollover digest above is typed here. Voice transcripts are not: the host routes
          // every utterance into the dated session under <root>/workspace, never into this
          // composer, so there is deliberately no voice claim/requeue loop.
        } catch (error) {
          // The host may be restarting; an AbortError means stopPolling() cancelled this very
          // generation's request, so neither may surface as a poller error.
          if (error?.name === 'AbortError') return;
        } finally {
          inFlight = false;
        }
      };

      handle.timer = setInterval(() => { void tick(); }, POLL_MS);
      void tick();
      return handle;
    }

    // ---- fastpath review (快路对话按域审阅) ----------------------------------------------------
    // P-69: one persisted conversation file can mix domains. The settings card lists one collapsible
    // group per domain ('' = 未分组), newest first, with a domain filter and a per-domain clear.
    // `h` is injected so the render can be asserted without React or a DOM.

    const FASTPATH_GROUP_ALL = '*';
    const FASTPATH_PREVIEW_CHARS = 90;
    const FASTPATH_UNGROUPED_LABEL = '未分组';

    function fastpathDomainLabel(domain, label) {
      const value = String(domain ?? '');
      if (value.length === 0) return FASTPATH_UNGROUPED_LABEL;
      // P-69 A: the group's display name is separate from its stable ID; without one, show the
      // first 8 characters of the ID instead of dumping the whole hash into the header.
      const text = String(label ?? '').trim();
      return text.length > 0 ? text : value.slice(0, 8);
    }

    function fastpathPreview(text, max = FASTPATH_PREVIEW_CHARS) {
      const value = String(text ?? '');
      return value.length > max
        ? { text: `${value.slice(0, max)}…`, truncated: true }
        : { text: value, truncated: false };
    }

    function fastpathEntryKey(domain, entry, index) {
      return `${String(domain)}|${Number(entry?.ts ?? 0)}|${String(entry?.role ?? '')}|${index}`;
    }

    function fastpathReviewBody(h, state, handlers) {
      const groups = Array.isArray(state?.groups) ? state.groups : [];
      const filter = String(state?.filter ?? FASTPATH_GROUP_ALL);
      const open = Array.isArray(state?.open) ? state.open : [];
      const expanded = Array.isArray(state?.expanded) ? state.expanded : [];
      const confirm = state?.confirm === undefined ? null : state.confirm;
      const busy = state?.busy === true;
      const loading = state?.loading === true;
      const filtering = filter !== FASTPATH_GROUP_ALL;
      const total = groups.reduce(
        (sum, group) => sum + Number(group?.count ?? (Array.isArray(group?.entries) ? group.entries.length : 0)),
        0,
      );
      const visibleGroups = filtering
        ? groups.filter((group) => String(group?.domain ?? '') === filter)
        : groups;
      // P-69 A: `label` is the workspace directory name (display only); the key stays the stable ID.
      const labelOfDomain = (domain) => {
        const key = String(domain ?? '');
        return fastpathDomainLabel(key, groups.find((group) => String(group?.domain ?? '') === key)?.label);
      };
      // 「未分组」always has its own option; the remaining options come from the loaded groups.
      const domainOptions = groups
        .map((group) => String(group?.domain ?? ''))
        .filter((domain) => domain.length > 0)
        .filter((domain, index, all) => all.indexOf(domain) === index)
        .map((domain) => h('option', { key: domain, value: domain }, labelOfDomain(domain)));

      return h('div', {
        'data-fastpath-review': true,
        style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${BORDER}` },
      },
        h('div', { style: styles.row },
          h('span', { style: styles.label }, `对话记录 · ${total} 条 / ${groups.length} 个域`),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              'data-fastpath-action': 'refresh',
              style: styles.btn,
              disabled: busy,
              onClick: () => handlers.refresh(),
            }, '刷新'),
            h('button', {
              'data-fastpath-action': 'close',
              style: styles.btn,
              onClick: () => handlers.close(),
            }, '收起'),
          ),
        ),
        h('label', { style: styles.field },
          h('span', { style: styles.value }, '按域筛选'),
          h('select', {
            'data-fastpath-filter': true,
            style: styles.input,
            value: filter,
            disabled: busy,
            onChange: (event) => handlers.setFilter(event.target.value),
          },
            h('option', { value: FASTPATH_GROUP_ALL }, '全部'),
            h('option', { value: '' }, FASTPATH_UNGROUPED_LABEL),
            domainOptions,
          ),
        ),
        loading
          ? h('div', { 'data-fastpath-loading': true, style: styles.hint }, '正在读取对话记录…')
          : visibleGroups.length === 0
            ? h('div', { 'data-fastpath-empty': true, style: styles.hint },
                filtering
                  ? `「${labelOfDomain(filter)}」没有记录。`
                  : '没有快路对话记录。快路对话不进 DSH 会话日志，只存在这里。')
            : visibleGroups.map((group) => {
                const domain = String(group?.domain ?? '');
                const entries = Array.isArray(group?.entries) ? group.entries : [];
                const count = Number(group?.count ?? entries.length);
                const isOpen = filtering || open.includes(domain);
                return h('div', {
                  key: `group-${domain}`,
                  'data-fastpath-group': domain,
                  style: { borderTop: '1px solid #f0f1f3', paddingTop: 6, marginTop: 6 },
                },
                  h('div', { style: styles.row },
                    h('button', {
                      'data-fastpath-action': 'toggle-group',
                      'data-domain': domain,
                      style: styles.btn,
                      disabled: busy,
                      onClick: () => handlers.toggleGroup(domain),
                    }, `${isOpen ? '▾' : '▸'} ${labelOfDomain(domain)}（${count}）`),
                    h('button', {
                      'data-fastpath-action': 'clear',
                      'data-domain': domain,
                      style: { ...styles.btnDanger, ...(busy || count === 0 ? styles.off : {}) },
                      disabled: busy || count === 0,
                      onClick: () => handlers.requestClear(domain),
                    }, '清空该域'),
                  ),
                  confirm === domain
                    ? h('div', {
                        'data-fastpath-confirm': domain,
                        style: { marginTop: 6, padding: 8, borderRadius: 8, background: '#fff7e6', border: '1px solid #d98324' },
                      },
                        h('div', { style: styles.value }, `确认清空「${labelOfDomain(domain)}」的 ${count} 条记录？其它域不受影响。`),
                        h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                          h('button', {
                            'data-fastpath-action': 'clear-confirm',
                            'data-domain': domain,
                            style: { ...styles.btnDanger, ...(busy ? styles.off : {}) },
                            disabled: busy,
                            onClick: () => handlers.confirmClear(domain),
                          }, '确认清空'),
                          h('button', {
                            'data-fastpath-action': 'clear-cancel',
                            style: styles.btn,
                            disabled: busy,
                            onClick: () => handlers.cancelClear(),
                          }, '取消'),
                        ),
                      )
                    : null,
                  isOpen
                    ? h('div', {
                        'data-fastpath-entries': domain,
                        style: { maxHeight: 320, overflow: 'auto', marginTop: 4 },
                      },
                        entries.length === 0
                          ? h('div', { style: styles.hint }, '该域没有记录。')
                          : entries.map((entry, index) => {
                              const key = fastpathEntryKey(domain, entry, index);
                              const text = String(entry?.text ?? '');
                              const preview = fastpathPreview(text);
                              const full = expanded.includes(key);
                              const role = entry?.role === 'user' ? '我' : '助手';
                              const ts = Number(entry?.ts ?? 0);
                              const when = ts > 0
                                ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                                : '—';
                              const meta = [
                                [entry?.provider, entry?.model]
                                  .filter((part) => typeof part === 'string' && part.length > 0)
                                  .join('/'),
                                Number(entry?.ms ?? 0) > 0 ? `${Number(entry.ms)} ms` : '',
                              ].filter((part) => part.length > 0).join(' · ');
                              return h('div', { key, 'data-fastpath-entry': key, style: { padding: '5px 0' } },
                                h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                                  h('span', { style: { ...styles.mono, width: 92, flex: '0 0 auto' } }, when),
                                  h('span', { style: { fontSize: 11, fontWeight: 600, color: role === '我' ? ACCENT : MUTED, width: 28, flex: '0 0 auto' } }, role),
                                  h('span', {
                                    'data-fastpath-text': key,
                                    style: { flex: 1, fontSize: 12, color: '#111827', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                                  }, full ? text : preview.text),
                                  preview.truncated
                                    ? h('button', {
                                        'data-fastpath-action': 'toggle-text',
                                        'data-entry': key,
                                        style: styles.btn,
                                        onClick: () => handlers.toggleText(key),
                                      }, full ? '收起' : '展开全文')
                                    : null,
                                ),
                                meta.length > 0
                                  ? h('div', { style: { ...styles.mono, marginLeft: 128 } }, meta)
                                  : null,
                              );
                            }),
                      )
                    : null,
                );
              }),
      );
    }

    // ---- profile library (人设库) -------------------------------------------------------------
    // Step 4: the settings card that sits directly under the memory card. The user only edits the
    // two texts; the host's model split turns them into categorized fragments. The card therefore
    // never renders an entry list or per-entry buttons (edit / lock / undo / remove all live only
    // in the host, not in this UI).

    /** The two box texts as persisted (`status.profile.text`), never derived from the entries. */
    function profileTexts(profile) {
      const text = profile !== null && typeof profile === 'object' ? profile.text : null;
      return {
        agent: String(text?.agent ?? ''),
        user: String(text?.user ?? ''),
      };
    }

    /** Card wording for a profile side: the entry tables use `agent`/`user`. */
    function profileSideLabel(side) {
      return side === 'agent' ? '人设' : '画像';
    }

    /** 「保存」：只写入文本框（持久化），不拆分、不入库、不重写；点「整理后入库」才进库。 */
    async function profileSaveText(act, text, show) {
      const result = await act({
        action: 'profile.save',
        agent: String(text?.agent ?? ''),
        user: String(text?.user ?? ''),
      }, 'profile-save');
      if (result?.ok === true && typeof show === 'function') {
        show('已保存到文本框，尚未入库；点「整理后入库」完成拆分→入库→重写→写回');
      }
      return result;
    }

    /** 保存结果 → 卡片状态：只报“未入库待整理”，不再显示拆分计数。 */
    function profileSaveState(result) {
      if (result === null || result === undefined) return { running: false, error: '保存请求失败' };
      if (result.ok === false) {
        return { running: false, error: String(result.error ?? result.reason ?? '保存失败') };
      }
      const pending = result.pending ?? {};
      const sides = ['agent', 'user'].filter((side) => pending[side] === true);
      return {
        running: false,
        error: '',
        summary: null,
        note: sides.length > 0
          ? '已保存到文本框，尚未入库；点「整理后入库」完成拆分→入库→重写→写回'
          : '文本框内容已保存，且与库一致',
      };
    }

    /** 「暂停自动整理」开关体：宿主只接受这一个最小字段。 */
    const profileAutoBody = (autoMaintain) => ({ action: 'profile.auto', autoMaintain: autoMaintain !== false });

    // ---- P-116 初始参考人设问卷 ------------------------------------------------------------
    // 十道题由宿主固定返回，这里只负责收集答案、展示可编辑草案，以及「应用试用 / 正式采用 /
    // 放弃试用 / 关闭」四个动作。没有作答时客户端先拦一次，宿主还会再用错误码拒绝。

    const PERSONA_QUIZ_HINT_TEXT = '可以直接写她理想中的回复，也可以描述你希望她如何回应，或把两种方式写在一起。';

    /** 已回答（非空）的题数；全空时不得提交。 */
    function personaQuizAnswered(answers) {
      return (Array.isArray(answers) ? answers : [])
        .filter((item) => String(item?.text ?? '').trim().length > 0).length;
    }

    /** 只发送有内容的答案；revision 让宿主能丢弃迟到结果。 */
    function personaQuizAnswersBody(answers, revision) {
      const list = (Array.isArray(answers) ? answers : [])
        .map((item) => ({ id: String(item?.id ?? ''), text: String(item?.text ?? '') }))
        .filter((item) => item.id.length > 0 && item.text.trim().length > 0);
      const body = { action: 'persona.quiz.generate', answers: list };
      if (revision !== null && revision !== undefined) body.revision = revision;
      return body;
    }

    function personaQuizCanGenerate(answers) {
      return personaQuizAnswered(answers) >= 1;
    }

    /** 问卷与草案弹窗；`h` 由调用方注入，默认关闭时不渲染任何节点。 */
    function personaQuizDialog(h, state, handlers) {
      const quiz = state?.quiz;
      if (quiz === null || quiz === undefined || quiz.open !== true) return null;
      const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
      const answers = Array.isArray(quiz.answers) ? quiz.answers : [];
      const trial = quiz.trial ?? state?.profile?.trial ?? null;
      const trialActive = trial?.active === true;
      const draft = String(quiz.draft ?? (trialActive ? trial?.text ?? '' : ''));
      const answered = personaQuizAnswered(answers);
      const busy = quiz.busy === true;
      const canGenerate = personaQuizCanGenerate(answers) && !busy;
      const error = String(quiz.error ?? '');
      const answerOf = (id) => String(answers.find((item) => item?.id === id)?.text ?? '');
      const hasDraft = draft.trim().length > 0 || trialActive;
      return h('div', { 'data-profile-quiz-dialog': true, style: styles.overlay },
        h('div', { style: styles.dialog },
          h('div', { style: styles.title }, trialActive ? '生成初始人设 · 试用中' : '生成初始人设'),
          h('div', { style: styles.hint }, PERSONA_QUIZ_HINT_TEXT),
          h('div', { style: styles.hint }, '每题都可以留空跳过；至少回答一题才能生成。'),
          questions.map((question, index) => h('label', {
            key: String(question.id),
            'data-profile-quiz-question': String(question.id),
            style: styles.field,
          },
            h('span', { style: styles.value }, `第 ${index + 1} 题 · ${question.topic ?? ''}（留空即跳过）`),
            h('div', { style: { fontSize: 13, color: '#111827', marginBottom: 2 } }, String(question.text ?? '')),
            h('textarea', {
              style: { ...styles.area, minHeight: 56 },
              value: answerOf(question.id),
              readOnly: busy,
              onChange: (event) => handlers.setQuizAnswer(String(question.id), event.target.value),
            }),
          )),
          h('div', { style: { ...styles.hint, color: answered >= 1 ? MUTED : DANGER } },
            answered >= 1 ? `已回答 ${answered} 题` : '还没有回答任何一题：至少回答一题才能生成。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
            h('button', {
              'data-profile-quiz-action': 'generate',
              style: { ...styles.btnPrimary, ...(canGenerate ? {} : styles.off) },
              disabled: !canGenerate,
              onClick: () => handlers.generateQuiz(),
            }, busy ? '生成中…' : '生成草案'),
            !hasDraft ? h('button', {
              'data-profile-quiz-action': 'close',
              style: styles.btn,
              onClick: () => handlers.closeQuiz(),
            }, '关闭') : null,
          ),
          hasDraft ? h('div', {
            'data-profile-quiz-draft-block': true,
            style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${BORDER}` },
          },
            h('div', { style: styles.value }, trialActive ? '试用文本（可直接编辑，保存后立即注入）' : '草案（可编辑后再应用试用）'),
            h('textarea', {
              'data-profile-quiz-input': 'draft',
              style: { ...styles.area, minHeight: 120 },
              value: draft,
              readOnly: busy,
              onChange: (event) => handlers.setQuizDraft(event.target.value),
            }),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
              h('button', {
                'data-profile-quiz-action': 'trial',
                style: styles.btnPrimary,
                disabled: busy || draft.trim().length === 0,
                onClick: () => handlers.applyTrial(),
              }, '应用试用'),
              h('button', {
                'data-profile-quiz-action': 'adopt',
                style: { ...styles.btn, ...(trialActive ? {} : styles.off) },
                disabled: busy || !trialActive,
                onClick: () => handlers.adoptTrial(),
              }, '正式采用'),
              h('button', {
                'data-profile-quiz-action': 'discard',
                style: { ...styles.btnDanger, ...(trialActive ? {} : styles.off) },
                disabled: busy || !trialActive,
                onClick: () => handlers.discardTrial(),
              }, '放弃试用'),
              h('button', {
                'data-profile-quiz-action': 'close',
                style: styles.btn,
                onClick: () => handlers.closeQuiz(),
              }, '关闭'),
            ),
          ) : null,
          error.length > 0 ? h('div', { 'data-profile-quiz-error': true, style: { ...styles.hint, color: DANGER } }, error) : null,
        ),
      );
    }


    /**
     * 「立刻整理」：与 7 天周期走同一条流程，只是不等周期。卡片会把两段文本一起发过去：
     * 宿主先落盘、由 agent 拆分改动过的一侧，整理结束后再把重写结果写回文本框。
     */
    async function profileMaintainNow(act, text) {
      const body = { action: 'profile.maintain.now' };
      if (text !== null && text !== undefined) {
        body.agent = String(text.agent ?? '');
        body.user = String(text.user ?? '');
      }
      return act(body, 'profile-maintain');
    }

    /** 一次手动整理后的卡片状态：摘要 / 说明 / 错误三选一，running/queued 归零。 */
    function profileMaintainState(result) {
      if (result === null || result === undefined) return { running: false, queued: false, error: '整理请求失败' };
      if (result.ok === false && result.reason === 'superseded') {
        return { running: false, queued: false, error: '', note: '已有更新的保存，本次整理已放弃' };
      }
      if (result.ok === false && result.status === 'rejected' && result.reason === 'queue-full') {
        return { running: false, queued: false, error: '', note: '已有整理任务在排队，请稍后再试' };
      }
      if (result.ok === false) {
        return { running: false, queued: false, error: String(result.error ?? result.reason ?? '整理失败') };
      }
      if (result.status === 'cancelled' || result.reason === 'cancelled') {
        return { running: false, queued: false, error: '', summary: null, note: '已取消' };
      }
      // Accepted but waiting behind a running round or pending speech: keep the button silent
      // until the host reports that the queue drained, never show a second clickable request.
      if (result.status === 'queued') {
        const note = result.reason === 'playing' || result.reason === 'pending-voice'
          ? '语音播放中，已排队，播放结束后自动开始'
          : '已排队，当前任务结束后开始';
        return { running: false, queued: true, taskId: result.taskId ?? null, error: '', summary: null, note };
      }
      if (result.ran === false) {
        const note = result.reason === 'active-turn'
          ? '正在对话，稍后再试'
          : result.reason === 'playing' || result.reason === 'pending-voice'
            ? '语音播放中，稍后再试'
            : '没有新的交流可整理';
        return { running: false, queued: false, error: '', summary: null, note };
      }
      return { running: false, queued: false, error: '', summary: result.summary ?? null, note: '' };
    }

    /** One summary line with exactly the counters the host returns for a finished round. */
    function profileSummaryText(summary) {
      const count = (key) => Number(summary?.[key] ?? 0) || 0;
      return `新增 ${count('added')} · 更新 ${count('updated')} · 收编 ${count('adopted')} · 丢弃 ${count('dropped')} · 遗忘 ${count('forgotten')} · ${fmtTokens(summary?.tokens)} tokens`;
    }

    /** Default row decision: a noise row is checked for deletion, a move is checked, keep is not. */
    function reclassifyDefaultChoice(item) {
      if (item?.suggested === 'delete') return 'delete';
      if (item?.suggested === 'move' && item?.to
        && (item.to.side !== item.side || String(item.to.category ?? '') !== String(item.category ?? ''))) {
        return 'move';
      }
      return 'keep';
    }

    function reclassifyChoices(items) {
      const choices = {};
      for (const item of Array.isArray(items) ? items : []) {
        const id = String(item?.entryId ?? '');
        if (id.length > 0) choices[id] = reclassifyDefaultChoice(item);
      }
      return choices;
    }

    /** Selectable decisions of one row; a row without a validated target cannot be moved. */
    function reclassifyChoiceOptions(item) {
      const move = item?.to
        && item.suggested === 'move'
        && (item.to.side !== item.side || String(item.to.category ?? '') !== String(item.category ?? ''));
      if (item?.suggested === 'delete') return [{ value: 'delete', label: '删除' }, { value: 'keep', label: '保留' }];
      if (move) {
        return [
          { value: 'move', label: `移入 ${profileSideLabel(item.to.side)}/${item.to.category || '未分类'}` },
          { value: 'keep', label: '保留' },
          { value: 'delete', label: '删除' },
        ];
      }
      return [{ value: 'keep', label: '保留' }, { value: 'delete', label: '删除' }];
    }

    /** Selected rows → the wire payload of `profile.reclassify.apply`. */
    function reclassifyMovesAndDeletes(items, choices) {
      const moves = [];
      const deletes = [];
      for (const item of Array.isArray(items) ? items : []) {
        const choice = choices?.[item?.entryId] ?? 'keep';
        if (choice === 'move' && item?.to) {
          moves.push({ id: item.entryId, side: item.to.side, category: item.to.category });
        } else if (choice === 'delete' && item?.entryId !== undefined) {
          deletes.push(item.entryId);
        }
      }
      return { moves, deletes };
    }

    function reclassifySelectedCount(items, choices) {
      const selected = reclassifyMovesAndDeletes(items, choices);
      return selected.moves.length + selected.deletes.length;
    }

    /** 「重新分类」preview result → card state: every live row gets a default decision. */
    function profileReclassifyPreviewState(result) {
      if (result === null || result === undefined) {
        return {
          open: false, busy: '', items: [], choices: {}, version: null, error: '预览请求失败', note: '',
        };
      }
      if (result.ok !== true) {
        return {
          open: false,
          busy: '',
          items: [],
          choices: {},
          version: null,
          error: result.status === 'busy' ? '整理进行中，请稍后再试' : String(result.error ?? result.reason ?? '预览失败'),
          note: '',
        };
      }
      const items = Array.isArray(result.items)
        ? result.items
        : (Array.isArray(result.changes)
          ? result.changes.map((change) => ({
            entryId: change.entryId,
            text: change.text,
            side: change.from?.side,
            category: change.from?.category,
            from: change.from,
            to: change.to,
            inBox: false,
            kind: 'normal',
            suggested: 'move',
          }))
          : []);
      if (items.length === 0) {
        return {
          open: false, busy: '', items: [], choices: {}, version: result.version ?? null, error: '', note: '分类已是最新',
        };
      }
      return {
        open: true,
        busy: '',
        items,
        changes: Array.isArray(result.changes) ? result.changes : [],
        choices: reclassifyChoices(items),
        version: result.version ?? null,
        error: '',
        note: '',
      };
    }

    /** 「重新分类」apply result → card state: moved/deleted counts, a stale plan asks for a new preview. */
    function profileReclassifyApplyState(result) {
      if (result === null || result === undefined) {
        return {
          open: false, busy: '', items: [], choices: {}, version: null, error: '应用请求失败', note: '',
        };
      }
      if (result.ok === true) {
        const moved = Number(result.moved ?? 0) || 0;
        const deleted = Number(result.deleted ?? 0) || 0;
        const applied = moved + deleted || Number(result.applied ?? 0) || 0;
        const parts = [];
        if (moved > 0) parts.push(`移入 ${moved} 条`);
        if (deleted > 0) parts.push(`删除 ${deleted} 条`);
        return {
          open: false,
          busy: '',
          items: [],
          choices: {},
          version: null,
          error: '',
          note: parts.length > 0 ? `已应用：${parts.join('，')}` : `已应用 ${applied} 条分类变更`,
          applied,
          moved,
          deleted,
        };
      }
      if (result.aborted === true && result.reason === 'version-conflict') {
        return {
          open: false, busy: '', items: [], choices: {}, version: null, error: '', note: '库已变化，请重新预览',
        };
      }
      return {
        open: false,
        busy: '',
        items: [],
        choices: {},
        version: null,
        error: result.status === 'busy' ? '整理进行中，请稍后再试' : String(result.error ?? result.reason ?? '应用失败'),
        note: '',
      };
    }

    /**
     * 「库编辑」: the entry list is the library itself (库=存). Editing text / re-filing / deleting
     * changes only the library; the two settings boxes (框=用) are rewritten only by the NEXT
     * organize round. A category carries its parent side, so picking a category across 人设/画像
     * moves the entry's side automatically. Every list row ends with a 框内/仅库 mark, which shows
     * that a library entry filtered out of the box is the filter working, not a gap.
     */
    function profileLibraryErrorText(result) {
      if (result === null || result === undefined) return '请求失败';
      const reason = String(result.reason ?? '');
      if (reason === 'duplicate-text') return '同一侧已有相同内容的条目';
      if (reason === 'empty-text') return '条目内容不能为空';
      if (reason === 'unknown-category') return '分类不存在';
      if (reason === 'unknown-entry') return '条目已不存在';
      return String(result.error ?? reason ?? '操作失败');
    }

    /** Stable category identity for the picker's "current item" comparison. */
    function profileCategoryKey(value) {
      return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
    }

    /** The picker's groups: 人设侧 first, then 画像侧, every existing category under its parent. */
    function profileLibraryPickerGroups(categories) {
      const rows = Array.isArray(categories) ? categories : [];
      return ['agent', 'user']
        .map((parent) => ({
          parent,
          label: profileSideLabel(parent),
          rows: rows.filter((row) => String(row?.parent ?? '') === parent),
        }))
        .filter((group) => group.rows.length > 0);
    }

    /** One row's category popup: grouped by parent, current entry highlighted, close = no change. */
    function profileLibraryPicker(h, row, categories, handlers) {
      const current = String(row?.category ?? '');
      const groups = profileLibraryPickerGroups(categories);
      return h('div', {
        'data-profile-library-picker': String(row?.id ?? ''),
        style: { flex: '1 1 100%', marginTop: 4, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fafbfc' },
      },
        h('div', { style: styles.hint }, '选择已有分类；跨父级会自动换 side。点当前项或「关闭」都不改。'),
        groups.map((group) => h('div', { key: group.parent, 'data-profile-library-group': group.parent, style: { marginTop: 4 } },
          h('div', { style: styles.label }, group.label),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            group.rows.map((item) => {
              const name = String(item?.name ?? '');
              const isCurrent = profileCategoryKey(name) === profileCategoryKey(current);
              return h('button', {
                key: `${group.parent}:${name}`,
                'data-profile-library-option': name,
                'data-profile-library-option-parent': group.parent,
                'data-profile-library-current': isCurrent ? 'true' : undefined,
                style: isCurrent ? styles.btnActive : styles.btn,
                onClick: () => handlers.chooseLibraryCategory(String(row?.id ?? ''), name),
              }, isCurrent ? `✓ ${name}` : name);
            })),
        )),
        h('button', {
          'data-profile-library-action': 'picker-close',
          style: styles.btn,
          onClick: () => handlers.closeLibraryPicker(),
        }, '关闭'),
      );
    }

    /**
     * 「库编辑」panel under the two boxes. Each row: text input (保存 / Enter), category button,
     * 框内/仅库 mark, delete with a second confirmation. A picker and the confirmation stay inline,
     * so no second page is opened.
     */
    function profileLibraryBody(h, state, handlers) {
      const library = state?.library ?? null;
      if (library === null || library === undefined || library.open !== true) return null;
      const rows = Array.isArray(library.rows) ? library.rows : [];
      const drafts = library.drafts ?? {};
      const picker = String(library.picker ?? '');
      const confirmDelete = String(library.confirmDelete ?? '');
      const busy = String(library.busy ?? '');
      const disabled = busy !== '';
      const knownCategories = Array.isArray(state?.category?.rows) && state.category.rows.length > 0
        ? state.category.rows
        : (Array.isArray(library.categories) ? library.categories : []);
      return h('div', {
        'data-profile-library': true,
        style: { marginTop: 6, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fafbfc' },
      },
        h('div', { style: styles.value }, `库编辑（${rows.length} 条）· 只改库，不重写文本框；下次整理才写回`),
        rows.length === 0
          ? h('div', { style: styles.hint }, '库里还没有条目')
          : h('div', { style: { maxHeight: '46vh', overflow: 'auto', marginTop: 4 } },
            rows.map((row) => {
              const id = String(row?.id ?? '');
              const text = String(row?.text ?? '');
              const value = drafts[id] !== undefined ? String(drafts[id]) : text;
              const dirty = value !== text;
              return h('div', {
                key: id,
                'data-profile-library-row': id,
                style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 0', borderTop: '1px solid #f0f1f3', fontSize: 12 },
              },
                h('input', {
                  'data-profile-library-input': id,
                  style: { ...styles.input, flex: '1 1 220px', minWidth: 0 },
                  value,
                  disabled,
                  onChange: (event) => handlers.setLibraryText(id, event.target.value),
                  onKeyDown: (event) => {
                    if (event?.key === 'Enter' && dirty) handlers.saveLibraryText(id);
                  },
                }),
                h('button', {
                  'data-profile-library-action': 'save',
                  style: { ...styles.btnPrimary, ...(disabled || !dirty ? styles.off : {}) },
                  disabled: disabled || !dirty,
                  onClick: () => handlers.saveLibraryText(id),
                }, busy === 'save' ? '保存中…' : '保存'),
                h('button', {
                  'data-profile-library-action': 'category',
                  style: styles.btn,
                  disabled,
                  title: '换一个已有分类；跨父级会自动换 side',
                  onClick: () => handlers.toggleLibraryPicker(id),
                }, `${profileSideLabel(row?.side)}/${String(row?.category ?? '') || '未分类'}`),
                h('button', {
                  'data-profile-library-action': 'delete',
                  style: { ...styles.btnDanger, ...(disabled ? styles.off : {}) },
                  disabled,
                  onClick: () => handlers.requestDeleteLibraryEntry(id),
                }, '删除'),
                confirmDelete === id
                  ? h('span', { 'data-profile-library-confirm': id, style: { display: 'flex', alignItems: 'center', gap: 4 } },
                    h('span', { style: { ...styles.hint, color: DANGER } }, '确认删除？'),
                    h('button', {
                      'data-profile-library-action': 'delete-confirm',
                      style: styles.btnDanger,
                      disabled,
                      onClick: () => handlers.confirmDeleteLibraryEntry(id),
                    }, '确认删除'),
                    h('button', {
                      'data-profile-library-action': 'delete-cancel',
                      style: styles.btn,
                      disabled,
                      onClick: () => handlers.cancelDeleteLibraryEntry(id),
                    }, '取消'))
                  : null,
                h('span', {
                  'data-profile-library-inbox': row?.inBox === true ? 'in' : 'library',
                  style: styles.badge,
                }, row?.inBox === true ? '框内' : '仅库'),
                picker === id ? profileLibraryPicker(h, row, knownCategories, handlers) : null,
              );
            })),
        library.error
          ? h('div', { 'data-profile-library-error': true, style: { ...styles.hint, color: DANGER } }, `库编辑失败：${library.error}`)
          : null,
        library.note ? h('div', { 'data-profile-library-note': true, style: styles.hint }, String(library.note)) : null,
      );
    }

    /**
     * 「人设库」设置体：标题/容量 + 两段可编辑文本 + 保存/整理/暂停/「库编辑」。
     * 保存只写文本框；只有「整理后入库」才会拆分、更新库、重写并写回。库编辑只改库（文本/分类/
     * 删除），绝不重写文本框——下次整理时才写回。`h` is injected so the card can be rendered in a
     * test without React or a DOM.
     */
    function profileSettingsBody(h, state, handlers) {
      const {
        profile = {}, busy = '', maintain = null, draft = null, reclassify = null, library = null,
      } = state ?? {};
      // `library` is present whenever the shipped Panel renders the card: the entry button is
      // 「库编辑」. A legacy card state without it keeps the old preview button (backward compat).
      const libraryAvailable = library !== null && library !== undefined;
      const libraryBusy = String(library?.busy ?? '') !== '';
      const capacity = profile.capacity ?? { used: 0, cap: 0 };
      const used = Number(capacity.used ?? 0);
      const cap = Number(capacity.cap ?? 0);
      const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
      const barColor = pct >= 90 ? '#dc2626' : pct >= 60 ? '#d98324' : '#2f9e44';
      const autoMaintain = profile.autoMaintain !== false;
      const reclassifyBusy = reclassify?.busy === 'preview' || reclassify?.busy === 'apply';
      const saving = busy === 'profile-save';
      const running = maintain?.running === true || profile.running === true || busy === 'profile-maintain';
      const queued = maintain?.queued === true || profile.queued === true;
      const pending = profile.pending ?? {};
      const hasPending = pending.agent === true || pending.user === true;
      const summary = maintain?.summary ?? profile.lastSummary ?? null;
      const summaryLabel = maintain?.summary === undefined || maintain?.summary === null ? '上次整理' : '本次整理';
      const lastRunAt = profile.lastRunAt ? new Date(profile.lastRunAt).toLocaleString('zh-CN') : '—';
      const disabled = busy !== '' || running || queued || reclassifyBusy || libraryBusy;
      const trial = profile.trial ?? null;
      const trialActive = trial?.active === true;
      const texts = profileTexts(profile);
      const valueOf = (side) => (draft !== null && draft !== undefined && draft[side] !== undefined
        ? String(draft[side])
        : texts[side]);
      const box = (side, label) => h('label', { 'data-profile-field': side, style: styles.field },
        h('span', { style: styles.value }, label),
        h('textarea', {
          'data-profile-input': side,
          style: styles.area,
          value: valueOf(side),
          readOnly: disabled,
          onChange: (event) => handlers.setText(side, event.target.value),
        }),
      );

      return h('div', { 'data-profile-card': true, style: styles.card },
        h('div', { 'data-profile-title': true, style: styles.title },
          `人设库 · ${used}/${cap}`,
          trialActive ? h('span', { 'data-profile-trial-badge': true, style: styles.badge }, '试用中') : null),
        line('容量', `${used} / ${cap} 条（${pct}%）`),
        h('div', { style: { height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', margin: '4px 0 8px' } },
          h('div', { style: { height: '100%', width: `${Math.min(100, pct)}%`, background: barColor } }),
        ),
        line('自动整理', autoMaintain
          ? `开（每 7 天一次，空闲时进行）· 上次 ${lastRunAt}`
          : '已暂停（只保留手动「立刻整理」）'),
        trialActive
          ? h('div', { 'data-profile-trial': true, style: styles.hint },
              '试用中：当前文本已注入，但还没有写入人设库。点「正式采用」才同步；「放弃试用」会恢复试用前的文本。')
          : null,
        box('agent', '人设（她是谁、怎么说话）'),
        box('user', '画像（稳定的偏好与事实）'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 } },
          h('button', {
            'data-profile-action': 'save',
            style: { ...styles.btnPrimary, ...(disabled ? styles.off : {}) },
            disabled,
            onClick: () => handlers.saveText(),
          }, trialActive ? '保存试用文本' : saving ? '保存中…' : '保存'),
          h('button', {
            'data-profile-action': 'maintain',
            style: styles.btn,
            disabled: disabled || saving,
            onClick: () => handlers.maintainNow(),
          }, queued ? '已排队…' : running ? '正在整理…' : hasPending ? '整理后入库' : '立刻整理'),
          libraryAvailable
            ? h('button', {
              'data-profile-action': 'library',
              style: styles.btn,
              disabled: disabled || saving,
              onClick: () => handlers.openLibrary(),
            }, String(library?.busy ?? '') === 'list' ? '加载中…' : '库编辑')
            // Backward-compatible render for a card state written before the library editor existed.
            : h('button', {
              'data-profile-action': 'reclassify',
              style: styles.btn,
              disabled: disabled || saving,
              onClick: () => handlers.previewReclassify(),
            }, reclassify?.busy === 'preview' ? '预览中…' : '重新分类'),
          queued
            ? h('button', {
              'data-profile-action': 'maintain-cancel',
              style: styles.btn,
              disabled: busy !== '',
              onClick: () => handlers.cancelMaintain(),
            }, '取消排队')
            : null,
          h('button', {
            'data-profile-action': 'auto',
            style: autoMaintain ? styles.btnActive : styles.btn,
            disabled: busy !== '',
            onClick: () => handlers.setAutoMaintain(!autoMaintain),
          }, autoMaintain ? '暂停自动整理' : '恢复自动整理'),
          h('button', {
            'data-profile-quiz': 'open',
            style: styles.btn,
            disabled: busy !== '',
            onClick: () => handlers.openQuiz(),
          }, trialActive ? '重新生成初始人设' : '生成初始人设'),
        ),
        running || queued
          ? h('div', { 'data-profile-maintain': queued ? 'queued' : 'running', style: styles.hint },
            queued
              ? '已排队，当前任务结束后开始（可取消排队）'
              : '正在整理：拆分→入库→重写→写回…（完成后刷新）')
          : null,
        hasPending && !running && !queued
          ? h('div', { 'data-profile-pending': true, style: styles.hint },
            '框内文本尚未入库：保存只写入文本框；点「整理后入库」完成拆分→入库→重写→写回。')
          : null,
        summary !== null
          ? h('div', { 'data-profile-summary': true, style: styles.hint }, `${summaryLabel}：${profileSummaryText(summary)}`)
          : null,
        maintain?.note ? h('div', { 'data-profile-note': true, style: styles.hint }, maintain.note) : null,
        maintain?.error ? h('div', { 'data-profile-error': true, style: { ...styles.hint, color: DANGER } }, `操作失败：${maintain.error}`) : null,
        reclassify?.open === true && Array.isArray(reclassify.items) && reclassify.items.length > 0
          ? (() => {
            const items = reclassify.items;
            const choices = reclassify.choices ?? {};
            const selected = reclassifySelectedCount(items, choices);
            const noiseCount = items.filter((item) => item?.kind === 'noise').length;
            const libraryOnly = items.filter((item) => item?.inBox !== true).length;
            return h('div', { 'data-profile-reclassify': true, style: { marginTop: 6, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fafbfc' } },
              h('div', { style: styles.value }, `待确认的分类变更（${items.length} 条）· 建议删除 ${noiseCount} · 仅库 ${libraryOnly}`),
              h('div', { style: { maxHeight: '42vh', overflow: 'auto', marginTop: 4 } },
                items.map((item) => {
                  const choice = choices[item?.entryId] ?? reclassifyDefaultChoice(item);
                  const checked = choice !== 'keep';
                  const from = item?.from ?? { side: item?.side, category: item?.category };
                  const to = item?.to;
                  const transition = to
                    ? `${profileSideLabel(from.side)}/${from.category || '未分类'} → ${profileSideLabel(to.side)}/${to.category || '未分类'}`
                    : `${profileSideLabel(from.side)}/${from.category || '未分类'} → 删除`;
                  return h('div', {
                    key: String(item?.entryId ?? ''),
                    'data-profile-reclassify-row': true,
                    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderTop: '1px solid #f0f1f3', fontSize: 12 },
                  },
                    h('input', {
                      type: 'checkbox',
                      'data-profile-reclassify-check': String(item?.entryId ?? ''),
                      checked,
                      onChange: (event) => {
                        const options = reclassifyChoiceOptions(item).map((option) => option.value);
                        const next = event.target.checked
                          ? (options.find((value) => value !== 'keep') ?? 'keep')
                          : 'keep';
                        handlers.setReclassifyChoice(item?.entryId, next);
                      },
                    }),
                    h('span', {
                      style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#111827' },
                    }, String(item?.text ?? '')),
                    h('span', { style: styles.mono }, transition),
                    h('span', {
                      'data-profile-reclassify-inbox': item?.inBox === true ? 'in' : 'library',
                      style: styles.badge,
                    }, item?.inBox === true ? '框内' : '仅库'),
                    item?.kind === 'noise'
                      ? h('span', { 'data-profile-reclassify-noise': true, style: styles.badge }, '噪声')
                      : null,
                    h('select', {
                      'data-profile-reclassify-choice': String(item?.entryId ?? ''),
                      style: { ...styles.input, width: 'auto', flex: '0 0 auto' },
                      value: choice,
                      onChange: (event) => handlers.setReclassifyChoice(item?.entryId, event.target.value),
                    }, reclassifyChoiceOptions(item).map((option) => h('option', { key: option.value, value: option.value }, option.label))),
                  );
                }),
              ),
              h('div', { style: { ...styles.row, marginTop: 6 } },
                h('button', {
                  'data-profile-action': 'reclassify-apply',
                  style: { ...styles.btnPrimary, ...(reclassify.busy === 'apply' || selected === 0 ? styles.off : {}) },
                  disabled: reclassify.busy === 'apply' || selected === 0,
                  onClick: () => handlers.applyReclassify(),
                }, reclassify.busy === 'apply' ? '应用中…' : `应用选中（${selected}）`),
                h('button', {
                  'data-profile-action': 'reclassify-cancel',
                  style: styles.btn,
                  disabled: reclassify.busy === 'apply',
                  onClick: () => handlers.cancelReclassify(),
                }, '全部取消'),
              ),
            );
          })()
          : reclassify?.open === true && Array.isArray(reclassify.changes) && reclassify.changes.length > 0
            // Backward-compatible render for a card state written before the per-row preview
            // (`items`): the same change list still shows and applies, never silently disappears.
            ? h('div', { 'data-profile-reclassify': true, style: { marginTop: 6, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, background: '#fafbfc' } },
              h('div', { style: styles.value }, `待确认的分类变更（${reclassify.changes.length} 条）`),
              reclassify.changes.map((change) => {
                const from = change?.from ?? {};
                const to = change?.to ?? {};
                const cross = from.side !== to.side;
                return h('div', {
                  key: String(change?.entryId ?? ''),
                  style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderTop: '1px solid #f0f1f3', fontSize: 12 },
                },
                  h('span', {
                    style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#111827' },
                  }, String(change?.text ?? '')),
                  h('span', { style: styles.mono }, `${String(from.category ?? '')} → ${String(to.category ?? '')}`),
                  cross
                    ? h('span', { 'data-profile-reclassify-cross': true, style: styles.badge },
                      `${profileSideLabel(from.side)} → ${profileSideLabel(to.side)}`)
                    : null,
                );
              }),
              h('div', { style: { ...styles.row, marginTop: 6 } },
                h('button', {
                  'data-profile-action': 'reclassify-apply',
                  style: { ...styles.btnPrimary, ...(reclassify.busy === 'apply' ? styles.off : {}) },
                  disabled: reclassify.busy === 'apply',
                  onClick: () => handlers.applyReclassify(),
                }, reclassify.busy === 'apply' ? '应用中…' : `应用 ${reclassify.changes.length} 条`),
                h('button', {
                  'data-profile-action': 'reclassify-cancel',
                  style: styles.btn,
                  disabled: reclassify.busy === 'apply',
                  onClick: () => handlers.cancelReclassify(),
                }, '取消'),
              ),
            )
            : null,
        reclassify?.note ? h('div', { 'data-profile-reclassify-note': true, style: styles.hint }, reclassify.note) : null,
        reclassify?.error
          ? h('div', { 'data-profile-reclassify-error': true, style: { ...styles.hint, color: DANGER } }, `分类变更失败：${reclassify.error}`)
          : null,
        profileLibraryBody(h, { library, category: state?.category ?? null }, handlers),
        profileCategoryBody(h, {
          rows: profileCategoryRows(profile, state?.category ?? null),
          category: state?.category ?? null,
        }, handlers),
        personaQuizDialog(h, { profile, quiz: state?.quiz ?? null }, handlers),
      );
    }

    // ---- 「分类管理」: the profile card's collapsible child container -------------------------
    // Only the category stack is managed here: list / rename / merge / delete. No entry is ever
    // deleted by this panel — a delete re-points its entries to the nearest category of the side.

    /** One row per category; `source` stays empty when only the status payload (no source) is known. */
    function profileCategoryRows(profile, category) {
      const listed = Array.isArray(category?.rows) ? category.rows : null;
      const source = listed !== null ? listed : (Array.isArray(profile?.categories) ? profile.categories : []);
      return source
        .filter((row) => String(row?.name ?? '').length > 0)
        .map((row) => ({
          name: String(row.name),
          parent: row.parent === 'user' ? 'user' : 'agent',
          count: Number(row.count ?? 0) || 0,
          source: row.source === 'model' ? 'model' : row.source === 'preset' ? 'preset' : '',
        }));
    }

    /** 来源一栏：预设 / 模型 / 用户；宿主没给来源时留一个占位符。 */
    function profileCategorySourceLabel(source) {
      if (source === 'model') return '模型';
      if (source === 'user') return '用户';
      if (source === 'preset') return '预设';
      return '—';
    }

    /** 分类动作失败 → 面板红字（CATEGORY_LAST 用固定文案，其余用宿主错误）。 */
    function profileCategoryErrorText(result) {
      if (result === null || result === undefined) return '请求失败';
      if (result.code === 'CATEGORY_LAST') return '同一侧至少保留一个分类';
      return String(result.error ?? result.reason ?? '操作失败');
    }

    /** 分类动作结果 → 面板状态：成功刷新列表并提示，失败把红字留在面板内。 */
    function profileCategoryResultState(current, result, listed, op = '') {
      const rows = listed?.ok === true && Array.isArray(listed.categories)
        ? listed.categories
        : (current?.rows ?? null);
      const base = {
        ...(current ?? {}),
        open: true,
        busy: '',
        editing: null,
        merging: null,
        rows,
        createName: result?.ok === true ? '' : String(current?.createName ?? ''),
        createParent: current?.createParent === 'user' ? 'user' : 'agent',
      };
      if (result?.ok !== true) return { ...base, error: profileCategoryErrorText(result), note: '' };
      const note = op === 'create'
        ? `已新建分类「${String(result.category?.name ?? result.name ?? '')}」`
        : op === 'rename'
          ? '已改名'
          : op === 'merge'
            ? `已合并，迁移 ${Number(result.moved ?? 0)} 条`
            : `已删除分类，${Number(result.reassigned ?? 0)} 条回退到「${String(result.fallback ?? '')}」`;
      return { ...base, error: '', note };
    }

    /**
     * 「分类管理」子容器：默认收起，标题带分类数；展开后每行 名称/上级/条目数/来源 + 改名/合并/删除。
     * 改名用行内输入、合并用行内下拉，错误红字留在面板内；操作进行中所有按钮禁用。
     */
    function profileCategoryBody(h, state, handlers) {
      const category = state?.category ?? null;
      const rows = Array.isArray(state?.rows) ? state.rows : [];
      const open = category?.open === true;
      const busy = String(category?.busy ?? '');
      const editing = category?.editing ?? null;
      const merging = category?.merging ?? null;
      const createName = String(category?.createName ?? '');
      const createParent = category?.createParent === 'user' ? 'user' : 'agent';
      const disabled = busy !== '';
      const sideCount = (parent) => rows.filter((row) => row.parent === parent).length;
      const editorOf = (row) => {
        const others = rows.filter((item) => item.parent === row.parent && item.name !== row.name);
        if (editing !== null && editing.name === row.name) {
          return h('span', { 'data-profile-category-editor': 'rename', style: styles.row },
            h('input', {
              'data-profile-category-input': 'rename',
              style: { ...styles.input, width: 110 },
              value: String(editing.value ?? ''),
              disabled,
              onChange: (event) => handlers.setCategoryName(event.target.value),
            }),
            h('button', {
              'data-profile-category-action': 'rename-save', style: styles.btnPrimary, disabled,
              onClick: () => handlers.submitCategoryRename(row.name),
            }, busy === 'rename' ? '保存中…' : '保存'),
            h('button', {
              'data-profile-category-action': 'cancel', style: styles.btn, disabled,
              onClick: () => handlers.cancelCategoryEdit(),
            }, '取消'),
          );
        }
        if (merging !== null && merging.name === row.name) {
          return h('span', { 'data-profile-category-editor': 'merge', style: styles.row },
            h('select', {
              'data-profile-category-input': 'merge',
              style: styles.input,
              value: String(merging.into ?? ''),
              disabled,
              onChange: (event) => handlers.setCategoryTarget(event.target.value),
            },
              h('option', { value: '' }, '选择目标分类'),
              others.map((item) => h('option', { key: item.name, value: item.name }, item.name)),
            ),
            h('button', {
              'data-profile-category-action': 'merge-save', style: styles.btnPrimary,
              disabled: disabled || others.length === 0 || String(merging.into ?? '').length === 0,
              onClick: () => handlers.submitCategoryMerge(row.name),
            }, busy === 'merge' ? '合并中…' : '确定'),
            h('button', {
              'data-profile-category-action': 'cancel', style: styles.btn, disabled,
              onClick: () => handlers.cancelCategoryEdit(),
            }, '取消'),
          );
        }
        const last = sideCount(row.parent) <= 1;
        return h('span', { style: styles.row },
          h('button', {
            'data-profile-category-action': 'rename', style: styles.btn, disabled,
            onClick: () => handlers.startCategoryRename(row.name),
          }, '改名'),
          h('button', {
            'data-profile-category-action': 'merge', style: styles.btn,
            disabled: disabled || others.length === 0,
            onClick: () => handlers.startCategoryMerge(row.name),
          }, '合并'),
          h('button', {
            'data-profile-category-action': 'delete',
            style: { ...styles.btn, ...(last ? styles.off : {}) },
            disabled: disabled || last,
            title: last ? '同一侧至少保留一个分类' : undefined,
            onClick: () => handlers.submitCategoryDelete(row.name),
          }, '删除'),
        );
      };
      return h('div', { 'data-profile-category': true, style: { marginTop: 10, paddingTop: 8, borderTop: `1px solid ${BORDER}` } },
        h('button', {
          'data-profile-category-toggle': true, style: styles.btn, disabled: busy === 'list',
          onClick: () => handlers.toggleCategory(),
        }, `分类管理（${rows.length}）${open ? ' ▾' : ' ▸'}`),
        category?.error
          ? h('div', { 'data-profile-category-error': true, style: { ...styles.hint, color: DANGER } }, String(category.error))
          : null,
        !open ? null : h('div', { 'data-profile-category-panel': true, style: { marginTop: 6 } },
          h('div', { 'data-profile-category-create-row': true, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '3px 0' } },
            h('input', {
              'data-profile-category-input': 'create-name',
              style: { ...styles.input, width: 130 },
              value: createName,
              disabled,
              placeholder: '新分类名称',
              onChange: (event) => handlers.setCategoryCreateName(event.target.value),
            }),
            h('select', {
              'data-profile-category-input': 'create-parent',
              style: { ...styles.input, width: 'auto' },
              value: createParent,
              disabled,
              onChange: (event) => handlers.setCategoryCreateParent(event.target.value),
            },
              h('option', { value: 'agent' }, '人设侧'),
              h('option', { value: 'user' }, '画像侧'),
            ),
            h('button', {
              'data-profile-category-action': 'create',
              style: { ...styles.btnPrimary, ...(disabled || createName.trim().length === 0 ? styles.off : {}) },
              disabled: disabled || createName.trim().length === 0,
              onClick: () => handlers.submitCategoryCreate(),
            }, busy === 'create' ? '新建中…' : '新建分类'),
          ),
          rows.length === 0
            ? h('div', { style: styles.hint }, '还没有分类')
            : rows.map((row) => h('div', {
              key: row.name,
              'data-profile-category-row': row.name,
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderTop: '1px solid #f0f1f3', fontSize: 12, flexWrap: 'wrap' },
            },
              h('span', { 'data-profile-category-name': true, style: { flex: '1 1 90px', color: '#111827' } }, row.name),
              h('span', { style: styles.mono }, profileSideLabel(row.parent)),
              h('span', { 'data-profile-category-count': true, style: styles.mono }, `${row.count} 条`),
              h('span', { 'data-profile-category-source': true, style: styles.badge }, profileCategorySourceLabel(row.source)),
              editorOf(row),
            )),
          category?.note ? h('div', { 'data-profile-category-note': true, style: styles.hint }, String(category.note)) : null,
        ),
      );
    }

    /**
     * 「浏览…」 of the always-visible Spout runtime row: pick the exe, keep it in the draft, then
     * persist it through the existing `spoutLayer.status` action (it writes settings and probes
     * again; the caller's `act` refreshes `/assistant/status` afterwards).
     */
    async function pickSpoutPath(act, setSpoutDraft) {
      const picked = await act({ action: 'pick.file', kind: 'exe' }, 'spout-pick');
      if (!picked || picked.ok !== true || typeof picked.path !== 'string' || picked.path.length === 0) return picked;
      setSpoutDraft(picked.path);
      await act({ action: 'spoutLayer.status', electronExecutable: picked.path }, 'spout-path');
      return picked;
    }

    /**
     * 「透明化」设置体：顶部两个模式按钮，下方只渲染当前后端自己的设置。
     *
     * `h` is injected (the panel passes React.createElement) so the render decision can be
     * asserted with a recording factory instead of a DOM. `styles`, `line`, `MUTED` and
     * `BORDER` still come from this module's closure.
     */
    function layerSettingsBody(h, state, handlers) {
      const {
        layer = {},
        spout = {},
        transparent = {},
        busy = '',
        spoutDraft = null,
        draft = null,
      } = state ?? {};
      const backend = layer.backend === 'spout' ? 'spout' : 'wpf';
      const switching = layer.switching === true || busy === 'layer-backend';
      const geometry = draft ?? {
        left: transparent.left ?? 1600,
        top: transparent.top ?? 300,
        width: transparent.width ?? 420,
        height: transparent.height ?? 760,
      };
      const persistedPath = String(spout.electronExecutable ?? '').trim();
      const draftPath = String(spoutDraft ?? persistedPath).trim();
      // A freshly typed path is a candidate: the host probes it before stopping the old backend.
      const pathDirty = spoutDraft !== null && draftPath !== persistedPath;
      const spoutReady = layer.available?.spout === true || (pathDirty && draftPath.length > 0);
      const spoutReason = String(layer.reason?.spout ?? '') || '未配置 Electron 路径';
      // Status of the configuration row: always rendered, so a user can repair Spout from WPF mode.
      const spoutStatus = draftPath.length === 0
        ? '未配置：填入 Electron 44 的 electron.exe 绝对路径'
        : pathDirty
          ? '已修改：点「保存」校验并写入设置'
          : layer.available?.spout === true
            ? `就绪${spout.versions?.electron ? ` · Electron ${spout.versions.electron}` : ''}`
            : `已配置但不可用：${spoutReason}`;
      const probeNote = spout.versions?.electron
        ? ` 当前窗口运行时 Electron ${spout.versions.electron}${spout.versions.bridge ? ` · texture-bridge ${spout.versions.bridge}` : ''}`
        : '';
      const modeButton = (target, label) => h('button', {
        'data-layer-mode': target,
        style: backend === target ? styles.btnActive : styles.btn,
        disabled: busy !== '' || switching || (target === 'spout' && !spoutReady),
        title: target === 'spout' && !spoutReady ? spoutReason : undefined,
        onClick: () => handlers.switchBackend(target),
      }, label);
      const wpfBlock = h('div', { 'data-settings-block': 'wpf' },
        line('状态', transparent.running ? `运行中 · pid ${transparent.pid}` : '未启动'),
        line('位置 / 尺寸', `${geometry.left}, ${geometry.top} · ${geometry.width}×${geometry.height}`),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          [['left', 'X'], ['top', 'Y'], ['width', '宽'], ['height', '高']].map(([key, label]) => h('label', {
            key,
            style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: MUTED },
          },
            label,
            h('input', {
              type: 'number',
              style: { ...styles.input, width: 76 },
              value: geometry[key],
              onChange: (event) => handlers.setField(key, event.target.value),
            }),
          )),
        ),
        h('div', { style: styles.row },
          h('button', {
            style: { ...styles.btnPrimary, ...(busy !== '' || switching ? styles.off : {}) },
            disabled: busy !== '' || switching,
            onClick: () => handlers.startWpf(),
          }, transparent.running ? '重启透明层' : '开启透明层'),
          h('button', {
            style: { ...styles.btn, ...(busy !== '' || switching || !transparent.running ? styles.off : {}) },
            disabled: busy !== '' || switching || !transparent.running,
            onClick: () => handlers.stopWpf(),
          }, '关闭'),
        ),
        h('div', { style: styles.hint }, '需要 VTS 已开启「透明推流」。该层只镜像模型、不移动 VTS；请把模型和动作按钮放到屏幕中间，避免右缘按钮被裁进画面。'),
      );
      // Configuration, not run control: rendered for BOTH backends, because a Spout switch needs a
      // path before it can ever become available (otherwise the Spout button can never be enabled).
      const spoutPathRow = h('div', { 'data-spout-path': 'row', style: { margin: '6px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: styles.label }, 'Spout 运行时'),
          h('input', {
            'data-spout-path-input': true,
            style: { ...styles.input, flex: '1 1 240px', minWidth: 200 },
            placeholder: '独立 Electron 44 的 electron.exe 绝对路径',
            value: draftPath,
            onChange: (event) => handlers.setSpoutDraft(event.target.value),
          }),
          h('button', {
            'data-spout-path-action': 'browse',
            style: styles.btn,
            disabled: busy !== '' || switching,
            onClick: () => handlers.pickSpout(),
          }, '浏览…'),
          h('button', {
            'data-spout-path-action': 'save',
            style: styles.btn,
            disabled: busy !== '' || switching || draftPath.length === 0,
            onClick: () => handlers.saveSpoutPath(),
          }, '保存'),
        ),
        h('div', { 'data-spout-path-status': true, style: styles.hint }, spoutStatus),
      );
      const spoutBlock = h('div', { 'data-settings-block': 'spout' },
        line('显示进程', spout.running === true
          ? `运行中 · pid ${spout.pid} · ${spout.readyPhase || 'starting'}`
          : spout.readyPhase === 'failed'
            ? `未运行 · ${spout.error?.code ?? 'ERROR'}`
            : '未启动'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' } },
          h('button', {
            style: styles.btn,
            disabled: busy !== '' || switching,
            onClick: () => handlers.probeSpout(),
          }, '检测'),
          h('button', {
            style: { ...(spout.running === true ? styles.btnActive : styles.btnPrimary), ...(busy !== '' || switching ? styles.off : {}) },
            disabled: busy !== '' || switching || spout.running === true,
            onClick: () => handlers.startSpout(),
          }, spout.running === true ? '运行中' : '启动'),
          h('button', {
            style: { ...styles.btn, ...(busy !== '' || switching || spout.running !== true ? styles.off : {}) },
            disabled: busy !== '' || switching || spout.running !== true,
            onClick: () => handlers.stopSpout(),
          }, '停止'),
        ),
        h('div', { style: styles.hint }, `同一时间只允许一个透明层在运行；切换模式会先停旧后端并确认退出，再启动新后端。${probeNote}`),
      );
      return h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: `1px solid ${BORDER}` } },
        h('div', { style: styles.label }, '透明化'),
        h('div', { style: styles.row }, modeButton('wpf', 'WPF'), modeButton('spout', 'Spout')),
        !spoutReady && backend === 'wpf'
          ? h('div', { style: styles.hint }, `Spout 模式不可用：${spoutReason}`)
          : null,
        switching ? h('div', { style: styles.hint }, '正在切换…') : null,
        layer.editMode === true && layer.editBackend === backend
          ? h('div', { style: styles.hint }, '编辑中：拖动移动、滚轮缩放；再按热键退出（退出时保存位置）')
          : null,
        spoutPathRow,
        backend === 'wpf' ? wpfBlock : spoutBlock,
      );
    }

    /**
     * 「听觉」阈值行：value 受控于「settings 已保存值 + 本地草稿」。保存（成功或失败）后丢弃草稿：
     * 成功后 act 已刷新 status，输入框回显新值；失败则回显旧值，绝不把脏草稿留在输入框里。
     */
    function hearingThresholdRow(h, { draft, saved, busy, onDraft, onSave }) {
      const value = draft ?? String(saved);
      return h('div', { style: styles.field },
        h('span', { style: styles.value }, `触发阈值 ${saved} dB（越低越灵敏；说话时电平需高于它）`),
        h('div', { style: styles.row },
          h('input', {
            style: styles.input,
            type: 'number',
            min: -90,
            max: -10,
            value,
            disabled: busy !== '',
            onChange: (event) => onDraft(event.target.value),
          }),
          h('button', {
            style: styles.btn,
            disabled: busy !== '',
            onClick: async () => {
              await onSave(Number(value));
              onDraft(null);
            },
          }, '保存阈值'),
        ),
      );
    }

    /**
     * 「候音等待」行：与阈值行同一套受控写法——value 来自「settings 已保存值 + 本地草稿」。
     * 非法输入（空/非数字/超出 0.5–15 秒）不写入，交给 onInvalid 提示，草稿留在输入框里；
     * 保存（成功或失败）后丢弃草稿，输入框回显 settings 的新值。
     */
    function ackDelayRow(h, { draft, saved, busy, onDraft, onSave, onInvalid }) {
      const value = draft ?? String(saved);
      return h('div', { style: styles.field },
        h('span', { style: styles.value }, `候音等待 ${saved} ms（0.5–15 秒，默认 3000）`),
        h('div', { style: styles.row },
          h('input', {
            style: styles.input,
            type: 'number',
            min: 500,
            max: 15000,
            step: 100,
            value,
            disabled: busy !== '',
            onChange: (event) => onDraft(event.target.value),
          }),
          h('span', { style: styles.value }, 'ms'),
          h('button', {
            style: styles.btn,
            disabled: busy !== '',
            onClick: async () => {
              const raw = Number(value);
              if (String(value).trim() === '' || !Number.isFinite(raw) || raw < 500 || raw > 15000) {
                onInvalid?.('候音等待需在 500–15000 ms（0.5–15 秒）之间');
                return;
              }
              await onSave(Math.round(raw));
              onDraft(null);
            },
          }, '保存候音等待'),
        ),
      );
    }

    /**
     * 「听觉 → 通话模式」：模式显示 + 手动切换（普通/通话）+ 称呼列表（添加/启用/删除）。
     * 所有写入都走 act；失败原因（无称呼、重名、与用户自称冲突）由宿主返回并就地提示。
     * 模式是宿主运行时状态：刷新页面后显示的是宿主当前值，不是本地开关。
     */
    function callModeSection(h, { status, busy, act, draft, onDraft, onShow }) {
      const call = status?.call ?? {};
      const names = Array.isArray(call.names) ? call.names : [];
      const mode = call.mode === 'call' ? 'call' : 'normal';
      const canEnter = names.some((entry) => entry.enabled === true);
      const stopping = busy !== '';
      const add = async () => {
        const text = String(draft ?? '').trim();
        if (text.length === 0) {
          onShow('先输入一个称呼');
          return;
        }
        const result = await act({ action: 'call.names.add', text }, 'call-names-add');
        if (result.ok) {
          onDraft('');
          onShow(`已添加称呼「${result.item?.text ?? text}」`);
        } else {
          onShow(result.error ?? result.reason ?? '称呼添加失败');
        }
      };
      return h('div', { style: styles.field },
        h('span', { style: styles.value }, `通话模式：${mode === 'call' ? '通话中' : '普通模式'}`),
        h('div', { style: styles.row },
          h('span', { style: styles.value }, canEnter ? '切换模式（立即生效，不用重启）' : '先添加并启用一个称呼，才能进入通话模式'),
          h('span', { style: { display: 'flex', gap: 8 } },
            h('button', {
              style: { ...(mode === 'normal' ? styles.btnActive : styles.btn), ...(stopping ? styles.off : {}) },
              disabled: stopping,
              onClick: () => void act({ action: 'call.mode', mode: 'normal' }, 'call-mode'),
            }, '普通'),
            h('button', {
              style: { ...(mode === 'call' ? styles.btnActive : styles.btn), ...(stopping || !canEnter ? styles.off : {}) },
              disabled: stopping || !canEnter,
              title: canEnter ? '' : '需要至少一个启用中的称呼',
              onClick: () => void act({ action: 'call.mode', mode: 'call' }, 'call-mode'),
            }, '通话'))),
        names.length === 0
          ? h('div', { style: styles.hint }, '还没有助手称呼。添加后在通话模式里只有「小满，在吗」这种明确叫称呼的话会被接收。')
          : h('div', {},
              names.map((entry) => h('div', { key: entry.id, style: styles.row },
                h('span', { style: { ...styles.value, color: entry.enabled === true ? '#111827' : MUTED } },
                  entry.text,
                  entry.enabled === true ? null : '（已停用）'),
                h('span', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    style: { ...(entry.enabled === true ? styles.btnActive : styles.btn), ...(stopping ? styles.off : {}) },
                    disabled: stopping,
                    onClick: () => void act({
                      action: 'call.names.toggle',
                      id: entry.id,
                      enabled: entry.enabled !== true,
                    }, 'call-name-toggle'),
                  }, entry.enabled === true ? '已启用' : '已停用'),
                  h('button', {
                    style: { ...styles.btnDanger, ...(stopping ? styles.off : {}) },
                    disabled: stopping,
                    onClick: () => void act({ action: 'call.names.remove', id: entry.id }, 'call-name-remove'),
                  }, '删除'))))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            style: styles.input,
            value: draft ?? '',
            placeholder: '添加称呼，例如：小满',
            disabled: stopping,
            onChange: (event) => onDraft(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') void add(); },
          }),
          h('button', {
            style: { ...styles.btnPrimary, ...(stopping || String(draft ?? '').trim() === '' ? styles.off : {}), whiteSpace: 'nowrap' },
            disabled: stopping || String(draft ?? '').trim() === '',
            onClick: () => void add(),
          }, '添加')),
        h('div', { style: styles.hint }, '通话模式只接收明确叫到称呼的话；没叫称呼不投递、不新建轮次、不打断播报。设置页可随时切回普通模式。'),
      );
    }

    /**
     * 「听觉 → 声纹影子」状态行（只读）：一个开关 + 模型/命中汇总。判定只记录，不参与投递。
     * 默认关闭；模型缺失时开启会由宿主触发 T1 下载，状态文本随即显示「下载中」。
     */
    function speakerShadowRow(h, { status, busy, act }) {
      const shadow = status?.speaker ?? {};
      const model = shadow.model === 'ready' ? '模型就绪'
        : shadow.model === 'downloading' ? '模型下载中' : '模型缺失（开启后自动下载）';
      const last = shadow.lastShadow?.decision ? ` · 最近判定 ${shadow.lastShadow.decision}` : '';
      const counts = `匹配 ${shadow.matches ?? 0} · 不确定 ${shadow.unsure ?? 0} · 无声纹 ${shadow.noSpeakers ?? 0} · 错误 ${shadow.errors ?? 0}`;
      return h('div', { style: styles.field },
        h('div', { style: styles.row },
          h('span', { style: styles.value }, '声纹影子（只记录，不参与投递）'),
          h('button', {
            style: { ...(shadow.enabled ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
            disabled: busy !== '',
            onClick: () => act({ action: 'voice.speakerShadow', enabled: shadow.enabled !== true }, 'speaker-shadow'),
          }, shadow.enabled ? '已开启' : '已关闭')),
        h('div', { style: styles.hint },
          `${shadow.enabled ? '已开启' : '默认关闭'} · ${model} · ${counts}${last}；判定不拦截、不改写、不入记忆。`),
      );
    }

    /**
     * 「动作预设」区块：家族分组 + 搜索/过滤 + 动作/家族级启停与优先级，放在现有「形象」卡片内。
     * 纯展示：所有写入都交给 handlers（Panel 里统一 act 到 motion.presets.*）。
     * 预览按钮在控制器接线前保持禁用并标注「待接线」，不会私自播放动作。
     */
    function motionPresetSection(h, { data, query, filters, drafts, busy }, handlers) {
      if (data === null || data === undefined) {
        return h('div', { style: { marginTop: 10 } },
          h('div', { style: styles.label }, '动作预设'),
          h('div', { style: styles.hint }, '正在读取动作预设…'),
        );
      }
      const items = Array.isArray(data.items) ? data.items : [];
      const families = Array.isArray(data.families) ? data.families : [];
      const overrides = data.overrides ?? {};
      const disabled = new Set(Array.isArray(overrides.disabled) ? overrides.disabled : []);
      const disabledFamilies = new Set(Array.isArray(overrides.disabledFamilies) ? overrides.disabledFamilies : []);
      const actionPriority = overrides.actionPriority ?? {};
      const familyPriority = overrides.familyPriority ?? {};
      const defaultPriority = Number.isFinite(data.defaultPriority) ? data.defaultPriority : 50;
      const state = filters ?? {};
      const q = String(query ?? '').trim().toLowerCase();
      const matches = (item) => {
        if (String(state.family ?? '') !== '' && item.family !== state.family) return false;
        if (String(state.style ?? '') !== '' && !(item.styles ?? []).includes(state.style)) return false;
        if (state.availability === 'available' && item.available !== true) return false;
        if (state.availability === 'unavailable' && item.available !== false) return false;
        if (q.length === 0) return true;
        return [
          item.name, item.description, item.family, item.familyLabel, item.recipe, item.variant,
          ...(item.states ?? []), ...(item.stateLabels ?? []),
          ...(item.events ?? []), ...(item.eventLabels ?? []),
          ...(item.styles ?? []), ...(item.styleLabels ?? []),
        ].map(value => String(value ?? '')).join(' ').toLowerCase().includes(q);
      };
      const visible = items.filter(matches);
      const styleOptions = [...new Map(items.flatMap((item) => (item.styles ?? [])
        .map((id, index) => [id, (item.styleLabels ?? [])[index] ?? id]))).entries()];
      const familyOrder = [...new Set([...families.map(family => family.family), ...items.map(item => item.family)])];
      const groups = familyOrder.map((family) => ({
        family,
        label: families.find(entry => entry.family === family)?.label
          ?? items.find(item => item.family === family)?.familyLabel ?? family,
        meta: families.find(entry => entry.family === family) ?? null,
        members: visible.filter(item => item.family === family),
      })).filter(group => group.members.length > 0);

      const priorityInput = (key, value, body) => h('input', {
        style: { ...styles.input, width: 72 },
        type: 'number', min: 0, max: 100, step: 1,
        title: '0–100，默认 50；只影响概率，不绕过硬约束，100 也不保证选中',
        value: drafts?.[key] ?? String(value),
        disabled: busy !== '',
        onChange: (event) => handlers.setDraft(key, event.target.value),
        onBlur: async (event) => {
          const raw = event.target.value;
          handlers.setDraft(key, null);
          const number = Number(raw);
          if (!Number.isFinite(number) || number === value) return;
          await handlers.override({ ...body, priority: number });
        },
        onKeyDown: (event) => { if (event.key === 'Enter' && event.target?.blur) event.target.blur(); },
      });

      const actionRow = (item) => {
        const enabled = !disabled.has(item.presetId);
        const priority = actionPriority[item.presetId] ?? familyPriority[item.family] ?? defaultPriority;
        return h('div', {
          key: item.presetId,
          'data-preset-id': item.presetId,
          'data-family': item.family,
          'data-styles': (item.styles ?? []).join(','),
          'data-available': item.available ? '1' : '0',
          style: { padding: '6px 0', borderTop: `1px dashed ${BORDER}` },
        },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, item.name),
            h('span', {
              style: { ...styles.badge, ...(item.available ? {} : { borderColor: DANGER, color: DANGER }) },
            }, item.available ? '可用' : '不可用'),
          ),
          h('div', { style: styles.hint }, item.description),
          h('div', { style: styles.hint },
            `状态：${(item.stateLabels ?? item.states ?? []).join(' / ')} · `
            + `事件：${(item.eventLabels ?? item.events ?? []).join(' / ')} · `
            + `风格：${(item.styleLabels ?? item.styles ?? []).join(' / ')}`),
          item.available ? null : h('div', { style: { ...styles.hint, color: DANGER } }, `不可用原因：${item.reason}`),
          h('div', { style: styles.row },
            h('button', {
              style: styles.btn,
              disabled: busy !== '',
              onClick: () => { void handlers.override({ kind: 'action', id: item.presetId, enabled: !enabled }); },
            }, enabled ? '禁用' : '启用'),
            priorityInput(`action:${item.presetId}`, priority, { kind: 'action', id: item.presetId }),
            h('button', {
              style: styles.btn,
              disabled: busy !== '',
              onClick: () => { void handlers.reset({ kind: 'action', id: item.presetId }); },
            }, '恢复默认'),
            h('button', {
              style: { ...styles.btn, ...styles.off },
              disabled: true,
              title: '待接线：预览将走正常控制器与安全限制',
            }, '预览（待接线）'),
          ),
        );
      };

      const familyBlock = (group) => {
        const familyEnabled = !disabledFamilies.has(group.family);
        const priority = familyPriority[group.family] ?? group.meta?.priority ?? defaultPriority;
        return h('div', {
          key: group.family,
          'data-family': group.family,
          style: { marginTop: 12 },
        },
          h('div', { style: styles.row },
            h('span', { style: { ...styles.label, fontWeight: 600 } }, `${group.label}（${group.members.length}）`),
            h('span', {
              style: { ...styles.badge, ...(familyEnabled ? {} : { borderColor: DANGER, color: DANGER }) },
            }, familyEnabled ? '家族启用' : '家族禁用'),
          ),
          h('div', { style: styles.row },
            h('button', {
              style: styles.btn,
              disabled: busy !== '',
              onClick: () => { void handlers.override({ kind: 'family', id: group.family, enabled: !familyEnabled }); },
            }, familyEnabled ? '禁用家族' : '启用家族'),
            priorityInput(`family:${group.family}`, priority, { kind: 'family', id: group.family }),
            h('button', {
              style: styles.btn,
              disabled: busy !== '',
              onClick: () => { void handlers.reset({ kind: 'family', id: group.family }); },
            }, '恢复该家族默认'),
          ),
          group.members.map(actionRow),
        );
      };

      const filterSelect = (title, value, options, onChange) => h('select', {
        style: { ...styles.input, width: 'auto' },
        title,
        value,
        disabled: busy !== '',
        onChange: (event) => onChange(event.target.value),
      }, options.map(option => h('option', { key: option.value, value: option.value }, option.label)));

      return h('div', { style: { marginTop: 10 } },
        h('div', { style: styles.row },
          h('span', { style: styles.label }, `动作预设（${visible.length} / ${items.length}）`),
          h('button', { style: styles.btn, disabled: busy !== '', onClick: handlers.refresh }, '刷新'),
        ),
        h('div', { style: styles.hint }, '影响概率，不绕过硬约束：优先级 100 也不保证选中。内置动作的“删除”= 本地隐藏/禁用，可恢复。'),
        h('div', { style: styles.field },
          h('input', {
            style: styles.input,
            type: 'search',
            placeholder: '搜索名称 / 家族 / 风格 / 状态 / 事件',
            value: query ?? '',
            disabled: busy !== '',
            onChange: (event) => handlers.setQuery(event.target.value),
          }),
        ),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          filterSelect('按家族过滤', state.family ?? '', [
            { value: '', label: '全部家族' },
            ...families.map(family => ({ value: family.family, label: family.label ?? family.family })),
          ], (value) => handlers.setFilter('family', value)),
          filterSelect('按风格过滤', state.style ?? '', [
            { value: '', label: '全部风格' },
            ...styleOptions.map(([id, label]) => ({ value: id, label })),
          ], (value) => handlers.setFilter('style', value)),
          filterSelect('按可用性过滤', state.availability ?? '', [
            { value: '', label: '全部可用性' },
            { value: 'available', label: '仅可用' },
            { value: 'unavailable', label: '仅不可用' },
          ], (value) => handlers.setFilter('availability', value)),
          h('button', {
            style: { ...styles.btnDanger, ...(busy !== '' ? styles.off : {}) },
            disabled: busy !== '',
            onClick: () => { void handlers.reset({ all: true }); },
          }, '全部恢复默认'),
        ),
        data.error ? h('div', { style: { ...styles.hint, color: DANGER } }, `读取失败：${data.error}`) : null,
        h('div', { style: { maxHeight: 520, overflowY: 'auto', marginTop: 4 } },
          groups.length > 0 ? groups.map(familyBlock) : h('div', { style: styles.hint }, '没有匹配的动作'),
        ),
      );
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [toast, setToast] = useState('');
      const toastTimer = useRef(null);

      const show = useCallback((text) => {
        setToast(text);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => {
          setToast('');
          toastTimer.current = null;
        }, 1500);
      }, []);

      const [editingHotkey, setEditingHotkey] = useState('');
      const [captured, setCaptured] = useState('');
      const [captureHint, setCaptureHint] = useState('');

      const [editorOpen, setEditorOpen] = useState(false);
      const [editingKey, setEditingKey] = useState('');
      const [draft, setDraft] = useState({ key: '', title: '', tags: '', kind: 'note', secret: false, value: '' });
      const [archive, setArchive] = useState([]);
      const [archiveOpen, setArchiveOpen] = useState(false);
      const [archiveQuery, setArchiveQuery] = useState('');
      const [chatDraft, setChatDraft] = useState('');
      const [chatResult, setChatResult] = useState(null);
      const [chatConfirm, setChatConfirm] = useState(false);
      const [layerDraft, setLayerDraft] = useState(null);
      const [spoutDraft, setSpoutDraft] = useState(null);
      const [fastpathReviewOpen, setFastpathReviewOpen] = useState(false);
      const [fastpathGroups, setFastpathGroups] = useState([]);
      const [fastpathFilter, setFastpathFilter] = useState(FASTPATH_GROUP_ALL);
      const [fastpathOpenGroups, setFastpathOpenGroups] = useState([]);
      const [fastpathExpanded, setFastpathExpanded] = useState([]);
      const [fastpathConfirm, setFastpathConfirm] = useState(null);
      // 听觉阈值：null = 未编辑，输入框直接回显 settings 里的已保存值（见 hearingThresholdRow）。
      const [thresholdDraft, setThresholdDraft] = useState(null);
      // 通话模式的新称呼输入草稿；添加成功后清空。
      const [callNameDraft, setCallNameDraft] = useState('');
      // 候音等待：同一套受控草稿；保存值来自 /assistant/status 的 voiceAckDelayMs。
      const [ackDelayDraft, setAckDelayDraft] = useState(null);
      // 字幕字号上限：同样的受控草稿，保存（失焦）后丢弃，输入框回显 status.subtitle.sizeMax。
      const [sizeMaxDraft, setSizeMaxDraft] = useState(null);
      const [autostartDraft, setAutostartDraft] = useState(null);
      const [gptAutostartDraft, setGptAutostartDraft] = useState(null);
      const [ttsDraft, setTtsDraft] = useState(null);
      // Last 「应用模型」 result of this visit; carries the per-model timings the status omits.
      const [ttsApply, setTtsApply] = useState(null);
      // 动作预设：列表（含覆盖值与可用性）、搜索/过滤、优先级草稿（key = action:id / family:id）。
      const [motionPresets, setMotionPresets] = useState(null);
      const [motionQuery, setMotionQuery] = useState('');
      const [motionFilters, setMotionFilters] = useState({ family: '', style: '', availability: '' });
      const [motionDrafts, setMotionDrafts] = useState({});
      // 「最近听到」只看 1 条还是最近 3 条；只是展示状态，不写 settings。
      const [expandedAmbient, setExpandedAmbient] = useState(false);
      // 人设库：本次手动整理/保存拆分的结果、「保存」前的文本草稿，以及「重新分类」的预览状态。
      const [profileMaintain, setProfileMaintain] = useState(null);
      const [profileDraft, setProfileDraft] = useState(null);
      const [profileReclassify, setProfileReclassify] = useState(null);
      // Synchronous guard for preview/apply: React state is async, this rejects a double click.
      const profileReclassifyLock = useRef(false);
      // 「库编辑」: rows from profile.entry.list; drafts/picker/confirmDelete are inline state.
      const [profileLibrary, setProfileLibrary] = useState({
        open: false, busy: '', rows: [], categories: [], drafts: {}, picker: '', confirmDelete: '', error: '', note: '',
      });
      const profileLibraryLock = useRef(false);
      // 「分类管理」子容器：rows 由 profile.category.list 刷新；editing/merging 是行内编辑器。
      const [profileCategory, setProfileCategory] = useState(null);
      const profileCategoryLock = useRef(false);
      // P-116 问卷弹窗：open/questions/answers/draft/revision/busy 全部在一个对象里。
      const [profileQuiz, setProfileQuiz] = useState(null);
      const profileQuizEpoch = useRef(0);
      // Synchronous double-click guard for 「立刻整理」: React state is async, this is not.
      const profileMaintainLock = useRef(false);

      const load = useCallback(async () => {
        try {
          const response = await fetch('/assistant/status', { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setStatus(await response.json());
          setError('');
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        }
      }, []);

      const act = useCallback(
        async (body, tag) => {
          setBusy(tag ?? body.action);
          try {
            const response = await fetch('/assistant/action', {
              method: 'POST',
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify(body),
            });
            const result = await response.json();
            if (!result.ok) show(result.error ? `失败：${result.error}` : '操作失败');
            await load();
            return result;
          } catch (cause) {
            show(`请求失败：${cause && cause.message ? cause.message : String(cause)}`);
            return { ok: false };
          } finally {
            setBusy('');
          }
        },
        [load, show],
      );

      // 动作预设列表：只在打开设置页时读一次，覆盖/恢复后再读一次（保持按钮与覆盖值一致）。
      const loadMotionPresets = useCallback(async () => {
        try {
          const response = await fetch('/assistant/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ action: 'motion.presets.list' }),
          });
          const result = await response.json();
          if (result?.ok === true) {
            setMotionPresets({
              items: Array.isArray(result.items) ? result.items : [],
              families: Array.isArray(result.families) ? result.families : [],
              overrides: result.overrides ?? null,
              defaultPriority: result.defaultPriority ?? 50,
              error: '',
            });
          } else {
            setMotionPresets({
              items: [], families: [], overrides: null, defaultPriority: 50,
              error: String(result?.error ?? '读取失败'),
            });
          }
        } catch (cause) {
          setMotionPresets({
            items: [], families: [], overrides: null, defaultPriority: 50,
            error: cause && cause.message ? cause.message : String(cause),
          });
        }
      }, []);

      const overrideMotionPreset = useCallback(async (body) => {
        const result = await act({ action: 'motion.presets.override', ...body }, 'motion-presets');
        if (result?.ok === true) await loadMotionPresets();
        return result;
      }, [act, loadMotionPresets]);

      const resetMotionPresets = useCallback(async (body) => {
        const result = await act({ action: 'motion.presets.reset', ...body }, 'motion-presets');
        if (result?.ok === true) await loadMotionPresets();
        return result;
      }, [act, loadMotionPresets]);

      // ---- P-116 问卷弹窗 handlers -----------------------------------------------------------
      // Every async step captures an epoch: closing the dialog (or a newer open) invalidates the
      // pending answer, so a late generation can never repopulate a cancelled dialog.
      const openProfileQuiz = useCallback(async () => {
        const epoch = profileQuizEpoch.current + 1;
        profileQuizEpoch.current = epoch;
        const result = await act({ action: 'persona.quiz.start' }, 'persona-quiz');
        if (epoch !== profileQuizEpoch.current) return;
        if (result?.ok !== true) return;
        const questions = Array.isArray(result.questions) ? result.questions : [];
        const trial = result.trial ?? status?.profile?.trial ?? null;
        setProfileQuiz({
          open: true,
          questions,
          revision: result.revision ?? null,
          trial,
          answers: questions.map((question) => ({ id: String(question.id), text: '' })),
          draft: trial?.active === true ? String(trial.text ?? '') : '',
          busy: false,
          error: '',
        });
      }, [act, status]);

      const closeProfileQuiz = useCallback(() => {
        profileQuizEpoch.current += 1;
        setProfileQuiz(null);
      }, []);

      const setQuizAnswer = useCallback((id, value) => {
        setProfileQuiz((current) => {
          if (current === null) return current;
          const answers = Array.isArray(current.answers) ? current.answers : [];
          return {
            ...current,
            answers: answers.map((item) => (item.id === id ? { ...item, text: value } : item)),
          };
        });
      }, []);

      const setQuizDraft = useCallback((value) => {
        setProfileQuiz((current) => (current === null ? current : { ...current, draft: value }));
      }, []);

      const generateProfileQuiz = useCallback(async () => {
        if (profileQuiz === null) return;
        const answers = Array.isArray(profileQuiz.answers) ? profileQuiz.answers : [];
        if (!personaQuizCanGenerate(answers)) {
          setProfileQuiz((current) => (current === null
            ? current
            : { ...current, error: '至少回答一题才能生成。' }));
          return;
        }
        const epoch = profileQuizEpoch.current;
        setProfileQuiz((current) => (current === null ? current : { ...current, busy: true, error: '' }));
        const result = await act(personaQuizAnswersBody(answers, profileQuiz.revision), 'persona-quiz');
        if (epoch !== profileQuizEpoch.current) return;
        setProfileQuiz((current) => {
          if (current === null) return current;
          if (result?.ok !== true) {
            return { ...current, busy: false, error: String(result?.error ?? result?.code ?? '生成失败') };
          }
          return {
            ...current,
            busy: false,
            error: '',
            draft: String(result.draft ?? result.text ?? ''),
            revision: result.revision ?? current.revision,
            trial: result.trial ?? current.trial,
          };
        });
      }, [act, profileQuiz]);

      const applyProfileQuizTrial = useCallback(async () => {
        if (profileQuiz === null) return;
        const epoch = profileQuizEpoch.current;
        setProfileQuiz((current) => (current === null ? current : { ...current, busy: true, error: '' }));
        const result = await act({
          action: 'persona.quiz.applyTrial',
          text: String(profileQuiz.draft ?? ''),
          revision: profileQuiz.revision ?? null,
        }, 'persona-quiz');
        if (epoch !== profileQuizEpoch.current) return;
        setProfileQuiz((current) => {
          if (current === null) return current;
          if (result?.ok !== true) {
            return { ...current, busy: false, error: String(result?.error ?? '应用试用失败') };
          }
          return {
            ...current,
            busy: false,
            error: '',
            draft: String(result.text ?? current.draft),
            revision: result.revision ?? current.revision,
            trial: result.trial ?? current.trial,
          };
        });
        if (result?.ok === true) setProfileDraft(null);
      }, [act, profileQuiz]);

      const adoptProfileQuizTrial = useCallback(async () => {
        if (profileQuiz === null) return;
        const epoch = profileQuizEpoch.current;
        setProfileQuiz((current) => (current === null ? current : { ...current, busy: true, error: '' }));
        const result = await act({
          action: 'persona.quiz.adopt',
          text: String(profileQuiz.draft ?? ''),
        }, 'persona-quiz');
        if (epoch !== profileQuizEpoch.current) return;
        if (result?.ok === true) {
          setProfileDraft(null);
          setProfileQuiz(null);
          show(`已正式采用：新增 ${Number(result.added ?? 0)} · 更新 ${Number(result.updated ?? 0)} · 移除 ${Number(result.removed ?? 0)}`);
          return;
        }
        setProfileQuiz((current) => (current === null
          ? current
          : { ...current, busy: false, error: String(result?.error ?? '正式采用失败') }));
      }, [act, profileQuiz, show]);

      const discardProfileQuizTrial = useCallback(async () => {
        if (profileQuiz === null) return;
        const epoch = profileQuizEpoch.current;
        setProfileQuiz((current) => (current === null ? current : { ...current, busy: true, error: '' }));
        const result = await act({ action: 'persona.quiz.discard' }, 'persona-quiz');
        if (epoch !== profileQuizEpoch.current) return;
        if (result?.ok === true) {
          setProfileDraft(null);
          setProfileQuiz(null);
          show('已放弃试用，恢复试用前的文本');
          return;
        }
        setProfileQuiz((current) => (current === null
          ? current
          : { ...current, busy: false, error: String(result?.error ?? '放弃试用失败') }));
      }, [act, profileQuiz, show]);

      const loadArchive = useCallback(async () => {
        const result = await act({ action: 'memory.archive.list', query: archiveQuery, limit: 100 }, 'archive');
        if (result.ok) setArchive(Array.isArray(result.items) ? result.items : []);
      }, [act, archiveQuery]);

      // 快路对话审阅：展开时才读取，避免每 3 秒状态轮询顺带读整个 JSONL。
      const loadFastpathHistory = useCallback(async () => {
        const result = await act({ action: 'fastpath.history' }, 'fastpath-history');
        if (result?.ok === true) setFastpathGroups(Array.isArray(result.groups) ? result.groups : []);
      }, [act]);

      /** 清空只发当前域；成功后只从本地分组里移除该域，其它域的条目原样保留。 */
      const clearFastpathDomain = useCallback(async (domain) => {
        const result = await act({ action: 'fastpath.clear', domain: String(domain ?? '') }, 'fastpath-clear');
        setFastpathConfirm(null);
        if (result?.ok !== true) return;
        setFastpathGroups((current) => current.filter((group) => String(group?.domain ?? '') !== domain));
        setFastpathExpanded((current) => current.filter((key) => !key.startsWith(`${String(domain)}|`)));
        show(`已清空「${fastpathDomainLabel(domain)}」${Number(result.removed ?? 0)} 条记录`);
      }, [act, show]);

      useEffect(() => {
        load();
        const timer = setInterval(load, 3000);
        return () => {
          clearInterval(timer);
        };
      }, [load]);

      // 动作预设不随 3 秒状态轮询：只在挂载时读一次，之后由刷新/覆盖/恢复触发。
      useEffect(() => {
        void loadMotionPresets();
      }, [loadMotionPresets]);

      // A queued round is finished by the host later: the 3 s status poll is what releases the
      // silent button, so the card can never stay on 「已排队…」 after the queue drained.
      useEffect(() => {
        if (profileMaintain?.queued !== true) return;
        const profile = status?.profile ?? {};
        if (profile.queued !== true && profile.running !== true) {
          setProfileMaintain({ running: false, queued: false, note: '整理完成' });
        }
      }, [status, profileMaintain?.queued]);

      useEffect(() => {
        if (editingHotkey === '') return undefined;
        const onKeyDown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') {
            setEditingHotkey('');
            setCaptured('');
            setCaptureHint('');
            return;
          }
          const mods = [];
          if (event.ctrlKey) mods.push('Ctrl');
          if (event.altKey) mods.push('Alt');
          if (event.shiftKey) mods.push('Shift');
          if (event.metaKey) mods.push('Win');
          const key = normalizeKey(event);
          if (key === null) {
            setCaptureHint('请按一个组合键（含 Ctrl / Alt / Shift / Win）');
            return;
          }
          if (mods.length === 0) {
            // Like the host, a single F key or media key may stand alone; a main-row
            // digit/letter (and every other key) is still refused without a modifier.
            const singleKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key)
              || /^(?:Media|Volume)[A-Za-z]+$/u.test(key);
            if (!singleKey) {
              setCaptureHint('主键盘字母/数字需要至少一个修饰键，例如 Ctrl+Alt+V；单个 F 键或媒体键可直接保存');
              return;
            }
          }
          setCaptured([...mods, key].join('+'));
          setCaptureHint('');
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [editingHotkey]);

      const feature = (id) => (status?.features ?? []).find((entry) => entry.id === id)?.enabled === true;

      // 连带启动：路径先存草稿、失去焦点才提交，避免每敲一个字都发一次请求。
      const autostartOf = (target) => status?.autostart?.[target] ?? { enabled: false, autoClose: true, path: '', running: false, owned: false };
      const autostartPath = (target) => autostartDraft?.[target] ?? autostartOf(target).path;
      const commitAutostartPath = async (target) => {
        const value = autostartDraft?.[target];
        if (typeof value !== 'string' || value === autostartOf(target).path) return;
        await act({ action: 'autostart.set', target, path: value }, `autostart-path:${target}`);
        setAutostartDraft((current) => (current === null ? null : { ...current, [target]: undefined }));
      };
      // 「浏览…」先用宿主的 Windows 文件对话框；宿主不可用时退回目录选择器，手动输入始终保留。
      const pickAutostartPath = async (target) => {
        const picked = await act({ action: 'autostart.pick', target }, `autostart-pick:${target}`);
        let path = picked?.ok === true && typeof picked.path === 'string' ? picked.path.trim() : '';
        if (picked?.ok !== true) {
          const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
          const dir = typeof uiWorkspace?.pickDirectory === 'function' ? await uiWorkspace.pickDirectory() : '';
          path = typeof dir === 'string' ? dir.trim() : '';
        }
        if (path.length === 0) return;
        setAutostartDraft((current) => ({ ...(current ?? {}), [target]: path }));
        const saved = await act({ action: 'autostart.set', target, path }, `autostart-path:${target}`);
        if (saved.ok !== false) {
          setAutostartDraft((current) => (current === null ? null : { ...current, [target]: undefined }));
          show('已选择路径');
        }
      };

      // GPT-SoVITS 的连带启动：同样草稿 + 失焦提交，字段比 OBS/VTS 多，所以单独一组。
      const gptAutostartOf = () => status?.autostart?.gptsovits ?? {
        enabled: false,
        pythonPath: '',
        scriptPath: '',
        workDir: '',
        port: 9880,
        running: false,
      };
      const gptAutostartValue = (key) => gptAutostartDraft?.[key] ?? String(gptAutostartOf()[key] ?? '');
      const commitGptAutostartField = async (key) => {
        const value = gptAutostartDraft?.[key];
        if (typeof value !== 'string' || value === String(gptAutostartOf()[key] ?? '')) return;
        const saved = await act(
          { action: 'autostart.set', target: 'gptsovits', [key]: value },
          `autostart-gpt:${key}`,
        );
        if (saved.ok !== false) {
          setGptAutostartDraft((current) => (current === null ? null : { ...current, [key]: undefined }));
        }
      };
      const pickGptAutostartFile = async (key, kind, label) => {
        const picked = await act({ action: 'pick.file', kind }, `autostart-gpt-pick:${key}`);
        const path = picked?.ok === true && typeof picked.path === 'string' ? picked.path.trim() : '';
        if (path.length === 0) return;
        setGptAutostartDraft((current) => ({ ...(current ?? {}), [key]: path }));
        const saved = await act(
          { action: 'autostart.set', target: 'gptsovits', [key]: path },
          `autostart-gpt:${key}`,
        );
        if (saved.ok !== false) {
          setGptAutostartDraft((current) => (current === null ? null : { ...current, [key]: undefined }));
          show(`已选择${label}`);
        }
      };
      const pickGptAutostartWorkDir = async () => {
        const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
        const picked = typeof uiWorkspace?.pickDirectory === 'function' ? await uiWorkspace.pickDirectory() : '';
        const path = typeof picked === 'string' ? picked.trim() : '';
        if (path.length === 0) return;
        setGptAutostartDraft((current) => ({ ...(current ?? {}), workDir: path }));
        const saved = await act(
          { action: 'autostart.set', target: 'gptsovits', workDir: path },
          'autostart-gpt:workDir',
        );
        if (saved.ok !== false) {
          setGptAutostartDraft((current) => (current === null ? null : { ...current, workDir: undefined }));
          show('已选择工作目录');
        }
      };
      const gptAutostartRow = (key, label, placeholder, onBrowse) =>
        h('div', { key, style: styles.field },
          h('div', { style: styles.value }, label),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              style: { ...styles.input, flex: 1 },
              value: gptAutostartValue(key),
              placeholder,
              onChange: (event) => setGptAutostartDraft({ ...(gptAutostartDraft ?? {}), [key]: event.target.value }),
              onBlur: () => void commitGptAutostartField(key),
            }),
            h('button', {
              style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
              disabled: busy !== '',
              onClick: onBrowse,
            }, '浏览…'),
          ),
        );

      // 语音合成：同样是草稿 + 失焦提交，避免状态轮询打断正在输入的文本。
      const gptSovits = status?.tts?.gptSovits ?? {
        enabled: false,
        apiBase: 'http://127.0.0.1:9880',
        refAudioPath: '',
        promptText: '',
        promptLang: '',
        textLang: '',
        models: { gptModelPath: '', sovitsModelPath: '' },
      };
      const gptModels = gptSovits.models ?? { gptModelPath: '', sovitsModelPath: '' };
      const langs = status?.langs ?? { speech: 'zh', subtitle: 'zh' };
      const ttsValue = (key) => ttsDraft?.[key] ?? gptSovits[key] ?? '';
      // '' = follow langs.speech; a picked value is the explicit pin sent to the host.
      const ttsLangLabels = { zh: '中文', ja: '日语', en: '英语', ko: '韩语', yue: '粤语' };
      const ttsLangRow = (key, label) => h('div', { style: styles.field },
        h('span', { style: styles.value }, label),
        h('select', {
          style: styles.input,
          value: gptSovits[key] ?? '',
          disabled: busy !== '',
          onChange: (event) => act({ action: 'tts.config', [key]: event.target.value }, `tts:${key}`),
        },
          h('option', { key: 'auto', value: '' }, `跟随语音（${ttsLangLabels[langs.speech] ?? '中文'}）`),
          Object.entries(ttsLangLabels).map(([value, text]) => h('option', { key: value, value }, text))));
      const ttsRefSeconds = typeof gptSovits.referenceSeconds === 'number' ? gptSovits.referenceSeconds : null;
      const ttsPromptOk = gptSovits.promptOk === true || String(gptSovits.promptText ?? '').trim().length > 0;
      const ttsEffectiveText = gptSovits.effectiveTextLang ?? langs.speech ?? 'zh';
      // One diagnostic line: what the host will actually send with the next /tts request.
      const ttsDiag = [
        ttsRefSeconds === null
          ? '参考音频时长未测到 ⚠（需 3–10 秒）'
          : `参考音频 ${ttsRefSeconds.toFixed(1)}s ${gptSovits.referenceOk === true ? '✓' : '✗（需 3–10 秒）'}`,
        `参考文本${ttsPromptOk ? '已填 ✓' : '未填 ✗'}`,
        `输出语种 ${ttsEffectiveText}`,
      ].join(' · ');
      const commitTtsField = async (key) => {
        const value = ttsDraft?.[key];
        if (typeof value !== 'string' || value === String(gptSovits[key] ?? '')) return;
        const result = await act({ action: 'tts.config', [key]: value }, `tts:${key}`);
        if (result.ok) {
          setTtsDraft((current) => (current === null ? null : { ...current, [key]: undefined }));
        }
      };
      const pickRefAudio = async () => {
        const picked = await act({ action: 'pick.file', kind: 'audio' }, 'tts-pick');
        const path = picked?.ok === true && typeof picked.path === 'string' ? picked.path.trim() : '';
        if (path.length === 0) return;
        setTtsDraft((current) => ({ ...(current ?? {}), refAudioPath: path }));
        const saved = await act({ action: 'tts.config', refAudioPath: path }, 'tts-ref');
        if (saved.ok) {
          setTtsDraft((current) => (current === null ? null : { ...current, refAudioPath: undefined }));
          show('已选择参考音频');
        }
      };
      // 模型路径：留空 = 用参考音频零样本推理；填了就请本机 GPT-SoVITS 切换权重。
      const ttsModelValue = (key) => ttsDraft?.[key] ?? gptModels[key] ?? '';
      const commitTtsModel = async (key) => {
        const value = ttsDraft?.[key];
        if (typeof value !== 'string' || value === String(gptModels[key] ?? '')) return;
        const result = await act({ action: 'tts.config', models: { [key]: value } }, `tts-model:${key}`);
        if (result.ok) {
          setTtsDraft((current) => (current === null ? null : { ...current, [key]: undefined }));
        }
      };
      const pickTtsModel = async (key) => {
        const picked = await act({ action: 'pick.file', kind: 'model' }, `tts-model-pick:${key}`);
        const path = picked?.ok === true && typeof picked.path === 'string' ? picked.path.trim() : '';
        if (path.length === 0) return;
        setTtsDraft((current) => ({ ...(current ?? {}), [key]: path }));
        const saved = await act({ action: 'tts.config', models: { [key]: path } }, `tts-model:${key}`);
        if (saved.ok) {
          setTtsDraft((current) => (current === null ? null : { ...current, [key]: undefined }));
          show('已选择模型路径');
        }
      };

      // 「应用模型」：唯一显式加载权重的地方；保存路径只把 modelsDirty 置真。
      const applyModels = async () => {
        const result = await act({ action: 'gptSovits.applyModels' }, 'tts-apply');
        setTtsApply(result);
        // 宿主先等当前句（最多 3 秒）再打断；旧宿主没有 interrupted 字段时保持原文案。
        if (result?.ok !== true) return;
        show(result.interrupted === true ? '模型已加载。已在等待超时后打断当前播报。' : '模型已加载');
      };
      // 状态行优先级：失败 > 已改动 > 已加载。耗时来自本次点击的返回，刷新后只保留预热耗时。
      const applySeconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '—');
      const applyState = (() => {
        const applied = gptSovits.modelsApplied ?? { gptOk: false, sovitsOk: false, at: 0, warmupMs: null };
        const appliedAt = Number(gptSovits.modelsAppliedAt ?? applied.at ?? 0);
        const dirty = gptSovits.modelsDirty === true;
        const failed = appliedAt > 0 && !dirty && (applied.gptOk !== true || applied.sovitsOk !== true);
        if (failed) {
          const stage = ttsApply?.stage || (applied.gptOk === true ? 'sovits' : 'gpt');
          const message = (ttsApply && ttsApply.ok === false ? ttsApply.error : '') || '模型未加载';
          return { text: `加载失败：${stage} ${message}`, dangerous: true };
        }
        if (dirty) return { text: '模型已改动，点「应用模型」加载', dangerous: false };
        if (appliedAt > 0) {
          const gptMs = ttsApply?.gpt?.elapsedMs;
          const sovitsMs = ttsApply?.sovits?.elapsedMs;
          const detail = Number.isFinite(gptMs) || Number.isFinite(sovitsMs)
            ? `GPT ${applySeconds(gptMs)} / SoVITS ${applySeconds(sovitsMs)} / 预热 ${applySeconds(applied.warmupMs)}`
            : `预热 ${applySeconds(applied.warmupMs)}`;
          return { text: `已加载（${detail}）`, dangerous: false };
        }
        return { text: '', dangerous: false };
      })();

      const openEditor = useCallback((resource) => {
        setEditingKey(resource?.key ?? '');
        setDraft(
          resource ?? { key: '', title: '', tags: '', kind: 'note', secret: false, value: '' },
        );
        setEditorOpen(true);
      }, []);

      const saveResource = useCallback(async () => {
        const result = await act({ action: 'resource.set', ...draft }, 'resource-save');
        if (result.ok) {
          setEditorOpen(false);
          show('固定记忆已保存');
        }
      }, [act, draft, show]);

      if (error.length > 0) return card('Seirein', h('div', { style: styles.value }, `无法读取状态：${error}`));
      if (status === null) return card('Seirein', h('div', { style: styles.value }, '读取中…'));

      const hearingOn = status.hearing.running;
      const resources = status.resources ?? [];
      const scope = status.workspaceScope ?? { enabled: true, path: status.workspace?.path ?? '' };
      const scopeOn = scope.enabled === true;
      const scopePath = typeof scope.path === 'string' ? scope.path : '';

      // Workspace permissions: the assistant session is switched to DSH full access, so the card
      // only states the policy; it no longer probes, grants or verifies directory ACLs.

      // Voice latency measurement only: the reasoning policy is not wired in this round, so the
      // card below reports timings and nothing about effort levels.
      const latency = status.voiceLatency ?? { samples: 0, recent: [], p50: {}, p95: {} };
      const fmtMs = (value) => (value === null || value === undefined || !Number.isFinite(Number(value))
        ? '—'
        : `${Math.round(Number(value))} ms`);

      const editorDialog = editorOpen
        ? h(
            'div',
            { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) setEditorOpen(false); } },
            h(
              'div',
              { style: styles.dialog },
              h('div', { style: styles.title }, editingKey.length > 0 ? `编辑固定记忆：${editingKey}` : '新增固定记忆（也可以直接对 agent 说「把这条固定下来」）'),
              h('div', { style: styles.field }, h('span', { style: styles.value }, '键名'), h('input', {
                style: styles.input, value: draft.key, placeholder: 'data.source',
                onChange: (event) => setDraft({ ...draft, key: event.target.value }),
              })),
              h('div', { style: styles.field }, h('span', { style: styles.value }, '标题'), h('input', {
                style: styles.input, value: draft.title, placeholder: '例如：动画资料查询源',
                onChange: (event) => setDraft({ ...draft, title: event.target.value }),
              })),
              h('div', { style: styles.field }, h('span', { style: styles.value }, '标签（逗号分隔）'), h('input', {
                style: styles.input, value: draft.tags, placeholder: 'code, study',
                onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
              })),
              h('div', { style: styles.field }, h('span', { style: styles.value }, '类型'), h('select', {
                style: styles.input, value: draft.kind,
                onChange: (event) => setDraft({ ...draft, kind: event.target.value }),
              }, KIND_OPTIONS.map((kind) => h('option', { key: kind, value: kind }, kind)))),
              h('div', { style: styles.field }, h('span', { style: styles.value }, '内容'), h('textarea', {
                style: styles.area, value: draft.value, placeholder: '例如：以后查开源项目资料先去 GitHub 找',
                onChange: (event) => setDraft({ ...draft, value: event.target.value }),
              })),
              h('label', { style: { ...styles.value, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 } },
                h('input', {
                  type: 'checkbox', checked: draft.secret,
                  onChange: (event) => setDraft({ ...draft, secret: event.target.checked }),
                }),
                '加密保存（DPAPI，凭据类选它）',
              ),
              h('div', { style: styles.row },
                h('span', { style: styles.value }, ''),
                h('span', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    style: { ...styles.btnPrimary, ...(busy !== '' || draft.key.trim() === '' || draft.value === '' ? styles.off : {}) },
                    disabled: busy !== '' || draft.key.trim() === '' || draft.value === '',
                    onClick: saveResource,
                  }, '保存'),
                  h('button', { style: styles.btn, onClick: () => setEditorOpen(false) }, '取消'),
                ),
              ),
            ),
          )
        : null;

      const archiveDialog = archiveOpen
        ? h(
            'div',
            { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) setArchiveOpen(false); } },
            h(
              'div',
              { style: styles.dialog },
              h('div', { style: styles.title }, `遗忘归档（${archive.length} 条）`),
              h('div', { style: styles.field },
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', {
                    style: styles.input,
                    value: archiveQuery,
                    placeholder: '按关键词过滤（留空看全部）',
                    onChange: (event) => setArchiveQuery(event.target.value),
                    onKeyDown: (event) => { if (event.key === 'Enter') void loadArchive(); },
                  }),
                  h('button', {
                    style: { ...styles.btn, ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: () => void loadArchive(),
                  }, '查询'),
                ),
              ),
              archive.length === 0
                ? h('div', { style: styles.hint }, '归档为空。容量到 90% 时会自动归档；也可以点记忆卡片的「遗忘归档」手动压缩。')
                : h('div', { style: { maxHeight: '52vh', overflow: 'auto', marginTop: 8 } },
                    archive.map((row) => h('div', {
                      key: row.id,
                      style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid #f0f1f3' },
                    },
                      h('span', { style: { flex: 1, fontSize: 12, color: '#111827' } },
                        h('span', { style: styles.mono }, `[${row.domain}] `),
                        row.text,
                        h('span', { style: { ...styles.mono, marginLeft: 6 } }, ` ${String(row.ts ?? '').slice(0, 10)}`)),
                      h('button', {
                        style: { ...styles.btnDanger, ...(busy !== '' ? styles.off : {}) },
                        disabled: busy !== '',
                        onClick: async () => {
                          const result = await act({ action: 'memory.archive.delete', ids: [row.id] }, 'archive-delete');
                          if (result.ok) {
                            setArchive(archive.filter((item) => item.id !== row.id));
                            show('已从归档删除');
                          }
                        },
                      }, '删除'),
                    )),
                  ),
              h('div', { style: styles.row },
                h('span', { style: styles.value }, '归档不进检索，可手动删除'),
                h('button', { style: styles.btn, onClick: () => setArchiveOpen(false) }, '关闭'),
              ),
            ),
          )
        : null;

      const dialog = h(React.Fragment, null, editorDialog, archiveDialog);

      return h(
        'div',
        { style: styles.wrap },
        toast.length > 0
          ? h('div', { style: styles.toast },
              h('span', null, toast),
              h('button', {
                style: { background: 'transparent', border: 'none', color: '#111827', cursor: 'pointer', fontSize: 15 },
                onClick: () => setToast(''), 'aria-label': 'close',
              }, '×'))
          : null,
        dialog,

        status.firstRun
          ? card(
            '首次使用：请先选择存放位置',
            h('div', { style: styles.hint },
              `当前数据会写到 ${status.root ?? '默认目录'}。选一个你自己的位置后，记忆、数据和工作区都会放在 <所选目录>\\Seirein 下，且改写根目录时会自动把已有数据带过去。`),
            h('div', { style: styles.row },
              h('button', {
                style: styles.btnPrimary,
                disabled: busy !== '',
                onClick: async () => {
                  const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
                  const picked = await uiWorkspace?.pickDirectory?.();
                  if (!picked) return;
                  const result = await act({ action: 'instance.setRoot', root: picked }, 'firstRun');
                  if (result.ok) show('已设定，重启 DSH 生效');
                },
              }, '选择存放位置'),
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: async () => {
                  const parent = (status.root ?? '').replace(/[\\/]+Seirein[\\/]*$/iu, '');
                  if (parent.length === 0) {
                    show('无法推断默认位置');
                    return;
                  }
                  const result = await act({ action: 'instance.setRoot', root: parent }, 'firstRunDefault');
                  if (result.ok) show('已使用默认位置');
                },
              }, '使用默认位置'),
            ),
          )
          : null,

        card(
          'Seirein',
          line('客户端 / 服务端', `v${CLIENT_VERSION} / v${status.version}`),
          line('根目录', status.root ?? '—'),
          h('div', { style: styles.row },
            h('button', {
              style: styles.btn,
              disabled: busy !== '',
              onClick: async () => {
                const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
                if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
                  show('目录选择器不可用，请手动编辑 instance.json');
                  return;
                }
                const picked = await uiWorkspace.pickDirectory();
                if (picked === null || picked === undefined || picked === '') return;
                const result = await act({ action: 'instance.setRoot', root: picked }, 'root');
                if (result.ok) show('已写入，重启 DSH 后生效');
              },
            }, '选择根目录'),
          ),
          line('运行时长', `${Math.max(1, Math.round(status.uptimeMs / 60000))} 分钟`),
          line('人设与画像', `${status.personaChars} 字符`),
          line('固定记忆', `${resources.length} 条`),
        ),

        card(
          '作用域',
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '只在指定工作区生效'),
            h('button', {
              style: { ...(scopeOn ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
              disabled: busy !== '',
              onClick: () => void act({ action: 'scope.set', enabled: !scopeOn }, 'scope'),
            }, scopeOn ? '已启用' : '已关闭')),
          h('div', { style: styles.field },
            h('span', { style: styles.label }, '工作区路径'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { ...styles.mono, flex: 1, wordBreak: 'break-all' } }, scopePath.length > 0 ? scopePath : '—'),
              h('button', {
                style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                disabled: busy !== '',
                onClick: async () => {
                  const uiWorkspace = window.__seireinCtx?.get?.('uiWorkspace');
                  if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
                    show('目录选择器不可用');
                    return;
                  }
                  const picked = await uiWorkspace.pickDirectory();
                  if (picked === null || picked === undefined || picked === '') return;
                  const result = await act({ action: 'scope.set', path: picked }, 'scope-path');
                  if (result.ok) show('作用域路径已保存');
                },
              }, '选择目录'),
            ),
          ),
          h('div', { style: styles.hint }, '默认启用。启用后人设/记忆只注入 Seirein 工作区，其它工作区（如默认工作区）调用记忆、人设、prompt 预览工具会被作用域挡下。'),
        ),

        card(
          '工作区权限',
          h('div', { style: styles.hint }, '助手会话使用 DSH 完全访问模式（危险）；其他工作区的新会话仍由 DSH 默认策略管理。'),
          h('div', { style: styles.hint }, '不再使用插件目录授权：插件不再检查、授权或验证目录 ACL，启动时也不会自动授权。'),
          h('details', { style: styles.hint },
            h('summary', { style: styles.value }, '诊断信息'),
            h('div', {}, '切换发生在助手会话创建或恢复时，事件：sandbox.switched / sandbox.already-full / sandbox.switch-unavailable。'),
            h('div', {}, '升级后已存在的助手会话会在下次恢复时切换；验证 PTY 需重启 DSH 后新建或恢复一次助手会话。')),
        ),

        card(
          '听觉',
          line('麦克风', hearingOn
            ? `监听中 · ${status.hearing.device} · ${status.hearing.rmsDb} dB`
            : `未启动${status.hearing?.deferred?.reason ? `（${status.hearing.deferred.reason}）` : ''}`),
          hearingThresholdRow(h, {
            draft: thresholdDraft,
            saved: Number(status.hearing?.thresholdDb ?? -50),
            busy,
            onDraft: setThresholdDraft,
            onSave: async (db) => {
              const result = await act({ action: 'hearing.threshold', db }, 'threshold');
              if (result.ok && result.restarted) show('已生效（新实例）');
              else if (result.ok) show('已保存（采集未运行）');
              else show(result.message ?? result.error ?? '保存失败');
            },
          }),
          callModeSection(h, {
            status,
            busy,
            act,
            draft: callNameDraft,
            onDraft: setCallNameDraft,
            onShow: show,
          }),
          (() => {
            // `deviceList` marks replay endpoints (Stereo Mix / virtual cable); an older status
            // payload only carries names, so those fall back to "selectable".
            const rows = Array.isArray(status.deviceList) && status.deviceList.length > 0
              ? status.deviceList
              : (status.devices ?? []).map((name) => ({ name, loopback: false }));
            const names = rows.map((row) => row.name);
            const selected = status.selectedDevice ?? '';
            const hasLoopback = rows.some((row) => row.loopback === true);
            return h('div', { style: styles.field },
              h('span', { style: styles.value }, '输入设备'),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('select', {
                  style: styles.input,
                  value: selected,
                  disabled: hearingOn || busy !== '',
                  onChange: (event) => act({ action: 'hearing.device', device: event.target.value }),
                },
                  rows.length === 0
                    ? h('option', { value: '' }, '（未检测到设备）')
                    : rows.map((row) => h('option', {
                        key: row.name,
                        value: row.name,
                        disabled: row.loopback === true,
                        title: row.loopback ? '回环输入不可作为麦克风' : undefined,
                      }, row.loopback ? `${row.name}（回环输入，不可选）` : row.name)),
                  selected && !names.includes(selected)
                    ? h('option', { value: selected }, `${selected}（当前）`)
                    : null,
                ),
                h('button', {
                  style: styles.btn,
                  disabled: busy !== '',
                  onClick: () => act({ action: 'hearing.devices.refresh' }),
                }, '刷新'),
              ),
              hasLoopback
                ? h('div', { style: styles.hint }, '回环输入不可作为麦克风：置灰的「立体声混音」「CABLE Output」等设备只能用于环境声音。')
                : null,
            );
          })(),
          h('div', { style: styles.row },
            h('button', {
              style: { ...(hearingOn ? styles.btnActive : styles.btnPrimary), ...(hearingOn || busy !== '' ? styles.off : {}) },
              disabled: hearingOn || busy !== '',
              onClick: () => act({ action: 'hearing.start' }),
            }, '测试麦克风'),
            h('button', {
              style: { ...styles.btn, ...(!hearingOn || busy !== '' ? styles.off : {}) },
              disabled: !hearingOn || busy !== '',
              onClick: () => act({ action: 'hearing.stop' }),
            }, '停止'),
          ),
          h('div', { style: styles.hint }, '点「测试麦克风」开始采集，看上面电平是否随说话跳动；说完停顿约 1.2 秒出终稿。'),
          h('div', { style: styles.hint }, feature('hearing')
            ? '关闭「听觉」组件会先停麦并关闭相关开关。'
            : '「听觉」组件当前关闭：点上面的按钮会先启用组件，再开始采集。'),
          h('div', { style: styles.row },
            h('span', { style: styles.value }, '开机自动监听（默认关闭；只授权，不在打开组件时立即录音）'),
            h('button', {
              style: { ...(status.hearing?.autoListen ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
              disabled: busy !== '',
              onClick: () => act({ action: 'hearing.autoListen', enabled: status.hearing?.autoListen !== true }, 'hearing-autoListen'),
            }, status.hearing?.autoListen ? '已开启' : '已关闭')),
          speakerShadowRow(h, { status, busy, act }),
        ),

        (() => {
          // 语种：语音与字幕分开配置，来源是 /assistant/status 的 langs。
          const langOptions = [['zh', '中文'], ['ja', '日语'], ['en', '英语'], ['ko', '韩语'], ['yue', '粤语']];
          const langRow = (label, key) => h('div', { style: styles.row },
            h('span', { style: styles.label }, label),
            h('select', {
              style: { ...styles.input, width: 140 },
              value: langs[key] ?? 'zh',
              disabled: busy !== '',
              onChange: (event) => act({ action: 'langs.set', [key]: event.target.value }, `langs:${key}`),
            }, langOptions.map(([value, text]) => h('option', { key: value, value }, text))),
          );
          return card(
            '语种',
            langRow('语音语种', 'speech'),
            langRow('字幕语种', 'subtitle'),
            h('div', { style: styles.hint }, langs.speech === langs.subtitle
              ? '两者一致：按普通文本输出即可，不必为了字幕调用工具。'
              : '两者不同：agent 会把语音文本放进 text、字幕文本放进 subtitle 调用 assistant_say。'),
          );
        })(),

        card(
          '语音合成',
          h('div', { style: { ...styles.hint, marginTop: 0, marginBottom: 6 } }, '更好的音色：支持 GPT-SoVITS 可运行模型'),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '语音播报'),
            h('button', {
              style: { ...(status.tts?.playbackEnabled !== false ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
              disabled: busy !== '',
              onClick: () => act({ action: 'voice.playback', enabled: status.tts?.playbackEnabled === false }, 'voice-playback'),
            }, status.tts?.playbackEnabled !== false ? '已开启' : '已关闭')),
          h('div', { style: styles.hint }, '「语音合成」是父组件：关闭它会先停播报，再关 GPT 音色并释放插件启动的 GPT-SoVITS；只关 GPT 音色不会关闭播报或组件。'),
          ackDelayRow(h, {
            draft: ackDelayDraft,
            saved: Number(status.voiceAckDelayMs ?? 3000),
            busy,
            onDraft: setAckDelayDraft,
            onSave: async (ms) => {
              const result = await act({ action: 'voice.ack.delay', ms }, 'ack-delay');
              if (result.ok) show(`候音等待已设为 ${result.ackDelayMs} ms`);
              return result;
            },
            onInvalid: (message) => show(message),
          }),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '使用 GPT-SoVITS 音色'),
            h('button', {
              style: { ...(gptSovits.enabled ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
              disabled: busy !== '',
              onClick: () => act({ action: 'tts.config', enabled: !gptSovits.enabled }, 'tts-enabled'),
            }, gptSovits.enabled ? '已开启' : '已关闭')),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, 'API 地址'),
            h('input', {
              style: styles.input,
              value: ttsValue('apiBase'),
              placeholder: 'http://127.0.0.1:9880',
              onChange: (event) => setTtsDraft({ ...(ttsDraft ?? {}), apiBase: event.target.value }),
              onBlur: () => void commitTtsField('apiBase'),
            })),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, '参考音频路径'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: ttsValue('refAudioPath'),
                placeholder: 'D:\\voice\\reference.wav',
                onChange: (event) => setTtsDraft({ ...(ttsDraft ?? {}), refAudioPath: event.target.value }),
                onBlur: () => void commitTtsField('refAudioPath'),
              }),
              h('button', {
                style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                disabled: busy !== '',
                onClick: () => void pickRefAudio(),
              }, '浏览…'))),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, '参考文本'),
            h('input', {
              style: styles.input,
              value: ttsValue('promptText'),
              placeholder: '参考音频里说的那句话',
              onChange: (event) => setTtsDraft({ ...(ttsDraft ?? {}), promptText: event.target.value }),
              onBlur: () => void commitTtsField('promptText'),
            })),
          ttsLangRow('textLang', '输出语种（text_lang）'),
          ttsLangRow('promptLang', '参考语种（prompt_lang）'),
          h('div', { style: styles.hint }, ttsDiag),
          h('div', { style: styles.label }, '模型（可选）'),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, 'GPT 模型（GPT_weights）'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: ttsModelValue('gptModelPath'),
                placeholder: 'D:\\GPT-SoVITS\\GPT_weights\\myvoice.ckpt',
                onChange: (event) => setTtsDraft({ ...(ttsDraft ?? {}), gptModelPath: event.target.value }),
                onBlur: () => void commitTtsModel('gptModelPath'),
              }),
              h('button', {
                style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                disabled: busy !== '',
                onClick: () => void pickTtsModel('gptModelPath'),
              }, '浏览…'))),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, 'SoVITS 模型（SoVITS_weights）'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: ttsModelValue('sovitsModelPath'),
                placeholder: 'D:\\GPT-SoVITS\\SoVITS_weights\\myvoice.pth',
                onChange: (event) => setTtsDraft({ ...(ttsDraft ?? {}), sovitsModelPath: event.target.value }),
                onBlur: () => void commitTtsModel('sovitsModelPath'),
              }),
              h('button', {
                style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                disabled: busy !== '',
                onClick: () => void pickTtsModel('sovitsModelPath'),
              }, '浏览…'))),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, '应用模型'),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('button', {
                style: { ...styles.btnPrimary, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                disabled: busy !== '',
                onClick: () => void applyModels(),
              }, busy === 'tts-apply' ? '加载中…' : '应用模型'),
              h('span', {
                style: { ...styles.value, ...(applyState.dangerous ? { color: DANGER } : {}) },
              }, applyState.text))),
          h('div', { style: styles.hint }, '会先等待当前句结束，最多 3 秒；超时后将打断播报。'),
          h('div', { style: styles.hint }, '留空则用参考音频零样本推理；填好路径后点「应用模型」加载，接口不可用时只保存路径（需在 GPT-SoVITS 端加载）。'),
          h('div', { style: styles.row },
            h('a', {
              href: 'https://github.com/RVC-Boss/GPT-SoVITS',
              target: '_blank',
              rel: 'noreferrer',
              style: { ...styles.btn, textDecoration: 'none', display: 'inline-block' },
            }, '官方使用说明'),
            // 链接后续替换：先用 B 站搜索结果占位，等有确定的教程地址再换成直链。
            h('a', {
              href: 'https://search.bilibili.com/all?keyword=GPT-SoVITS%20%E8%AE%AD%E7%BB%83',
              target: '_blank',
              rel: 'noreferrer',
              style: { ...styles.btn, textDecoration: 'none', display: 'inline-block' },
            }, 'B站教程')),
        ),

        (() => {
          // 环境声音：系统音频单独走一条 ASR，只进上下文，不触发回复。
          const loopbacks = status.loopbackDevices ?? [];
          const ambientOn = status.ambient?.running === true;
          const deferred = status.ambient?.deferred;
          const deferredSuffix = deferred?.reason ? `（${deferred.reason}）` : '';
          const missing = loopbacks.length === 0;
          return card(
            '环境声音',
            line('状态', ambientOn ? `采集中 · ${status.ambient.device}` : `未启动${deferredSuffix}`),
            ambientRecentRow(h, {
              recent: status.ambient?.recent ?? [],
              expanded: expandedAmbient,
              onToggle: setExpandedAmbient,
            }),
            h('div', { style: styles.field },
              h('span', { style: styles.value }, '回环设备'),
              h('select', {
                style: styles.input,
                value: loopbacks[0] ?? '',
                disabled: ambientOn || busy !== '' || missing,
                onChange: (event) => act({ action: 'ambient.start', device: event.target.value }),
              },
                missing
                  ? h('option', { value: '' }, '（未检测到回环设备）')
                  : loopbacks.map((device) => h('option', { key: device, value: device }, device)),
              ),
            ),
            h('div', { style: styles.row },
              h('button', {
                style: { ...(ambientOn ? styles.btnActive : styles.btnPrimary), ...(ambientOn || busy !== '' || missing ? styles.off : {}) },
                disabled: ambientOn || busy !== '' || missing,
                onClick: () => act({ action: 'ambient.start' }),
              }, '开始采集'),
              h('button', {
                style: { ...styles.btn, ...(!ambientOn || busy !== '' ? styles.off : {}) },
                disabled: !ambientOn || busy !== '',
                onClick: () => act({ action: 'ambient.stop' }),
              }, '停止'),
            ),
            h('div', { style: styles.hint }, feature('ambient')
              ? '关闭「环境声音」组件会先停回环采集，再关开关。'
              : '「环境声音」组件当前关闭：点「开始采集」会先启用组件，再开始采集。'),
            h('div', { style: styles.row },
              h('span', { style: styles.value }, '开机自动采集（默认关闭；只授权，不在打开组件时立即采集）'),
              h('button', {
                style: { ...(status.ambient?.autoListen ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: () => act({ action: 'ambient.autoListen', enabled: status.ambient?.autoListen !== true }, 'ambient-autoListen'),
              }, status.ambient?.autoListen ? '已开启' : '已关闭')),
            h('div', { style: styles.hint }, missing
              ? '需要虚拟声卡：装 VB-Cable 后会出现「CABLE Output」；或在声音设置里启用「立体声混音」。'
              : '电脑声音只作为上下文，不会触发回复。OBS 里把「监视设备」设为 CABLE Input 即可接入。'),
          );
        })(),

        (() => {
          // 记忆：容量条 + 清晰度分布 + 归档管理（归档不进检索，可手动删）。
          const mem = status.memory ?? {};
          const usage = mem.usage ?? { records: 0, capacity: 5000, ratio: 0, archived: 0 };
          const clarity = mem.clarity ?? {};
          const auto = mem.auto ?? { enabled: true, minChars: 1, maxChars: 400, includeReply: true };
          const pct = Math.round((usage.ratio ?? 0) * 100);
          const barColor = pct >= 90 ? '#dc2626' : pct >= 60 ? '#d98324' : '#2f9e44';
          return card(
            '记忆',
            line('容量', `${usage.records} / ${usage.capacity} 条（${pct}%）`),
            h('div', { style: { height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', margin: '4px 0 8px' } },
              h('div', { style: { height: '100%', width: `${Math.min(100, pct)}%`, background: barColor } }),
            ),
            line('清晰度', `清晰 ${clarity.vivid ?? 0} · 清楚 ${clarity.clear ?? 0} · 模糊 ${clarity.fuzzy ?? 0} · 印象 ${clarity.trace ?? 0}`),
            line('自动记忆', auto.enabled === false
              ? '关（只保留手动提炼）'
              : `开（≥${auto.minChars ?? 1} 字全量入库，展示单条 ≤${auto.maxChars ?? 400} 字，${auto.includeReply === false ? '只记用户原话' : '原话与回复都记'}）`),
            line('归档', `${usage.archived ?? 0} 条（不参与检索，可手动删除）`),
            h('div', { style: styles.row },
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'memory.auto', auto: { enabled: auto.enabled === false } }),
              }, auto.enabled === false ? '开启自动记忆' : '关闭自动记忆'),
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'memory.maintain' }),
              }, '记忆整理'),
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'memory.compact' }),
              }, '遗忘归档'),
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: async () => {
                  await loadArchive();
                  setArchiveOpen(true);
                },
              }, '查看归档'),
            ),
          );
        })(),

        (() => {
          // 人设库：记忆卡片的子容器，位置紧随记忆卡片之后。用户只编辑两段文本，分类由宿主拆分填写。
          // 「分类管理」：列表在展开时加载；改名/合并/删除后刷新列表，act() 已顺带刷新容量。
          const categoryList = async () => {
            const listed = await act({ action: 'profile.category.list' }, 'profile-category');
            const ok = listed?.ok === true;
            setProfileCategory((current) => ({
              ...(current ?? {}),
              open: true,
              busy: '',
              rows: ok && Array.isArray(listed.categories) ? listed.categories : (current?.rows ?? null),
              error: ok ? '' : profileCategoryErrorText(listed),
              note: '',
            }));
          };
          const categoryOp = async (op, body = {}) => {
            if (profileCategoryLock.current) return;
            profileCategoryLock.current = true;
            setProfileCategory((current) => ({ ...(current ?? {}), open: true, busy: op, error: '', note: '' }));
            try {
              const result = await act({ action: `profile.category.${op}`, ...body }, 'profile-category');
              const listed = await act({ action: 'profile.category.list' }, 'profile-category');
              setProfileCategory((current) => profileCategoryResultState(current, result, listed, op));
            } catch (cause) {
              setProfileCategory((current) => ({ ...(current ?? {}), busy: '', error: cause?.message ?? String(cause) }));
            } finally {
              profileCategoryLock.current = false;
            }
          };
          const toggleCategory = async () => {
            if (profileCategoryLock.current) return;
            if (profileCategory?.open === true) {
              setProfileCategory((current) => ({ ...(current ?? {}), open: false, error: '', editing: null, merging: null }));
              return;
            }
            profileCategoryLock.current = true;
            setProfileCategory((current) => ({ ...(current ?? {}), open: true, busy: 'list', error: '', note: '' }));
            try {
              await categoryList();
            } catch (cause) {
              setProfileCategory((current) => ({ ...(current ?? {}), busy: '', error: cause?.message ?? String(cause) }));
            } finally {
              profileCategoryLock.current = false;
            }
          };
          const editCategory = (patch) => setProfileCategory((current) => ({ ...(current ?? {}), ...patch }));
          // 「库编辑」：条目列表只在按钮打开时加载；每条编辑/换分类/删除后重读列表与分类栈。
          const libraryList = async () => {
            const listed = await act({ action: 'profile.entry.list' }, 'profile-entry');
            const cats = await act({ action: 'profile.category.list' }, 'profile-category');
            const ok = listed?.ok === true;
            setProfileLibrary((current) => ({
              ...(current ?? {}),
              open: true,
              busy: '',
              rows: ok && Array.isArray(listed.entries) ? listed.entries : (current?.rows ?? []),
              categories: cats?.ok === true && Array.isArray(cats.categories)
                ? cats.categories
                : (current?.categories ?? []),
              drafts: {},
              picker: '',
              confirmDelete: '',
              error: ok ? '' : profileLibraryErrorText(listed),
              note: '',
            }));
          };
          const toggleLibrary = async () => {
            if (profileLibraryLock.current) return;
            if (profileLibrary?.open === true) {
              setProfileLibrary((current) => ({ ...(current ?? {}), open: false, picker: '', confirmDelete: '', error: '' }));
              return;
            }
            profileLibraryLock.current = true;
            setProfileLibrary((current) => ({ ...(current ?? {}), open: true, busy: 'list', error: '', note: '' }));
            try {
              await libraryList();
            } catch (cause) {
              setProfileLibrary((current) => ({ ...(current ?? {}), busy: '', error: cause?.message ?? String(cause) }));
            } finally {
              profileLibraryLock.current = false;
            }
          };
          const libraryEntryOp = async (body, tag, note) => {
            if (profileLibraryLock.current) return;
            profileLibraryLock.current = true;
            setProfileLibrary((current) => ({ ...(current ?? {}), busy: tag, error: '', note: '' }));
            try {
              const result = await act(body, 'profile-entry');
              await libraryList();
              setProfileLibrary((current) => ({
                ...(current ?? {}),
                busy: '',
                error: result?.ok === true ? '' : profileLibraryErrorText(result),
                note: result?.ok === true ? note : '',
              }));
            } catch (cause) {
              setProfileLibrary((current) => ({ ...(current ?? {}), busy: '', error: cause?.message ?? String(cause) }));
            } finally {
              profileLibraryLock.current = false;
            }
          };
          return profileSettingsBody(h, {
            profile: status.profile ?? {},
            busy,
            maintain: profileMaintain,
            draft: profileDraft,
            reclassify: profileReclassify,
            library: profileLibrary,
            category: profileCategory,
            quiz: profileQuiz,
          }, {
            maintainNow: async () => {
              // 双保险：服务端只允许一个任务；客户端在请求返回前也不接受第二次点击。
              if (profileMaintainLock.current) return;
              profileMaintainLock.current = true;
              setProfileMaintain({ running: true, queued: false });
              try {
                const text = { ...profileTexts(status.profile ?? {}), ...(profileDraft ?? {}) };
                const result = await profileMaintainNow(act, text);
                setProfileMaintain(profileMaintainState(result));
                // 整理结束会把 agent 重写后的提示词写回文本框：丢掉本地草稿才能看到写回结果。
                if (result?.ok === true) setProfileDraft(null);
              } catch (cause) {
                // 网络层异常同样必须复位，不能让按钮永久停在「正在整理…」。
                setProfileMaintain({ running: false, queued: false, error: cause?.message ?? String(cause) });
              } finally {
                profileMaintainLock.current = false;
              }
            },
            cancelMaintain: async () => {
              const taskId = profileMaintain?.taskId;
              if (typeof taskId !== 'string' || taskId.length === 0) return;
              setProfileMaintain((current) => ({ ...(current ?? {}), running: true, queued: true, taskId, note: '正在取消…' }));
              try {
                const result = await act({ action: 'profile.maintain.cancel', taskId }, 'profile-maintain');
                setProfileMaintain(result?.ok === false
                  ? { running: false, queued: false, error: String(result.error ?? '取消失败') }
                  : { running: false, queued: false, note: '已取消' });
              } catch (cause) {
                setProfileMaintain({ running: false, queued: false, error: cause?.message ?? String(cause) });
              }
            },
            setAutoMaintain: (on) => void act(profileAutoBody(on), 'profile-auto'),
            setText: (field, value) => setProfileDraft((current) => ({
              ...profileTexts(status.profile ?? {}),
              ...(current ?? {}),
              [field]: value,
            })),
            saveText: async () => {
              const text = { ...profileTexts(status.profile ?? {}), ...(profileDraft ?? {}) };
              // 试用期间只更新当前注入的人设，不拆分、不入库；正式采用走「正式采用」按钮。
              if (status.profile?.trial?.active === true) {
                const edited = await act({ action: 'persona.quiz.edit', text: text.agent }, 'persona-quiz');
                if (edited?.ok === true) {
                  setProfileDraft(null);
                  show('已保存试用文本（尚未写入人设库）');
                }
                return;
              }
              const result = await profileSaveText(act, text, show);
              setProfileMaintain(profileSaveState(result));
              // act() already reloaded status: dropping the draft reveals the newly persisted text.
              if (result?.ok === true) setProfileDraft(null);
            },
            previewReclassify: async () => {
              if (profileReclassifyLock.current) return;
              profileReclassifyLock.current = true;
              setProfileReclassify({
                open: false, busy: 'preview', items: [], choices: {}, version: null, error: '', note: '',
              });
              try {
                const result = await act({ action: 'profile.reclassify.preview' }, 'profile-reclassify');
                setProfileReclassify(profileReclassifyPreviewState(result));
              } catch (cause) {
                setProfileReclassify({
                  open: false, busy: '', items: [], choices: {}, version: null, error: cause?.message ?? String(cause), note: '',
                });
              } finally {
                profileReclassifyLock.current = false;
              }
            },
            setReclassifyChoice: (entryId, choice) => setProfileReclassify((current) => {
              if (current?.open !== true || typeof entryId !== 'string') return current;
              return { ...current, choices: { ...(current.choices ?? {}), [entryId]: String(choice) } };
            }),
            applyReclassify: async () => {
              if (profileReclassifyLock.current) return;
              if (profileReclassify?.open !== true) return;
              const items = Array.isArray(profileReclassify.items) ? profileReclassify.items : [];
              let moves = [];
              let deletes = [];
              if (items.length > 0) {
                ({ moves, deletes } = reclassifyMovesAndDeletes(items, profileReclassify.choices ?? {}));
              } else {
                const changes = Array.isArray(profileReclassify.changes) ? profileReclassify.changes : [];
                moves = changes
                  .filter((change) => change?.entryId && change?.to?.side && change?.to?.category)
                  .map((change) => ({
                    id: change.entryId,
                    side: change.to.side,
                    category: change.to.category,
                  }));
              }
              if (moves.length === 0 && deletes.length === 0) return;
              profileReclassifyLock.current = true;
              setProfileReclassify((current) => ({ ...(current ?? {}), busy: 'apply', error: '', note: '' }));
              try {
                const result = await act({
                  action: 'profile.reclassify.apply',
                  moves,
                  deletes,
                  version: profileReclassify.version ?? null,
                }, 'profile-reclassify');
                setProfileReclassify(profileReclassifyApplyState(result));
              } catch (cause) {
                setProfileReclassify({
                  open: false, busy: '', items: [], choices: {}, version: null, error: cause?.message ?? String(cause), note: '',
                });
              } finally {
                profileReclassifyLock.current = false;
              }
            },
            cancelReclassify: () => {
              if (profileReclassifyLock.current) return;
              setProfileReclassify(null);
            },
            openLibrary: () => void toggleLibrary(),
            setLibraryText: (id, value) => setProfileLibrary((current) => ({
              ...(current ?? {}),
              drafts: { ...(current?.drafts ?? {}), [String(id)]: String(value) },
            })),
            saveLibraryText: (id) => {
              const row = (profileLibrary?.rows ?? []).find((item) => item.id === id);
              const text = profileLibrary?.drafts?.[id] !== undefined
                ? String(profileLibrary.drafts[id])
                : String(row?.text ?? '');
              if (row === undefined || text === String(row.text)) return;
              void libraryEntryOp({ action: 'profile.entry.update', id, text }, 'save', '已保存条目内容（文本框未改）');
            },
            toggleLibraryPicker: (id) => setProfileLibrary((current) => ({
              ...(current ?? {}),
              picker: current?.picker === id ? '' : String(id),
              confirmDelete: '',
            })),
            closeLibraryPicker: () => setProfileLibrary((current) => ({ ...(current ?? {}), picker: '' })),
            chooseLibraryCategory: (id, category) => {
              const row = (profileLibrary?.rows ?? []).find((item) => item.id === id);
              if (row === undefined) return;
              // Clicking the current category is explicitly a no-op (点当前项=不改).
              if (profileCategoryKey(row.category) === profileCategoryKey(category)) {
                setProfileLibrary((current) => ({ ...(current ?? {}), picker: '' }));
                return;
              }
              void libraryEntryOp(
                { action: 'profile.entry.setCategory', id, category: String(category) },
                'category',
                '已换分类（跨父级时 side 一起换）',
              );
            },
            requestDeleteLibraryEntry: (id) => setProfileLibrary((current) => ({
              ...(current ?? {}), confirmDelete: String(id), picker: '',
            })),
            cancelDeleteLibraryEntry: () => setProfileLibrary((current) => ({ ...(current ?? {}), confirmDelete: '' })),
            confirmDeleteLibraryEntry: (id) => void libraryEntryOp(
              { action: 'profile.entry.delete', id },
              'delete',
              '已删除条目',
            ),
            toggleCategory: () => void toggleCategory(),
            startCategoryRename: (name) => editCategory({
              open: true, error: '', note: '', editing: { name: String(name), value: String(name) }, merging: null,
            }),
            setCategoryName: (value) => editCategory({
              editing: { ...(profileCategory?.editing ?? {}), value: String(value) },
            }),
            startCategoryMerge: (name) => editCategory({
              open: true, error: '', note: '', merging: { name: String(name), into: '' }, editing: null,
            }),
            setCategoryTarget: (into) => editCategory({
              merging: { ...(profileCategory?.merging ?? {}), into: String(into) },
            }),
            cancelCategoryEdit: () => editCategory({ editing: null, merging: null, error: '' }),
            submitCategoryRename: (name) => void categoryOp('rename', {
              name, next: String(profileCategory?.editing?.value ?? ''),
            }),
            submitCategoryMerge: (name) => void categoryOp('merge', {
              from: name, into: String(profileCategory?.merging?.into ?? ''),
            }),
            submitCategoryDelete: (name) => void categoryOp('delete', { name }),
            setCategoryCreateName: (value) => editCategory({ createName: String(value) }),
            setCategoryCreateParent: (parent) => editCategory({ createParent: parent === 'user' ? 'user' : 'agent' }),
            submitCategoryCreate: () => void categoryOp('create', {
              name: String(profileCategory?.createName ?? ''),
              parent: profileCategory?.createParent === 'user' ? 'user' : 'agent',
            }),
            openQuiz: () => void openProfileQuiz(),
            setQuizAnswer,
            setQuizDraft,
            generateQuiz: () => void generateProfileQuiz(),
            applyTrial: () => void applyProfileQuizTrial(),
            adoptTrial: () => void adoptProfileQuizTrial(),
            discardTrial: () => void discardProfileQuizTrial(),
            closeQuiz: closeProfileQuiz,
          });
        })(),

        (() => {
          // 两种观看来源共用一套采集能力：桌面（ffmpeg ddagrab）与 OBS 场景（虚拟摄像头）。
          // 隐私是插件侧锁：停两种来源、清空预览，但不再切 OBS 隐私场景。
          const vm = status.vision ?? {};
          const mode = vm.mode ?? 'watch';
          const locked = vm.locked === true || mode === 'privacy';
          const source = vm.source ?? (mode === 'scene' ? 'obs' : 'desktop');
          const scenes = vm.scenes ?? [];
          const capturing = vm.capturing === true;
          const busyNow = busy !== '';
          const visionHotkey = (status.hotkeys ?? []).find((entry) => entry.action === 'vision')?.combo ?? 'Ctrl+Alt+V';
          const lastCaptureAt = Number(vm.lastCaptureAt) || 0;
          const lastCaptureText = lastCaptureAt > 0 ? new Date(lastCaptureAt).toLocaleTimeString() : '—';
          const sourceLabel = source === 'obs' ? `OBS 场景「${vm.scene || '未指定'}」` : '桌面';
          const modeLabel = locked
            ? '隐私模式（锁定）'
            : capturing
              ? `持续观看 · ${sourceLabel}`
              : source === 'obs' ? `OBS 场景观看 ·「${vm.scene || '未指定'}」` : '桌面观看';
          // No local state: the select value is the source the Host actually has.
          const sourceValue = source === 'obs' ? (vm.scene || '__obs__') : '__desktop__';
          return card(
            '视觉与隐私',
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '当前视觉来源'),
              h('span', {
                style: {
                  ...styles.badge,
                  ...(locked
                    ? { borderColor: DANGER, color: DANGER, fontWeight: 600 }
                    : source === 'obs'
                      ? { borderColor: ACCENT, color: ACCENT, fontWeight: 600 }
                      : {}),
                },
              }, modeLabel),
            ),
            line('观看来源', locked
              ? '已暂停（桌面与 OBS 采集均已停止）'
              : source === 'obs'
                ? `${sourceLabel}（虚拟摄像头）`
                : '桌面（ffmpeg ddagrab，不经 OBS）'),
            line('持续观看', capturing
              ? `采集中 · 最近取景 ${lastCaptureText}`
              : vm.lastCaptureAt ? `未启动 · 最近取景 ${lastCaptureText}` : '未启动'),
            line('虚拟摄像头', vm.virtualCam
              ? capturing ? '运行中（持续观看占用）' : `运行中 · 空闲 ${vm.idleSeconds ?? 0} 秒后自动停止`
              : '已停止（取景时按需启动；用户自启的不会关闭）'),
            line('OBS 进程', vm.obsRunning ? '运行中' : '未运行 / 未连接'),
            line('OBS 场景', status.obsScene || '未连接 / 未知'),
            h('div', { style: styles.field },
              h('span', { style: styles.value }, '选择观看来源'),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('select', {
                  style: styles.input,
                  value: sourceValue,
                  disabled: busyNow || locked,
                  onChange: (event) => {
                    const value = event.target.value;
                    if (value === '__desktop__') void act({ action: 'vision.mode', mode: 'watch' }, 'vision');
                    else void act({ action: 'vision.mode', mode: 'scene', scene: value }, 'vision');
                  },
                },
                  h('option', { value: '__desktop__' }, '桌面（屏幕）'),
                  scenes.map((name) => h('option', { key: name, value: name }, name)),
                  !locked && source === 'obs' && vm.scene && !scenes.includes(vm.scene)
                    ? h('option', { key: '__current', value: vm.scene }, `${vm.scene}（当前）`)
                    : null,
                ),
                h('button', {
                  style: styles.btn,
                  disabled: busyNow,
                  onClick: () => act({ action: 'vision.scenes' }, 'vision-scenes'),
                }, '刷新场景'),
              ),
            ),
            h('div', { style: styles.row },
              h('button', {
                style: { ...(capturing ? styles.btnActive : styles.btnPrimary), ...(busyNow ? styles.off : {}) },
                disabled: busyNow || locked,
                onClick: async () => {
                  const result = capturing
                    ? await act({ action: 'vision.watch.stop' }, 'vision-watch')
                    : await act({ action: 'vision.watch.start', source, scene: vm.scene || '' }, 'vision-watch');
                  if (result.ok) show(capturing ? '已停止持续观看' : '已开始持续观看');
                },
              }, capturing ? '停止持续观看' : '启动持续观看'),
              h('button', {
                style: { ...styles.btn, ...(busyNow ? styles.off : {}) },
                disabled: busyNow,
                onClick: async () => {
                  const result = await act({ action: 'vision.snapshot' }, 'snapshot');
                  if (result.ok) show('已截图，可在 cache/screens 查看');
                },
              }, '截图测试'),
              h('button', {
                // Escape hatch: never gate this on the vision feature, or privacy could trap the user.
                style: { ...(locked ? styles.btnActive : styles.btnPrimary), ...(busyNow ? styles.off : {}) },
                disabled: busyNow,
                onClick: () => act({ action: 'privacy.toggle' }, 'privacy'),
              }, locked ? '退出隐私模式' : '切换隐私模式'),
            ),
            vm.lastShot
              ? h('div', { style: { marginTop: 8 } },
                  h('span', { style: styles.value }, `最近取景：${vm.lastShot.source === 'scene' ? `OBS 场景「${vm.lastShot.scene || '—'}」` : '桌面'} · ${vm.lastShot.width}×${vm.lastShot.height}`),
                  h('img', {
                    src: `/assistant/shot?path=${encodeURIComponent(vm.lastShot.file)}&t=${vm.lastShot.ts}`,
                    alt: '最近取景',
                    style: {
                      display: 'block', marginTop: 6, maxWidth: '100%', maxHeight: 200,
                      borderRadius: 8, border: `1px solid ${BORDER}`, background: '#000',
                    },
                  }),
                )
              : h('div', { style: styles.hint }, '还没有取景；点「截图测试」拍一张。'),
            h('div', { style: styles.hint }, locked
              ? `隐私模式已锁定：桌面与 OBS 采集均已停止，agent 不能截图或切出；你可以按 ${visionHotkey} 或点上面的按钮退出。`
              : source === 'obs'
                ? 'OBS 场景观看：持续采集选定场景，按需把变化帧打包成一张故事板交付；切换场景会清空旧帧并重新采集。'
                : '桌面观看：ffmpeg ddagrab 持续采集桌面，不依赖 OBS；可随时切换来源或隐私。'),
            h('div', { style: styles.hint }, feature('vision')
              ? '视觉 ↔ OBS：选择 OBS 来源时按需启动 OBS；虚拟摄像头只按归属释放（插件启动的会停，用户自己启动的保留）。'
              : '「视觉」组件当前关闭：点截图或启动观看会先启用组件；桌面观看不会因此启动 OBS。'),
          );
        })(),

        (() => {
          // 形象：VTS 连接、模型、热键、表情。
          const l = status.live2d ?? {};
          const ready = l.ready === true;
          const socketOpen = l.socketOpen === true;
          const hotkeys = l.hotkeys ?? [];
          const expressions = l.expressions ?? [];
          return card(
            '形象',
            line('VTS', ready
              ? `已连接 · ${l.model || '未知模型'}`
              : socketOpen
                ? 'WebSocket 已打开，但认证未完成（未就绪）'
                : '未连接（VTube Studio 需开启 API 8001）'),
            (() => {
              // 订阅状态单独一行：服务器拒绝订阅时连接仍可用，用提示色把原因显示出来；
              // 订阅成功时只显示状态，不再显示 subscriptionError。
              const subscribed = l.eventsSubscribed === true;
              const subscriptionError = String(l.subscriptionError ?? '');
              const failed = !subscribed && ready && subscriptionError.length > 0;
              return h('div', { style: styles.row },
                h('span', { style: styles.label }, '订阅'),
                h('span', {
                  style: failed ? { fontSize: 13, color: DANGER } : styles.value,
                }, subscribed
                  ? 'ModelLoadedEvent 已订阅'
                  : failed
                    ? `失败：${subscriptionError}`
                    : ready
                      ? '未订阅'
                      : '—'),
              );
            })(),
            line('热键', hotkeys.length > 0 ? `${hotkeys.length} 个` : '—'),
            h('div', { style: styles.row },
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'live2d.connect' }, 'live2d'),
              }, ready ? '重新连接' : '连接 VTS'),
              // 唯一的测试入口：触发当前模型的第一个热键，验证 VTS 连接与热键通道。
              h('button', {
                style: { ...styles.btn, ...(busy !== '' || hotkeys.length === 0 ? styles.off : {}) },
                disabled: busy !== '' || hotkeys.length === 0,
                // 无可触发热键时按钮置灰；只用 title 给原因，不占卡片版面。
                title: hotkeys.length === 0 ? '无可用热键' : undefined,
                onClick: async () => {
                  const result = await act({ action: 'live2d.hotkey', name: hotkeys[0] }, 'live2d');
                  if (result.ok) show(`已触发：${result.name ?? hotkeys[0]}`);
                },
              }, '测试连接'),
            ),
            expressions.length > 0
              ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' } },
                  expressions.map((name) => h('button', {
                    key: name,
                    style: styles.btn,
                    disabled: busy !== '',
                    onClick: () => act({ action: 'live2d.expression', name }, 'live2d'),
                  }, `表情：${name}`)))
              : null,
            h('div', { style: styles.hint }, '说话时自动口型；点「测试连接」触发当前模型的第一个热键。'),
            (() => {
              // 能力发现：VTS 注入的是输入参数。这里把两个问题分开显示：
              //   可注入 = 这个名字存在于 InputParameterListRequest，值能发出去；
              //   已验证 = 有证据它确实驱动该部位（用户显式映射，或模型参数列表里有对应目标）。
              const caps = l.capabilities ?? null;
              const groups = [
                { label: '视线', channels: ['gazeX', 'gazeY'] },
                { label: '头', channels: ['headX', 'headY', 'headZ'] },
                { label: '眼', channels: ['eyeOpenL', 'eyeOpenR'] },
                { label: '眉', channels: ['browL', 'browR'] },
                { label: '口', channels: ['mouth'] },
                { label: '身体', channels: ['bodyX', 'breath'] },
              ];
              const inputs = caps?.inputs ?? {};
              const injectableSet = new Set(Array.isArray(caps?.mapped) ? caps.mapped : []);
              const verifiedSet = new Set(Array.isArray(caps?.verified) ? caps.verified : []);
              const nameOf = (channel) => inputs[channel]?.inputName ?? inputs[channel]?.name ?? channel;
              // 每个通道单独一行；两栏并排各占一半，窄屏（flexWrap）自动换行堆叠；
              // 通道较多（>6）时该栏限制高度并滚动，避免卡片无限变高。
              const rowsOf = (set) => groups.flatMap((group) => group.channels
                .filter((channel) => set.has(channel))
                .map((channel) => ({ key: channel, group: group.label, name: nameOf(channel) })));
              const columnOf = (label, rows, emptyText) => h('div', {
                style: { flex: '1 1 0', minWidth: 220, minHeight: 0 },
              },
                h('div', { style: styles.label }, `${label}（${rows.length}）`),
                rows.length > 0
                  ? h('div', {
                      style: {
                        marginTop: 4,
                        paddingLeft: 2,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        ...(rows.length > 6 ? { maxHeight: 160, overflowY: 'auto' } : {}),
                      },
                    }, rows.map((row) => h('div', { key: row.key, style: styles.value },
                      h('span', { style: { marginRight: 6 } }, '·'),
                      `${row.group} ${row.name}`)))
                  : h('div', { style: styles.hint }, emptyText),
              );
              const discovered = caps !== null && caps.discovered === true;
              const injectableRows = rowsOf(injectableSet);
              const verifiedRows = rowsOf(verifiedSet);
              const transport = l.transport ?? {};
              const hz = Number(transport.computedHz ?? 0);
              const dropped = Number(transport.dropped ?? 0);
              const sent = Number(transport.sent ?? 0);
              return h('div', { style: { marginTop: 10 } },
                h('div', {
                  style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 12, marginTop: 8 },
                },
                  discovered
                    ? columnOf('可注入', injectableRows, '无（名字匹配只是候选）')
                    : h('div', { style: { flex: '1 1 0', minWidth: 220 } },
                        h('div', { style: styles.label }, '可注入'),
                        h('div', { style: styles.hint }, '尚未探测')),
                  discovered ? columnOf('已验证', verifiedRows, '无（名字匹配只是候选）') : null,
                ),
                h('div', { style: styles.hint }, `实时帧：${hz.toFixed(1)} Hz · 已发 ${sent} · 丢弃 ${dropped}${caps?.live === false ? '（VTS 离线，显示上次结果）' : ''}`),
                h('div', { style: styles.row },
                  h('button', {
                    style: { ...styles.btn, ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: async () => {
                      const result = await act({ action: 'avatar.capabilities.refresh' }, 'avatar-capabilities');
                      if (result.ok) {
                        const injectable = Array.isArray(result.mapped) ? result.mapped.length : 0;
                        const verified = Array.isArray(result.verified) ? result.verified.length : 0;
                        show(`已探测 ${injectable} 个可注入通道，${verified} 个已验证`);
                      }
                    },
                  }, '重新探测'),
                  h('span', { style: styles.hint }, caps?.error ? `探测失败：${caps.error}` : ''),
                ),
                h('div', { style: styles.hint }, '「可注入」只说明值能发出去；「已验证」才说明有证据它驱动该部位。模型是否响应取决于 VTS 内的参数映射。'),
              );
            })(),
            (() => {
              const backendLayer = status.layer ?? {};
              const layer = {
                running: backendLayer.running === true,
                editMode: backendLayer.editMode === true,
                adjusting: backendLayer.editMode === true,
                geometry: backendLayer.backend === 'spout'
                  ? null
                  : status.avatarLayer?.geometry,
              };
              const geo = layer.geometry;
              return h('div', { style: { marginTop: 8 } },
                line('桌面悬浮', layer.running
                  ? `${layer.editMode ? '编辑中（可拖动/滚轮缩放）' : '运行中'} · ${geo ? `${geo.width}×${geo.height} @ ${geo.left},${geo.top}` : ''}`
                  : '未启动'),
                h('div', { style: styles.row },
                  h('button', {
                    style: layer.adjusting ? styles.btnActive : styles.btnPrimary,
                    disabled: busy !== '',
                    onClick: () => act({
                      action: layer.adjusting ? 'layer.edit.exit' : 'layer.edit.enter',
                    }, 'avatarLayer'),
                  }, layer.adjusting ? '完成编辑' : '编辑模式'),
                ),
                h('div', { style: styles.hint }, layer.adjusting
                  ? 'VTS 窗口已回到屏幕：像普通窗口一样拖动/拉边框；点「完成编辑」保存并恢复悬浮。'
                  : layer.running
                    ? '悬浮中；按钮与 Ctrl+Alt+E 都会停止当前显示层，调出 VTS 编辑；完成后在原位置恢复显示。'
                    : '先开启桌面悬浮，再点「编辑模式」或按 Ctrl+Alt+E 调整。'),
              );
            })(),
            (() => {
              // 透明化（原「Spout（实验）」位置）：WPF / Spout 单层互斥。模式来自
              // status.layer.backend（缺省 wpf），下方只渲染当前后端自己的设置。
              const lay = status.layer ?? {};
              const tp = status.transparent ?? {};
              const sp = lay.spout ?? l.spoutLayer ?? {};
              const draft = layerDraft ?? {
                left: tp.left ?? 1600,
                top: tp.top ?? 300,
                width: tp.width ?? 420,
                height: tp.height ?? 760,
              };
              const draftPath = String(spoutDraft ?? sp.electronExecutable ?? '').trim();
              return layerSettingsBody(h, {
                layer: lay,
                spout: sp,
                transparent: tp,
                busy,
                spoutDraft,
                draft,
              }, {
                // 切换由宿主串行执行：可用性检查 → 停旧后端并确认退出 → 启新后端。
                switchBackend: (backend) => {
                  void act({ action: 'layer.backend', backend, electronExecutable: draftPath }, 'layer-backend');
                },
                setField: (key, value) => setLayerDraft({ ...draft, [key]: value }),
                setSpoutDraft,
                pickSpout: () => pickSpoutPath(act, setSpoutDraft),
                // 「保存」: the same `spoutLayer.status` action both write the typed path and re-probe;
                // `act` refreshes the status so the Spout button flips as soon as the path is valid.
                saveSpoutPath: async () => {
                  const result = await act({ action: 'spoutLayer.status', electronExecutable: draftPath }, 'spout-path');
                  const probe = result.probe ?? {};
                  if (probe.ok) show(`Spout 路径已保存 · Electron ${probe.version || '可用'}`);
                  else show(`路径已保存，校验失败：${probe.code || probe.message || '未知错误'}`);
                },
                probeSpout: async () => {
                  const result = await act({ action: 'spoutLayer.status', electronExecutable: draftPath }, 'spout-probe');
                  const probe = result.probe ?? {};
                  if (probe.ok) show(`Electron ${probe.version || '可用'} · 校验通过`);
                  else show(`检测失败：${probe.code || probe.message || '未知错误'}`);
                },
                startSpout: async () => {
                  const result = await act({ action: 'spoutLayer.start', electronExecutable: draftPath }, 'spoutLayer');
                  if (result.ok) show('显示层已启动，等待首帧上报');
                },
                stopSpout: () => act({ action: 'spoutLayer.stop' }, 'spoutLayer'),
                startWpf: () => act({
                  action: 'transparent.start',
                  left: Number(draft.left),
                  top: Number(draft.top),
                  width: Number(draft.width),
                  height: Number(draft.height),
                }, 'transparent'),
                stopWpf: () => act({ action: 'transparent.stop' }, 'transparent'),
              });
            })(),
            motionPresetSection(h, {
              data: motionPresets,
              query: motionQuery,
              filters: motionFilters,
              drafts: motionDrafts,
              busy,
            }, {
              setQuery: setMotionQuery,
              setFilter: (key, value) => setMotionFilters((current) => ({ ...current, [key]: value })),
              setDraft: (key, value) => setMotionDrafts((current) => {
                const next = { ...current };
                if (value === null) delete next[key];
                else next[key] = value;
                return next;
              }),
              override: overrideMotionPreset,
              reset: resetMotionPresets,
              refresh: () => { void loadMotionPresets(); },
            }),
          );
        })(),

        (() => {
          // 闲聊模式（快路）：只聊天、不接工具与感知，用于明确要"陪聊"的场合。
          const fp = status.fastpath ?? {};
          const ready = fp.available === true;
          const on = fp.enabled === true;
          return card(
            '闲聊模式（可选）',
            line('状态', on ? '已开启 · 不包含聊天外任何功能' : '未开启（默认走 agent）'),
            line('模型', ready ? `${fp.provider}/${fp.model}` : 'DSH llm 服务不可用'),
            line('历史', `${fp.turns ?? 0} 条消息`),
            h('div', { style: styles.row },
              h('button', {
                style: { ...(on ? styles.btnActive : styles.btn), ...(busy !== '' || !ready ? styles.off : {}) },
                disabled: busy !== '' || !ready,
                onClick: () => {
                  if (on) {
                    void act({ action: 'feature.set', id: 'fastpath', enabled: false }, 'fastpath');
                    setChatConfirm(false);
                    return;
                  }
                  setChatConfirm(true);
                },
              }, on ? '关闭闲聊模式' : '开启闲聊模式'),
              h('button', {
                style: { ...(fastpathReviewOpen ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: async () => {
                  if (fastpathReviewOpen) {
                    setFastpathReviewOpen(false);
                    return;
                  }
                  setFastpathReviewOpen(true);
                  await loadFastpathHistory();
                },
              }, fastpathReviewOpen ? '收起审阅' : '审阅对话'),
            ),
            chatConfirm
              ? h('div', { style: { marginTop: 8, padding: 10, borderRadius: 8, background: '#fff7e6', border: '1px solid #d98324' } },
                h('div', { style: { fontSize: 13, color: '#111827' } },
                  '开启后她只会聊天：不调用工具、不看屏幕、不查长期记忆，语音也直接走这里而不进 agent。需要做事时请关掉。'),
                h('div', { style: styles.row },
                  h('button', {
                    style: styles.btnPrimary,
                    disabled: busy !== '',
                    onClick: async () => {
                      await act({ action: 'feature.set', id: 'fastpath', enabled: true }, 'fastpath');
                      setChatConfirm(false);
                    },
                  }, '确认开启'),
                  h('button', {
                    style: styles.btn,
                    disabled: busy !== '',
                    onClick: () => setChatConfirm(false),
                  }, '取消'),
                ),
              )
              : null,
            fastpathReviewOpen
              ? fastpathReviewBody(h, {
                  groups: fastpathGroups,
                  filter: fastpathFilter,
                  open: fastpathOpenGroups,
                  expanded: fastpathExpanded,
                  confirm: fastpathConfirm,
                  busy: busy !== '',
                  loading: busy === 'fastpath-history',
                }, {
                  setFilter: setFastpathFilter,
                  toggleGroup: (domain) => setFastpathOpenGroups((current) => (current.includes(domain)
                    ? current.filter((item) => item !== domain)
                    : [...current, domain])),
                  toggleText: (key) => setFastpathExpanded((current) => (current.includes(key)
                    ? current.filter((item) => item !== key)
                    : [...current, key])),
                  requestClear: (domain) => setFastpathConfirm(domain),
                  cancelClear: () => setFastpathConfirm(null),
                  confirmClear: (domain) => { void clearFastpathDomain(domain); },
                  refresh: () => { void loadFastpathHistory(); },
                  close: () => {
                    setFastpathReviewOpen(false);
                    setFastpathConfirm(null);
                  },
                })
              : null,
            h('div', { style: styles.hint }, '平时保持关闭：语音默认走 agent，只有你主动打开时才切到纯聊天。'),
          );
        })(),

        (() => {
          // 字幕：区域拖选 / 气泡跟随 VTS + 字体字号 + 对比色。
          const sub = status.subtitle ?? {};
          const region = sub.region;
          const bubble = sub.mode === 'bubble';
          const layerRunning = status.avatarLayer?.running === true;
          // 字体：下拉框只列本机已安装的字体族；当前值不在列表里时补一个「当前」选项。
          const fonts = Array.isArray(sub.availableFonts) ? sub.availableFonts : [];
          const currentFont = typeof sub.font === 'string' && sub.font.trim().length > 0
            ? sub.font.trim()
            : 'Microsoft YaHei UI';
          const currentFontListed = fonts.includes(currentFont);
          const canEnable = bubble ? layerRunning : region !== null && region !== undefined;
          const subtitleOn = feature('subtitle') && sub.enabled === true;
          const blockReason = bubble
            ? (layerRunning ? '' : '气泡模式需要先「放到桌面」，否则没有可依附的窗口')
            : (canEnable ? '' : '区域模式需要先拖选一个区域');
          return card(
            '字幕',
            line('状态', subtitleOn ? (sub.running ? '显示中' : '已启用') : '未启用'),
            line('模式', bubble ? '气泡 · 跟随悬浮窗' : '区域 · 固定位置'),
            h('div', { style: styles.row },
              h('button', {
                style: bubble ? styles.btn : styles.btnActive,
                disabled: busy !== '',
                onClick: () => act({ action: 'subtitle.config', mode: 'region' }, 'subtitle-mode'),
              }, '区域模式'),
              h('button', {
                style: bubble ? styles.btnActive : styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'subtitle.config', mode: 'bubble' }, 'subtitle-mode'),
              }, '气泡模式'),
            ),
            h('div', { style: styles.hint }, subtitleOn ? '' : '字幕当前关闭：点模式或「启用字幕」会先启用字幕组件，再切换/打开容器。'),
            h('div', { style: styles.row },
              h('button', {
                style: { ...(subtitleOn ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: () => act({ action: 'subtitle.config', enabled: !sub.enabled }),
              }, sub.enabled ? '停用字幕' : '启用字幕'),
              h('button', {
                style: styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'subtitle.preview' }),
              }, '预览'),
            ),
            h('div', { style: styles.hint }, blockReason),
            bubble
              ? h('div', { style: styles.hint },
                  `气泡宽度跟随悬浮窗（${status.avatarLayer?.geometry?.width ?? '—'} px），高度随字数增长，字号按窗口高度等比缩放；不使用字体/字号/区域设置。`)
              : h('div', null,
                  h('div', { style: styles.row },
                    h('button', {
                      style: styles.btn,
                      disabled: busy !== '',
                      onClick: async () => {
                        const result = await act({ action: 'subtitle.select' }, 'subtitle.select');
                        if (result.ok) show('区域已保存');
                      },
                    }, '选择区域'),
                    h('span', { style: styles.value }, region ? `${region.x}, ${region.y} · ${region.w}×${region.h}` : '未选择'),
                  ),
                  h('div', { style: styles.field },
                    h('span', { style: styles.label }, '字体'),
                    h('div', { style: { display: 'flex', gap: 8 } },
                      h('select', {
                        style: styles.input,
                        value: currentFont,
                        disabled: busy !== '',
                        onChange: (event) => {
                          if (event.target.value.length > 0) {
                            void act({ action: 'subtitle.config', font: event.target.value });
                          }
                        },
                      },
                        currentFontListed ? null : h('option', { value: currentFont }, `（当前：${currentFont}）`),
                        fonts.map((name) => h('option', { key: name, value: name }, name)),
                      ),
                      h('button', {
                        style: styles.btn,
                        disabled: busy !== '',
                        title: '重新读取本机已安装的字体',
                        onClick: () => act({ action: 'subtitle.fonts.refresh' }),
                      }, '刷新字体列表'),
                    ),
                    h('div', { style: styles.hint }, fonts.length === 0
                      ? '正在读取本机已安装字体…'
                      : `本机已安装 ${fonts.length} 个字体族${sub.truncatedFonts === true ? '（仅列出前 1000 个）' : ''}`),
                  ),
                  h('div', { style: styles.field },
                    h('span', { style: styles.label }, '字号上限'),
                    h('input', {
                      style: { ...styles.input, width: 80 },
                      type: 'number',
                      min: 12,
                      max: 96,
                      value: sizeMaxDraft ?? String(sub.sizeMax ?? 32),
                      onChange: (event) => setSizeMaxDraft(event.target.value),
                      onBlur: async (event) => {
                        const value = Number.parseInt(event.target.value, 10);
                        if (Number.isFinite(value)) await act({ action: 'subtitle.config', sizeMax: value });
                        // 保存成功或失败都丢弃草稿：成功回显新值，失败回显旧值，不留脏数据。
                        setSizeMaxDraft(null);
                      },
                    }),
                  ),
                ),
            h('div', { style: styles.hint }, feature('subtitle')
              ? '区域模式：拖选后启用；气泡模式：锚在悬浮窗左上角，气泡色取自模型区域，文字取对比色。关闭「字幕」组件会先隐藏字幕，再连同区域/显示开关一起置为关。'
              : '字幕组件当前关闭：上面的按钮仍可点，会先启用「字幕显示」组件，再执行字幕动作。'),
          );
        })(),

        card(
          '语音延迟测量',
          h('div', { style: styles.hint }, '只做测量，不改推理档位与播放逻辑；语音轮次仍使用 Harness 当前设置。'),
          h('div', { style: styles.field },
            line('延迟样本', `${latency.samples ?? 0} 条（近 ${(latency.recent ?? []).length} 条参与分位）`),
            line('ASR（端点→终稿）p50 / p95', `${fmtMs(latency.p50?.asrMs)} / ${fmtMs(latency.p95?.asrMs)}`),
            line('投递→首段文本 p50 / p95', `${fmtMs(latency.p50?.ackToFirstTextMs)} / ${fmtMs(latency.p95?.ackToFirstTextMs)}`),
            line('首段文本→首句 p50 / p95', `${fmtMs(latency.p50?.firstTextToFirstSentenceMs)} / ${fmtMs(latency.p95?.firstTextToFirstSentenceMs)}`),
            line('首句→首音频 p50 / p95', `${fmtMs(latency.p50?.firstSentenceToFirstAudioMs)} / ${fmtMs(latency.p95?.firstSentenceToFirstAudioMs)}`),
            line('总延迟 p50 / p95', `${fmtMs(latency.p50?.totalMs)} / ${fmtMs(latency.p95?.totalMs)}`),
            line('翻译', fmtTranslateLatency(latency)),
            h('div', { style: styles.hint }, '总延迟 = 静音端点判定 → 第一个音频开始播放；含合并窗口、记忆召回、整轮等待与合成。'),
            h('div', { style: styles.hint }, '翻译取最近一轮；「—」表示该轮没有翻译（同语言），不参与任何计费。'),
          ),
        ),

        card(
          '组件开关',
          (status.features ?? []).filter((entry) => entry.id !== 'fastpath').map((entry) =>
            h('div', { key: entry.id, style: styles.row },
              h('span', { style: styles.label },
                `${entry.enabled ? '● ' : '○ '}${entry.label}`,
                h('span', { style: { ...styles.value, marginLeft: 8 } }, entry.description)),
              h('button', {
                style: entry.enabled ? styles.btnActive : styles.btn,
                disabled: busy !== '',
                onClick: () => act({ action: 'feature.set', id: entry.id, enabled: !entry.enabled }, `feature:${entry.id}`),
              }, entry.enabled ? '已启用' : '已关闭')),
          ),
          h('div', { style: styles.hint }, '每个能力是独立组件的总控：关闭会先停资源再关容器/自启动；打开会连带打开容器开关（不会因此立刻开麦或截图）。'),
          h('div', { style: styles.hint }, '外部程序绑定：视觉 ↔ OBS；语音合成 ↔ GPT-SoVITS；形象 ↔ VTube Studio。字幕、听觉、环境声音没有外部程序。'),
          h('div', { style: styles.hint }, '子级开关（GPT 音色 / OBS 场景 / 形象后端）不等于组件开关：关子级不会关组件，关组件会连带关闭子级。'),
        ),

        card(
          '连带启动',
          line('说明', '只在插件启动时尝试一次'),
          ...[
            { target: 'obs', label: 'OBS', placeholder: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' },
            { target: 'vts', label: 'VTube Studio', placeholder: 'steam://rungameid/1325860' },
          ].map((entry) => {
            const current = autostartOf(entry.target);
            const owner = entry.target === 'obs' ? 'vision' : 'avatar';
            return h('div', { key: entry.target, style: { ...styles.field, marginTop: 10 } },
              h('div', { style: styles.row },
                h('span', { style: styles.label }, `${entry.label} · ${current.running ? '运行中' : '未运行'}${current.owned ? '（插件启动）' : ''} · 绑定${owner === 'vision' ? '视觉' : '形象'}组件`),
                h('span', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    style: { ...(current.enabled ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: () => act({ action: 'autostart.set', target: entry.target, enabled: !current.enabled }, `autostart:${entry.target}`),
                  }, current.enabled ? '自启动：开' : '自启动：关'),
                  h('button', {
                    style: { ...(current.autoClose !== false ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: () => act({ action: 'autostart.set', target: entry.target, autoClose: current.autoClose === false }, `autoclose:${entry.target}`),
                  }, current.autoClose !== false ? '自动关闭：开' : '自动关闭：关'))),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('input', {
                  style: { ...styles.input, flex: 1 },
                  value: autostartPath(entry.target),
                  placeholder: entry.placeholder,
                  onChange: (event) => setAutostartDraft({ ...(autostartDraft ?? {}), [entry.target]: event.target.value }),
                  onBlur: () => void commitAutostartPath(entry.target),
                }),
                h('button', {
                  style: { ...styles.btn, ...(busy !== '' ? styles.off : {}), whiteSpace: 'nowrap' },
                  disabled: busy !== '',
                  onClick: () => void pickAutostartPath(entry.target),
                }, '浏览…'),
              ),
            );
          }),
          (() => {
            const current = gptAutostartOf();
            return h('div', { style: { ...styles.field, marginTop: 10, borderTop: `1px solid ${BORDER}`, paddingTop: 10 } },
              h('div', { style: styles.row },
                h('span', { style: styles.label }, `GPT-SoVITS · ${current.running ? '运行中' : '未运行'}${current.owned ? '（插件启动）' : ''} · 绑定语音合成组件`),
                h('span', { style: { display: 'flex', gap: 8 } },
                  h('button', {
                    style: { ...(current.enabled ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: () => act({ action: 'autostart.set', target: 'gptsovits', enabled: !current.enabled }, 'autostart:gptsovits'),
                  }, current.enabled ? '自启动：开' : '自启动：关'),
                  h('button', {
                    style: { ...(current.autoClose !== false ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    onClick: () => act({ action: 'autostart.set', target: 'gptsovits', autoClose: current.autoClose === false }, 'autoclose:gptsovits'),
                  }, current.autoClose !== false ? '自动关闭：开' : '自动关闭：关'))),
              gptAutostartRow('pythonPath', 'Python 路径', 'G:\\GPT-SoVITS-v2pro\\runtime\\python.exe', () => void pickGptAutostartFile('pythonPath', 'exe', 'Python 路径')),
              gptAutostartRow('scriptPath', 'api_v2.py 路径', 'G:\\GPT-SoVITS-v2pro\\api_v2.py', () => void pickGptAutostartFile('scriptPath', 'script', 'api_v2.py 路径')),
              gptAutostartRow('workDir', '工作目录（留空用脚本所在目录）', '留空 = api_v2.py 所在目录', () => void pickGptAutostartWorkDir()),
              h('div', { style: styles.row },
                h('span', { style: styles.label }, '端口'),
                h('input', {
                  style: { ...styles.input, width: 120 },
                  value: gptAutostartValue('port'),
                  placeholder: '9880',
                  onChange: (event) => setGptAutostartDraft({ ...(gptAutostartDraft ?? {}), port: event.target.value }),
                  onBlur: () => void commitGptAutostartField('port'),
                })),
              h('div', { style: styles.hint }, '开启后插件启动时会拉起 GPT-SoVITS 的 API 服务；已在运行则跳过。'),
              h('div', { style: styles.hint }, '端口跟随「语音合成」里的 apiBase；这里只是 apiBase 没写端口时的默认值。'),
            );
          })(),
          h('div', { style: styles.row },
            h('span', { style: styles.value }, '已在运行（OBS 4455 / VTS 8001 / GPT-SoVITS 9880）就跳过'),
            h('button', {
              style: { ...styles.btn, ...(busy !== '' ? styles.off : {}) },
              disabled: busy !== '',
              onClick: async () => {
                const result = await act({ action: 'autostart.run' }, 'autostart-run');
                const text = (result.results ?? [])
                  .map((row) => `${row.target}：${row.started ? '已启动' : (row.running ? '已在运行' : (row.error || '未启动'))}`)
                  .join('；');
                show(text.length > 0 ? text : '没有可尝试的目标');
              },
            }, '立即尝试一次')),
          h('div', { style: styles.hint }, 'OBS 路径填 obs64.exe；VTS 可以直接填 steam://rungameid/1325860。路径为空时启动只记一条 autostart.failed，不报错也不阻塞。'),
          h('div', { style: styles.hint }, '绑定规则：组件关闭时这里的自启动/自动关闭都不生效，也不会代用户关闭；组件打开会恢复它们。DSH 退出时，只按插件自己记录的 PID 关闭插件启动的程序，用户手动启动的程序不动。'),
          h('div', { style: styles.hint }, '「浏览…」打开 Windows 文件对话框选择 exe；VTS 的 Steam 协议路径不能用文件对话框选中，取消对话框后直接在输入框里填 steam://rungameid/1325860 即可。'),
        ),

        card(
          '全局快捷键',
          status.hotkeys
            .filter((entry) => HOTKEY_ACTIONS.includes(entry.action))
            .map((entry) =>
            h('div', { key: entry.action, style: styles.row },
              h('span', { style: styles.label }, HOTKEY_LABEL[entry.action] ?? entry.action),
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: styles.mono }, editingHotkey === entry.action ? (captured || '请按键…') : entry.combo),
                editingHotkey === entry.action
                  ? h(React.Fragment, null,
                      h('button', {
                        style: { ...styles.btnPrimary, ...(captured.length === 0 ? styles.off : {}) },
                        disabled: captured.length === 0,
                        onClick: async () => {
                          const result = await act({ action: 'hotkey.set', name: entry.action, combo: captured }, 'hotkey');
                          if (result.ok) { setEditingHotkey(''); setCaptured(''); show('已改绑'); }
                        },
                      }, '保存'),
                      h('button', { style: styles.btn, onClick: () => { setEditingHotkey(''); setCaptured(''); setCaptureHint(''); } }, '取消'))
                  : h('button', {
                      style: styles.btn,
                      onClick: () => { setEditingHotkey(entry.action); setCaptured(''); setCaptureHint('按下组合键（Esc 取消）'); },
                    }, '改键'))),
          ),
          captureHint.length > 0 ? h('div', { style: styles.hint }, captureHint) : null,
          h('div', { style: styles.hint }, '小键盘键显示为 Num1 / NumAdd（与主键盘数字区分）；小键盘需要 NumLock 打开（关闭时产生的是方向键功能）。'),
          h('div', { style: styles.row },
            h('span', { style: styles.value }, '恢复默认四组'),
            h('button', { style: styles.btn, disabled: busy !== '', onClick: () => act({ action: 'hotkey.reset' }) }, '重置')),
        ),

        card(
          '固定记忆',
          h('div', { style: styles.row },
            h('span', { style: styles.value }, `${resources.length} 条已保存`),
            h('button', { style: styles.btnPrimary, onClick: () => openEditor(null) }, '＋ 新增固定记忆')),
          h('div', { style: styles.hint }, '固定记忆：用户明确要求长期保留的内容，每轮注入上下文'),
          h('div', { style: styles.hint }, '普通记忆：由对话自动沉淀，按相关性/重要性/时间召回'),
          h('div', { style: styles.hint }, '说「记住……，以后一直这样」或「把这条固定下来」即可新增；说「删掉那条固定记忆」会先列出确认再删。只有你明确要求长期保留时才会写入固定记忆，普通偏好仍走自动记忆。'),
          resources.length === 0
            ? h('div', { style: styles.value }, '还没有固定记忆。')
            : resources.map((resource) =>
                h('div', { key: resource.key, style: styles.row },
                  h('span', { style: styles.label },
                    resource.title || resource.key,
                    resource.secret ? h('span', { style: styles.badge }, '加密') : null,
                    h('span', { style: styles.mono }, `  ${resource.key}`)),
                  h('span', { style: { display: 'flex', gap: 6 } },
                    h('button', {
                      style: styles.btn,
                      onClick: async () => {
                        const result = await act({ action: 'resource.get', key: resource.key, reveal: resource.secret === true }, 'resource-get');
                        if (result.ok) openEditor(result.resource);
                      },
                    }, '修改'),
                    h('button', {
                      style: styles.btnDanger,
                      onClick: async () => {
                        if (window.confirm(`删除固定记忆「${resource.key}」？`)) {
                          const result = await act({ action: 'resource.delete', key: resource.key }, 'resource-delete');
                          if (result.ok) show('固定记忆已删除');
                        }
                      },
                    }, '删除')))),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Expose the client context so the background voice/rollover poller can use client
        // services (uiWorkspace) without a React scope.
        if (typeof window !== 'undefined') window.__seireinCtx = ctx;
        // Re-arm the always-on poller: startPolling is idempotent and stops the generation it
        // replaces, so a reload that only re-runs apply still ends up with exactly one interval.
        const handle = startPolling();
        // Unload/hot reload: stop only this generation. A newer apply has already replaced the
        // window handle, and that newer poller must keep running.
        ctx.effect(() => () => {
          if (typeof window !== 'undefined' && window[POLL_KEY] === handle) stopPolling();
        });
        const options = { id: 'assistant', order: 50, label: 'Seirein' };
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', ...options }, Panel));
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', ...options }, Panel));
      },
    };
  },
});
