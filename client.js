window.__ModuleLoader__.load({
  id: '@local/dsh-assistant',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    // Bump together with package.json. Shown in the UI so a stale browser bundle is obvious.
    const CLIENT_VERSION = '0.99.0';

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
      // 设置页布局：分区卡片 / 子容器 / 分隔线 / 对齐。只决定长什么样，不携带状态也不发请求。
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      sectionHeading: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '2px 2px 0' },
      sectionTitle: { fontSize: 13, fontWeight: 700, color: '#374151', letterSpacing: 0.2 },
      sectionHint: { fontSize: 12, color: MUTED },
      sectionBody: { display: 'flex', flexDirection: 'column', gap: 12 },
      sectionCard: { border: `1px solid ${BORDER}`, borderRadius: 12, padding: 14, background: '#fff' },
      sectionCardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 10, color: '#111827' },
      sectionSummary: { cursor: 'pointer', marginBottom: 0 },
      group: {
        border: '1px solid #e6eaf0',
        borderRadius: 10,
        padding: '10px 12px',
        background: '#f6f8fa',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      groupTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
      groupTitle: { fontSize: 13, fontWeight: 600, color: '#111827' },
      divider: { borderTop: '1px solid #e5e9ef', margin: '10px 0 2px' },
      // 同一行里的 label 固定宽度、控件区可伸缩、操作列右对齐。
      fieldRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' },
      fieldLabel: { flex: '0 0 132px', fontSize: 13, color: '#111827' },
      fieldControls: { display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 0', minWidth: 0, flexWrap: 'wrap' },
      actionRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', padding: '4px 0' },
    };

    // ---- 设置页布局：分区 / 子容器 / 分隔线（纯布局函数，无状态、无请求、无轮询） --------------
    /**
     * 设置页信息架构：12 个分区，按重要性排列——顶部是插件与工作目录，
     * 其次是组件开关，然后视觉 → 听觉 → 形象 → 记忆 → 声纹 → 语音 → 通话 → 字幕，
     * 最后是诊断维护与「其他设置」。数组顺序就是渲染顺序。
     */
    const SETTINGS_SECTIONS = Object.freeze([
      {
        id: 'intro',
        title: '1 插件与工作目录',
        hint: '版本、运行时长与数据存放位置；权限说明只读。',
      },
      {
        id: 'features',
        title: '2 组件开关',
        hint: '所有功能的总控：先在这里开关组件，再到对应分区调细节。',
      },
      {
        id: 'vision',
        title: '3 视觉',
        hint: '看屏幕或 OBS 场景：来源、隐私、持续观看与截图。',
      },
      {
        id: 'hearing',
        title: '4 听觉',
        hint: '麦克风与回环设备：先测电平，再决定是否自动监听。',
      },
      {
        id: 'avatar',
        title: '5 形象与动作',
        hint: 'VTS 连接、编辑与沉底、显示层透明化、动作预设。',
      },
      {
        id: 'memory',
        title: '6 记忆与人设',
        hint: '人设、画像、固定记忆、记忆容量与共享语言库。',
      },
      {
        id: 'speaker',
        title: '7 声纹',
        hint: '只登记与观测本人声纹，不参与拒收或打断。',
      },
      {
        id: 'voice',
        title: '8 语音',
        hint: '播报、候音等待、语种与 GPT-SoVITS 音色。',
      },
      {
        id: 'call',
        title: '9 通话模式',
        hint: '只有明确叫到称呼的话才会被接收。',
      },
      {
        id: 'subtitle',
        title: '10 字幕',
        hint: '区域与气泡两种显示方式、字体字号。',
      },
      {
        id: 'diagnostics',
        title: '11 诊断与维护',
        hint: '只在排查问题时打开：读取都不轮询，写入都要显式点击。',
      },
      {
        id: 'misc',
        title: '12 其他设置',
        hint: '连带启动、全局快捷键与闲聊模式：日常不用改。',
      },
    ]);

    const SETTINGS_SECTION_IDS = SETTINGS_SECTIONS.map((section) => section.id);
    /** 未知分区落到最后一个分区，绝不静默丢块。 */
    const SETTINGS_FALLBACK_SECTION_ID = SETTINGS_SECTION_IDS[SETTINGS_SECTION_IDS.length - 1] ?? 'misc';

    /** 一个块 = 一张分区卡片；未知分区落到「高级」，绝不静默丢块。 */
    function settingsBlock(section, node) {
      return { section, node };
    }

    /** 分区卡片：白底、圆角、标题；子容器之间自动插一条分隔线。 */
    function settingsCard(h, id, title, ...children) {
      const body = children.flat(Infinity).filter((child) => child !== null && child !== undefined);
      const parts = [];
      body.forEach((child, index) => {
        if (index > 0) parts.push(settingsDivider(h, `${id}-${index}`));
        parts.push(child);
      });
      return h('div', { 'data-settings-card': id, style: styles.sectionCard },
        h('div', { style: styles.sectionCardTitle }, title),
        ...parts);
    }

    /**
     * 子容器：圆角矩形 + 很浅的灰底（#f6f8fa）。只做视觉分组：不挂状态、不发请求、
     * 不改变子控件的顺序与行为；嵌套最多两层（分区卡片 → 子容器）。
     */
    function settingsGroup(h, id, title, ...children) {
      const body = children.flat(Infinity).filter((child) => child !== null && child !== undefined);
      return h('div', { 'data-settings-group': id, style: styles.group },
        typeof title === 'string' && title !== ''
          ? h('div', { style: styles.groupTitle }, title)
          : null,
        ...body);
    }

    /** 子容器之间的分隔线。 */
    function settingsDivider(h, id) {
      return h('div', { 'data-settings-divider': id, role: 'separator', style: styles.divider });
    }

    /** 一行「label + 控件」：label 固定宽度，控件区吸收剩余宽度，同一行垂直居中对齐。 */
    function settingsField(h, label, ...controls) {
      return h('div', { 'data-settings-field': label, style: styles.fieldRow },
        h('span', { style: styles.fieldLabel }, label),
        h('div', { style: styles.fieldControls }, ...controls));
    }

    /** 操作列：按钮排在同一行，统一高度并右对齐（主操作在左，次操作靠右）。 */
    function settingsActions(h, ...buttons) {
      return h('div', { 'data-settings-actions': 'true', style: styles.actionRow }, ...buttons);
    }

    /**
     * 按 SETTINGS_SECTIONS 的固定顺序把块分组：同一分区的卡片共用一个分区标题与一个纵向容器；
     * 顺序与块的声明顺序无关；`collapsed` 分区仍支持 <details>，但当前 12 个分区都不折叠。纯函数，便于测试顺序。
     */
    function groupSettingsBlocks(h, blocks) {
      const bySection = new Map(SETTINGS_SECTION_IDS.map((id) => [id, []]));
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block === null || block === undefined) continue;
        const id = SETTINGS_SECTION_IDS.includes(block.section) ? block.section : SETTINGS_FALLBACK_SECTION_ID;
        for (const node of Array.isArray(block.node) ? block.node.flat(Infinity) : [block.node]) {
          if (node !== null && node !== undefined) bySection.get(id).push(node);
        }
      }
      return SETTINGS_SECTIONS
        .filter((section) => bySection.get(section.id).length > 0)
        .map((section) => {
          const heading = h('span', { 'data-settings-heading': section.id, style: styles.sectionHeading },
            h('span', { style: styles.sectionTitle }, section.title),
            section.hint ? h('span', { style: styles.sectionHint }, section.hint) : null);
          const body = h('div', { 'data-settings-body': section.id, style: styles.sectionBody },
            ...bySection.get(section.id));
          const collapsed = section.collapsed === true;
          return h('div', {
            key: section.id,
            'data-settings-section': section.id,
            style: styles.section,
          },
            collapsed
              ? h('details', {
                  'data-settings-collapsed': 'true',
                  style: styles.section,
                },
                  h('summary', { style: styles.sectionSummary }, heading),
                  body)
              : heading,
            collapsed ? null : body);
        });
    }

    // ---- TTS 预热状态（只读展示）：纯格式化，无状态、无请求、无轮询 --------------------------
    // `status.tts.warmup` is the host's read-only projection. This function only turns it into
    // display text: it never starts/retries a warm-up, and a missing/broken field reads as
    // 「不可用」 instead of inventing a state. `stale` is true only when the host/UI marks the
    // snapshot as no longer matching the current model/reference-audio/language identity.
    const TTS_WARMUP_STATUS_LABELS = Object.freeze({
      unknown: '未知',
      queued: '排队中',
      warming: '预热中',
      ready: '就绪',
      failed: '失败',
    });

    /** Identity inputs the card can compare across status refreshes; paths never leave the page. */
    function ttsWarmupConfigSignature(tts, langs) {
      const gpt = tts?.gptSovits ?? {};
      const models = gpt.models ?? {};
      const applied = gpt.modelsApplied ?? {};
      try {
        return JSON.stringify([
          gpt.enabled === true,
          String(gpt.apiBase ?? ''),
          String(gpt.refAudioPath ?? ''),
          String(gpt.promptText ?? ''),
          String(models.gptModelPath ?? ''),
          String(models.sovitsModelPath ?? ''),
          String(applied.gptPath ?? ''),
          String(applied.sovitsPath ?? ''),
          Number(applied.at) || 0,
          String(gpt.textLang ?? ''),
          String(gpt.promptLang ?? ''),
          String(langs?.speech ?? ''),
        ]);
      } catch {
        return '';
      }
    }

    /**
     * Format one warm-up snapshot for the read-only row. Pure: reads only its arguments.
     * Returns `{available, status, stale, label, errorCode, retryInMs, text}`.
     */
    function formatTtsWarmupStatus(warmup, options = {}) {
      const forcedStale = options !== null && typeof options === 'object' && options.stale === true;
      if (warmup === null || typeof warmup !== 'object' || typeof warmup.status !== 'string'
        || warmup.status.trim().length === 0) {
        return {
          available: false,
          status: 'unknown',
          stale: false,
          label: '不可用',
          errorCode: null,
          retryInMs: null,
          text: '不可用',
        };
      }
      const raw = warmup.status.trim().toLowerCase();
      const mapped = raw === 'stale' ? 'failed' : raw;
      const status = Object.hasOwn(TTS_WARMUP_STATUS_LABELS, mapped) ? mapped : 'unknown';
      const label = TTS_WARMUP_STATUS_LABELS[status];
      const errorCode = typeof warmup.lastErrorCode === 'string' && warmup.lastErrorCode.trim().length > 0
        ? warmup.lastErrorCode.trim().slice(0, 80)
        : null;
      const retryInMs = Number.isFinite(warmup.retryInMs) && warmup.retryInMs >= 0
        ? Math.round(warmup.retryInMs)
        : null;
      const stale = forcedStale === true || warmup.stale === true || raw === 'stale'
        || /^TTS_WARMUP_(?:STALE|PREEMPTED)$/u.test(errorCode ?? '');
      const parts = [`${label}（${status}）`];
      if (errorCode !== null) parts.push(`错误码：${errorCode}`);
      if (retryInMs !== null) parts.push(`重试：${(retryInMs / 1000).toFixed(1)}s 后`);
      parts.push(stale ? 'stale（旧状态，已失效）' : '非 stale');
      return {
        available: true,
        status,
        stale,
        label,
        errorCode,
        retryInMs,
        text: parts.join(' · '),
      };
    }
    // ---- TTS 预热状态（只读展示）结束 ----------------------------------------------------------

    /** The global hotkeys the host ships; anything else in status is ignored. */
    const HOTKEY_ACTIONS = ['mic', 'vision', 'layerEdit', 'ambient', 'callMode'];

    const HOTKEY_LABEL = {
      mic: '麦克风静音 / 恢复',
      vision: '隐私场景（视觉）切换',
      layerEdit: '形象编辑模式',
      ambient: '环境声音',
      callMode: '通话模式 / 普通模式切换',
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

    // ---- P-111 P2: client-local diagnostics（默认关闭，受控，无正文） ----------------------
    // 开关：`?seireinDiag=1` 或 `localStorage.seireinDiag === '1'`；两种都没有时本页不建 ring、
    // 不暴露 window 全局、不产生事件。每条只允许 {t, code, generation}：绝不记录请求 body、
    // rollover digest、error.message、用户文本或 URL 查询串；不新增定时器，也不发送到网络。
    const DIAG_KEY = '__seireinDiag';
    const DIAG_SWITCH_KEY = 'seireinDiag';
    const DIAG_MAX_EVENTS = 200;
    const DIAG_EVENT_CODES = Object.freeze([
      'poll.start', 'poll.abort', 'send.cancel', 'action.unknown',
      'session.start.failed', 'timeline.render',
    ]);

    const diagEnabled = (() => {
      try {
        const pageLocation = typeof window === 'undefined' ? undefined : window.location;
        const search = typeof pageLocation?.search === 'string' ? pageLocation.search : '';
        if (new URLSearchParams(search).get(DIAG_SWITCH_KEY) === '1') return true;
        const storage = typeof window === 'undefined' ? undefined : window.localStorage;
        if (storage?.getItem?.(DIAG_SWITCH_KEY) === '1') return true;
        // Same key as a property, for storage objects that expose it that way.
        return storage?.[DIAG_SWITCH_KEY] === '1';
      } catch {
        return false;
      }
    })();
    const diagRing = diagEnabled ? [] : null;

    /** Record one fixed event code; disabled pages return before touching the ring. */
    function diag(code, generation) {
      if (!diagEnabled || diagRing === null) return;
      if (!DIAG_EVENT_CODES.includes(code)) return;
      const numericGeneration = Number(generation);
      diagRing.push({
        t: Date.now(),
        code,
        generation: Number.isFinite(numericGeneration) ? numericGeneration : 0,
      });
      // Bounded: keep the newest 200 entries, never grow without limit.
      if (diagRing.length > DIAG_MAX_EVENTS) diagRing.shift();
    }

    if (diagEnabled && typeof window !== 'undefined') {
      window[DIAG_KEY] = {
        enabled: true,
        events: () => diagRing.map((event) => ({ ...event })),
        clear: () => { diagRing.length = 0; },
      };
    }

    /** Stop whatever poller an earlier generation installed. Idempotent; safe when none runs. */
    function stopPolling() {
      if (typeof window === 'undefined') return;
      const previous = window[POLL_KEY];
      if (previous === null || previous === undefined) return;
      // Invalidate the generation first: every tick re-checks `cancelled` after each await, and
      // aborting the controller rejects the request that is already in flight.
      previous.cancelled = true;
      previous.controller?.abort();
      // Observation only: the old generation's request was invalidated. No request data is kept.
      diag('poll.abort', previous.generation);
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
      diag('poll.start', handle.generation);

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
            // Observation only: a deferred SEND had live timers and lost them to cancellation.
            if (value === false && pending.size > 0 && typeof diag === 'function') {
              diag('send.cancel', handle.generation);
            }
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
          const reply = await response.json();
          // Observation only: the host rejected this action as unknown. Do not record its body.
          if (reply?.ok === false && typeof reply.error === 'string'
            && reply.error.startsWith('unknown action')) {
            diag('action.unknown', handle.generation);
          }
          return reply;
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
              diag('session.start.failed', handle.generation);
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
          if (error?.name === 'AbortError') {
            // stopPolling() already logged its own abort; only an abort while this generation
            // still owns the page is a separate observation.
            if (!handle.cancelled) diag('poll.abort', handle.generation);
            return;
          }
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

      return h('div', { 'data-profile-card': true, 'data-settings-card': 'persona', style: styles.sectionCard },
        h('div', { 'data-profile-title': true, style: styles.sectionCardTitle },
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
        avatarGeometry = null,
      } = state ?? {};
      const geo = avatarGeometry ?? null;
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
      return h('div', { 'data-settings-group': 'display-layer', style: styles.group },
        h('div', { style: styles.groupTitle }, '编辑、沉底与透明化'),
        line('桌面悬浮', layer.running === true
          ? `${layer.editMode === true ? '编辑中（可拖动/滚轮缩放）' : '运行中'}${geo ? ` · ${geo.width}×${geo.height} @ ${geo.left},${geo.top}` : ''}`
          : '未启动'),
        h('div', { style: styles.row },
          h('button', {
            style: layer.editMode === true ? styles.btnActive : styles.btnPrimary,
            disabled: busy !== '',
            onClick: () => handlers.toggleEditMode?.(),
          }, layer.editMode === true ? '完成编辑' : '编辑模式'),
        ),
        h('div', { style: styles.hint }, layer.editMode === true
          ? 'VTS 窗口已回到屏幕：像普通窗口一样拖动/拉边框；点「完成编辑」保存并恢复悬浮。'
          : layer.running
            ? '悬浮中；按钮与 Ctrl+Alt+E 都会停止当前显示层，调出 VTS 编辑；完成后在原位置恢复显示。'
            : '先开启桌面悬浮，再点「编辑模式」或按 Ctrl+Alt+E 调整。'),
        h('div', { style: styles.divider }),
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

      return h('div', { 'data-settings-group': 'motion', style: styles.group },
        h('div', { style: styles.groupTitleRow },
          h('span', { style: styles.groupTitle }, `动作预设（${visible.length} / ${items.length}）`),
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

    /**
     * 「听觉 → 音频保留（诊断）」：默认关闭的开关 + 可疑片段列表 + 试听 / 删除。
     * 列表来自 audio.retention.list；试听只显示宿主返回的文件路径（绝不自动播放），
     * 删除先确认；任何失败只渲染错误文案，不向调用方抛出。
     */
    function retentionSection(h, {
      status, data, busy, preview, confirm, onToggle, onPreview, onAskDelete, onDelete, onCancel, onDeleteAll,
    }) {
      const enabled = status?.retention?.enabled === true;
      const limits = data?.limits ?? {};
      const maxClips = Number(limits.maxClips ?? 20);
      const maxMinutes = Math.max(1, Math.round(Number(limits.maxDurationMs ?? 300000) / 60000));
      const maxMb = Math.max(1, Math.round(Number(limits.maxBytes ?? 50 * 1024 * 1024) / 1024 / 1024));
      const items = Array.isArray(data?.items) ? data.items : [];
      const error = String(data?.error ?? '');
      const reasonLabel = { 'low-evidence': '证据不足', echo: '回声', noise: '噪声', filtered: '被过滤' };
      const stopped = busy !== '';
      const timeOf = (item) => {
        const at = Date.parse(item.createdAt ?? '');
        return Number.isFinite(at) ? new Date(at).toLocaleString() : '—';
      };
      const rowOf = (item) => h('div', { key: item.id, style: styles.row },
        h('span', { style: styles.mono },
          `${timeOf(item)} · ${(Number(item.durationMs ?? 0) / 1000).toFixed(1)} 秒 · `
          + `${reasonLabel[item.reason] ?? item.reason ?? '未知'} · `
          + `${Math.max(1, Math.round(Number(item.bytes ?? 0) / 1024))} KB`
          + `${item.missing === true ? ' · 文件缺失' : ''}`),
        h('span', { style: { display: 'flex', gap: 8 } },
          h('button', {
            style: { ...styles.btn, ...(stopped ? styles.off : {}) },
            disabled: stopped,
            onClick: () => void onPreview(item.id),
          }, '试听'),
          confirm === item.id
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: styles.value }, '确认删除？'),
                h('button', {
                  style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void onDelete(item.id),
                }, '确认'),
                h('button', {
                  style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void onCancel(),
                }, '取消'))
            : h('button', {
                style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                disabled: stopped,
                onClick: () => void onAskDelete(item.id),
              }, '删除')));
      return h('div', { 'data-settings-group': 'retention', style: styles.group },
        h('div', { style: styles.groupTitleRow },
          h('span', { style: styles.groupTitle }, '音频保留（诊断）'),
          h('button', {
            style: { ...(enabled ? styles.btnActive : styles.btn), ...(stopped ? styles.off : {}) },
            disabled: stopped,
            onClick: () => void onToggle(enabled !== true),
          }, enabled ? '已开启' : '已关闭')),
        h('div', { style: styles.hint },
          `开启后仅保留可疑片段的短期音频（最多 ${maxClips} 条/${maxMinutes} 分钟/${maxMb} MB）`),
        h('div', { style: styles.hint }, '默认关闭；判定与投递完全不受影响，删除或试听都只作用于这些片段。'),
        error === '' ? null : h('div', { style: { ...styles.hint, color: DANGER } }, `音频保留不可用：${error}`),
        data === null || data === undefined || data.loading === true
          ? h('div', { style: styles.hint }, '正在读取保留列表…')
          : (items.length === 0
              ? h('div', { style: styles.hint }, '暂时没有保留的片段')
              : h('div', { style: { maxHeight: 220, overflowY: 'auto' } }, items.map(rowOf))),
        preview === null || preview === undefined
          ? null
          : h('div', { style: styles.field },
              h('span', { style: styles.mono }, `试听路径（用系统播放器打开，不自动播放）：${String(preview.path ?? '')}`)),
        h('div', { style: styles.row },
          h('button', {
            style: { ...styles.btnDanger, ...(stopped || items.length === 0 ? styles.off : {}) },
            disabled: stopped || items.length === 0,
            onClick: () => void onAskDelete('all'),
          }, '全部删除'),
          confirm === 'all'
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: styles.value }, '确认删除全部？'),
                h('button', {
                  style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void onDeleteAll(),
                }, '确认全部删除'),
                h('button', {
                  style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void onCancel(),
                }, '取消'))
            : null),
      );
    }

    /**
     * 「记忆与人设 → 共享语言库」：待确认候选 → 确认 → 共享词库，卡片式两段列表 + 确认/编辑弹窗。
     * 词库是所有人共享的，确认只要求用户点确认；身份只作为可选来源从宿主状态取
     * （`lexiconSpeakerId`），拿不到就不带 speakerId，绝不因此禁用确认或猜一个身份。
     * 渲染是纯函数，所有写入都交给 handlers（Panel 里统一走 act）。
     */
    function lexiconSpeakerId(status) {
      const explicit = [
        status?.lexicon?.speakerId,
        status?.speaker?.selfId,
        status?.speaker?.speakerId,
        status?.speaker?.id,
      ].find((value) => typeof value === 'string' && value.trim() !== '');
      if (explicit !== undefined) return explicit.trim();
      // 宿主还没有专门的「本人」speakerId 字段时，退回声纹影子的最近一次判定：
      // 只认可 match（unsure / no-speakers 不当作身份）；拿不到就返回空，确认照常可用。
      const shadow = status?.speaker?.lastShadow;
      if (shadow?.decision === 'match' && typeof shadow?.speakerId === 'string') {
        return shadow.speakerId.trim();
      }
      return '';
    }

    /**
     * `lexicon.list` 的两种成功形状：契约里的 `{ok:true, entries, unassigned}`，以及宿主当前
     * 直接返回的裸 `{entries, unassigned}`（无 ok）。任何 `ok:false` 或缺数组的返回都算失败，
     * 只在卡片里显示错误，不抛异常。
     */
    function lexiconListData(result) {
      const entries = Array.isArray(result?.entries) ? result.entries : null;
      const unassigned = Array.isArray(result?.unassigned) ? result.unassigned : null;
      if (entries !== null && unassigned !== null && result?.ok !== false) {
        return { entries, unassigned, loading: false, error: '' };
      }
      return {
        entries: [],
        unassigned: [],
        loading: false,
        error: String(result?.error ?? result?.reason ?? result?.code ?? '读取失败'),
      };
    }

    const LEXICON_KIND_LABEL = Object.freeze({ 'proper-noun': '专有名词', correction: '纠正' });

    function lexiconKindLabel(kind) {
      return LEXICON_KIND_LABEL[String(kind ?? '')] ?? '专有名词';
    }

    /** 手动词条的类别：旧英文枚举与中文标签只作为建议；其他文本按用户输入保存。 */
    const LEXICON_CATEGORY_OPTIONS = Object.freeze([
      ['person', '人名'],
      ['character', '角色'],
      ['work', '作品'],
      ['place', '地点'],
      ['term', '术语'],
      ['expression', '特殊表达'],
      ['meme', '梗'],
      ['unknown', '未知'],
    ]);
    const LEXICON_CATEGORY_LABEL = Object.freeze(Object.fromEntries(LEXICON_CATEGORY_OPTIONS));
    const LEXICON_CATEGORY_PLACEHOLDER = '可自定义，如 人名 / 术语 / 饮品';
    const LEXICON_CATEGORY_SUGGESTIONS_NEW = 'lexicon-category-suggestions-new';
    const LEXICON_CATEGORY_SUGGESTIONS_DIALOG = 'lexicon-category-suggestions-dialog';

    function lexiconCategoryLabel(category) {
      const value = String(category ?? '').trim();
      if (value === '') return '未知';
      return LEXICON_CATEGORY_LABEL[value] ?? value;
    }

    /** 类别 datalist：只给建议，任意输入都有效，空字符串由宿主存成 unknown。 */
    function lexiconCategoryDatalist(h, id) {
      return h('datalist', { id },
        LEXICON_CATEGORY_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)));
    }

    const LEXICON_LIBRARY_LABEL = Object.freeze({ public: '公共库', voiceprint: '声纹库' });

    function lexiconLibraryLabel(library) {
      return LEXICON_LIBRARY_LABEL[String(library ?? '')] ?? '公共库';
    }

    function lexiconEmptyDraft() {
      return { text: '', category: 'person', library: 'public', usage: '', reading: '', error: '' };
    }

    /** 新建词条请求体：主表单三字段 + 可选读音 + 库位（默认公共库）。 */
    function lexiconAddBody(draft) {
      return {
        action: 'lexicon.add',
        text: String(draft?.text ?? '').trim(),
        category: String(draft?.category ?? '').trim(),
        usage: String(draft?.usage ?? '').trim(),
        reading: String(draft?.reading ?? '').trim(),
        library: String(draft?.library ?? 'public') === 'voiceprint' ? 'voiceprint' : 'public',
      };
    }

    /** 行内确认时间；无法解析时给 `—`，绝不因坏值抛错。 */
    function lexiconTimeText(value) {
      const at = Date.parse(String(value ?? ''));
      return Number.isFinite(at) ? new Date(at).toLocaleString() : '—';
    }

    /**
     * 自动带出「当前出现过的误识别形式」：已记录的 wrongForms；对已确认的专有名词，
     * 原始文本与正确写法不同时也算一条（GTP4 → GPT-4）。纠正候选的 text 是正确目标，
     * 不能反过来当成误识别形式。
     */
    function lexiconObservedForms(entry) {
      const forms = [];
      const push = (value) => {
        const text = String(value ?? '').trim();
        if (text !== '' && !forms.includes(text)) forms.push(text);
      };
      for (const form of Array.isArray(entry?.wrongForms) ? entry.wrongForms : []) push(form);
      const text = String(entry?.text ?? '').trim();
      const canonical = String(entry?.canonical ?? '').trim();
      if (entry?.kind !== 'correction' && canonical !== '' && text !== canonical) push(text);
      return forms;
    }

    /**
     * 弹窗状态：确认模式带候选原文与可删减的误识别形式；编辑模式带出手动词条的三字段、读音
     * 和库位（库位只读，移动走列表按钮，避免编辑时误改 status/library）。
     */
    function lexiconDialogOf(entry, mode) {
      const observed = lexiconObservedForms(entry);
      const editing = mode === 'edit';
      const category = String(entry?.category ?? '').trim();
      return {
        mode: editing ? 'edit' : 'confirm',
        id: String(entry?.id ?? ''),
        text: String(entry?.text ?? ''),
        canonical: String(entry?.canonical ?? '') || String(entry?.text ?? ''),
        category,
        usage: String(entry?.usage ?? ''),
        reading: String(entry?.reading ?? ''),
        library: String(entry?.library ?? 'public'),
        originalLibrary: String(entry?.library ?? 'public'),
        wrongForms: observed,
        observed,
        context: editing
          ? { before: String(entry?.context?.before ?? ''), after: String(entry?.context?.after ?? '') }
          : null,
        error: '',
      };
    }

    /**
     * 弹窗 → 写入请求体（契约固定）：
     *   确认：{action:'lexicon.confirm', id|text, canonical?, speakerId?}（speakerId 可选：
     *   有才带，空字符串绝不进入请求体）
     *   编辑：{action:'lexicon.update', id, canonical, category, usage, reading, library?}
     *   （library 只在用户真的换了库位时携带，避免普通编辑被声纹门槛拦住）
     */
    function lexiconSaveBody(dialog, speakerId) {
      const current = dialog ?? {};
      const forms = (Array.isArray(current.wrongForms) ? current.wrongForms : [])
        .map((form) => String(form ?? '').trim())
        .filter((form) => form !== '');
      if (current.mode === 'edit') {
        // 主表单走 lexicon.update：只改词/类别/用法/读音/库位，status/kind/wrongForms 不在这里改。
        const body = {
          action: 'lexicon.update',
          id: String(current.id ?? ''),
          canonical: String(current.canonical ?? '').trim(),
          category: String(current.category ?? '').trim(),
          usage: String(current.usage ?? '').trim(),
          reading: String(current.reading ?? '').trim(),
        };
        const library = String(current.library ?? 'public') === 'voiceprint' ? 'voiceprint' : 'public';
        if (String(current.originalLibrary ?? 'public') !== library) body.library = library;
        return body;
      }
      const body = { action: 'lexicon.confirm' };
      const speaker = String(speakerId ?? '').trim();
      if (speaker !== '') body.speakerId = speaker;
      if (String(current.id ?? '') !== '') body.id = String(current.id);
      else if (String(current.text ?? '') !== '') body.text = String(current.text);
      const canonical = String(current.canonical ?? '').trim();
      if (canonical !== '') body.canonical = canonical;
      return body;
    }

    /** 宿主失败原因：error / reason / code 取第一个非空值，与弹窗里显示的文案同源。 */
    function lexiconFailureReason(result) {
      for (const value of [result?.error, result?.reason, result?.code]) {
        const text = String(value ?? '').trim();
        if (text !== '') return text;
      }
      return '操作失败';
    }

    /** 第二步失败文案：说清「已经确认」与「哪一部分没保存、为什么」。 */
    function lexiconPartialNotice(reason) {
      const text = String(reason ?? '').trim();
      return `已确认但误识别形式未保存：${text === '' ? '操作失败' : text}`;
    }

    /**
     * 第二步/重试共用的 edit 请求体：正确写法已由 confirm 保存，这里只补误识别形式，
     * 不重发 canonical/context（确认弹窗没有上下文，重发会把已有上下文写空）。
     */
    function lexiconWrongFormsBody(dialog, entryId) {
      const forms = (Array.isArray(dialog?.wrongForms) ? dialog.wrongForms : [])
        .map((form) => String(form ?? '').trim())
        .filter((form) => form !== '');
      return { action: 'lexicon.edit', id: String(entryId ?? ''), wrongForms: forms };
    }

    /**
     * 两步保存的调度（Panel 注入 act，测试注入假 act）：只返回结果，不做界面副作用。
     * confirm 契约不带 wrongForms，删减过的形式要在确认成功后补一次 edit；这一步的结果必须
     * 返回给调用方，不能 await 完就丢掉。
     */
    async function lexiconSaveSteps({ dialog, speakerId, act }) {
      if (dialog === null || dialog === undefined) return { stage: 'skipped' };
      const body = lexiconSaveBody(dialog, speakerId);
      const firstTag = body.action === 'lexicon.edit'
        ? 'lexicon-edit'
        : (body.action === 'lexicon.update' ? 'lexicon-update' : 'lexicon-confirm');
      const first = await act(body, firstTag);
      if (first?.ok !== true) return { stage: 'failed', error: lexiconFailureReason(first) };
      const kept = Array.isArray(dialog.wrongForms) ? dialog.wrongForms.length : 0;
      const observed = Array.isArray(dialog.observed) ? dialog.observed.length : kept;
      if (dialog.mode !== 'confirm' || kept === observed) return { stage: 'done' };
      const entryId = String(first.entry?.id ?? dialog.id ?? '').trim();
      const second = await act(lexiconWrongFormsBody(dialog, entryId), 'lexicon-edit');
      if (second?.ok !== true) {
        return { stage: 'partial', entryId, notice: lexiconPartialNotice(lexiconFailureReason(second)) };
      }
      return { stage: 'done' };
    }

    /** 重试只补第二步：只发 lexicon.edit，绝不重复 confirm。 */
    async function lexiconRetryStep({ dialog, act }) {
      const entryId = String(dialog?.retryId ?? '').trim();
      if (entryId === '') return { stage: 'skipped' };
      const result = await act(lexiconWrongFormsBody(dialog, entryId), 'lexicon-edit');
      if (result?.ok !== true) {
        return { stage: 'partial', entryId, notice: lexiconPartialNotice(lexiconFailureReason(result)) };
      }
      return { stage: 'done' };
    }

    /**
     * 结果落到弹窗：只有全部成功才关闭；部分成功保留内容 + 重试入口并照常刷新列表
     * （confirm 已生效）；第一步失败只显示错误，不刷新、不关闭。
     */
    async function settleLexiconSave({ dialog, outcome, setDialog, loadLexicon, show }) {
      const stage = outcome?.stage ?? 'skipped';
      if (stage === 'skipped') return;
      if (stage === 'failed') {
        setDialog((current) => (current === null ? current : { ...current, error: outcome.error }));
        return;
      }
      if (stage === 'partial') {
        setDialog((current) => (current === null ? current : {
          ...current, retryId: outcome.entryId, notice: outcome.notice, error: '',
        }));
        await loadLexicon();
        return;
      }
      setDialog(null);
      await loadLexicon();
      if (typeof show === 'function') {
        show(dialog?.mode === 'edit' ? '词库已更新' : `已确认「${dialog?.canonical || dialog?.text}」`);
      }
    }

    /** 关闭弹窗：部分成功时刷新列表并保留提示，不假装完整成功。 */
    async function closeLexiconDialogState({ dialog, setDialog, loadLexicon, show }) {
      setDialog(null);
      if (String(dialog?.retryId ?? '') === '') return;
      await loadLexicon();
      if (typeof show === 'function') {
        show(`已确认「${dialog?.canonical || dialog?.text}」，误识别形式未保存`);
      }
    }

    function lexiconSection(h, {
      data, busy, dialog, pending, speakerId, confirmedSelfId, draft,
    }, handlers) {
      const loading = data === null || data === undefined || data.loading === true;
      // `entries` 是管理列表：只显示已确认的词条（契约给 status，旧形状没有时也接受）。
      const entries = (Array.isArray(data?.entries) ? data.entries : [])
        .filter((entry) => entry?.status === undefined || entry.status === 'confirmed');
      const unassigned = Array.isArray(data?.unassigned) ? data.unassigned : [];
      const error = String(data?.error ?? '');
      const stopped = busy !== '';
      // 身份只是可选来源：没有也不影响确认，只在请求体里「有则带」。
      const selfId = String(speakerId ?? '');
      // 声纹库只对“已确认本人”生效。这个 id 来自 enrollment 的确认条目，不是影子猜测或设置提示。
      const voiceprintReady = String(confirmedSelfId ?? '').trim().length > 0;
      const newDraft = draft ?? lexiconEmptyDraft();
      const draftText = String(newDraft?.text ?? '');
      const draftCategory = String(newDraft?.category ?? '');
      // 声纹不可用时，草稿里的 voiceprint 退回公共库，绝不提交一个会被宿主拒绝的库位。
      const draftLibrary = voiceprintReady && String(newDraft?.library ?? '') === 'voiceprint'
        ? 'voiceprint'
        : 'public';
      const addBlocked = stopped
        || draftText.trim() === '';
      const isPending = (kind, id) => pending?.kind === kind && String(pending?.id ?? '') === String(id);
      const evidenceText = (entry) => {
        const count = Number(entry?.count);
        if (Number.isFinite(count) && count > 0) return `出现 ${count} 次`;
        const sources = Array.isArray(entry?.sourceIds) ? entry.sourceIds.length : 0;
        return sources > 0 ? `出现 ${sources} 次` : '';
      };
      const metaText = (entry) => [evidenceText(entry), lexiconTimeText(entry?.at)]
        .filter((text) => text !== '').join(' · ');

      const candidateRow = (entry) => h('div', {
        key: String(entry?.id ?? ''),
        'data-lexicon-candidate': String(entry?.id ?? ''),
        style: { padding: '6px 0', borderTop: `1px dashed ${BORDER}` },
      },
        h('div', { style: styles.row },
          h('span', { style: styles.label },
            String(entry?.text ?? '（空）'),
            h('span', { style: styles.badge }, lexiconKindLabel(entry?.kind))),
          h('span', { style: styles.mono }, metaText(entry))),
        h('div', { style: styles.row },
          h('button', {
            style: { ...styles.btnPrimary, ...(stopped ? styles.off : {}) },
            disabled: stopped,
            onClick: () => handlers.openConfirm(entry),
          }, '确认'),
          isPending('ignore', entry?.id)
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: styles.value }, '确认忽略？'),
                h('button', {
                  style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void handlers.ignore(entry?.id),
                }, '确认忽略'),
                h('button', {
                  style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => handlers.cancelWrite(),
                }, '取消'))
            : h('button', {
                style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                disabled: stopped,
                onClick: () => handlers.askIgnore(entry?.id),
              }, '忽略'),
          isPending('remove', entry?.id)
            ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: styles.value }, '确认删除？'),
                h('button', {
                  style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => void handlers.remove(entry?.id),
                }, '确认删除'),
                h('button', {
                  style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => handlers.cancelWrite(),
                }, '取消'))
            : h('button', {
                style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                disabled: stopped,
                onClick: () => handlers.askRemove(entry?.id),
              }, '删除')));

      const wordRow = (entry) => {
        const library = String(entry?.library ?? 'public') === 'voiceprint' ? 'voiceprint' : 'public';
        const targetLibrary = library === 'public' ? 'voiceprint' : 'public';
        // Moving back to public is always available (it only releases ownership); moving into
        // voiceprint needs a confirmed self.
        const targetReady = targetLibrary === 'public' || voiceprintReady;
        const forms = Array.isArray(entry?.wrongForms) ? entry.wrongForms : [];
        return h('div', {
          key: String(entry?.id ?? ''),
          'data-lexicon-entry': String(entry?.id ?? ''),
          'data-lexicon-library': library,
          style: { padding: '6px 0', borderTop: `1px dashed ${BORDER}` },
        },
          h('div', { style: styles.row },
            h('span', { style: styles.label },
              String(entry?.canonical ?? '') || String(entry?.text ?? '') || '（空）',
              h('span', { style: styles.badge }, lexiconCategoryLabel(entry?.category)),
              h('span', { style: styles.badge }, lexiconLibraryLabel(library))),
            h('span', { style: styles.mono }, `确认于 ${lexiconTimeText(entry?.confirmedAt ?? entry?.at)}`)),
          h('div', { style: styles.hint },
            `用法：${String(entry?.usage ?? '').trim() || '—'}`),
          String(entry?.reading ?? '').trim() === ''
            ? null
            : h('div', { style: styles.hint }, `读音：${String(entry.reading).trim()}`),
          forms.length === 0
            ? null
            : h('div', { style: styles.hint }, `误识别形式：${forms.join(' / ')}`),
          h('div', { style: styles.row },
            h('button', {
              'data-lexicon-edit': String(entry?.id ?? ''),
              style: { ...styles.btn, ...(stopped ? styles.off : {}) },
              disabled: stopped,
              onClick: () => handlers.openEdit(entry),
            }, '编辑'),
            h('button', {
              'data-lexicon-move': targetLibrary,
              style: { ...styles.btn, ...(stopped || !targetReady ? styles.off : {}) },
              disabled: stopped || !targetReady,
              title: targetReady ? '' : '声纹库只对已确认本人开放：请先完成本人声纹确认',
              onClick: () => void handlers.move(entry?.id, targetLibrary),
            }, targetLibrary === 'voiceprint' ? '移到声纹库' : '移到公共库'),
            isPending('remove', entry?.id)
              ? h('span', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { style: styles.value }, '确认删除？'),
                  h('button', {
                    style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                    disabled: stopped,
                    onClick: () => void handlers.remove(entry?.id),
                  }, '确认删除'),
                  h('button', {
                    style: { ...styles.btn, ...(stopped ? styles.off : {}) },
                    disabled: stopped,
                    onClick: () => handlers.cancelWrite(),
                  }, '取消'))
              : h('button', {
                  style: { ...styles.btnDanger, ...(stopped ? styles.off : {}) },
                  disabled: stopped,
                  onClick: () => handlers.askRemove(entry?.id),
                }, '删除')));
      };

      const editing = dialog?.mode === 'edit';
      const forms = Array.isArray(dialog?.wrongForms) ? dialog.wrongForms : [];
      const canonical = String(dialog?.canonical ?? '');
      const dialogCategory = String(dialog?.category ?? '').trim();
      const dialogUsage = String(dialog?.usage ?? '');
      const dialogReading = String(dialog?.reading ?? '');
      const dialogLibrary = String(dialog?.library ?? 'public') === 'voiceprint' ? 'voiceprint' : 'public';
      // 第一步（confirm）已生效、第二步（补存误识别形式）失败：保留内容，换成重试入口。
      const notice = String(dialog?.notice ?? '');
      const retryId = String(dialog?.retryId ?? '');
      const partial = notice !== '' && !editing;
      const saveBlocked = stopped || canonical.trim() === '';
      const dialogNode = h('div', {
        'data-lexicon-dialog': editing ? 'edit' : 'confirm',
        'data-lexicon-partial': partial ? '1' : undefined,
        style: styles.overlay,
      },
        h('div', { style: styles.dialog },
          h('div', { style: styles.title }, editing
            ? `编辑「${canonical || String(dialog?.text ?? '')}」`
            : `确认候选「${String(dialog?.text ?? '')}」`),
          h('div', { style: styles.hint }, editing
            ? '修改词、类别、用法、读音或库位；不改状态、不改写历史记录。公共库所有人可用，声纹库只对已确认本人生效。'
            : '确认后这一条会进入公共词库，所有人说话时的识别与替换都可使用；声纹只是可选的来源标注，不是确认门槛。'),
          h('div', { style: styles.field },
            h('span', { style: styles.value }, editing ? '词或短语' : '正确写法'),
            h('input', {
              'data-lexicon-dialog-text': '1',
              style: styles.input,
              value: canonical,
              placeholder: '例如：向晚',
              // 部分成功时正确写法已经随 confirm 保存，这里只剩误识别形式待补存。
              disabled: stopped || partial,
              title: partial ? '正确写法已随确认保存；重试只补存误识别形式' : '',
              onChange: (event) => handlers.changeDialog({ canonical: event.target.value }),
            })),
          editing
            ? h('div', { style: styles.field },
                h('span', { style: styles.value }, '类别'),
                h('input', {
                  'data-lexicon-dialog-category': '1',
                  style: styles.input,
                  value: dialogCategory,
                  list: LEXICON_CATEGORY_SUGGESTIONS_DIALOG,
                  placeholder: LEXICON_CATEGORY_PLACEHOLDER,
                  title: '可填任意类别，空格分隔多个，如：人物 动画；留空按“未知”保存',
                  disabled: stopped,
                  onChange: (event) => handlers.changeDialog({ category: event.target.value }),
                }),
                lexiconCategoryDatalist(h, LEXICON_CATEGORY_SUGGESTIONS_DIALOG))
            : null,
          editing
            ? h('div', { style: styles.field },
                h('span', { style: styles.value }, '库位'),
                h('select', {
                  'data-lexicon-dialog-library': '1',
                  style: styles.input,
                  value: dialogLibrary,
                  disabled: stopped,
                  onChange: (event) => handlers.changeDialog({ library: event.target.value }),
                },
                  h('option', { key: 'public', value: 'public' }, '公共库（所有人可用）'),
                  h('option', {
                    key: 'voiceprint',
                    value: 'voiceprint',
                    disabled: !voiceprintReady,
                  }, voiceprintReady ? '声纹库（仅本人可用）' : '声纹库（需先确认本人声纹）')),
                h('div', { style: styles.hint }, voiceprintReady
                  ? '声纹库词条只对已确认本人生效；移回公共库会清空归属。'
                  : '尚无已确认本人声纹：只能使用公共库。'))
            : null,
          editing
            ? h('div', { style: styles.field },
                h('span', { style: styles.value }, '用法（可留空）'),
                h('input', {
                  'data-lexicon-dialog-usage': '1',
                  style: styles.input,
                  value: dialogUsage,
                  placeholder: '例如：指陪我聊一会，不是给设备充电',
                  disabled: stopped,
                  onChange: (event) => handlers.changeDialog({ usage: event.target.value }),
                }))
            : null,
          editing
            ? h('div', { style: styles.field },
                h('span', { style: styles.value }, '读音（可选，可留空）'),
                h('input', {
                  'data-lexicon-dialog-reading': '1',
                  style: styles.input,
                  value: dialogReading,
                  placeholder: '可填拼音，无需声调，如 chong dian',
                  disabled: stopped,
                  onChange: (event) => handlers.changeDialog({ reading: event.target.value }),
                }))
            : null,
          editing
            ? null
            : h('div', { style: styles.field },
                h('span', { style: styles.value }, '当前出现过的误识别形式（可删减）'),
                forms.length === 0
                  ? h('div', { style: styles.hint }, '没有已记录的误识别形式')
                  : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                      forms.map((form, index) => h('span', {
                        key: `${index}:${String(form)}`,
                        style: { ...styles.badge, marginLeft: 0, display: 'inline-flex', alignItems: 'center', gap: 4 },
                      },
                        String(form),
                        h('button', {
                          'data-lexicon-remove-form': String(index),
                          style: { fontSize: 12, lineHeight: 1, padding: '0 3px', border: 'none', background: 'transparent', color: DANGER, cursor: 'pointer' },
                          disabled: stopped,
                          title: '删除该误识别形式',
                          onClick: () => handlers.removeWrongForm(index),
                        }, '×'))))),
          String(dialog?.error ?? '') === ''
            ? null
            : h('div', { style: { ...styles.hint, color: DANGER } }, String(dialog?.error ?? '')),
          partial
            ? h('div', { 'data-lexicon-notice': '1', style: { ...styles.hint, color: DANGER } }, notice)
            : null,
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
            partial
              ? h('button', {
                  'data-lexicon-retry': '1',
                  style: { ...styles.btnPrimary, ...(stopped || retryId === '' ? styles.off : {}) },
                  disabled: stopped || retryId === '',
                  title: '只重试保存误识别形式，不会重复确认',
                  onClick: () => void handlers.retrySave(dialog),
                }, '重试保存')
              : h('button', {
                  style: { ...styles.btnPrimary, ...(saveBlocked ? styles.off : {}) },
                  disabled: saveBlocked,
                  onClick: () => void handlers.saveDialog(dialog, selfId),
                }, editing ? '保存修改' : '确认'),
            h('button', {
              style: { ...styles.btn, ...(stopped ? styles.off : {}) },
              disabled: stopped,
              onClick: () => void handlers.closeDialog(dialog),
            }, partial ? '关闭' : '取消')),
        ));

      return h('div', { 'data-settings-group': 'lexicon', style: styles.group },
        h('div', { style: styles.groupTitleRow },
          h('span', { style: styles.groupTitle }, '词库（公共 / 声纹）'),
          h('button', { style: styles.btn, disabled: stopped, onClick: handlers.refresh }, '刷新')),
        h('div', { style: styles.hint }, '公共库：所有说话人都会使用；声纹库：只对已确认本人（enrollment.selfId）生效。声纹不是添加或确认公共词条的门槛。'),
        h('div', { style: styles.hint }, voiceprintReady
          ? '已确认本人声纹：声纹库可用，个人词条不会进入其他人的识别列表。'
          : '尚未确认本人声纹：只能使用公共库，声纹库选项已禁用。'),
        h('div', { style: styles.hint }, '自动提取候选默认关闭；已有候选仍可确认或删除。'),
        error === '' ? null : h('div', { style: { ...styles.hint, color: DANGER } }, `语言库不可用：${error}`),
        loading
          ? h('div', { style: styles.hint }, '正在读取语言库…')
          : h('div', {},
              h('div', { 'data-lexicon-new-form': '1', style: { marginTop: 8, padding: '8px 0', borderTop: `1px dashed ${BORDER}` } },
                h('div', { style: styles.label }, '新建词条'),
                h('div', { style: styles.field },
                  h('span', { style: styles.value }, '词或短语'),
                  h('input', {
                    'data-lexicon-new-text': '1',
                    style: styles.input,
                    value: draftText,
                    placeholder: '例如：充电',
                    disabled: stopped,
                    onChange: (event) => handlers.changeDraft({ text: event.target.value }),
                  })),
                h('div', { style: styles.field },
                  h('span', { style: styles.value }, '类别'),
                  h('input', {
                    'data-lexicon-new-category': '1',
                    style: styles.input,
                    value: draftCategory,
                    list: LEXICON_CATEGORY_SUGGESTIONS_NEW,
                    placeholder: LEXICON_CATEGORY_PLACEHOLDER,
                    title: '可填任意类别，空格分隔多个，如：人物 动画；留空按“未知”保存',
                    disabled: stopped,
                    onChange: (event) => handlers.changeDraft({ category: event.target.value }),
                  }),
                  lexiconCategoryDatalist(h, LEXICON_CATEGORY_SUGGESTIONS_NEW)),
                h('div', { style: styles.field },
                  h('span', { style: styles.value }, '库位'),
                  h('select', {
                    'data-lexicon-new-library': '1',
                    style: styles.input,
                    value: draftLibrary,
                    disabled: stopped,
                    onChange: (event) => handlers.changeDraft({ library: event.target.value }),
                  },
                    h('option', { key: 'public', value: 'public' }, '公共库（所有人可用）'),
                    h('option', {
                      key: 'voiceprint',
                      value: 'voiceprint',
                      disabled: !voiceprintReady,
                    }, voiceprintReady ? '声纹库（仅本人可用）' : '声纹库（需先确认本人声纹）')),
                  h('div', { style: styles.hint }, '声纹库只对已确认本人生效；未确认时请用公共库。')),
                h('div', { style: styles.field },
                  h('span', { style: styles.value }, '用法（可留空）'),
                  h('input', {
                    'data-lexicon-new-usage': '1',
                    style: styles.input,
                    value: String(newDraft?.usage ?? ''),
                    placeholder: '例如：指陪我聊一会，不是给设备充电',
                    disabled: stopped,
                    onChange: (event) => handlers.changeDraft({ usage: event.target.value }),
                  })),
                h('div', { style: styles.field },
                  h('span', { style: styles.value }, '读音（可选，可留空）'),
                  h('input', {
                    'data-lexicon-new-reading': '1',
                    style: styles.input,
                    value: String(newDraft?.reading ?? ''),
                    placeholder: '可填拼音，无需声调，如 chong dian',
                    disabled: stopped,
                    onChange: (event) => handlers.changeDraft({ reading: event.target.value }),
                  })),
                String(newDraft?.error ?? '') === ''
                  ? null
                  : h('div', { style: { ...styles.hint, color: DANGER } }, String(newDraft.error)),
                h('div', { style: styles.row },
                  h('button', {
                    'data-lexicon-add': '1',
                    style: { ...styles.btnPrimary, ...(addBlocked ? styles.off : {}) },
                    disabled: addBlocked,
                    onClick: () => void handlers.add({ ...newDraft, library: draftLibrary }),
                  }, '添加词条'))),
              h('div', { style: { ...styles.label, marginTop: 8 } }, `待确认候选（${unassigned.length}）`),
              unassigned.length === 0
                ? h('div', { style: styles.hint }, '没有待确认的候选')
                : h('div', { style: { maxHeight: 220, overflowY: 'auto' } }, unassigned.map(candidateRow)),
              h('div', { style: { ...styles.label, marginTop: 10 } }, `全部词条（${entries.length}）`),
              entries.length === 0
                ? h('div', { style: styles.hint }, '词库还是空的')
                : h('div', { style: { maxHeight: 220, overflowY: 'auto' } }, entries.map(wordRow))),
        dialog === null || dialog === undefined ? null : dialogNode,
      );
    }

    // ---- 声纹登记（客户端） -------------------------------------------------------------
    // 只按宿主契约读写：speaker.enroll.list / .confirm / .reject / .remove + speaker.status.shadow。
    // 一次挂载读一次，之后只有「刷新」再读：没有定时器、不自动确认、不自动拒绝；影子判定只展示，
    // 不参与拒收、打断或投递。接口缺失、超时、畸形字段都只变成一行提示，不向渲染抛出。
    const SPEAKER_ENROLL_READ_TIMEOUT_MS = 4000;
    const SPEAKER_ENROLL_MIN_TOTAL_MS = 3000;
    const SPEAKER_ENROLL_STATUS_TEXT = Object.freeze({
      pending: '待确认',
      confirmed: '已确认',
      rejected: '已拒绝',
    });
    const SPEAKER_ENROLL_DECISION_TEXT = Object.freeze({
      match: '匹配',
      mismatch: '不匹配',
      unsure: '不确定',
      'no-speakers': '无声纹',
    });
    const SPEAKER_ENROLL_CLASS_TEXT = Object.freeze({
      self: '本人',
      other: '他人',
      'unknown-identity': '身份未知',
    });
    const SPEAKER_ENROLL_QUALITY_TEXT = Object.freeze({
      ok: '清晰',
      short: '太短',
      quiet: '太轻',
      noisy: '噪声',
    });
    const SPEAKER_ENROLL_MISSING_RE = /not implemented|unknown action|unsupported|未实现|不支持/iu;
    const SPEAKER_ENROLL_RECORD_HINT =
      '现在不再需要专门「说三句话」：开启听觉页的「声纹影子」后，正常说话会自动进入下方候选；试听、勾选后点「建立基础声纹」才生效。';
    const SPEAKER_ENROLL_CONFIRM_NOTICE =
      '已确认：之后只用于词库与新增记忆归属，不用于拒收/打断。';

    /** 只接受普通对象；数组 / null / 原始值一律当作「没有结果」。 */
    const speakerEnrollObject = (value) => (
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    );

    const speakerEnrollText = (...values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      }
      return '';
    };

    const speakerEnrollNumber = (...values) => {
      for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };

    /** 样本数：契约是数字；宿主误传数组时按长度算，其它畸形值按 0。 */
    const speakerEnrollSamples = (value, fallback) => {
      const source = value === null || value === undefined ? fallback : value;
      if (Array.isArray(source)) return source.length;
      const number = speakerEnrollNumber(source);
      return number === null || number < 0 ? 0 : Math.round(number);
    };

    /** 总时长：优先 totalDurationMs；缺失时退回样本数组里各条 durationMs 之和。 */
    const speakerEnrollTotalMs = (entry) => {
      const direct = speakerEnrollNumber(entry?.totalDurationMs, entry?.durationMs);
      if (direct !== null) return Math.max(0, Math.round(direct));
      const samples = Array.isArray(entry?.samples) ? entry.samples : [];
      const sum = samples.reduce((total, item) => total + (speakerEnrollNumber(item?.durationMs) ?? 0), 0);
      return Math.max(0, Math.round(sum));
    };

    const speakerEnrollDurationText = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} 秒`;

    /** 受控词表里的中文名；键不在词表里时原样显示（不猜测含义）。 */
    const speakerEnrollLabel = (table, key, fallback = '') => (
      typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : (key || fallback)
    );

    /** 一条登记记录：字段缺失或畸形都降级为默认值，渲染永远拿得到同样的字段。 */
    function speakerEnrollEntryOf(value, index) {
      const entry = speakerEnrollObject(value);
      if (entry === null) return null;
      const speakerId = speakerEnrollText(entry.speakerId, entry.id);
      if (speakerId === '') return null;
      const status = speakerEnrollText(entry.status).toLowerCase();
      const totalDurationMs = speakerEnrollTotalMs(entry);
      return {
        key: `${speakerId}#${index}`,
        speakerId,
        label: speakerEnrollText(entry.label),
        status,
        statusText: speakerEnrollLabel(SPEAKER_ENROLL_STATUS_TEXT, status, '未知状态'),
        samples: speakerEnrollSamples(entry.samples, entry.sampleCount),
        totalDurationMs,
        confirmedAt: speakerEnrollText(entry.confirmedAt),
        confirmable: totalDurationMs >= SPEAKER_ENROLL_MIN_TOTAL_MS,
      };
    }

    /** 卡片的主条目：优先本人已确认，其次任一已确认，再其次待确认，最后第一行。 */
    function speakerEnrollPrimary(entries, selfId) {
      const confirmedSelf = entries.find(
        (entry) => entry.status === 'confirmed' && selfId !== '' && entry.speakerId === selfId,
      );
      return confirmedSelf
        ?? entries.find((entry) => entry.status === 'confirmed')
        ?? entries.find((entry) => entry.status === 'pending')
        ?? entries[0]
        ?? null;
    }

    /** 最近一条影子判定：decision 缺失视为「暂无样本」，其余字段全部可选。 */
    function speakerEnrollLastShadowOf(value) {
      const shadow = speakerEnrollObject(value);
      if (shadow === null) return null;
      const decision = speakerEnrollText(shadow.decision);
      if (decision === '') return null;
      const classKey = speakerEnrollText(shadow.class);
      const qualityKey = speakerEnrollText(shadow.quality);
      return {
        decision,
        decisionText: speakerEnrollLabel(SPEAKER_ENROLL_DECISION_TEXT, decision),
        class: classKey,
        classText: classKey === '' ? '' : speakerEnrollLabel(SPEAKER_ENROLL_CLASS_TEXT, classKey),
        quality: qualityKey,
        qualityText: qualityKey === '' ? '' : speakerEnrollLabel(SPEAKER_ENROLL_QUALITY_TEXT, qualityKey),
        score: speakerEnrollNumber(shadow.score),
        speakerId: speakerEnrollText(shadow.speakerId),
        at: speakerEnrollText(shadow.at),
      };
    }

    /** 三类计数：缺字段 / 负数 / 非数字都按 0；兼容旧宿主用的 matches 字段名。 */
    function speakerEnrollCountsOf(value) {
      const counts = speakerEnrollObject(value) ?? {};
      const count = (...keys) => {
        for (const key of keys) {
          const number = speakerEnrollNumber(counts[key]);
          if (number !== null) return number < 0 ? 0 : Math.round(number);
        }
        return 0;
      };
      return {
        match: count('match', 'matches'),
        mismatch: count('mismatch'),
        unsure: count('unsure'),
      };
    }

    /** 接口不存在（或返回受控的「未实现」）时换成一句用户能看懂的提示。 */
    const speakerEnrollMissingText = (text) => (
      SPEAKER_ENROLL_MISSING_RE.test(text) ? '需要宿主支持声纹登记（宿主还没有实现这些动作）' : text
    );

    /**
     * 读取结果 → 卡片视图。`data` 是 Panel 的 { list, shadow, loading, error, at }；一处坏字段
     * 只影响它自己那一行，整块失败显示「不可用」。
     */
    function speakerEnrollView(data) {
      const list = speakerEnrollObject(data?.list);
      const shadow = speakerEnrollObject(data?.shadow);
      const available = list !== null && list.ok === true;
      const entries = (Array.isArray(list?.entries) ? list.entries : [])
        .map((value, index) => speakerEnrollEntryOf(value, index))
        .filter((entry) => entry !== null);
      const selfId = speakerEnrollText(list?.selfId);
      const primary = available ? speakerEnrollPrimary(entries, selfId) : null;
      const listError = speakerEnrollText(list?.error, list?.reason, data?.error);
      return {
        available,
        loading: data === null || data === undefined || data.loading === true,
        error: listError === '' ? '' : speakerEnrollMissingText(listError),
        at: speakerEnrollNumber(data?.at) ?? 0,
        selfId,
        entries,
        primary,
        empty: available && entries.length === 0,
        stateText: available ? (primary === null ? '未登记' : primary.statusText) : '不可用',
        shadow: {
          available: shadow !== null && shadow.ok === true,
          error: speakerEnrollText(shadow?.error, shadow?.reason),
          last: speakerEnrollLastShadowOf(shadow?.lastShadow),
          counts: speakerEnrollCountsOf(shadow?.counts),
        },
      };
    }

    /** 确认按钮为什么不能点：'' 表示可点。只看样本时长和状态，不做任何身份推断。 */
    function speakerEnrollConfirmReason(entry) {
      if (entry === null) return '还没有可确认的条目';
      if (entry.status === 'confirmed') return '已确认，不用重复确认';
      if (entry.status === 'rejected') return '已拒绝的条目不能再确认';
      if (entry.totalDurationMs < SPEAKER_ENROLL_MIN_TOTAL_MS) {
        return `样本不足 3 秒（已 ${speakerEnrollDurationText(entry.totalDurationMs)}）`;
      }
      return '';
    }

    /** 一次显式动作的结果文案；成功确认固定说明只用于词库与新增记忆归属。 */
    function speakerEnrollOutcome(op, result) {
      if (result?.ok === true) {
        if (op === 'confirm') return { ok: true, message: SPEAKER_ENROLL_CONFIRM_NOTICE };
        if (op === 'reject') return { ok: true, message: '已拒绝该条目：不参与任何判定。' };
        return { ok: true, message: '已删除该条目。' };
      }
      const reason = speakerEnrollText(result?.reason, result?.error, result?.code);
      if (reason === 'insufficient-samples') return { ok: false, message: '样本不足 3 秒，暂时不能确认' };
      if (reason === '') return { ok: false, message: '操作失败' };
      const missing = speakerEnrollMissingText(reason);
      return { ok: false, message: missing === reason ? `操作失败：${reason}` : missing };
    }

    /** 报告里只保留像 id 的值：路径 / 空白一律打码，标签文本与样本 id 根本不进报告。 */
    const speakerEnrollReportId = (value) => {
      const text = speakerEnrollText(value);
      if (text === '') return '';
      return /[\\/\s]|^[A-Za-z]:/u.test(text) ? '<redacted>' : text;
    };

    /** 复制用的脱敏报告：只有状态、计数和分数，没有标签文本、样本 id、路径或任何转写。 */
    function speakerEnrollReportOf(data) {
      const view = speakerEnrollView(data);
      const last = view.shadow.last;
      return JSON.stringify({
        schema: 1,
        kind: 'speaker-enrollment',
        selfId: speakerEnrollReportId(view.selfId),
        entries: view.entries.map((entry) => ({
          speakerId: speakerEnrollReportId(entry.speakerId),
          status: entry.status === '' ? 'unknown' : entry.status,
          samples: entry.samples,
          totalDurationMs: entry.totalDurationMs,
          confirmed: entry.confirmedAt !== '',
        })),
        shadow: {
          last: last === null ? null : {
            decision: speakerEnrollReportId(last.decision),
            class: speakerEnrollReportId(last.class),
            quality: speakerEnrollReportId(last.quality),
            score: last.score,
            speakerId: speakerEnrollReportId(last.speakerId),
            at: speakerEnrollReportId(last.at),
          },
          counts: view.shadow.counts,
        },
      }, null, 2);
    }

    /** 一次读取两个只读动作（list + shadow）；超时 / 异常都收成 {ok:false}，不向渲染抛出。 */
    async function speakerEnrollRead(fetchImpl, timeoutMs = SPEAKER_ENROLL_READ_TIMEOUT_MS) {
      if (typeof fetchImpl !== 'function') {
        return { list: null, shadow: null, error: '当前环境没有 fetch' };
      }
      const post = async (body) => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl('/assistant/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(body),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const result = await response.json();
          return speakerEnrollObject(result) ?? { ok: false, error: '返回不是对象' };
        } catch (cause) {
          const aborted = cause !== null && typeof cause === 'object' && cause.name === 'AbortError';
          return {
            ok: false,
            error: aborted ? '请求超时' : (cause && cause.message ? cause.message : String(cause)),
          };
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      };
      const [list, shadow] = await Promise.all([
        post({ action: 'speaker.enroll.list' }),
        post({ action: 'speaker.status.shadow' }),
      ]);
      return { list, shadow, error: '' };
    }

    // ---- 声纹候选（客户端） -------------------------------------------------------------
    // 候选只是「听见过的话」：渲染与试听不写库、不确认、不把候选 speakerId 当成本人。只有用户
    // 勾选后点「建立基础声纹」才调用一次宿主 build；失败时保留勾选并显示受控原因，不自动重试。
    const SPEAKER_CANDIDATE_READ_TIMEOUT_MS = 4000;
    const SPEAKER_CANDIDATE_LABEL_MAX_CHARS = 40;
    const SPEAKER_CANDIDATE_NOTICE =
      '只有你确认后才生效：试听后勾选候选，点「建立基础声纹」才会写入本人声纹；不会自动认领。';
    const SPEAKER_TEMPLATE_NOTICE =
      '版本链最多保留 20 个版本；强化和回滚都只在你点击后发生，不会自动强化，也不会自动确认 self。';

    /** 一条候选：字段缺失只降级这一行；embedding / audioPath 根本不会到达客户端。 */
    function speakerCandidateOf(value, index) {
      const entry = speakerEnrollObject(value);
      if (entry === null) return null;
      const id = speakerEnrollText(entry.id, entry.candidateId, entry.utteranceId);
      if (id === '') return null;
      return {
        key: `${id}#${index}`,
        id,
        durationMs: Math.max(0, Math.round(speakerEnrollNumber(entry.durationMs, entry.totalDurationMs) ?? 0)),
        at: speakerEnrollText(entry.at),
        text: typeof entry.text === 'string' ? entry.text.trim() : '',
        groupId: speakerEnrollText(entry.groupId),
        // Older hosts may omit the flag; only an explicit false disables retry/试听.
        audioAvailable: entry.audioAvailable !== false,
      };
    }

    /** 候选按宿主给的 groupId 分组；没有 groupId 的行放进「未分组」。只做展示。 */
    function speakerCandidateGroupsOf(candidates) {
      const groups = new Map();
      for (const candidate of candidates) {
        const key = candidate.groupId === '' ? '__ungrouped' : candidate.groupId;
        if (!groups.has(key)) groups.set(key, { key, candidates: [] });
        groups.get(key).candidates.push(candidate);
      }
      return [...groups.values()].map((group, index) => ({
        ...group,
        label: group.key === '__ungrouped' ? '未分组' : `分组 ${index + 1}`,
      }));
    }

    /** 读取结果 → 候选视图。列表不可用与「确实 0 条」必须区分。 */
    function speakerCandidateView(data) {
      const list = speakerEnrollObject(data?.list);
      const available = list !== null && list.ok === true;
      const candidates = (Array.isArray(list?.candidates) ? list.candidates : [])
        .map((value, index) => speakerCandidateOf(value, index))
        .filter((candidate) => candidate !== null);
      const groups = speakerCandidateGroupsOf(candidates);
      const library = speakerEnrollObject(list?.library);
      const listCount = speakerEnrollNumber(list?.count);
      const listedGroups = speakerEnrollNumber(list?.groupCount);
      const template = speakerEnrollObject(list?.template);
      const templateAvailable = template?.ok === true;
      const templateVersions = (Array.isArray(template?.versions) ? template.versions : [])
        .map((value) => {
          const record = speakerEnrollObject(value);
          if (record === null) return null;
          const version = speakerEnrollNumber(record.version);
          if (version === null || version < 1) return null;
          return {
            version: Math.round(version),
            sampleCount: Math.max(0, Math.round(speakerEnrollNumber(record.sampleCount) ?? 0)),
            totalDurationMs: Math.max(0, Math.round(speakerEnrollNumber(record.totalDurationMs) ?? 0)),
            createdAt: speakerEnrollText(record.createdAt),
            reason: speakerEnrollText(record.reason),
            parentVersion: speakerEnrollNumber(record.parentVersion),
          };
        })
        .filter((record) => record !== null);
      const listedCurrent = speakerEnrollNumber(template?.currentVersion);
      const templateCurrentVersion = listedCurrent === null || listedCurrent < 1
        ? null
        : Math.round(listedCurrent);
      const templateCurrent = templateVersions.find(
        (record) => record.version === templateCurrentVersion,
      ) ?? null;
      const error = speakerEnrollText(list?.error, list?.reason, data?.error);
      return {
        available,
        loading: data === null || data === undefined || data.loading === true,
        error: error === '' ? '' : speakerEnrollMissingText(error),
        count: listCount === null || listCount < 0 ? candidates.length : Math.round(listCount),
        groupCount: listedGroups === null || listedGroups < 0 ? groups.length : Math.round(listedGroups),
        candidates,
        groups,
        selfId: speakerEnrollText(list?.selfId),
        libraryPresent: library?.present === true,
        libraryLabel: speakerEnrollText(library?.label),
        libraryEnabled: library?.enabled === true,
        templateAvailable,
        templateVersions,
        templateCurrentVersion,
        templateCurrent,
        templateCanRollback: template?.canRollback === true,
      };
    }

    /** 一次显式候选动作的结果文案；inconsistent 会点名疑似异常的候选 id。 */
    function speakerCandidateOutcome(op, result) {
      if (result?.ok === true) {
        if (op === 'audio') return { ok: true, message: '试听已加载。' };
        if (op === 'remove') return { ok: true, message: '已删除这个候选（含试听音频）。' };
        if (op === 'clear') {
          const removed = speakerEnrollNumber(result.removed);
          return { ok: true, message: `已清空候选${removed === null ? '' : `（${removed} 条）`}。` };
        }
        if (op === 'build') {
          const count = speakerEnrollNumber(result.sampleCount);
          const total = speakerEnrollNumber(result.totalDurationMs);
          return {
            ok: true,
            message: `已建立基础声纹${count === null ? '' : `：${count} 条候选`}`
              + `${total === null ? '' : ` · ${speakerEnrollDurationText(total)}`}。${SPEAKER_CANDIDATE_NOTICE}`,
          };
        }
        if (op === 'rename') return { ok: true, message: '已重命名；speakerId 不变。' };
        if (op === 'strengthen') {
          const version = speakerEnrollNumber(result.version);
          const count = speakerEnrollNumber(result.sampleCount);
          const total = speakerEnrollNumber(result.totalDurationMs);
          return {
            ok: true,
            message: `已强化当前声纹${version === null ? '' : `：v${Math.round(version)}`}`
              + `${count === null ? '' : ` · 累计 ${count} 条样本`}`
              + `${total === null ? '' : ` · ${speakerEnrollDurationText(total)}`}。${SPEAKER_TEMPLATE_NOTICE}`,
          };
        }
        if (op === 'rollback') {
          const version = speakerEnrollNumber(result.currentVersion);
          return {
            ok: true,
            message: `已回滚到${version === null ? '所选版本' : ` v${Math.round(version)}`}；库声纹已同步，历史版本仍保留。`,
          };
        }
        if (op === 'preview') {
          const count = speakerEnrollNumber(result.sampleCount);
          const total = speakerEnrollNumber(result.totalDurationMs);
          const floor = speakerEnrollNumber(result.minPairCosine);
          return {
            ok: true,
            message: '一致性预览通过'
              + (count === null ? '' : `：${count} 条`)
              + (total === null ? '' : ` · ${speakerEnrollDurationText(total)}`)
              + (floor === null ? '' : ` · 最低相似度 ${floor.toFixed(2)}`)
              + '。',
          };
        }
        return { ok: true, message: '已完成。' };
      }
      const reason = speakerEnrollText(result?.reason, result?.error, result?.code);
      if (reason === 'inconsistent') {
        const outliers = (Array.isArray(result?.outlierIds) ? result.outlierIds : [])
          .map((id) => speakerEnrollText(id))
          .filter((id) => id !== '')
          .slice(0, 5);
        return {
          ok: false,
          message: `候选不一致，未写入${outliers.length === 0 ? '' : `：疑似异常 ${outliers.join('、')}`}。`,
        };
      }
      if (reason === 'insufficient-samples') {
        const total = speakerEnrollNumber(result?.totalDurationMs) ?? 0;
        return {
          ok: false,
          message: `样本总时长不足 3 秒（已 ${speakerEnrollDurationText(total)}），未写入。`,
        };
      }
      if (reason === 'already-confirmed') {
        return { ok: false, message: '已有已确认的本人声纹；如需重建，请先在条目里拒绝或删除。' };
      }
      if (reason === 'label-required') return { ok: false, message: '名称不能为空。' };
      if (reason === 'label-too-long') {
        return { ok: false, message: `名称最多 ${SPEAKER_CANDIDATE_LABEL_MAX_CHARS} 个字符。` };
      }
      if (reason === 'audio-missing') return { ok: false, message: '这个候选的试听音频已不存在。' };
      if (reason === 'audio-too-large') return { ok: false, message: '试听音频太大，无法在页面播放。' };
      if (reason === 'audio-unreadable') return { ok: false, message: '试听音频读取失败。' };
      if (reason === 'candidate-not-found' || reason === 'not-found') {
        return { ok: false, message: '候选或库条目已不存在，请刷新后再试。' };
      }
      if (reason === 'library-failed' || reason === 'enrollment-failed' || reason === 'store-failed'
        || reason === 'read-failed' || reason === 'write-failed') {
        return { ok: false, message: `读取或写入失败（${reason}），未完成。` };
      }
      if (reason === 'unavailable') return { ok: false, message: '需要宿主支持声纹候选。' };
      if (reason === 'not-initialized' || reason === 'no-base-template') {
        return { ok: false, message: '还没有基础声纹版本：请先「建立基础声纹」，再强化当前声纹。' };
      }
      if (reason === 'low-similarity') {
        const score = speakerEnrollNumber(result?.similarity);
        return {
          ok: false,
          message: `候选与当前声纹不够相似${score === null ? '' : `（${score.toFixed(2)}）`}，未写入新版本。`,
        };
      }
      if (reason === 'version-not-found' || reason === 'bad-version-vector') {
        return { ok: false, message: '这个版本已不在保留链中，无法回滚；请刷新后重试。' };
      }
      if (reason === 'invalid-version') return { ok: false, message: '版本号无效，未回滚。' };
      if (reason === 'too-many-samples') {
        const max = speakerEnrollNumber(result?.maxSamples);
        return { ok: false, message: `一次最多强化${max === null ? ' 8' : ` ${Math.round(max)}`} 条候选，未写入。` };
      }
      if (reason === 'duration-cap-exceeded') {
        return { ok: false, message: '本次候选总时长超过强化上限，未写入。' };
      }
      if (reason === 'template-write-failed' || reason === 'template-failed'
        || reason === 'template-read-failed') {
        return { ok: false, message: `声纹版本读写失败（${reason}），未完成。` };
      }
      if (reason === 'dim-mismatch') return { ok: false, message: '候选维度与当前声纹不一致，未写入。' };
      if (reason === '') return { ok: false, message: '操作失败' };
      const missing = speakerEnrollMissingText(reason);
      const base = missing === reason ? `操作失败：${reason}` : missing;
      return {
        ok: false,
        message: (result?.rolledBack === true || result?.restored === false)
          ? `${base}${result?.restored === false ? '（版本文件未能恢复）' : '（已回滚，未留下半套数据）'}`
          : base,
      };
    }

    /** 设置页候选子块：数量/分组、逐个试听/选择/删除、清空、一致性预览、建库与重命名。 */
    function speakerCandidateSection(h, props) {
      const view = speakerCandidateView(props?.candidateData);
      const locked = props?.busy === true || props?.candidateBusy === true;
      const selected = Array.isArray(props?.candidateSelection) ? props.candidateSelection : [];
      const selectedSet = new Set(selected);
      const label = speakerEnrollText(props?.label);
      const audioMap = speakerEnrollObject(props?.candidateAudio) ?? {};
      const preview = speakerEnrollObject(props?.candidatePreview);
      const previewText = preview === null ? '' : speakerCandidateOutcome('preview', preview).message;
      const notice = speakerEnrollObject(props?.candidateNotice);
      const noticeText = speakerEnrollText(notice?.message);
      const noSelection = selected.length === 0;
      const shadowEnabled = props?.shadowEnabled === true;
      const buildReason = !view.available
        ? '建立基础声纹已禁用：候选接口不可用。'
        : (view.count === 0
            ? '建立基础声纹已禁用：还没有候选；开启声纹影子并正常说话，或点「刷新候选」。'
            : (noSelection ? '建立基础声纹已禁用：先勾选至少一条候选。' : ''));
      const strengthenReason = !view.available
        ? '强化当前声纹已禁用：候选接口不可用。'
        : (view.templateCurrentVersion === null
            ? '强化当前声纹已禁用：还没有基础声纹版本；先建立基础声纹。'
            : (view.count === 0
                ? '强化当前声纹已禁用：还没有候选。'
                : (noSelection ? '强化当前声纹已禁用：先勾选至少一条候选。' : '')));
      const renameReason = label === '' ? '重命名已禁用：名称不能为空。' : '';
      const rollbackAsk = speakerEnrollNumber(props?.rollbackAsk);
      const templateCurrent = view.templateCurrent;
      const templateCurrentText = templateCurrent === null
        ? (view.templateAvailable ? '未建立' : '不可用')
        : `v${templateCurrent.version} · 样本 ${templateCurrent.sampleCount} 条 · ${speakerEnrollDurationText(templateCurrent.totalDurationMs)}`;
      const templateReasonText = (reason) => {
        if (reason === 'initial') return '初始建立';
        if (reason === 'strengthen') return '显式强化';
        return reason === '' ? '手动' : reason;
      };
      const templateVersionRow = (record) => {
        const isCurrent = record.version === view.templateCurrentVersion;
        const asking = rollbackAsk === record.version;
        return h('div', { key: `template-v${record.version}`, style: { marginTop: 6 } },
          h('div', { style: { ...styles.row, alignItems: 'flex-start' } },
            h('span', { style: { ...styles.value, flex: 1 } },
              `v${record.version}${isCurrent ? ' · 当前' : ''}`
              + ` · 样本 ${record.sampleCount} 条 · ${speakerEnrollDurationText(record.totalDurationMs)}`
              + ` · ${templateReasonText(record.reason)}`
              + `${record.createdAt === '' ? '' : ` · ${record.createdAt}`}`),
            isCurrent
              ? null
              : (asking
                  ? h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h('span', { style: styles.hint }, `确认回滚到 v${record.version}？`),
                      h('button', {
                        style: { ...styles.btnPrimary, ...(locked ? styles.off : {}) },
                        disabled: locked,
                        onClick: () => props?.onTemplateRollback?.(record.version),
                      }, '确认回滚'),
                      h('button', {
                        style: { ...styles.btn, ...(locked ? styles.off : {}) },
                        disabled: locked,
                        onClick: () => props?.onTemplateRollbackCancel?.(),
                      }, '取消'))
                  : h('button', {
                      style: { ...styles.btn, ...(locked ? styles.off : {}) },
                      disabled: locked,
                      onClick: () => props?.onTemplateRollbackAsk?.(record.version),
                    }, '回滚到此版本'))),
        );
      };
      const candidateRow = (candidate) => {
        const checked = selectedSet.has(candidate.id);
        const audioUrl = speakerEnrollText(audioMap[candidate.id]);
        const text = candidate.text.length > 24
          ? `${candidate.text.slice(0, 24)}…`
          : candidate.text;
        return h('div', { key: candidate.key, style: { marginTop: 6 } },
          h('div', { style: { ...styles.row, alignItems: 'flex-start' } },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: locked,
              title: '选择这个候选',
              onChange: () => props?.onCandidateToggle?.(candidate.id, !checked),
            }),
            h('span', { style: { ...styles.value, flex: 1 } },
              `${speakerEnrollDurationText(candidate.durationMs)}`
              + `${candidate.at === '' ? '' : ` · ${candidate.at}`}`
              + `${text === '' ? '' : ` · ${text}`}`),
            h('span', { style: { display: 'flex', gap: 6 } },
              h('button', {
                style: { ...styles.btn, ...(locked || candidate.audioAvailable === false ? styles.off : {}) },
                disabled: locked || candidate.audioAvailable === false,
                title: candidate.audioAvailable === false ? '候选音频不存在' : '试听候选音频',
                onClick: () => props?.onCandidateAudio?.(candidate.id),
              }, '试听'),
              h('button', {
                style: { ...styles.btnDanger, ...(locked ? styles.off : {}) },
                disabled: locked,
                onClick: () => props?.onCandidateRemove?.(candidate.id),
              }, '删除'))),
          audioUrl === ''
            ? null
            : h('audio', {
                controls: true,
                src: audioUrl,
                style: { width: '100%', height: 28, marginTop: 4 },
              }));
      };
      return h('div', {
        style: { ...styles.group, marginTop: 10 },
        'data-settings-group': 'speaker-candidates',
        'data-seirein-speaker-candidates': 'client',
      },
        h('div', { style: styles.groupTitle }, '声纹候选'),
        h('div', { style: styles.hint }, SPEAKER_CANDIDATE_NOTICE),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '候选数'),
          h('span', { style: styles.value },
            view.available ? `${view.count} 条 · 分组 ${view.groupCount}` : '不可用'),
          h('button', {
            'data-speaker-candidate-refresh': 'true',
            style: { ...styles.btn, ...(locked || view.loading ? styles.off : {}) },
            disabled: locked || view.loading,
            onClick: () => props?.onCandidateRefresh?.(),
          }, view.loading ? '刷新中…' : '刷新候选')),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '库名称'),
          h('span', { style: styles.value },
            view.available
              ? (view.libraryPresent
                  ? `${view.libraryLabel === '' ? '未命名' : view.libraryLabel}${view.libraryEnabled ? '' : '（已停用）'}`
                  : '未建立')
              : '不可用')),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '当前版本'),
          h('span', { style: styles.value },
            view.available ? templateCurrentText : '不可用')),
        h('div', { style: styles.hint }, SPEAKER_TEMPLATE_NOTICE),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '已选'),
          h('span', { style: styles.value }, `${selected.length} 条`)),
        view.error === ''
          ? null
          : h('div', { style: { ...styles.hint, color: DANGER } }, `候选读取失败：${view.error}`),
        view.loading ? h('div', { style: styles.hint }, '正在读取声纹候选…') : null,
        view.available && view.count === 0 && !view.loading
          ? h('div', {
              'data-speaker-candidate-empty': 'true',
              style: { marginTop: 6 },
            },
              h('div', { style: styles.hint },
                '还没有声纹候选：先在听觉页开启「声纹影子」，正常说话会自动收集；不需要专门说三句话。'),
              h('div', { style: styles.hint },
                shadowEnabled
                  ? '当前声纹影子已开启：正常说话就会进入候选；刚切换的话点「刷新候选」，或等当前会话下一次发言。'
                  : '去「听觉」页开启「声纹影子」：当前监听会立即补挂候选收集，不用等下次重启。'),
              h('div', { style: styles.hint },
                '未收集到候选时也可以随时点上方「刷新候选」；不会自动确认本人，也不会自动建立声纹。'))
          : null,
        view.available
          ? h('div', { style: { marginTop: 6 } },
              view.groups.map((group) => h('div', { key: group.key },
                h('div', { style: { ...styles.label, fontWeight: 600 } },
                  `${group.label} · ${group.candidates.length} 条`),
                group.candidates.map(candidateRow))))
          : null,
        h('div', { style: { marginTop: 8 } },
          h('div', { style: { ...styles.label, fontWeight: 600 } },
            `版本链${view.templateVersions.length === 0 ? '' : ` · ${view.templateVersions.length} 个`}`),
          view.templateVersions.length === 0
            ? h('div', { style: styles.hint },
                view.templateAvailable ? '还没有版本：建立基础声纹后会从 v1 开始。' : '版本信息不可用。')
            : [...view.templateVersions]
                .sort((left, right) => right.version - left.version)
                .map(templateVersionRow)),
        h('div', { style: { ...styles.row, marginTop: 8 } },
          h('input', {
            style: styles.input,
            value: label,
            maxLength: SPEAKER_CANDIDATE_LABEL_MAX_CHARS,
            placeholder: '本人声纹名称（留空使用「本人」）',
            disabled: locked,
            onChange: (event) => props?.onCandidateLabel?.(event?.target?.value ?? ''),
          }),
          h('button', {
            style: { ...styles.btn, ...(locked || label === '' ? styles.off : {}) },
            disabled: locked || label === '',
            title: label === '' ? '名称不能为空' : '只改库里的显示名称，不改 speakerId',
            onClick: () => props?.onCandidateRename?.(label),
          }, '重命名')),
        h('div', { style: { ...styles.row, marginTop: 6, justifyContent: 'flex-end' } },
          h('button', {
            style: { ...styles.btn, ...(locked || !view.available || noSelection ? styles.off : {}) },
            disabled: locked || !view.available || noSelection,
            onClick: () => props?.onCandidatePreview?.(selected),
          }, '预览一致性'),
          h('button', {
            style: { ...styles.btnPrimary, ...(locked || !view.available || noSelection ? styles.off : {}) },
            disabled: locked || !view.available || noSelection,
            title: '只有你点这里才会写入本人声纹；不会自动确认',
            onClick: () => props?.onCandidateBuild?.(selected, label === '' ? '本人' : label),
          }, '建立基础声纹'),
          h('button', {
            style: {
              ...styles.btn,
              ...(locked || !view.available || noSelection || !view.templateAvailable
                || view.templateCurrentVersion === null ? styles.off : {}),
            },
            disabled: locked || !view.available || noSelection || !view.templateAvailable
              || view.templateCurrentVersion === null,
            title: view.templateCurrentVersion === null
              ? '还没有基础声纹版本；先建立基础声纹'
              : '把已选候选合并进当前声纹并追加一个版本；不会自动强化',
            onClick: () => props?.onTemplateStrengthen?.(
              selected,
              label === '' ? '本人' : label,
            ),
          }, '强化当前声纹'),
          h('button', {
            style: { ...styles.btnDanger, ...(locked || !view.available || view.count === 0 ? styles.off : {}) },
            disabled: locked || !view.available || view.count === 0,
            onClick: () => props?.onCandidateClear?.(),
          }, '清空候选')),
        buildReason === ''
          ? null
          : h('div', {
              'data-speaker-candidate-build-reason': 'true',
              style: styles.hint,
            }, buildReason),
        strengthenReason === ''
          ? null
          : h('div', {
              'data-speaker-candidate-strengthen-reason': 'true',
              style: styles.hint,
            }, strengthenReason),
        renameReason === ''
          ? null
          : h('div', {
              'data-speaker-candidate-rename-reason': 'true',
              style: styles.hint,
            }, renameReason),
        previewText === ''
          ? null
          : h('div', {
              style: { ...styles.hint, color: preview?.ok === true ? '#2b8a3e' : DANGER },
            }, previewText),
        noticeText === ''
          ? null
          : h('div', {
              style: { ...styles.hint, color: notice?.ok === true ? '#2b8a3e' : DANGER },
            }, noticeText));
    }

    /**
     * 设置页「声纹」卡片：登记状态 + 显式确认/拒绝/删除 + 影子观测 + 候选建库。
     * 卡片本身不发请求也不自动改状态：只有按钮才会写，刷新只由用户点。
     */
    function speakerEnrollSection(h, props) {
      const view = speakerEnrollView(props?.data);
      const locked = props?.busy === true;
      const last = view.shadow.last;
      const row = (label, value, danger = false) => h('div', { style: styles.row },
        h('span', { style: styles.label }, label),
        h('span', { style: danger ? { ...styles.value, color: DANGER } : styles.value }, value));
      const primary = view.primary;
      const sampleText = primary === null
        ? '—'
        : `${primary.samples} 条 · ${speakerEnrollDurationText(primary.totalDurationMs)}`
          + (primary.confirmable ? '' : '（不足 3 秒，不能确认）');
      const entryRow = (entry) => {
        const reason = speakerEnrollConfirmReason(entry);
        return h('div', { key: entry.key, style: { marginTop: 8 } },
          h('div', { style: styles.row },
            h('span', { style: styles.value },
              `${entry.label === '' ? entry.speakerId : `${entry.label}（${entry.speakerId}）`}`
              + ` · ${entry.statusText}`),
            h('span', { style: { display: 'flex', gap: 8 } },
              h('button', {
                style: { ...styles.btnPrimary, ...(locked || reason !== '' ? styles.off : {}) },
                disabled: locked || reason !== '',
                title: reason,
                onClick: () => props?.onConfirm?.(entry.speakerId),
              }, '确认'),
              h('button', {
                style: { ...styles.btn, ...(locked ? styles.off : {}) },
                disabled: locked,
                onClick: () => props?.onReject?.(entry.speakerId),
              }, '拒绝'),
              h('button', {
                style: { ...styles.btnDanger, ...(locked ? styles.off : {}) },
                disabled: locked,
                onClick: () => props?.onRemove?.(entry.speakerId),
              }, '删除条目'))),
          h('div', { style: styles.hint },
            `样本 ${entry.samples} 条 · ${speakerEnrollDurationText(entry.totalDurationMs)}`
            + (entry.confirmedAt === '' ? '' : ` · 确认于 ${entry.confirmedAt}`)
            + (reason === '' ? '' : ` · ${reason}`)));
      };
      const lastText = last === null
        ? '暂无样本'
        : [
            last.decisionText === last.decision
              ? last.decision
              : `${last.decisionText}（${last.decision}）`,
            last.classText === '' ? '' : `${last.classText}（${last.class}）`,
            last.qualityText === '' ? '' : `${last.qualityText}（${last.quality}）`,
            last.score === null ? '' : `分数 ${last.score.toFixed(2)}`,
          ].filter((part) => part !== '').join(' · ');
      const counts = view.shadow.counts;
      const countsText = view.shadow.available
        ? `匹配 ${counts.match} · 不匹配 ${counts.mismatch} · 不确定 ${counts.unsure}`
        : '不可用';
      return h('div', { style: styles.group, 'data-settings-group': 'speaker-enroll', 'data-seirein-speaker-enroll': 'client' },
        h('div', { style: styles.groupTitle }, '声纹'),
        h('div', { style: styles.hint },
          '先登记本人声纹，影子只观测：不自动确认、不自动拒绝，判定不参与拒收、打断或投递。'),
        h('div', { style: styles.row },
          h('button', {
            style: { ...styles.btn, ...(locked || view.loading ? styles.off : {}) },
            disabled: locked || view.loading,
            onClick: () => props?.onRefresh?.(),
          }, view.loading ? '读取中…' : '刷新'),
          h('button', {
            style: { ...styles.btn, ...(locked ? styles.off : {}) },
            disabled: locked,
            onClick: () => props?.onCopy?.(),
          }, '复制声纹报告')),
        view.error === ''
          ? null
          : h('div', { style: { ...styles.hint, color: DANGER } }, `声纹读取失败：${view.error}`),
        view.loading ? h('div', { style: styles.hint }, '正在读取声纹登记…') : null,
        view.at > 0 && !view.loading
          ? h('div', { style: styles.mono },
              `上次读取：${new Date(view.at).toLocaleTimeString('zh-CN', { hour12: false })}`)
          : null,
        // 主视野：状态 → 候选 → 版本/建库。旧登记条目在下面折叠，兼容但不再抢占注意力。
        h('div', { style: { marginTop: 10 } },
          h('div', { style: { ...styles.label, fontWeight: 600 } }, '登记状态'),
          row('本人 speakerId', view.available ? (view.selfId === '' ? '未登记' : view.selfId) : '不可用'),
          row('状态', view.stateText),
          row('样本', sampleText),
          row('确认时间', primary === null || primary.confirmedAt === '' ? '—' : primary.confirmedAt)),
        speakerCandidateSection(h, props),
        h('div', { style: styles.hint }, SPEAKER_ENROLL_RECORD_HINT),
        h('details', {
          'data-settings-group': 'speaker-enroll-legacy',
          'data-seirein-speaker-legacy': 'client',
          style: { marginTop: 12 },
        },
          h('summary', { style: { ...styles.value, cursor: 'pointer', fontWeight: 600 } },
            `旧登记记录（兼容） · ${view.available ? `${view.entries.length} 条` : '不可用'}`),
          h('div', { style: styles.hint },
            '以下为旧版登记条目与影子观测，仅用于兼容；日常请用上方候选建立/强化声纹。旧条目的确认/拒绝/删除仍然可用。'),
          view.available
            ? h('div', { style: { marginTop: 10 } },
                h('div', { style: { ...styles.label, fontWeight: 600 } }, `旧登记条目（${view.entries.length}）`),
                view.empty
                  ? h('div', { style: styles.hint },
                      '还没有登记条目：开启声纹影子后正常说话，候选会出现在上方；确认建立后才有本人声纹。')
                  : view.entries.map(entryRow))
            : null,
          h('div', { style: { marginTop: 10 } },
            h('div', { style: { ...styles.label, fontWeight: 600 } }, '旧影子观测（只记录）'),
            row('最近一条', lastText),
            row('三类计数', countsText),
            view.shadow.available
              ? null
              : h('div', { style: styles.hint },
                  view.shadow.error === ''
                    ? '影子状态不可用：需要宿主支持 speaker.status.shadow。'
                    : `影子状态不可用：${view.shadow.error}（需要宿主支持 speaker.status.shadow）`))),
        props?.notice
          ? h('div', { style: { ...styles.hint, color: '#2b8a3e' } }, String(props.notice))
          : null);
    }

    // ---- P-111 客户端诊断 ---------------------------------------------------------------
    // 只读 /assistant/status：设置页打开时读一次，之后只由「刷新」再读。这里没有任何定时器，
    // 不新增轮询；所有字段都按可选处理，宿主暂时没有的字段在面板里显示「不可用」。
    const DIAGNOSTICS_READ_TIMEOUT_MS = 4000;

    const DIAGNOSTICS_ACK_SOURCE = { draft: '本轮草稿', warm: '预热池', fallback: '兜底句' };
    const DIAGNOSTICS_ACK_PHASE = {
      preparing: '准备中', ready: '就绪', playing: '播放中', played: '已播放', dropped: '未播放',
    };

    /** status 是宿主给的 JSON：每个分支都必须容错，不能因为一个坏字段抛异常。 */
    const diagnosticsObject = (value) => (
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    );

    const diagnosticsText = (...values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      }
      return '';
    };

    const diagnosticsNumber = (...values) => {
      for (const value of values) {
        if (value === null || value === undefined || value === '') continue;
        const number = Number(value);
        if (Number.isFinite(number)) return number;
      }
      return null;
    };

    /** count/total 优先，其次数组长度；没有可数结构就是 null（界面显示不可用）。 */
    const diagnosticsCount = (value) => {
      const object = diagnosticsObject(value);
      if (object === null) return null;
      for (const key of ['count', 'total']) {
        const number = diagnosticsNumber(object[key]);
        if (number !== null && number >= 0) return Math.round(number);
      }
      for (const key of ['items', 'entries', 'rows', 'list']) {
        if (Array.isArray(object[key])) return object[key].length;
      }
      return null;
    };

    const diagnosticsRestart = (value) => {
      const object = diagnosticsObject(value);
      if (object === null) return null;
      const restarted = object.restarted === true;
      return {
        ok: object.ok === true || restarted || object.success === true,
        restarted,
        instanceId: diagnosticsText(object.instanceId, object.instance),
        at: diagnosticsNumber(object.at, object.time, object.ts),
        message: diagnosticsText(object.message, object.error, object.reason),
      };
    };

    /**
     * status.voiceCompaction（宿主自动压缩 preset 的只读快照）：只取白名单字段。整块缺失时
     * available=false，单个字段缺失时为 null / ''，界面与报告统一显示「不可用」，不抛异常。
     */
    const diagnosticsCompactionOf = (value) => {
      const object = diagnosticsObject(value);
      if (object === null) {
        return {
          available: false, presetId: '', status: '', source: '',
          registered: null, enabled: null, reason: '', running: null, mounted: null, active: null,
          requiresRestart: null, note: '', nearLimit: null,
          pressure: { tokens: null, windowTokens: null, ratio: null, threshold: null },
        };
      }
      const pressure = diagnosticsObject(object.pressure) ?? {};
      const flag = (raw) => (raw === true ? true : raw === false ? false : null);
      return {
        available: true,
        presetId: diagnosticsText(object.presetId),
        status: diagnosticsText(object.status),
        source: diagnosticsText(object.source),
        registered: flag(object.registered),
        enabled: flag(object.enabled),
        reason: diagnosticsText(object.reason),
        running: diagnosticsNumber(object.running),
        mounted: diagnosticsNumber(object.mounted),
        active: diagnosticsNumber(object.active),
        requiresRestart: flag(object.requiresRestart),
        note: diagnosticsText(object.note),
        nearLimit: flag(object.nearLimit ?? object['near-limit']),
        pressure: {
          tokens: diagnosticsNumber(pressure.tokens),
          windowTokens: diagnosticsNumber(pressure.windowTokens),
          ratio: diagnosticsNumber(pressure.ratio),
          threshold: diagnosticsNumber(pressure.threshold),
        },
      };
    };

    /**
     * 把一次 /assistant/status 投影成面板与报告共用的安全结构。只读取下面列出的白名单字段，
     * 因此 voiceAck.captionText/speechText、ambient.recent、voicePending 等文本永远不会进入报告。
     */
    function diagnosticsView(status, localRestart = null) {
      const root = diagnosticsObject(status) ?? {};
      const hearing = diagnosticsObject(root.hearing);
      const voice = diagnosticsObject(root.voice);
      const vision = diagnosticsObject(root.vision);
      const privacy = diagnosticsObject(root.privacy);
      const runtime = diagnosticsObject(diagnosticsObject(root.live2d)?.runtime);
      const presets = diagnosticsObject(diagnosticsObject(runtime?.motion)?.presets)
        ?? diagnosticsObject(diagnosticsObject(root.motion)?.presets)
        ?? diagnosticsObject(root.presets);
      const debug = diagnosticsObject(presets?.debug) ?? presets;
      const byAction = diagnosticsObject(presets?.byAction) ?? diagnosticsObject(debug?.byAction);

      const restart = diagnosticsRestart(
        hearing?.lastRestart ?? hearing?.restart ?? root.lastRestart ?? localRestart,
      );
      const instanceId = diagnosticsText(
        hearing?.instanceId,
        hearing?.sessionInstanceId,
        hearing?.diagnostics?.instanceId,
        root.instanceId,
        voice?.instanceId,
      );
      const thresholdDb = diagnosticsNumber(
        hearing?.thresholdDb,
        hearing?.minRmsDb,
        hearing?.effectiveMinRmsDb,
        voice?.thresholdDb,
      );

      const ackRows = Array.isArray(root.voiceAck) ? root.voiceAck : [];
      const latestAck = ackRows.length === 0 ? null : diagnosticsObject(ackRows[ackRows.length - 1]);
      const ackSourceKey = diagnosticsText(latestAck?.source);
      const ackSource = ackSourceKey === ''
        ? '' : (DIAGNOSTICS_ACK_SOURCE[ackSourceKey] ?? ackSourceKey);
      const ackPhaseKey = diagnosticsText(latestAck?.phase);
      const ackPhase = ackPhaseKey === ''
        ? '' : (DIAGNOSTICS_ACK_PHASE[ackPhaseKey] ?? ackPhaseKey);
      const ackPlayed = ackPhaseKey === 'played' || ackPhaseKey === 'playing';
      const ackHit = latestAck === null
        ? ''
        : ackPlayed
          ? (ackSourceKey === 'warm' ? '预热池命中' : ackSourceKey === 'draft' ? '本轮草稿命中'
            : ackSourceKey === 'fallback' ? '兜底句命中' : '命中')
          : `未命中${ackPhase === '' ? '' : `（${ackPhase}）`}`;

      const latency = diagnosticsObject(root.voiceLatency);
      const recent = Array.isArray(latency?.recent) ? latency.recent : [];
      const latestRound = recent.length === 0 ? null : diagnosticsObject(recent[recent.length - 1]);
      const lastError = diagnosticsText(
        hearing?.lastError,
        hearing?.error,
        hearing?.diagnostics?.lastError,
        hearing?.deferred?.reason,
        voice?.lastError,
        root.voiceError,
      );

      const virtualCamErrorObject = diagnosticsObject(vision?.virtualCamError);
      const virtualCamError = vision === null || vision.virtualCamError === null
        || vision.virtualCamError === undefined
        ? ''
        : virtualCamErrorObject !== null
          ? diagnosticsText(virtualCamErrorObject.code, virtualCamErrorObject.reason,
            virtualCamErrorObject.message, virtualCamErrorObject.error) || '已记录（无详情）'
          : diagnosticsText(vision.virtualCamError);
      const visionSourceKey = diagnosticsText(vision?.source);
      const visionSource = visionSourceKey === ''
        ? '' : visionSourceKey === 'obs' ? 'OBS 场景' : visionSourceKey === 'desktop' ? '桌面' : visionSourceKey;
      const privacyOn = privacy !== null
        ? privacy.active === true
        : vision !== null ? (vision.locked === true || vision.mode === 'privacy') : null;

      const presetEnabled = presets === null
        ? null
        : (presets.enabled === true || debug?.enabled === true) ? true
          : (presets.enabled === false || debug?.enabled === false) ? false : null;
      const selection = diagnosticsObject(presets?.lastSelection);
      const selectionReasons = Array.isArray(selection?.reasons) ? selection.reasons : [];
      const lastSkipReason = diagnosticsText(
        debug?.lastSkipReason,
        presets?.lastSkipReason,
        diagnosticsObject(presets?.lastSkip)?.reason,
        diagnosticsObject(root.motion)?.lastSkipReason,
        selectionReasons.find((reason) => typeof reason === 'string' && reason.length > 0),
        diagnosticsObject(presets?.lastTrace)?.output?.reason,
      );

      const lexicon = diagnosticsObject(root.lexicon) ?? diagnosticsObject(hearing?.lexicon);
      const retention = diagnosticsObject(root.retention)
        ?? diagnosticsObject(root.audioRetention)
        ?? diagnosticsObject(hearing?.retention)
        ?? diagnosticsObject(diagnosticsObject(root.audio)?.retention);
      const library = (value) => (value === null
        ? { available: false, enabled: null, count: null }
        : {
            available: true,
            enabled: value.enabled === true ? true : value.enabled === false ? false : null,
            count: diagnosticsCount(value),
          });

      return {
        about: {
          serverVersion: diagnosticsText(root.version),
          uptimeMs: diagnosticsNumber(root.uptimeMs),
          instanceId,
          thresholdDb,
          restart,
        },
        voice: {
          lastError,
          ackSource,
          ackHit,
          firstAudibleMs: diagnosticsNumber(latestRound?.firstAudibleMs),
          firstAudibleLane: diagnosticsText(latestRound?.firstAudibleLane),
          firstAudibleUnknown: diagnosticsText(latestRound?.firstAudibleUnknown),
        },
        vision: {
          available: vision !== null,
          source: visionSource,
          scene: diagnosticsText(vision?.scene),
          privacy: privacyOn,
          virtualCam: vision === null ? null : vision.virtualCam === true,
          virtualCamError,
        },
        motion: {
          available: presets !== null,
          enabled: presetEnabled,
          select: diagnosticsNumber(debug?.decisions, debug?.select, debug?.selected, debug?.selects),
          skip: diagnosticsNumber(debug?.skips, debug?.skip),
          commit: diagnosticsNumber(byAction?.lastCommitCount, debug?.lastCommitCount, debug?.commits),
          lastSkipReason,
          lastEvent: diagnosticsText(debug?.lastEvent, presets?.lastEvent),
        },
        libraries: { lexicon: library(lexicon), retention: library(retention) },
        compaction: diagnosticsCompactionOf(root.voiceCompaction),
      };
    }

    const diagnosticsRestartText = (restart) => {
      if (restart === null) return '不可用';
      if (restart.ok === true && restart.restarted === true) {
        return restart.instanceId === '' ? '成功（新实例）' : `成功（新实例 ${restart.instanceId}）`;
      }
      if (restart.ok === true) return '已保存（采集未运行）';
      return restart.message === '' ? '失败' : `失败：${restart.message}`;
    };

    const diagnosticsFirstAudibleText = (voice) => {
      if (voice.firstAudibleMs !== null) {
        return voice.firstAudibleLane === ''
          ? `${voice.firstAudibleMs}ms` : `${voice.firstAudibleMs}ms · ${voice.firstAudibleLane}`;
      }
      if (voice.firstAudibleUnknown !== '') return `不可用（${voice.firstAudibleUnknown}）`;
      return '不可用';
    };

    const diagnosticsLibraryText = (library) => {
      if (library.available !== true) return '不可用';
      const enabled = library.enabled === true ? '已开启' : library.enabled === false ? '已关闭' : '开关不可用';
      const count = library.count === null ? '条目数不可用' : `${library.count} 条`;
      return `${enabled} · ${count}`;
    };

    // ---- 自动压缩（status.voiceCompaction）：状态 / 可用性 / 压力 / 装配四行 --------------------
    const DIAGNOSTICS_COMPACTION_STATUS = {
      registered: '已注册', reused: '复用', conflict: '冲突', failed: '失败',
      unavailable: '不可用', idle: '未注册',
    };

    const diagnosticsCompactionStateText = (compaction) => {
      if (compaction.available !== true) return '不可用';
      const label = DIAGNOSTICS_COMPACTION_STATUS[compaction.status] ?? compaction.status;
      if (label === '') return '不可用';
      return compaction.source === '' ? label : `${label}（来源 ${compaction.source}）`;
    };

    /** enabled 才是功能答案：已注册不等于已装配；不可用时带上宿主给的 reason。 */
    const diagnosticsCompactionUsableText = (compaction) => {
      if (compaction.available !== true || compaction.enabled === null) return '不可用';
      if (compaction.enabled === true) return '可用';
      return compaction.reason === '' ? '不可用' : compaction.reason;
    };

    const diagnosticsCompactionPressureText = (compaction) => {
      if (compaction.available !== true) return '不可用';
      const { tokens, windowTokens, ratio } = compaction.pressure;
      const near = compaction.nearLimit === true || (ratio !== null && ratio > 0.8);
      const detail = tokens === null || windowTokens === null || ratio === null
        ? '' : `${tokens}/${windowTokens} tokens · ${Math.round(ratio * 1000) / 10}%`;
      if (detail === '') return near ? '接近上限' : '不可用';
      return near ? `${detail} · 接近上限` : detail;
    };

    const diagnosticsCompactionAssemblyText = (compaction) => {
      if (compaction.available !== true) return '不可用';
      const mark = (raw) => (raw === true ? '是' : raw === false ? '否' : '—');
      const count = (raw) => (raw === null ? '—' : raw);
      const text = `registered ${mark(compaction.registered)} · mounted ${count(compaction.mounted)}`
        + ` · active ${count(compaction.active)} · running ${count(compaction.running)}`;
      return compaction.requiresRestart === true ? `${text} · 需重启或执行恢复` : text;
    };

    // ---- 最近一轮时间线（turn.timeline + pipeline.timeline，只读投影） --------------------
    // 两个 probe 都只取白名单字段；一次读取 = 每个 probe 恰好一个请求（宿主 action 一次只接受
    // 一个 probe），没有重试、没有定时器。缺字段一律 null，界面显示「—」，绝不补 0。
    const DIAGNOSTICS_TIMELINE_LIMIT = 5;
    const DIAGNOSTICS_TIMELINE_KINDS = ['self-speech', 'self-wait', 'perception', 'work'];
    const DIAGNOSTICS_TIMELINE_EMPTY = '暂无时间线（尚未产生或未重启）';
    const DIAGNOSTICS_WARN = '#b8860b';
    /** 受控拒绝码 -> 可读原因；未知码回落到宿主 reason。 */
    const DIAGNOSTICS_TIMELINE_REASON = {
      disabled: '诊断通道未启用',
      'invalid-probe': '探针不可用',
      'read-failed': '读取事件日志失败',
    };

    /** turn.timeline 行 -> 投影；counts / overlaps / toolKinds 整块缺失时保持 null。 */
    const diagnosticsTimelineOf = (value) => {
      const object = diagnosticsObject(value);
      if (object === null) return null;
      const counts = diagnosticsObject(object.counts) ?? {};
      const overlaps = diagnosticsObject(object.overlaps) ?? {};
      const kinds = diagnosticsObject(object.toolKinds) ?? {};
      return {
        at: diagnosticsText(object.at),
        turn: diagnosticsNumber(object.turn, object.acceptTurn),
        sessionId: diagnosticsText(object.sessionId),
        deliveryMessageId: diagnosticsText(object.deliveryMessageId),
        status: diagnosticsText(object.status),
        modelRounds: diagnosticsNumber(counts.modelRounds),
        toolKinds: {
          'self-speech': diagnosticsNumber(kinds['self-speech']),
          'self-wait': diagnosticsNumber(kinds['self-wait']),
          perception: diagnosticsNumber(kinds.perception),
          work: diagnosticsNumber(kinds.work),
        },
        toolWallMs: diagnosticsNumber(overlaps.toolWallMs),
        residualMs: diagnosticsNumber(object.residualMs),
      };
    };

    /**
     * pipeline.timeline 行 -> 投影；只保留合并展示需要的计时字段与会话/交付标识。
     * 首块 TTS 队列等待是宿主已有的事件字段（P-46），只透传、不派生；0 是真实观测，保留。
     */
    const diagnosticsPipelineTimelineOf = (value) => {
      const object = diagnosticsObject(value);
      if (object === null) return null;
      return {
        at: diagnosticsText(object.at),
        turn: diagnosticsNumber(object.turn),
        sessionId: diagnosticsText(object.sessionId),
        deliveryMessageId: diagnosticsText(object.deliveryMessageId),
        totalMs: diagnosticsNumber(object.totalMs),
        asrMs: diagnosticsNumber(object.asrMs),
        injectToAckMs: diagnosticsNumber(object.injectToAckMs),
        ackToFirstTextMs: diagnosticsNumber(object.ackToFirstTextMs),
        bodyReadyMs: diagnosticsNumber(object.bodyReadyMs),
        firstAudioMs: diagnosticsNumber(object.firstAudioMs),
        firstChunkQueueWaitMs: diagnosticsNumber(object.firstChunkQueueWaitMs),
      };
    };

    /**
     * 按轮次合并两份时间线：优先精确 deliveryMessageId，其次校验过的 sessionId+turn；旧行没有
     * sessionId 时只有该轮两侧都唯一才回退。无法唯一确认的字段留 null（界面显示「—」），
     * 绝不把另一会话同 turn 的数值借过来；展示顺序见下面的 `at` 排序（事件时间，缺则轮次）。
     */
    function mergeDiagnosticsTimeline(turnRows, pipelineRows) {
      const claim = (map, key, row) => {
        if (key === '') return;
        // A repeated key is ambiguous: a null value means "present but never merged".
        map.set(key, map.has(key) ? null : row);
      };
      const countTurns = (rows) => {
        const counts = new Map();
        for (const row of rows) {
          if (row.turn !== null) counts.set(row.turn, (counts.get(row.turn) ?? 0) + 1);
        }
        return counts;
      };
      const turnCount = countTurns(turnRows);
      const pipelineTurnCount = countTurns(pipelineRows);
      const byDelivery = new Map();
      const bySessionTurn = new Map();
      const legacyTurnRows = new Map();
      for (const row of turnRows) {
        claim(byDelivery, row.deliveryMessageId, row);
        if (row.turn === null) continue;
        if (row.sessionId !== '') {
          claim(bySessionTurn, `${row.sessionId}\u0000${row.turn}`, row);
        } else if (turnCount.get(row.turn) === 1) {
          legacyTurnRows.set(row.turn, row);
        }
      }
      const uniqueLegacyRow = (turn) => (
        turnCount.get(turn) === 1 && pipelineTurnCount.get(turn) === 1
          ? legacyTurnRows.get(turn) ?? null
          : null
      );
      const matchOf = (entry) => {
        if (entry.deliveryMessageId !== '' && byDelivery.has(entry.deliveryMessageId)) {
          return byDelivery.get(entry.deliveryMessageId);
        }
        if (entry.turn === null) return null;
        if (entry.sessionId !== '') {
          const key = `${entry.sessionId}\u0000${entry.turn}`;
          if (bySessionTurn.has(key)) return bySessionTurn.get(key);
        }
        return uniqueLegacyRow(entry.turn);
      };
      const rows = [];
      const mergedOf = new Map();
      for (const entry of turnRows) {
        const row = {
          at: entry.at,
          turn: entry.turn,
          sessionId: entry.sessionId,
          deliveryMessageId: entry.deliveryMessageId,
          status: entry.status,
          modelRounds: entry.modelRounds,
          toolKinds: entry.toolKinds,
          toolWallMs: entry.toolWallMs,
          residualMs: entry.residualMs,
          totalMs: null,
          firstAudioMs: null,
          firstChunkQueueWaitMs: null,
          hasTurn: true,
          hasPipeline: false,
        };
        mergedOf.set(entry, row);
        rows.push(row);
      }
      for (const entry of pipelineRows) {
        const match = matchOf(entry);
        const target = match === null ? undefined : mergedOf.get(match);
        if (target !== undefined && target.hasPipeline === false) {
          target.totalMs = entry.totalMs;
          target.firstAudioMs = entry.firstAudioMs;
          target.firstChunkQueueWaitMs = entry.firstChunkQueueWaitMs;
          target.hasPipeline = true;
          continue;
        }
        rows.push({
          // 合并行沿用 turn 行的事件时间（那是本轮汇总产生的时刻）；只有 pipeline 行时用它自己的。
          at: entry.at,
          turn: entry.turn,
          sessionId: entry.sessionId,
          deliveryMessageId: entry.deliveryMessageId,
          status: '',
          modelRounds: null,
          toolKinds: null,
          toolWallMs: null,
          residualMs: null,
          totalMs: entry.totalMs,
          firstAudioMs: entry.firstAudioMs,
          firstChunkQueueWaitMs: entry.firstChunkQueueWaitMs,
          hasTurn: false,
          hasPipeline: true,
        });
      }
      // 展示顺序：按事件时间（at）倒序，同一时刻再按轮次倒序。at 缺失的行没有可比较的事件时间，
      // 回退到轮次倒序并排在已带时间的行之后；旧日志（宿主未投影 at）因此保持修复前的轮次顺序。
      const atOf = (row) => {
        const text = typeof row?.at === 'string' ? row.at : '';
        const ms = Date.parse(text);
        return Number.isFinite(ms) ? ms : null;
      };
      const byTurnDesc = (left, right) => {
        if (left.turn === null && right.turn === null) return 0;
        if (left.turn === null) return 1;
        if (right.turn === null) return -1;
        return right.turn - left.turn;
      };
      const dated = [];
      const undated = [];
      for (const row of rows) (atOf(row) === null ? undated : dated).push(row);
      dated.sort((left, right) => atOf(right) - atOf(left) || byTurnDesc(left, right));
      undated.sort(byTurnDesc);
      return [...dated, ...undated];
    }

    /** 单个 probe：一次请求、一个硬超时；失败只返回 `{rows:[], error}`，不向调用方抛出。 */
    async function readDiagnosticsTimelineProbe(post, probe, limit = DIAGNOSTICS_TIMELINE_LIMIT) {
      if (typeof post !== 'function') return { rows: [], error: '时间线读取接口不可用' };
      try {
        const result = await post(
          { action: 'diagnostics.query', probe, limit },
          DIAGNOSTICS_READ_TIMEOUT_MS,
        );
        const object = diagnosticsObject(result);
        if (object === null) return { rows: [], error: '返回格式异常' };
        if (object.ok !== true) {
          const reason = diagnosticsText(object.reason, object.error);
          const mapped = DIAGNOSTICS_TIMELINE_REASON[reason] ?? reason;
          return { rows: [], error: mapped === '' ? '查询失败' : mapped };
        }
        return { rows: Array.isArray(object.rows) ? object.rows : [], error: '' };
      } catch (cause) {
        return { rows: [], error: cause && cause.message ? String(cause.message) : String(cause) };
      }
    }

    /**
     * 一次刷新读取两个 probe 各一次（共两个请求），合并成按事件时间倒序的行（at 缺失的旧行回退
     * 轮次倒序）；没有任何轮询。
     * `post` 与 `runSettingsAction` 同签名 `(body, timeoutMs) => Promise<object>`。
     */
    async function readDiagnosticsTimelines(post, limit = DIAGNOSTICS_TIMELINE_LIMIT) {
      const at = Date.now();
      const [turn, pipeline] = await Promise.all([
        readDiagnosticsTimelineProbe(post, 'turn.timeline', limit),
        readDiagnosticsTimelineProbe(post, 'pipeline.timeline', limit),
      ]);
      const turnRows = turn.rows.map(diagnosticsTimelineOf).filter((row) => row !== null);
      const pipelineRows = pipeline.rows
        .map(diagnosticsPipelineTimelineOf).filter((row) => row !== null);
      const error = [...new Set(
        [turn.error, pipeline.error].filter((text) => text !== ''),
      )].join('；');
      return {
        at,
        ok: error === '',
        error,
        turn: turnRows,
        pipeline: pipelineRows,
        rows: mergeDiagnosticsTimeline(turnRows, pipelineRows),
      };
    }

    const diagnosticsTimelineNumberText = (value, unit = '') => (
      value === null || value === undefined ? '—' : `${value}${unit}`
    );

    const diagnosticsTimelineToolText = (toolKinds) => {
      const kinds = diagnosticsObject(toolKinds);
      if (kinds === null) return '—';
      return DIAGNOSTICS_TIMELINE_KINDS.map((kind) => (
        `${kind} ${diagnosticsTimelineNumberText(diagnosticsNumber(kinds[kind]))}`
      )).join(' · ');
    };

    /**
     * 报告里的时间线摘要（纯投影）：只有轮次 / 状态 / 计数 / 耗时，绝不含 phases、路径或文本；
     * 即使调用方塞进额外字段也不会被带进报告。
     */
    const diagnosticsTimelineReportOf = (timeline) => {
      const object = diagnosticsObject(timeline);
      const rows = Array.isArray(object?.rows) ? object.rows : [];
      return {
        error: reportField(object?.error),
        rows: rows.slice(0, DIAGNOSTICS_TIMELINE_LIMIT).map((row) => {
          const entry = diagnosticsObject(row) ?? {};
          const kinds = diagnosticsObject(entry.toolKinds) ?? {};
          return {
            turn: diagnosticsNumber(entry.turn),
            status: reportField(entry.status),
            modelRounds: diagnosticsNumber(entry.modelRounds),
            toolKinds: {
              'self-speech': diagnosticsNumber(kinds['self-speech']),
              'self-wait': diagnosticsNumber(kinds['self-wait']),
              perception: diagnosticsNumber(kinds.perception),
              work: diagnosticsNumber(kinds.work),
            },
            toolWallMs: diagnosticsNumber(entry.toolWallMs),
            totalMs: diagnosticsNumber(entry.totalMs),
            firstAudioMs: diagnosticsNumber(entry.firstAudioMs),
            residualMs: diagnosticsNumber(entry.residualMs),
          };
        }),
      };
    };

    // ---- P2 报告脱敏：本机界面照旧显示原文，只有「复制诊断报告」走这里 ----------------------
    // 听觉/TTS 会把 ffmpeg 原始错误（如 `failed to open C:\Users\<name>\voice.wav`）留在
    // lastError 里。这些自由文本可以出现在本机界面，但绝不能进入可复制的报告。
    const DIAGNOSTIC_CONTROLLED_CODE =
      /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HTTP[ /-]?\d{3}|E(?:RR)?_[A-Z0-9_]+|E[A-Z]{2,}\d*)$/u;
    const DIAGNOSTIC_CATEGORY = [
      [/(?:timeout|timed out|超时)/iu, 'timeout'],
      [/(?:abort|cancel|取消|中止)/iu, 'aborted'],
      [/(?:permission|denied|eacces|拒绝|无权限)/iu, 'denied'],
      [/(?:not ?found|missing|enoent|no such|不存在)/iu, 'missing'],
    ];
    const DIAGNOSTIC_FILENAME =
      /[^\s"'<>`]*\.(?:wav|mp3|m4a|ogg|flac|opus|aac|png|jpe?g|webp|gif|bmp|mp4|mkv|webm|jsonl?|log|txt|csv|db|sqlite|onnx|bin|dll|exe|mjs|cjs|js|ts|tsx|html|css|md|pdf|ya?ml|toml|ini|cfg)\b/giu;

    /**
     * 纯函数：URL → `<url>`；Windows 盘符路径、UNC、/home 与 /Users 等 home 路径、带扩展名的
     * 文件路径 → `<path>`；邮箱 → `<email>`；控制字符与多余空白一并清掉。界面不使用这个结果。
     */
    const sanitizeDiagnosticText = (value) => {
      if (typeof value !== 'string') return '';
      // 先截断再替换：敏感路径的前缀仍在，替换依旧从盘符 / UNC / home 起整段吃掉。
      return value.slice(0, 4096)
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/(?:https?|wss?|ftp|file):\/\/[^\s"'<>`]+/giu, '<url>')
        .replace(/\b[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]*[\\/])*[^\\/:*?"<>|\r\n]*/gu, '<path>')
        .replace(/\\\\[^\s"'<>`]+/gu, '<path>')
        .replace(/(^|[\s"'(\[=:,])\/(?:home|Users|root|tmp|var|opt|mnt|media|Volumes|private|usr|etc)\/[^\s"'<>`]*/gu, '$1<path>')
        .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu, '<email>')
        .replace(DIAGNOSTIC_FILENAME, '<path>')
        .replace(/\s{2,}/gu, ' ')
        .trim()
        .slice(0, 240);
    };

    /** 自由文本错误 → 「阶段 + 错误类别」；开头的受控码原样保留。 */
    const diagnosticSummaryOf = (text) => {
      const code = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|HTTP[ /-]?\d{3}|E(?:RR)?_[A-Z0-9_]+|E[A-Z]{2,}\d*)\b/u.exec(text);
      if (code !== null) return code[1];
      const stage = /^([A-Za-z][A-Za-z0-9_.-]{0,23})\s*[:：]/u.exec(text);
      const category = DIAGNOSTIC_CATEGORY.find(([pattern]) => pattern.test(text));
      const name = category === undefined ? 'error' : category[1];
      return stage === null ? name : `${stage[1].toLowerCase()}: ${name}`;
    };

    /**
     * 报告字段的唯一出口（纯函数）：受控码/枚举原样保留，其余字符串一律过
     * sanitizeDiagnosticText；freeText=true 的自由文本错误再压成摘要。
     */
    const reportField = (value, freeText = false) => {
      if (value === null || value === undefined) return null;
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return null;
      if (DIAGNOSTIC_CONTROLLED_CODE.test(text)) return text;
      const sanitized = sanitizeDiagnosticText(text);
      if (sanitized === '') return null;
      return freeText ? diagnosticSummaryOf(sanitized) : sanitized;
    };

    /**
     * 纯文本 JSON 摘要。字段是上面投影的白名单子集：不包含转写、字幕、候音台词、环境声文本
     * 或任何音频/文件路径；每个字符串字段都经 reportField 脱敏（受控码保留，路径 → <path>，
     * 自由文本错误 → 阶段 + 类别），因此剪贴板里的报告不含本机路径、URL 或用户名。
     */
    function diagnosticsReportOf(
      status,
      {
        clientVersion = '', localRestart = null, at = Date.now(), readError = '', timeline = null,
      } = {},
    ) {
      const view = diagnosticsView(status, localRestart);
      const report = {
        schema: 1,
        generatedAt: reportField(new Date(at).toISOString()),
        clientVersion: reportField(String(clientVersion ?? '')),
        readError: reportField(readError, true),
        serverVersion: reportField(view.about.serverVersion),
        uptimeMs: view.about.uptimeMs,
        instanceId: reportField(view.about.instanceId),
        thresholdDb: view.about.thresholdDb,
        restart: view.about.restart === null ? null : {
          ok: view.about.restart.ok,
          restarted: view.about.restart.restarted,
          instanceId: reportField(view.about.restart.instanceId),
          at: view.about.restart.at,
          message: reportField(view.about.restart.message, true),
        },
        voice: {
          lastError: reportField(view.voice.lastError, true),
          ackSource: reportField(view.voice.ackSource),
          ackHit: reportField(view.voice.ackHit),
          firstAudibleMs: view.voice.firstAudibleMs,
          firstAudibleLane: reportField(view.voice.firstAudibleLane),
        },
        vision: {
          available: view.vision.available,
          source: reportField(view.vision.source),
          scene: reportField(view.vision.scene),
          privacy: view.vision.privacy,
          virtualCam: view.vision.virtualCam,
          virtualCamError: reportField(view.vision.virtualCamError, true),
        },
        motion: {
          available: view.motion.available,
          enabled: view.motion.enabled,
          select: view.motion.select,
          skip: view.motion.skip,
          commit: view.motion.commit,
          lastSkipReason: reportField(view.motion.lastSkipReason),
        },
        libraries: {
          lexicon: { ...view.libraries.lexicon },
          retention: { ...view.libraries.retention },
        },
        compaction: {
          available: view.compaction.available,
          presetId: reportField(view.compaction.presetId),
          status: reportField(view.compaction.status),
          source: reportField(view.compaction.source),
          registered: view.compaction.registered,
          enabled: view.compaction.enabled,
          reason: reportField(view.compaction.reason),
          running: view.compaction.running,
          mounted: view.compaction.mounted,
          active: view.compaction.active,
          requiresRestart: view.compaction.requiresRestart,
          note: reportField(view.compaction.note),
          nearLimit: view.compaction.nearLimit,
          pressure: {
            tokens: view.compaction.pressure.tokens,
            windowTokens: view.compaction.pressure.windowTokens,
            ratio: view.compaction.pressure.ratio,
            threshold: view.compaction.pressure.threshold,
          },
        },
        timeline: diagnosticsTimelineReportOf(timeline),
      };
      return JSON.stringify(report, null, 2);
    }

    async function copyDiagnosticsReport(text, clipboard) {
      const target = clipboard !== undefined
        ? clipboard : (typeof navigator === 'undefined' ? null : navigator.clipboard);
      if (target === null || target === undefined || typeof target.writeText !== 'function') {
        return { ok: false, error: '剪贴板不可用' };
      }
      try {
        await target.writeText(String(text ?? ''));
        return { ok: true, error: '' };
      } catch (cause) {
        return { ok: false, error: cause && cause.message ? String(cause.message) : String(cause) };
      }
    }

    /**
     * One `GET /assistant/status` for the diagnostics card. A new AbortController gives the read a
     * hard timeout; the caller never gets an exception, only `{status, error, at}`.
     */
    async function loadDiagnosticsStatus(
      fetchImpl = typeof fetch === 'function' ? fetch : null,
      timeoutMs = DIAGNOSTICS_READ_TIMEOUT_MS,
    ) {
      if (typeof fetchImpl !== 'function') {
        return { status: null, error: '无法读取状态', at: Date.now() };
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl('/assistant/status', {
          cache: 'no-store',
          signal: controller?.signal,
        });
        if (response === null || response === undefined || response.ok !== true) {
          throw new Error(`HTTP ${response?.status ?? 'UNKNOWN'}`);
        }
        const status = await response.json();
        return { status: diagnosticsObject(status), error: '', at: Date.now() };
      } catch (cause) {
        const aborted = cause && cause.name === 'AbortError';
        return {
          status: null,
          error: aborted ? '请求超时' : (cause && cause.message ? String(cause.message) : String(cause)),
          at: Date.now(),
        };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    /** 设置页「关于 / 诊断」卡片：纯展示，所有写入都经 handlers。 */
    function diagnosticsSection(h, {
      data, clientVersion, restart, busy, onRefresh, onCopy, recover = null,
    }) {
      const status = diagnosticsObject(data?.status);
      const view = diagnosticsView(status, restart);
      const loading = data === null || data === undefined || data.loading === true;
      const error = diagnosticsText(data?.error);
      const updated = diagnosticsNumber(data?.at);
      const missing = status === null;
      const value = (text, fallback = '不可用') => (
        text === '' || text === null || text === undefined ? fallback : text
      );
      const row = (label, text) => h('div', { style: styles.row },
        h('span', { style: styles.label }, label),
        h('span', { style: styles.value }, value(text)));
      /** 同一行结构，value 在 danger 时标红（自动压缩不可用）。 */
      const rowDanger = (label, text, danger) => h('div', { style: styles.row },
        h('span', { style: styles.label }, label),
        h('span', { style: danger ? { ...styles.value, color: DANGER } : styles.value }, value(text)));
      /** 同一行结构，value 在 warn 时标黄（恢复后容量仍不健康）。 */
      const rowWarn = (label, text, warn) => h('div', { style: styles.row },
        h('span', { style: styles.label }, label),
        h('span', { style: warn ? { ...styles.value, color: DIAGNOSTICS_WARN } : styles.value },
          value(text)));
      const group = (title, rows) => h('div', { style: { marginTop: 10 } },
        h('div', { style: { ...styles.label, fontWeight: 600 } }, title),
        ...rows);
      const sourceText = (text) => (missing ? '不可用' : value(text, '无'));
      const motionCounts = view.motion.available
        ? `select ${view.motion.select ?? '—'} · skip ${view.motion.skip ?? '—'} · commit ${view.motion.commit ?? '—'}`
        : '不可用';
      // 有数据但 enabled 不为 true 才算「不可用」；整块缺失沿用分区占位，不额外标红。
      const compactionDanger = view.compaction.available === true && view.compaction.enabled !== true;
      // 恢复结果里的 stillNearLimit / recommendation / compressionEffective：只展示，不触发动作。
      const recoverView = diagnosticsObject(recover);
      const recoverWarnings = Array.isArray(recoverView?.warnings)
        ? recoverView.warnings.filter((text) => typeof text === 'string' && text.trim() !== '')
        : [];
      const recoverCapacityWarn = recoverWarnings.length > 0;
      const recoverCapacity = recoverView === null
        ? '尚未恢复'
        : recoverCapacityWarn
          ? recoverWarnings.join(' · ')
          : recoverView.compressionEffective === true ? '压缩有效，容量正常' : '不可用';

      return h('div', { style: styles.group, 'data-settings-group': 'client-diagnostics', 'data-seirein-diagnostics': 'client' },
        h('div', { style: styles.groupTitle }, '诊断（客户端）'),
        h('div', { style: styles.hint },
          '打开时读取一次 /assistant/status，不新增轮询；只显示状态摘要，不含对话文本或音频。'),
        h('div', { style: styles.row },
          h('button', {
            style: { ...styles.btn, ...(busy || loading ? styles.off : {}) },
            disabled: busy || loading,
            onClick: () => onRefresh?.(),
          }, loading ? '读取中…' : '刷新'),
          h('button', {
            style: { ...styles.btn, ...(busy || loading ? styles.off : {}) },
            disabled: busy || loading,
            onClick: () => onCopy?.(),
          }, '复制诊断报告')),
        error === ''
          ? null
          : h('div', { style: { ...styles.hint, color: DANGER } }, `诊断读取失败：${error}`),
        loading ? h('div', { style: styles.hint }, '正在读取诊断状态…') : null,
        updated === null
          ? null
          : h('div', { style: styles.mono },
            `上次读取：${new Date(updated).toLocaleTimeString('zh-CN', { hour12: false })}`),
        group('概况', [
          row('客户端 / 服务端版本', missing
            ? '不可用' : `v${clientVersion} / v${view.about.serverVersion || '不可用'}`),
          row('运行实例 id', view.about.instanceId),
          row('阈值生效值', view.about.thresholdDb === null
            ? '不可用' : `${view.about.thresholdDb} dB`),
          row('最近重启结果', diagnosticsRestartText(view.about.restart)),
        ]),
        group('语音', [
          row('最后错误', sourceText(view.voice.lastError)),
          row('候音来源', sourceText(view.voice.ackSource)),
          row('候音命中', sourceText(view.voice.ackHit)),
          row('首音时间（最近一轮）', missing ? '不可用' : diagnosticsFirstAudibleText(view.voice)),
        ]),
        group('自动压缩', [
          row('状态', diagnosticsCompactionStateText(view.compaction)),
          rowDanger('是否可用', diagnosticsCompactionUsableText(view.compaction), compactionDanger),
          row('上下文压力', diagnosticsCompactionPressureText(view.compaction)),
          row('装配（registered / mounted / active / running）',
            diagnosticsCompactionAssemblyText(view.compaction)),
          rowWarn('恢复后容量', recoverCapacity, recoverCapacityWarn),
          view.compaction.requiresRestart === true && view.compaction.note !== ''
            ? h('div', { style: styles.hint }, `恢复说明：${view.compaction.note}`)
            : null,
        ]),
        group('视觉', [
          row('来源', missing ? '不可用' : view.vision.source),
          row('场景', missing ? '不可用' : view.vision.scene),
          row('隐私模式', view.vision.privacy === null
            ? '不可用' : view.vision.privacy ? '开启' : '关闭'),
          row('虚拟摄像头', view.vision.virtualCam === null
            ? '不可用' : view.vision.virtualCam ? '运行中' : '未运行'),
          row('虚拟摄像头错误', missing ? '不可用' : value(view.vision.virtualCamError, '无')),
        ]),
        group('动作', [
          row('预设开关（presets.enabled）', view.motion.enabled === null
            ? '不可用' : view.motion.enabled ? '已开启' : '已关闭'),
          row('最近计数', missing ? '不可用' : motionCounts),
          row('最近跳过原因', missing
            ? '不可用'
            : view.motion.lastSkipReason !== ''
              ? view.motion.lastSkipReason
              : (view.motion.skip !== null && view.motion.skip > 0 ? '不可用（状态未提供）' : '无')),
          row('最近事件', sourceText(view.motion.lastEvent)),
        ]),
        group('语言库 / 音频保留', [
          row('语言库', missing ? '不可用' : diagnosticsLibraryText(view.libraries.lexicon)),
          row('音频保留', missing ? '不可用' : diagnosticsLibraryText(view.libraries.retention)),
        ]),
      );
    }

    /**
     * 「最近一轮时间线」卡片：跟随诊断卡的打开/刷新读取，自己不带按钮、不轮询、不自动动作。
     * 无数据 / 失败 / 缺字段都只降级成一行提示或「—」，绝不猜测数值。
     */
    function timelineSection(h, { data } = {}) {
      // P-111 local diagnostics：只记一次渲染事件码，不记录任何时间线数据。
      if (typeof diag === 'function') diag('timeline.render', 0);
      const timeline = diagnosticsObject(data);
      const loading = data === null || data === undefined || timeline?.loading === true;
      const rows = Array.isArray(timeline?.rows) ? timeline.rows : [];
      const error = diagnosticsText(timeline?.error);
      const updated = diagnosticsNumber(timeline?.at);
      const show = (value, unit = '') => diagnosticsTimelineNumberText(
        diagnosticsNumber(value), unit,
      );
      const turnBlock = (row, index) => {
        const entry = diagnosticsObject(row) ?? {};
        const turn = diagnosticsNumber(entry.turn);
        const status = diagnosticsText(entry.status);
        const modelRounds = diagnosticsNumber(entry.modelRounds);
        return h('div', {
          key: `${turn === null ? 'unknown' : turn}-${index}`,
          style: { marginTop: 8, borderTop: '1px solid #e5e7eb' },
          'data-seirein-timeline-row': turn === null ? '' : String(turn),
        },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, `轮次 ${turn === null ? '—' : turn}`),
            h('span', { style: styles.value },
              `状态 ${status === '' ? '—' : status}`
              + ` · 模型 ${modelRounds === null ? '—' : modelRounds} 轮`
              + ` · 工具 ${diagnosticsTimelineToolText(entry.toolKinds)}`)),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '耗时'),
            h('span', { style: styles.value },
              `toolWallMs ${show(entry.toolWallMs, 'ms')}`
              + ` · 总时长 ${show(entry.totalMs, 'ms')}`
              + ` · 首音 ${show(entry.firstAudioMs, 'ms')}`
              + ` · 残差 ${show(entry.residualMs, 'ms')}`
              + ` · 首块队列等待 ${show(entry.firstChunkQueueWaitMs, 'ms')}`)));
      };
      return h('div', { style: styles.group, 'data-settings-group': 'timeline', 'data-seirein-timeline': 'turn' },
        h('div', { style: styles.groupTitle }, '最近一轮时间线'),
        h('div', { style: styles.hint },
          '只在打开设置页或点「刷新」时读取一次 turn.timeline / pipeline.timeline；'
          + '不轮询，也不自动新建会话或压缩。'),
        loading ? h('div', { style: styles.hint }, '正在读取时间线…') : null,
        error === ''
          ? null
          : h('div', { style: { ...styles.hint, color: DANGER } }, `时间线读取失败：${error}`),
        !loading && rows.length === 0 && error === ''
          ? h('div', { style: styles.hint }, DIAGNOSTICS_TIMELINE_EMPTY)
          : null,
        loading ? null : rows.map(turnBlock),
        updated === null
          ? null
          : h('div', { style: styles.mono },
            `上次读取：${new Date(updated).toLocaleTimeString('zh-CN', { hour12: false })}`));
    }

    // ---- 设置页：存放位置 / 恢复语音会话 ------------------------------------------------
    // 两个都是显式动作：保存只写设置、恢复只手动触发。这里没有定时器、没有自动重试，也没有
    // 自动重启或数据迁移；接口缺失 / 超时 / 畸形返回都只变成一行提示，不向渲染抛出。
    const SETTINGS_ACTION_TIMEOUT_MS = 8000;
    const RECOVER_SESSION_TIMEOUT_MS = 30000;

    /** 只接受普通对象；数组 / null / 原始值一律当作「没有结果」。 */
    const settingsObject = (value) => (
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
    );

    const settingsText = (...values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
      }
      return '';
    };

    const settingsErrorText = (cause) => (
      cause instanceof Error ? cause.message : String(cause ?? '未知错误')
    );

    /** status 里的当前 root（只读）：status.root 优先，其次 config/paths/instance 上的副本。 */
    function instanceRootOf(status, fallback = '') {
      const object = settingsObject(status);
      return settingsText(
        object?.root,
        object?.instance?.root,
        object?.config?.root,
        object?.paths?.root,
        fallback,
      );
    }

    /** 宿主的 root 是数据目录；选择框存父目录（host 会补 `<parent>\Seirein`）。 */
    function instanceRootParentOf(root) {
      const text = settingsText(root);
      if (text === '') return '';
      const parent = text.replace(/[\\/]+Seirein[\\/]*$/iu, '');
      return parent === text ? text : parent;
    }

    /**
     * POST /assistant/action 的最小封装：一次请求、一个硬超时，任何失败都只返回
     * `{ok:false, code, error, timedOut}`，调用方永远不需要 try/catch。
     */
    async function runSettingsAction(body, options = {}) {
      const fetchImpl = options.fetchImpl !== undefined
        ? options.fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : SETTINGS_ACTION_TIMEOUT_MS;
      if (typeof fetchImpl !== 'function') {
        return { ok: false, code: 'FETCH_UNAVAILABLE', error: '服务未就绪（无法连接 DSH）', timedOut: false };
      }
      let controller = null;
      try {
        controller = typeof AbortController === 'function' ? new AbortController() : null;
      } catch {
        controller = null;
      }
      const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl('/assistant/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body ?? {}),
          ...(controller === null ? {} : { signal: controller.signal }),
        });
        if (response === null || response === undefined || response.ok !== true) {
          const status = Number(response?.status);
          return {
            ok: false,
            code: Number.isFinite(status) ? `HTTP_${status}` : 'NO_RESPONSE',
            error: Number.isFinite(status) ? `HTTP ${status}` : '没有响应',
            timedOut: false,
          };
        }
        const result = await response.json();
        const object = settingsObject(result);
        if (object === null) {
          return { ok: false, code: 'BAD_RESPONSE', error: '返回格式异常', timedOut: false };
        }
        return object;
      } catch (cause) {
        const aborted = cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR';
        return {
          ok: false,
          code: aborted ? 'TIMEOUT' : 'REQUEST_FAILED',
          error: aborted ? '请求超时' : settingsErrorText(cause),
          timedOut: aborted,
        };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    /** instance.setRoot 的拒绝码 -> 可读原因（码本身仍留在 detail 里）。 */
    const INSTANCE_ROOT_CODE_TEXT = {
      EMPTY_ROOT: '请填写存放位置',
      RELATIVE_ROOT: '请填写绝对路径',
      NOT_A_DIRECTORY: '所选路径是文件，不是目录',
      NOT_WRITABLE: '该位置不可写（检查权限或路径）',
      WRITE_FAILED: '写入设置失败（检查权限）',
      TIMEOUT: '请求超时，未确认是否保存',
      FETCH_UNAVAILABLE: '服务未就绪（无法连接 DSH）',
      NO_RESPONSE: '服务没有响应',
      BAD_RESPONSE: '返回格式异常',
      REQUEST_FAILED: '请求失败',
    };

    const instanceRootCodeText = (code) => INSTANCE_ROOT_CODE_TEXT[code] ?? '';

    /**
     * 把一次 instance.setRoot 结果投影成卡片提示。restart-required 是正常结果：既可能是
     * `applied:'restart-required'`，也可能是旧的 `applied:false, reason:'restart-required'`。
     */
    function instanceRootOutcome(result, submitted = '') {
      const object = settingsObject(result);
      if (object === null) {
        return {
          ok: false, danger: true, restartRequired: false, root: '', code: 'NO_RESPONSE',
          message: '保存失败：没有返回结果', detail: '',
        };
      }
      const code = settingsText(object.code);
      const reason = settingsText(object.reason);
      const restartRequired = object.applied === 'restart-required'
        || reason === 'restart-required'
        || code === 'restart-required'
        || object.restartRequired === true;
      // restart-required 只是「下次启动生效」，不能报成失败；真正的拒绝会带别的错误码。
      const accepted = object.ok === true
        || (restartRequired && (code === '' || code === 'restart-required'));
      if (accepted) {
        const root = settingsText(object.root, object.dataRoot, object.parent, submitted);
        const appliedNow = object.applied === true;
        return {
          ok: true,
          danger: false,
          restartRequired: !appliedNow,
          root,
          code: '',
          message: appliedNow ? '已保存并已生效' : '已保存，需重启 DSH 生效',
          detail: root === '' ? '' : `存放位置：${root}`,
        };
      }
      const friendly = instanceRootCodeText(code)
        || instanceRootCodeText(reason)
        || reason
        || code
        || '未知原因';
      return {
        ok: false,
        danger: true,
        restartRequired: false,
        root: '',
        code: code || reason,
        message: `保存失败：${friendly}`,
        detail: code === '' ? '' : `原因码：${code}`,
      };
    }

    /** 显式保存：空输入不发请求；动作参数固定 `{ action:'instance.setRoot', root }`。 */
    async function submitInstanceRoot(root, post) {
      const value = typeof root === 'string' ? root.trim() : '';
      if (value === '') {
        return {
          ok: false, danger: true, restartRequired: false, root: '', code: 'EMPTY_ROOT',
          message: '请先选择或输入存放位置', detail: '',
        };
      }
      if (typeof post !== 'function') {
        return instanceRootOutcome({ ok: false, code: 'FETCH_UNAVAILABLE' }, value);
      }
      let result;
      try {
        result = await post({ action: 'instance.setRoot', root: value });
      } catch (cause) {
        result = { ok: false, code: 'REQUEST_FAILED', error: settingsErrorText(cause) };
      }
      return instanceRootOutcome(result, value);
    }

    /** 目录选择器是可选依赖：缺失 / 取消 / 抛错都只返回一行提示，不打断设置页。 */
    async function pickRootDirectory(uiWorkspace) {
      if (uiWorkspace === null || uiWorkspace === undefined
        || typeof uiWorkspace.pickDirectory !== 'function') {
        return { ok: false, path: '', error: '目录选择器不可用，请手动输入路径' };
      }
      try {
        const picked = await uiWorkspace.pickDirectory();
        if (typeof picked !== 'string' || picked.trim() === '') return { ok: false, path: '', error: '' };
        return { ok: true, path: picked.trim(), error: '' };
      } catch (cause) {
        return { ok: false, path: '', error: `目录选择失败：${settingsErrorText(cause)}` };
      }
    }

    /** voice.session.recover 的受控码 -> 友好文案；未知码回落到宿主 reason。 */
    const RECOVER_CODE_TEXT = {
      'agent-owned': '会话仍被占用，请先重启 DSH',
      'preset-missing': '压缩能力未就绪',
      'preset-conflict': '压缩预设冲突（见诊断）',
      'compaction-failed': '压缩失败，历史未删除',
      'resume-failed': '恢复失败，历史未改动',
      'mount-failed': '恢复后压缩能力未挂载',
      'compaction-unavailable': '当前作用域没有压缩能力',
      'agent-loop-unavailable': '恢复接口不可用（需重启 DSH）',
      'session-unresolved': '找不到要恢复的语音会话',
      'not-voice-session': '只能恢复 seirein-YYYY-MM-DD 语音会话',
      'preset-invalid': '压缩预设定义损坏（见诊断）',
      'preset-unavailable': '压缩预设读取失败',
      'preset-registry-unavailable': '找不到压缩预设注册表',
      TIMEOUT: '恢复超时，未确认结果',
      FETCH_UNAVAILABLE: '服务未就绪（无法连接 DSH）',
      NO_RESPONSE: '服务没有响应',
      BAD_RESPONSE: '返回格式异常',
      REQUEST_FAILED: '请求失败',
    };

    const recoverCodeText = (code) => RECOVER_CODE_TEXT[code] ?? '';

    const recoverCount = (value) => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    );

    // ---- 恢复结果的容量建议：只展示，绝不自动滚动、自动压缩或自动新建会话 -------------------
    const RECOVER_WARN = '#b8860b';
    const RECOVER_CAPACITY_TEXT = {
      STILL_NEAR_LIMIT: '压缩后仍接近上限',
      NEW_SESSION: '建议新建会话+交接摘要',
      MANUAL_COMPACT: '建议手动再压缩一次',
      INEFFECTIVE: '本次压缩未明显释放容量',
    };
    const RECOVER_RECOMMENDATION_TEXT = {
      'new-session': RECOVER_CAPACITY_TEXT.NEW_SESSION,
      'manual-compact': RECOVER_CAPACITY_TEXT.MANUAL_COMPACT,
    };
    const recoverFlag = (raw) => (raw === true ? true : raw === false ? false : null);

    /**
     * voice.session.recover 的 stillNearLimit / compressionEffective / recommendation ->
     * 规范化三字段 + 黄字提示。未知 recommendation 原样保留，不猜测含义。
     */
    function recoverCapacityOf(value) {
      const object = settingsObject(value);
      if (object === null) {
        return { stillNearLimit: null, compressionEffective: null, recommendation: '', warnings: [] };
      }
      const stillNearLimit = recoverFlag(object.stillNearLimit);
      const compressionEffective = recoverFlag(object.compressionEffective);
      const recommendation = settingsText(object.recommendation);
      const warnings = [];
      if (stillNearLimit === true) warnings.push(RECOVER_CAPACITY_TEXT.STILL_NEAR_LIMIT);
      const recommended = RECOVER_RECOMMENDATION_TEXT[recommendation];
      if (recommended !== undefined) warnings.push(recommended);
      if (compressionEffective === false) warnings.push(RECOVER_CAPACITY_TEXT.INEFFECTIVE);
      return { stillNearLimit, compressionEffective, recommendation, warnings };
    }

    /** 成功展示 before→after / freed / mounted；失败只展示受控文案 + 原因码。 */
    function recoverSessionOutcome(result) {
      const object = settingsObject(result);
      if (object === null) {
        return {
          ok: false, danger: true, code: 'NO_RESPONSE', sessionId: '', mounted: null,
          before: null, after: null, freed: null, compacted: null,
          ...recoverCapacityOf(null),
          message: recoverCodeText('NO_RESPONSE'), detail: '',
        };
      }
      const capacity = recoverCapacityOf(object);
      const code = settingsText(object.code);
      const sessionId = settingsText(object.sessionId);
      if (object.ok === true) {
        const before = recoverCount(object.before);
        const after = recoverCount(object.after);
        const freed = recoverCount(object.freed)
          ?? (before !== null && after !== null ? before - after : null);
        const mounted = object.mounted === true;
        const compacted = object.compacted === true;
        const show = (value) => (value === null ? '—' : String(value));
        return {
          ok: true, danger: false, code: '', sessionId, mounted, before, after, freed, compacted,
          ...capacity,
          message: `已恢复${sessionId === '' ? '' : ` ${sessionId}`}：`
            + `${show(before)} → ${show(after)} token，释放 ${show(freed)}`,
          detail: `preset ${mounted ? '已挂载' : '未挂载'} · `
            + `${compacted ? '已压缩一次' : '本次没有可压缩范围（历史未改动）'}`,
        };
      }
      const reason = settingsText(object.reason, object.error);
      const friendly = recoverCodeText(code);
      return {
        ok: false,
        danger: true,
        code,
        sessionId,
        mounted: object.mounted === true,
        before: recoverCount(object.before),
        after: null,
        freed: null,
        compacted: false,
        ...capacity,
        message: friendly !== '' ? friendly : (reason !== '' ? reason : '恢复失败'),
        detail: code === '' ? '' : `原因码：${code}`,
      };
    }

    /** 二次确认之后才调用的唯一入口；没有 sessionId 时由宿主恢复当前的语音会话。 */
    async function submitVoiceSessionRecover(post, sessionId = '') {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      const body = id === ''
        ? { action: 'voice.session.recover' }
        : { action: 'voice.session.recover', sessionId: id };
      if (typeof post !== 'function') {
        return recoverSessionOutcome({ ok: false, code: 'FETCH_UNAVAILABLE' });
      }
      let result;
      try {
        result = await post(body, RECOVER_SESSION_TIMEOUT_MS);
      } catch (cause) {
        result = { ok: false, code: 'REQUEST_FAILED', error: settingsErrorText(cause) };
      }
      return recoverSessionOutcome(result);
    }

    /** 存放位置卡片：只读 root + 一个显式按钮；弹窗里可以输入或走目录选择器。 */
    function instanceRootSection(h, props) {
      const { status, dialog, notice, busy } = props;
      const root = instanceRootOf(status, settingsText(props.fallbackRoot));
      const open = settingsObject(dialog) !== null;
      const draft = open && typeof dialog.draft === 'string' ? dialog.draft : '';
      const dialogError = open ? settingsText(dialog.error) : '';
      const locked = busy === true;
      const saveDisabled = locked || draft.trim() === '';
      return h('div', { style: styles.group, 'data-settings-group': 'instance-root', 'data-seirein-root': 'instance' },
        h('div', { style: styles.groupTitle }, '工作目录（root 只读）'),
        h('div', { style: styles.row },
          h('span', { style: styles.label }, '当前工作目录'),
          h('span', { style: { ...styles.mono, wordBreak: 'break-all' } }, root === '' ? '不可用' : root)),
        h('div', { style: styles.row },
          h('span', { style: styles.value }, '只写入设置，需重启 DSH 生效'),
          h('button', {
            style: { ...styles.btnPrimary, ...(locked ? styles.off : {}) },
            disabled: locked,
            onClick: () => props.onOpen?.(),
          }, '选择存放位置')),
        h('div', { style: styles.hint },
          '保存后不会自动重启 DSH，也不会自动迁移已有数据；重启后新位置生效，原数据需要自己搬。'),
        notice === null || notice === undefined
          ? null
          : h('div', {
              style: { ...styles.hint, color: notice.danger === true ? DANGER : '#2b8a3e' },
            },
              notice.message,
              typeof notice.detail === 'string' && notice.detail !== ''
                ? h('span', { style: styles.mono }, ` · ${notice.detail}`)
                : null),
        !open ? null : h('div', {
          style: styles.overlay,
          onClick: (event) => { if (event.target === event.currentTarget) props.onCancel?.(); },
        },
          h('div', { style: styles.dialog },
            h('div', { style: styles.title }, '选择存放位置'),
            h('div', { style: styles.hint },
              '数据会写到 <所选目录>\\Seirein。保存后需重启 DSH 生效；不会自动重启，也不会迁移已有数据。'),
            h('div', { style: styles.field },
              h('span', { style: styles.label }, '目录（绝对路径）'),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('input', {
                  style: styles.input,
                  value: draft,
                  placeholder: '例如：D:\\SeireinData',
                  onChange: (event) => props.onDraft?.(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !saveDisabled) props.onSave?.();
                  },
                }),
                h('button', {
                  style: { ...styles.btn, ...(locked ? styles.off : {}) },
                  disabled: locked,
                  onClick: () => props.onPick?.(),
                }, '浏览…'))),
            dialogError === ''
              ? null
              : h('div', { style: { ...styles.hint, color: DANGER } }, dialogError),
            h('div', { style: styles.row },
              h('span', { style: styles.value }, ''),
              h('span', { style: { display: 'flex', gap: 8 } },
                h('button', {
                  style: { ...styles.btn, ...(locked ? styles.off : {}) },
                  disabled: locked,
                  onClick: () => props.onCancel?.(),
                }, '取消'),
                h('button', {
                  style: { ...styles.btnPrimary, ...(saveDisabled ? styles.off : {}) },
                  disabled: saveDisabled,
                  onClick: () => props.onSave?.(),
                }, locked ? '保存中…' : '保存'))))));
    }

    /** 恢复卡片：按钮 -> 二次确认 -> 一次动作；结果只展示，不自动调用、不轮询。 */
    function recoverSessionSection(h, props) {
      const { confirm, busy, outcome } = props;
      const armed = confirm === true;
      const locked = busy === true;
      return h('div', { style: styles.group, 'data-settings-group': 'recover', 'data-seirein-recover': 'voice-session' },
        h('div', { style: styles.groupTitle }, '恢复语音会话（诊断）'),
        h('div', { style: styles.hint },
          '手动重装配压缩 preset 并先压缩一次；不会自动调用，也不会轮询。历史不会被删除。'),
        armed
          ? h('div', { style: styles.row },
              h('span', { style: { ...styles.value, color: DANGER } },
                '将重新恢复当前语音会话并压缩一次，确认吗？'),
              h('span', { style: { display: 'flex', gap: 8 } },
                h('button', {
                  style: { ...styles.btn, ...(locked ? styles.off : {}) },
                  disabled: locked,
                  onClick: () => props.onCancel?.(),
                }, '取消'),
                h('button', {
                  style: { ...styles.btnDanger, ...(locked ? styles.off : {}) },
                  disabled: locked,
                  onClick: () => props.onConfirm?.(),
                }, locked ? '恢复中…' : '确认恢复')))
          : h('div', { style: styles.row },
              h('span', { style: styles.value }, '只在需要时手动点一次'),
              h('button', {
                style: { ...styles.btn, ...(locked ? styles.off : {}) },
                disabled: locked,
                onClick: () => props.onAsk?.(),
              }, '恢复当前语音会话')),
        outcome === null || outcome === undefined
          ? null
          : h('div', {
              style: { ...styles.hint, color: outcome.danger === true ? DANGER : '#2b8a3e' },
            },
              outcome.message,
              typeof outcome.detail === 'string' && outcome.detail !== ''
                ? h('span', { style: styles.mono }, ` · ${outcome.detail}`)
                : null),
        outcome === null || outcome === undefined
          || !Array.isArray(outcome.warnings) || outcome.warnings.length === 0
          ? null
          : h('div', { style: { ...styles.hint, color: RECOVER_WARN } },
            outcome.warnings.join(' · ')));
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
      // 显式视线输入映射（settings.avatar.channelMap）：null = 未编辑，输入框回显 status；
      // 保存失败时用 status.avatar.channelMap 回滚，避免输入框停在宿主拒绝的值上。
      const [avatarChannelMapDraft, setAvatarChannelMapDraft] = useState(null);
      // 眨眼控制方（settings.avatar.blinkOwner）：null = 未编辑，按钮回显 status；
      // 失败时回到最近一次确认值，不把界面留在宿主拒绝的选择上。
      const [avatarBlinkOwnerDraft, setAvatarBlinkOwnerDraft] = useState(null);
      // 启动时自动验证动作映射（settings.avatar.verifyMappingsOnStartup）：null = 未编辑，
      // 开关回显 status；保存失败回到 status 的已确认值。
      const [avatarAutoVerifyDraft, setAvatarAutoVerifyDraft] = useState(null);
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
      // Read-only warm-up snapshot: remembers the config identity of the last observed status so
      // a changed model/reference/language can mark the still-shown old snapshot stale. No request.
      const ttsWarmupWatch = useRef(null);
      // 动作预设：列表（含覆盖值与可用性）、搜索/过滤、优先级草稿（key = action:id / family:id）。
      const [motionPresets, setMotionPresets] = useState(null);
      const [motionQuery, setMotionQuery] = useState('');
      const [motionFilters, setMotionFilters] = useState({ family: '', style: '', availability: '' });
      const [motionDrafts, setMotionDrafts] = useState({});
      // 「音频保留（诊断）」：列表/限制/错误来自 audio.retention.list；删除与试听都先经此处。
      const [retentionData, setRetentionData] = useState(null);
      const [retentionPreview, setRetentionPreview] = useState(null);
      const [retentionConfirm, setRetentionConfirm] = useState('');
      // 「共享语言库」：列表（待确认候选 + 共享词库）、确认/编辑弹窗与忽略/删除的两步确认。
      const [lexiconData, setLexiconData] = useState(null);
      const [lexiconDialog, setLexiconDialog] = useState(null);
      const [lexiconPending, setLexiconPending] = useState(null);
      const [lexiconDraft, setLexiconDraft] = useState(() => lexiconEmptyDraft());
      // 客户端诊断：打开设置页时读一次 /assistant/status；之后只由「刷新」再读，不新增轮询。
      const [diagnostics, setDiagnostics] = useState(null);
      // 最近一轮时间线：与诊断同一次打开/刷新读取（每个 probe 一次），不额外轮询。
      const [timeline, setTimeline] = useState(null);

      // 声纹登记：一次读取的结果 + 最近一次显式动作的提示（不自动确认、不自动拒绝）。
      const [speakerEnroll, setSpeakerEnroll] = useState(null);
      const [speakerEnrollNotice, setSpeakerEnrollNotice] = useState('');
      // 声纹候选：一次读取 + 用户勾选/试听/预览/建库。所有写操作只在按钮回调里发生。
      const [speakerCandidates, setSpeakerCandidates] = useState(null);
      const [speakerCandidateSelection, setSpeakerCandidateSelection] = useState([]);
      const [speakerCandidateAudio, setSpeakerCandidateAudio] = useState({});
      const [speakerCandidatePreview, setSpeakerCandidatePreview] = useState(null);
      const [speakerCandidateNotice, setSpeakerCandidateNotice] = useState(null);
      const [speakerCandidateLabel, setSpeakerCandidateLabel] = useState('');
      const [speakerCandidateBusy, setSpeakerCandidateBusy] = useState('');
      // 版本回滚的二次确认：只保存待确认的版本号，不查库也不改状态。
      const [speakerTemplateRollback, setSpeakerTemplateRollback] = useState(null);
      // 存放位置：当前 root 只读来自 status；保存只写设置，需重启 DSH 生效（不自动重启/迁移）。
      const [rootDialog, setRootDialog] = useState(null);
      const [rootNotice, setRootNotice] = useState(null);
      const [rootBusy, setRootBusy] = useState(false);
      // 恢复语音会话：按钮 -> 二次确认 -> 一次动作；结果只展示，不轮询、不自动重试。
      const [recoverConfirm, setRecoverConfirm] = useState(false);
      const [recoverBusy, setRecoverBusy] = useState(false);
      const [recoverOutcome, setRecoverOutcome] = useState(null);
      // 阈值保存触发的采集重启结果：状态接口未提供时，用本次设置页最后一次动作结果补齐。
      const [lastRestart, setLastRestart] = useState(null);
      // 「最近听到」只看 1 条还是最近 3 条；只是展示状态，不写 settings。
      const [expandedAmbient, setExpandedAmbient] = useState(false);
      // 「主动回应」开关与通过率：null = 跟随 status 里的已保存值；改动先乐观写本地，失败再回滚。
      const [proactiveDraft, setProactiveDraft] = useState(null);
      const [proactiveRateDraft, setProactiveRateDraft] = useState(null);
      const [proactiveError, setProactiveError] = useState('');
      // 持续观看的独立开关：只作为本次动作的乐观值，最终以 status.vision.continuous.enabled 为准。
      const [continuousDraft, setContinuousDraft] = useState(null);
      const [continuousError, setContinuousError] = useState('');
      // 文字陪伴归属（settings.companion）：开关、手动登记输入与最近一次动作提示。
      // 归属只认宿主返回的 typedSessions；pre-step 不会自动登记，本页也只发送显式动作。
      const [typedCompanionDraft, setTypedCompanionDraft] = useState(null);
      const [typedSessionDraft, setTypedSessionDraft] = useState('');
      const [typedCompanionError, setTypedCompanionError] = useState('');
      const [typedCompanionNotice, setTypedCompanionNotice] = useState('');
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
            if (body.action === 'hearing.threshold' && result !== null && typeof result === 'object') {
              setLastRestart({
                ok: result.ok === true,
                restarted: result.restarted === true,
                instanceId: String(result.instanceId ?? ''),
                message: String(result.message ?? result.error ?? ''),
                at: Date.now(),
              });
            }
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

      /**
       * 最近一轮时间线：一次读取 = turn.timeline / pipeline.timeline 各一个请求（宿主 action 一次
       * 只接受一个 probe），没有重试、没有定时器；失败只变成卡片里的一行原因。
       */
      const loadTimeline = useCallback(async () => {
        setTimeline((current) => ({ ...(current ?? {}), loading: true, error: '' }));
        const read = await readDiagnosticsTimelines(
          (body, timeoutMs) => runSettingsAction(body, { timeoutMs }),
        );
        setTimeline({ ...read, loading: false });
      }, []);

      /**
       * 客户端诊断：一次面板打开只读一次 /assistant/status，之后只由「刷新」再读。
       * 失败时保留上一次成功的数据并显示错误；首次失败则各分区显示「不可用」。
       * 时间线跟随同一次读取，不额外增加轮询或第二个入口。
       */
      const loadDiagnostics = useCallback(async () => {
        setDiagnostics((current) => ({
          status: current?.status ?? null,
          error: '',
          loading: true,
          at: current?.at ?? 0,
        }));
        const [result] = await Promise.all([loadDiagnosticsStatus(), loadTimeline()]);
        setDiagnostics((current) => ({
          status: result.status ?? current?.status ?? null,
          error: result.error,
          loading: false,
          at: result.at,
        }));
      }, [loadTimeline]);

      const copyDiagnostics = useCallback(async () => {
        const text = diagnosticsReportOf(diagnostics?.status ?? null, {
          clientVersion: CLIENT_VERSION,
          localRestart: lastRestart,
          readError: diagnostics?.error ?? '',
          timeline,
        });
        const result = await copyDiagnosticsReport(
          text,
          typeof navigator === 'undefined' ? null : navigator.clipboard,
        );
        show(result.ok ? '诊断报告已复制' : `复制失败：${result.error}`);
      }, [diagnostics, lastRestart, show, timeline]);

      // ---- 声纹登记（客户端）handlers -----------------------------------------------------
      // 一次挂载读一次 list + shadow；之后只有「刷新」或一次显式动作成功后再读。没有定时器。
      const loadSpeakerEnroll = useCallback(async () => {
        setSpeakerEnroll((current) => ({
          list: current?.list ?? null,
          shadow: current?.shadow ?? null,
          loading: true,
          error: '',
          at: current?.at ?? 0,
        }));
        const read = await speakerEnrollRead(fetch);
        setSpeakerEnroll({
          list: read.list,
          shadow: read.shadow,
          loading: false,
          error: read.error,
          at: Date.now(),
        });
      }, []);

      /** 确认 / 拒绝 / 删除都是一次点击一次请求：不重试，也不顺手改别的条目。 */
      const runSpeakerEnroll = useCallback(async (op, speakerId) => {
        const body = op === 'confirm'
          ? { action: 'speaker.enroll.confirm', speakerId }
          : op === 'reject'
            ? { action: 'speaker.enroll.reject', speakerId }
            : { action: 'speaker.enroll.remove', speakerId };
        const result = await act(body, `speaker-enroll-${op}`);
        const outcome = speakerEnrollOutcome(op, result);
        setSpeakerEnrollNotice(outcome.message);
        if (outcome.ok) await loadSpeakerEnroll();
        return result;
      }, [act, loadSpeakerEnroll]);

      /** 契约里还没有录制动作：不假装开始录音，直接说明先自动收集。 */
      const startSpeakerEnroll = useCallback(() => {
        setSpeakerEnrollNotice(SPEAKER_ENROLL_RECORD_HINT);
        show(SPEAKER_ENROLL_RECORD_HINT);
      }, [show]);

      // ---- 声纹候选 handlers ---------------------------------------------------------------
      // 读取只读 list；所有写动作都是「一次点击 = 一次请求」，没有定时器、重试或自动确认。
      const loadSpeakerCandidates = useCallback(async () => {
        setSpeakerCandidates((current) => ({
          list: current?.list ?? null,
          loading: true,
          error: '',
          at: current?.at ?? 0,
        }));
        const result = await runSettingsAction(
          { action: 'speaker.candidates.list' },
          { timeoutMs: SPEAKER_CANDIDATE_READ_TIMEOUT_MS },
        );
        const list = result !== null && typeof result === 'object'
          ? result
          : { ok: false, error: '没有返回' };
        const data = { list, loading: false, error: '', at: Date.now() };
        setSpeakerCandidates(data);
        const view = speakerCandidateView(data);
        if (view.available) {
          const ids = new Set(view.candidates.map((candidate) => candidate.id));
          setSpeakerCandidateSelection((current) => current.filter((id) => ids.has(id)));
        }
        setSpeakerCandidateLabel((current) => (
          current.trim() === '' ? view.libraryLabel : current
        ));
      }, []);

      const runSpeakerCandidateAction = useCallback(async (body, tag) => {
        setSpeakerCandidateBusy(tag);
        try {
          return await runSettingsAction(body);
        } finally {
          setSpeakerCandidateBusy('');
        }
      }, []);

      const toggleSpeakerCandidate = useCallback((id, checked) => {
        setSpeakerCandidateSelection((current) => {
          if (checked === true) return current.includes(id) ? current : [...current, id];
          return current.filter((value) => value !== id);
        });
      }, []);

      const loadSpeakerCandidateAudio = useCallback(async (id) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.candidates.audio', id },
          'speaker-candidate-audio',
        );
        const outcome = speakerCandidateOutcome('audio', result);
        setSpeakerCandidateNotice(outcome);
        if (outcome.ok && typeof result?.dataUrl === 'string' && result.dataUrl !== '') {
          setSpeakerCandidateAudio((current) => ({ ...current, [id]: result.dataUrl }));
        }
      }, [runSpeakerCandidateAction]);

      const removeSpeakerCandidate = useCallback(async (id) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.candidates.remove', id },
          'speaker-candidate-remove',
        );
        const outcome = speakerCandidateOutcome('remove', result);
        setSpeakerCandidateNotice(outcome);
        if (!outcome.ok) return; // A failure must not silently drop the user's selection.
        setSpeakerCandidateSelection((current) => current.filter((value) => value !== id));
        setSpeakerCandidateAudio((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        await loadSpeakerCandidates();
      }, [loadSpeakerCandidates, runSpeakerCandidateAction]);

      const clearSpeakerCandidates = useCallback(async () => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.candidates.clear' },
          'speaker-candidate-clear',
        );
        const outcome = speakerCandidateOutcome('clear', result);
        setSpeakerCandidateNotice(outcome);
        if (!outcome.ok) return;
        setSpeakerCandidateSelection([]);
        setSpeakerCandidateAudio({});
        setSpeakerCandidatePreview(null);
        await loadSpeakerCandidates();
      }, [loadSpeakerCandidates, runSpeakerCandidateAction]);

      const previewSpeakerCandidates = useCallback(async (ids) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.candidates.preview', ids },
          'speaker-candidate-preview',
        );
        setSpeakerCandidatePreview(result);
        setSpeakerCandidateNotice(null);
      }, [runSpeakerCandidateAction]);

      const buildSpeakerBase = useCallback(async (ids, label) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.candidates.build', ids, label },
          'speaker-candidate-build',
        );
        const outcome = speakerCandidateOutcome('build', result);
        setSpeakerCandidateNotice(outcome);
        if (!outcome.ok) return; // keep the selection so a corrected set can be retried
        setSpeakerCandidateSelection([]);
        setSpeakerCandidatePreview(null);
        await Promise.all([loadSpeakerCandidates(), loadSpeakerEnroll()]);
      }, [loadSpeakerCandidates, loadSpeakerEnroll, runSpeakerCandidateAction]);

      /** 显式强化：失败时保留勾选；成功只刷新候选/版本视图，不碰登记里的确认状态。 */
      const strengthenSpeakerTemplate = useCallback(async (ids, label) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.template.strengthen', ids, label },
          'speaker-template-strengthen',
        );
        const outcome = speakerCandidateOutcome('strengthen', result);
        setSpeakerCandidateNotice(outcome);
        if (!outcome.ok) return; // a failed strengthen keeps the user's selection
        setSpeakerCandidateSelection([]);
        setSpeakerCandidatePreview(null);
        setSpeakerTemplateRollback(null);
        await loadSpeakerCandidates();
      }, [loadSpeakerCandidates, runSpeakerCandidateAction]);

      /** 回滚只在用户第二次确认后发一次请求；恢复失败也保留当前选择。 */
      const rollbackSpeakerTemplate = useCallback(async (version) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.template.rollback', version },
          'speaker-template-rollback',
        );
        const outcome = speakerCandidateOutcome('rollback', result);
        setSpeakerCandidateNotice(outcome);
        setSpeakerTemplateRollback(null);
        if (!outcome.ok) return;
        await loadSpeakerCandidates();
      }, [loadSpeakerCandidates, runSpeakerCandidateAction]);

      const renameSpeakerLibrary = useCallback(async (label) => {
        const result = await runSpeakerCandidateAction(
          { action: 'speaker.rename', speakerId: 'self', label },
          'speaker-rename',
        );
        const outcome = speakerCandidateOutcome('rename', result);
        setSpeakerCandidateNotice(outcome);
        if (!outcome.ok) return;
        await loadSpeakerCandidates();
      }, [loadSpeakerCandidates, runSpeakerCandidateAction]);

      /** 只复制脱敏后的状态摘要：没有标签文本、样本 id、路径或转写。 */
      const copySpeakerEnroll = useCallback(async () => {
        const text = speakerEnrollReportOf(speakerEnroll);
        const target = typeof navigator === 'undefined' ? null : navigator.clipboard;
        if (target === null || typeof target?.writeText !== 'function') {
          show('复制失败：剪贴板不可用');
          return;
        }
        try {
          await target.writeText(text);
          show('声纹报告已复制（已脱敏，不含路径与文本）');
        } catch (cause) {
          show(`复制失败：${cause && cause.message ? cause.message : String(cause)}`);
        }
      }, [speakerEnroll, show]);

      // ---- 存放位置 / 恢复语音会话 handlers ------------------------------------------------
      // 一次点击一次请求：这两个动作没有定时器、没有重试、没有自动重启或数据迁移。
      const postSettingsAction = useCallback(
        (body, timeoutMs) => runSettingsAction(body, { timeoutMs }),
        [],
      );

      const openRootDialog = useCallback(() => {
        setRootDialog({ draft: instanceRootParentOf(instanceRootOf(status)), error: '' });
      }, [status]);

      const closeRootDialog = useCallback(() => {
        setRootDialog(null);
      }, []);

      const pickRootIntoDialog = useCallback(async () => {
        const picked = await pickRootDirectory(window.__seireinCtx?.get?.('uiWorkspace'));
        if (picked.ok === true) {
          setRootDialog((current) => (current === null
            ? current
            : { ...current, draft: picked.path, error: '' }));
          return;
        }
        if (picked.error !== '') {
          setRootDialog((current) => (current === null
            ? current
            : { ...current, error: picked.error }));
        }
      }, []);

      const saveRootDialog = useCallback(async () => {
        if (rootDialog === null || rootBusy) return;
        setRootBusy(true);
        const outcome = await submitInstanceRoot(rootDialog.draft, postSettingsAction);
        setRootBusy(false);
        setRootNotice(outcome);
        if (outcome.ok) {
          setRootDialog(null);
          show(outcome.message);
          return;
        }
        setRootDialog((current) => (current === null
          ? current
          : { ...current, error: outcome.message }));
      }, [postSettingsAction, rootBusy, rootDialog, show]);

      /** 首次使用卡片上的「使用默认位置」：同一条显式保存路径，不迁移数据。 */
      const applyDefaultRoot = useCallback(async () => {
        const parent = instanceRootParentOf(instanceRootOf(status));
        if (parent === '') {
          setRootNotice({
            ok: false, danger: true, restartRequired: false, root: '', code: 'EMPTY_ROOT',
            message: '无法推断默认位置', detail: '',
          });
          return;
        }
        setRootBusy(true);
        const outcome = await submitInstanceRoot(parent, postSettingsAction);
        setRootBusy(false);
        setRootNotice(outcome);
        if (outcome.ok) show(outcome.message);
      }, [postSettingsAction, show, status]);

      const askRecoverSession = useCallback(() => {
        setRecoverOutcome(null);
        setRecoverConfirm(true);
      }, []);

      const cancelRecoverSession = useCallback(() => {
        setRecoverConfirm(false);
      }, []);

      const confirmRecoverSession = useCallback(async () => {
        if (recoverBusy) return;
        setRecoverBusy(true);
        const outcome = await submitVoiceSessionRecover(postSettingsAction);
        setRecoverBusy(false);
        setRecoverConfirm(false);
        setRecoverOutcome(outcome);
      }, [postSettingsAction, recoverBusy]);

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

      /**
       * 音频保留列表：只在挂载/开关/删除/试听后读取，不跟随 3 秒状态轮询。
       * 未接线（AUDIO_RETENTION_UNAVAILABLE）或文件读失败时保留宿主的错误文案，卡片只显示，
       * 不抛出、不影响同一张「听觉」卡片上的其它控件。
       */
      const loadRetention = useCallback(async () => {
        try {
          const response = await fetch('/assistant/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ action: 'audio.retention.list' }),
          });
          const result = await response.json();
          setRetentionData(result?.ok === true
            ? {
                items: Array.isArray(result.items) ? result.items : [],
                limits: result.limits ?? null,
                loading: false,
                error: '',
              }
            : {
                items: [],
                limits: null,
                loading: false,
                error: String(result?.error ?? result?.code ?? '读取失败'),
              });
        } catch (cause) {
          setRetentionData({
            items: [],
            limits: null,
            loading: false,
            error: cause && cause.message ? cause.message : String(cause),
          });
        }
      }, []);

      const retentionFailure = useCallback((result) => {
        setRetentionData((current) => ({
          items: current?.items ?? [],
          limits: current?.limits ?? null,
          loading: false,
          error: String(result?.error ?? result?.code ?? '操作失败'),
        }));
      }, []);

      const toggleRetention = useCallback(async (enabled) => {
        const result = await act({ action: 'voice.audioRetention', enabled }, 'audio-retention');
        if (result?.ok === true) {
          show(enabled ? '已开启音频保留（默认关闭）' : '已关闭音频保留');
          await loadRetention();
        }
      }, [act, loadRetention, show]);

      const previewRetention = useCallback(async (id) => {
        // 只取路径：不自动播放，避免诊断音频在用户没有要求时出声。
        const result = await act({ action: 'audio.retention.export', id }, 'audio-retention-export');
        if (result?.ok === true) setRetentionPreview({ id, path: String(result.path ?? '') });
        else retentionFailure(result);
      }, [act, retentionFailure]);

      const deleteRetention = useCallback(async (id) => {
        const body = id === 'all'
          ? { action: 'audio.retention.delete', all: true }
          : { action: 'audio.retention.delete', id };
        const result = await act(body, 'audio-retention-delete');
        setRetentionConfirm('');
        if (result?.ok !== true) {
          retentionFailure(result);
          return;
        }
        setRetentionPreview((current) => (
          id === 'all' || (current !== null && current?.id === id) ? null : current
        ));
        show(id === 'all' ? `已全部删除 ${Number(result.removed ?? 0)} 条` : '已删除该片段');
        await loadRetention();
      }, [act, loadRetention, retentionFailure, show]);

      /**
       * 语言库列表：与音频保留同一条读法，只在挂载/写入成功后读取，不跟 3 秒状态轮询。
       * 未接线（宿主还没有 lexicon.* 动作）或读取失败时保留宿主错误文案，卡片只显示，
       * 不抛出、不影响同一张「听觉」卡片上的其它控件。
       */
      const loadLexicon = useCallback(async () => {
        try {
          const response = await fetch('/assistant/action', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ action: 'lexicon.list' }),
          });
          const result = await response.json();
          setLexiconData(lexiconListData(result));
        } catch (cause) {
          setLexiconData({
            entries: [],
            unassigned: [],
            loading: false,
            error: cause && cause.message ? cause.message : String(cause),
          });
        }
      }, []);

      const changeLexiconDraft = useCallback((patch) => {
        setLexiconDraft((current) => ({ ...current, ...patch, error: '' }));
      }, []);

      /** 手动添加：不走候选、不需要声纹确认；库位随草稿提交，声纹位由宿主再次校验 selfId。 */
      const addLexiconEntry = useCallback(async (draft) => {
        const body = lexiconAddBody(draft);
        if (body.text === '') {
          setLexiconDraft((current) => ({ ...current, error: '词或短语不能为空' }));
          return;
        }
        const result = await act(body, 'lexicon-add');
        if (result?.ok !== true) {
          setLexiconDraft((current) => ({ ...current, error: lexiconFailureReason(result) }));
          return;
        }
        setLexiconDraft(lexiconEmptyDraft());
        await loadLexicon();
        show(`已添加「${body.text}」`);
      }, [act, loadLexicon, show]);

      /** 库位移动只改 library；声纹位需要已确认本人，入口在 UI 里按 selfId 禁用。 */
      const moveLexicon = useCallback(async (id, library) => {
        const result = await act({ action: 'lexicon.move', id: String(id), library: String(library) }, 'lexicon-move');
        if (result?.ok !== true) return;
        await loadLexicon();
        show(library === 'voiceprint' ? '已移到声纹库' : '已移到公共库');
      }, [act, loadLexicon, show]);

      const openLexiconConfirm = useCallback((entry) => {
        setLexiconPending(null);
        setLexiconDialog(lexiconDialogOf(entry, 'confirm'));
      }, []);

      const openLexiconEdit = useCallback((entry) => {
        setLexiconPending(null);
        setLexiconDialog(lexiconDialogOf(entry, 'edit'));
      }, []);

      const closeLexiconDialog = useCallback(async (dialog) => {
        await closeLexiconDialogState({ dialog, setDialog: setLexiconDialog, loadLexicon, show });
      }, [loadLexicon, show]);

      const changeLexiconDialog = useCallback((patch) => {
        setLexiconDialog((current) => (current === null ? current : { ...current, ...patch, error: '' }));
      }, []);

      const removeLexiconWrongForm = useCallback((index) => {
        setLexiconDialog((current) => {
          if (current === null) return current;
          const forms = (Array.isArray(current.wrongForms) ? current.wrongForms : [])
            .filter((_form, at) => at !== index);
          return { ...current, wrongForms: forms };
        });
      }, []);

      /**
       * 弹窗保存：确认走 lexicon.confirm（speakerId 可选，仅作为来源标注），编辑走 lexicon.edit。
       * confirm 契约不带 wrongForms，弹窗里删减过的形式在确认成功后补一次 edit；两步的结果都
       * 落到界面上：只有都成功才关闭，第二步失败时保留弹窗并给出重试，绝不吞掉。
       */
      const saveLexiconDialog = useCallback(async (dialog, speakerId) => {
        const outcome = await lexiconSaveSteps({ dialog, speakerId, act });
        await settleLexiconSave({
          dialog, outcome, setDialog: setLexiconDialog, loadLexicon, show,
        });
      }, [act, loadLexicon, show]);

      /** 重试只补一次 lexicon.edit（不再 confirm）：成功关闭刷新，失败继续留在弹窗。 */
      const retryLexiconSave = useCallback(async (dialog) => {
        const outcome = await lexiconRetryStep({ dialog, act });
        await settleLexiconSave({
          dialog, outcome, setDialog: setLexiconDialog, loadLexicon, show,
        });
      }, [act, loadLexicon, show]);

      const writeLexiconEntry = useCallback(async (body, tag) => {
        const result = await act(body, tag);
        setLexiconPending(null);
        if (result?.ok !== true) return result;
        await loadLexicon();
        return result;
      }, [act, loadLexicon]);

      const ignoreLexicon = useCallback(async (id) => {
        const result = await writeLexiconEntry({ action: 'lexicon.reject', id: String(id) }, 'lexicon-reject');
        if (result?.ok === true) show('已忽略该候选');
      }, [show, writeLexiconEntry]);

      const removeLexicon = useCallback(async (id) => {
        const result = await writeLexiconEntry({ action: 'lexicon.remove', id: String(id) }, 'lexicon-remove');
        if (result?.ok === true) show('已从共享词库删除');
      }, [show, writeLexiconEntry]);

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

      // 音频保留列表同样只在挂载时读一次；开关/删除/试听之后由上面的处理器刷新。
      useEffect(() => {
        void loadRetention();
      }, [loadRetention]);

      // 语言库列表同样只在挂载时读一次；确认/编辑/忽略/删除成功后由上面的处理器刷新。
      useEffect(() => {
        void loadLexicon();
      }, [loadLexicon]);

      // 诊断面板只在挂载时读一次（打开设置页 = 一次）；没有 setInterval，也没有第二个轮询源。
      useEffect(() => {
        void loadDiagnostics();
      }, [loadDiagnostics]);

      // 声纹登记同样只在挂载时读一次；确认/拒绝/删除/手动刷新之后由处理器再读，不跟 3 秒轮询。
      useEffect(() => {
        void loadSpeakerEnroll();
      }, [loadSpeakerEnroll]);

      // 候选与登记各读一次；只有显式动作或「刷新」会让处理器再读。没有新增轮询。
      useEffect(() => {
        void loadSpeakerCandidates();
      }, [loadSpeakerCandidates]);

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

      // 用户输入时是否立即打断当前播报：缺省 true（历史行为），只有明确存过 false 才关闭。
      const inputInterrupts = status.voiceInputInterruptsReply !== false;

      // TTS warm-up is read-only: compare this poll's config identity with the one observed with
      // the same warm-up snapshot. A change marks the old snapshot stale (never a retry/request).
      const ttsWarmupView = (() => {
        const warmup = status?.tts?.warmup ?? null;
        const signature = ttsWarmupConfigSignature(status?.tts, status?.langs);
        const watch = ttsWarmupWatch.current;
        if (warmup === null || typeof warmup !== 'object') {
          ttsWarmupWatch.current = { signature, key: null, generation: null, staleKey: null };
          return formatTtsWarmupStatus(warmup);
        }
        const key = warmup.key ?? null;
        const generation = warmup.generation ?? null;
        const snapshotKey = `${key ?? ''}\u0000${generation ?? ''}`;
        // Same warm-up snapshot + changed model/reference/language inputs → stale. Once marked,
        // keep it stale until the warm-up identity itself changes, so an unrelated re-render does
        // not silently turn an invalid snapshot back into "current".
        const configChanged = watch !== null
          && (watch.staleKey === snapshotKey
            || (watch.signature !== signature && watch.key === key && watch.generation === generation));
        ttsWarmupWatch.current = {
          signature,
          key,
          generation,
          staleKey: configChanged ? snapshotKey : null,
        };
        return formatTtsWarmupStatus(warmup, { stale: configChanged });
      })();

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

      // ---- 设置页信息架构：12 个分区，重要性从总控到不常用 --------------------------------
      // 只重排布局：块与块之间的动作、参数、状态字段和默认值都保持原样。
      const settingsBlocks = [
        settingsBlock('intro', settingsCard(h, 'intro', '插件与工作目录',
          settingsGroup(h, 'plugin', '插件介绍',
            line('客户端 / 服务端', `v${CLIENT_VERSION} / v${status.version}`),
            line('运行时长', `${Math.max(1, Math.round(status.uptimeMs / 60000))} 分钟`),
          ),
          instanceRootSection(h, {
            status,
            fallbackRoot: status.root ?? '',
            dialog: rootDialog,
            notice: rootNotice,
            busy: rootBusy,
            onOpen: openRootDialog,
            onDraft: (value) => setRootDialog((current) => (current === null
              ? current
              : { ...current, draft: value, error: '' })),
            onPick: () => void pickRootIntoDialog(),
            onCancel: closeRootDialog,
            onSave: () => void saveRootDialog(),
          }),
          settingsGroup(h, 'sandbox', '工作区权限（只读）',
            h('div', { style: styles.hint }, '助手会话使用 DSH 完全访问模式（危险）；其他工作区的新会话仍由 DSH 默认策略管理。'),
            h('div', { style: styles.hint }, '不再使用插件目录授权：插件不再检查、授权或验证目录 ACL，启动时也不会自动授权。'),
            h('details', { style: styles.hint },
              h('summary', { style: styles.value }, '诊断信息'),
              h('div', {}, '切换发生在助手会话创建或恢复时，事件：sandbox.switched / sandbox.already-full / sandbox.switch-unavailable。'),
              h('div', {}, '升级后已存在的助手会话会在下次恢复时切换；验证 PTY 需重启 DSH 后新建或恢复一次助手会话。')),
          ),
          settingsGroup(h, 'scope', '只在当前工作目录生效',
            h('div', { style: styles.hint }, '记忆、人设、语言库、声纹、音频保留与诊断文件都写在上面显示的工作目录；换一个工作目录就是另一套数据。'),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '只在指定工作区生效'),
              h('button', {
                style: { ...(scopeOn ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: () => void act({ action: 'scope.set', enabled: !scopeOn }, 'scope'),
              }, scopeOn ? '已启用' : '已关闭')),
            h('div', { style: styles.field },
              settingsField(h, '工作区路径',
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
                }, '选择目录')),
            ),
            h('div', { style: styles.hint }, '默认启用。启用后人设/记忆只注入 Seirein 工作区，其它工作区（如默认工作区）调用记忆、人设、prompt 预览工具会被作用域挡下。'),
          ),
        )),
        settingsBlock('features', settingsCard(h, 'features', '组件开关',
          settingsGroup(h, 'features', '功能总控',
            (status.features ?? []).map((entry) =>
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
        )),
        settingsBlock('vision', settingsCard(h, 'vision', '视觉与感知',
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
            // 初值来自 /assistant/status 的 vision.proactive.{enabled,rate}；未知时按开启 / 100%
            // 展示，但不强行写回设置。draft 只承载本次动作的乐观值，失败时清掉即回滚。
            const clampProactiveRate = (value) => {
              const number = Number(value);
              if (!Number.isFinite(number)) return null;
              return Math.min(100, Math.max(0, Math.round(number)));
            };
            const proactiveSaved = typeof vm.proactive?.enabled === 'boolean' ? vm.proactive.enabled : true;
            const proactiveOn = typeof proactiveDraft === 'boolean' ? proactiveDraft : proactiveSaved;
            const proactiveRateSaved = clampProactiveRate(vm.proactive?.rate) ?? 100;
            const proactiveRate = typeof proactiveRateDraft === 'number'
              ? proactiveRateDraft
              : proactiveRateSaved;
            // 持续观看独立设置：未知（旧 status / 首次加载）按默认开启展示，不写回。
            const continuousView = vm.continuous ?? {};
            const continuousSaved = typeof continuousView.enabled === 'boolean'
              ? continuousView.enabled
              : true;
            const continuousOn = typeof continuousDraft === 'boolean' ? continuousDraft : continuousSaved;
            const continuousState = typeof continuousView.state === 'string'
              ? continuousView.state
              : (continuousOn ? 'waiting' : 'off');
            const continuousLabels = {
              off: '已关闭',
              waiting: '等待依赖就绪',
              starting: '正在启动',
              capturing: '采集中',
              privacy: '隐私模式暂停',
              failed: '启动失败',
              retrying: '等待重试',
            };
            const continuousStateLabel = continuousLabels[continuousState] ?? continuousState;
            const continuousSourceLabel = continuousView.source === 'obs'
              ? `OBS 场景「${vm.scene || '未指定'}」`
              : '桌面';
            const continuousAt = (value) => {
              const at = Number(value);
              return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleTimeString() : '—';
            };
            // 文字陪伴归属：只读 status.companion；未登记/关闭时界面如实显示，不把普通会话
            // 当成陪伴。draft 只承载本次动作的乐观值，失败时清掉即回滚到 status。
            const companion = status.companion ?? {};
            const typedEnabledSaved = companion.typedEnabled !== false;
            const typedEnabledOn = typeof typedCompanionDraft === 'boolean'
              ? typedCompanionDraft
              : typedEnabledSaved;
            const typedSessions = Array.isArray(companion.typedSessions)
              ? companion.typedSessions.filter((entry) => typeof entry === 'string' && entry.length > 0)
              : [];
            const typedSessionLimit = Number.isFinite(Number(companion.limit)) && Number(companion.limit) > 0
              ? Math.floor(Number(companion.limit))
              : 32;
            const lastTypedSessionId = typeof companion.lastSessionId === 'string'
              ? companion.lastSessionId
              : '';
            const commitTypedEnabled = async () => {
              const next = !typedEnabledOn;
              setTypedCompanionDraft(next);
              setTypedCompanionError('');
              setTypedCompanionNotice('');
              const result = await act(
                { action: 'companion.typedEnabled.set', enabled: next },
                'companion-typed-enabled',
              );
              if (result?.ok === true) {
                setTypedCompanionDraft(typeof result.typedEnabled === 'boolean' ? result.typedEnabled : next);
                setTypedCompanionNotice(next ? '已开启已登记会话的文字能力' : '已关闭已登记会话的文字能力；登记列表保留');
                return;
              }
              setTypedCompanionDraft(null);
              setTypedCompanionError(String(result?.error ?? '保存失败'));
            };
            const commitTypedRegister = async (id) => {
              const target = String(id ?? '').trim();
              if (target === '') {
                setTypedCompanionError('请输入要登记的会话 ID');
                return;
              }
              setTypedCompanionError('');
              setTypedCompanionNotice('');
              const result = await act(
                { action: 'companion.typed.register', sessionId: target },
                'companion-typed-register',
              );
              if (result?.ok === true) {
                setTypedSessionDraft('');
                setTypedCompanionNotice(`已登记文字陪伴会话：${target}`);
                return;
              }
              setTypedCompanionError(String(result?.error ?? '登记失败'));
            };
            const commitTypedRemove = async (id) => {
              const target = String(id ?? '').trim();
              if (target === '') return;
              setTypedCompanionError('');
              setTypedCompanionNotice('');
              const result = await act(
                { action: 'companion.typed.remove', sessionId: target },
                'companion-typed-remove',
              );
              if (result?.ok === true) {
                setTypedCompanionNotice(result.removed === true ? `已移除登记：${target}` : `该会话原本未登记：${target}`);
                return;
              }
              setTypedCompanionError(String(result?.error ?? '移除失败'));
            };
            // 通过率提交：先乐观写本地，成功以宿主返回的 0–100 值为准，失败清掉乐观值回滚。
            const commitProactiveRate = async () => {
              const next = clampProactiveRate(proactiveRate);
              if (next === null || next === proactiveRateSaved) {
                setProactiveRateDraft(null);
                return;
              }
              setProactiveRateDraft(next);
              setProactiveError('');
              const result = await act(
                { action: 'vision.proactive', enabled: proactiveOn, rate: next },
                'vision-proactive-rate',
              );
              if (result?.ok === true) {
                setProactiveRateDraft(clampProactiveRate(result.rate) ?? next);
                if (typeof result.enabled === 'boolean') setProactiveDraft(result.enabled);
                return;
              }
              setProactiveRateDraft(null);
              setProactiveError(String(result?.error ?? '保存失败'));
            };
            const visionHotkey = (status.hotkeys ?? []).find((entry) => entry.action === 'vision')?.combo ?? 'Ctrl+Alt+V';
            const lastCaptureAt = Number(vm.lastCaptureAt) || 0;
            const lastCaptureText = lastCaptureAt > 0 ? new Date(lastCaptureAt).toLocaleTimeString() : '—';
            const sourceLabel = source === 'obs' ? `OBS 场景「${vm.scene || '未指定'}」` : '桌面';
            const modeLabel = locked
              ? '隐私模式（锁定）'
              : (continuousOn && continuousState === 'capturing')
                ? `持续观看 · ${sourceLabel}`
                : capturing
                  ? `即时观看 · ${sourceLabel}`
                  : source === 'obs' ? `OBS 场景观看 ·「${vm.scene || '未指定'}」` : '桌面观看';
            // No local state: the select value is the source the Host actually has.
            const sourceValue = source === 'obs' ? (vm.scene || '__obs__') : '__desktop__';
            // 后台理解成本概览：只读 status.vision.understanding，优先用宿主给的限速/上限；
            // 缺失或畸形时退回 20 秒 / 3 张 / 180 次 / 540 张。只展示，不新增开关或轮询。
            const understandingView = vm.understanding ?? {};
            const boundedCount = (value, fallback, allowZero = false) => {
              const number = Number(value);
              if (!Number.isFinite(number) || number < 0) return fallback;
              if (!allowZero && number === 0) return fallback;
              return Math.floor(number);
            };
            const understandingIntervalMs = boundedCount(understandingView.intervalMs, 20_000);
            const understandingMaxImages = boundedCount(understandingView.maxImages, 3);
            const understandingPerHour = boundedCount(understandingView.theoreticalPerHour, 180, true);
            const understandingImagesFallback = understandingPerHour * understandingMaxImages || 540;
            const understandingImagesPerHour = boundedCount(
              understandingView.theoreticalImagesPerHour,
              understandingImagesFallback,
              true,
            );
            const understandingIntervalText = understandingIntervalMs % 1000 === 0
              ? `${understandingIntervalMs / 1000} 秒`
              : `${(understandingIntervalMs / 1000).toFixed(1)} 秒`;
            return [settingsGroup(h, 'vision', '观看来源与隐私',
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
              line('即时观看', capturing
                ? `采集中 · 最近取景 ${lastCaptureText}`
                : vm.lastCaptureAt ? `未启动 · 最近取景 ${lastCaptureText}` : '未启动'),
              h('div', { style: styles.row },
                h('span', { style: styles.label },
                  '持续观看（后台证据采集）',
                  h('span', { style: { ...styles.value, marginLeft: 6 } }, '（需显式开启；开启后启动 DSH 自动采集，关闭后重启仍关闭）')),
                h('button', {
                  'data-settings-toggle': 'vision-continuous-view',
                  style: { ...(continuousOn ? styles.btnActive : styles.btn), ...(busyNow ? styles.off : {}) },
                  disabled: busyNow,
                  onClick: async () => {
                    const next = !continuousOn;
                    setContinuousDraft(next);
                    setContinuousError('');
                    const result = await act(
                      { action: 'vision.continuousView', enabled: next },
                      'vision-continuous-view',
                    );
                    if (result?.ok === true) {
                      // 成功以宿主返回的有效值为准；没带布尔值时保留乐观值，等 status 刷新校正。
                      setContinuousDraft(typeof result.enabled === 'boolean' ? result.enabled : next);
                      return;
                    }
                    // 失败回滚：清掉乐观值，界面回到 status.vision.continuous.enabled。
                    setContinuousDraft(null);
                    setContinuousError(String(result?.error ?? '保存失败'));
                  },
                }, continuousOn ? '已开启' : '已关闭')),
              line('持续观看状态', continuousOn
                ? `${continuousStateLabel}${continuousState === 'capturing' ? ` · ${continuousSourceLabel}` : ''}`
                : '已关闭，不会自动恢复'),
              line('持续观看来源', continuousView.source === 'obs' ? 'OBS 场景' : '桌面'),
              line('最近帧', continuousAt(continuousView.lastFrameAt)),
              line('最近理解', continuousAt(continuousView.lastUnderstandingAt)),
              continuousOn && continuousView.retryAt
                ? line('下次重试', continuousAt(continuousView.retryAt))
                : null,
              continuousOn && continuousView.error
                ? line('失败原因', String(continuousView.error))
                : null,
              continuousError !== ''
                ? h('div', { style: { ...styles.hint, color: DANGER } }, `持续观看保存失败：${continuousError}`)
                : null,
              h('div', { style: styles.hint }, continuousOn
                ? '已开启：启动 DSH 后会自动采集；隐私、视觉组件关闭或依赖缺失时暂停/失败。理解与主动回应仍从首次真实陪伴轮开始。'
                : '已关闭，不会自动恢复：首轮、切换来源、重试和重启 DSH 都不会重新打开；只有再次打开这个开关才会恢复。'),
              line('虚拟摄像头', vm.virtualCam
                ? capturing ? '运行中（持续观看占用）' : `运行中 · 空闲 ${vm.idleSeconds ?? 0} 秒后自动停止`
                : '已停止（取景时按需启动；用户自启的不会关闭）'),
              line('OBS 进程', vm.obsRunning ? '运行中' : '未运行 / 未连接'),
              line('OBS 场景', status.obsScene || '未连接 / 未知'),
              h('div', {
                style: styles.hint,
                'data-settings-note': 'understanding-cost',
              }, `后台理解：最短间隔约 ${understandingIntervalText}；持续触发理论上限约 ${understandingPerHour} 次/小时、最多 ${understandingImagesPerHour} 张输入图（实际消耗取决于模型与图片处理方式）`),
              h('div', {
                style: styles.hint,
                'data-settings-note': 'understanding-trigger',
              }, `限速、按变化触发，不是定时调用：每次分析最多 ${understandingMaxImages} 张输入图，静止或没有新证据时不会调用。`),
              h('div', { style: styles.row },
                h('span', { style: styles.label },
                  '主动回应',
                  h('span', { style: { ...styles.value, marginLeft: 6 } }, '（看到值得说的事时主动开口）')),
                h('button', {
                  'data-settings-toggle': 'vision-proactive',
                  style: { ...(proactiveOn ? styles.btnActive : styles.btn), ...(busyNow ? styles.off : {}) },
                  disabled: busyNow,
                  onClick: async () => {
                    const next = !proactiveOn;
                    setProactiveDraft(next);
                    setProactiveError('');
                    // 契约扩展：开关动作也带上当前通过率，宿主一次保存两个字段。
                    const result = await act(
                      { action: 'vision.proactive', enabled: next, rate: proactiveRate },
                      'vision-proactive',
                    );
                    if (result?.ok === true) {
                      // 成功以宿主返回的有效值为准；没带布尔值时保留乐观值，等 status 刷新校正。
                      setProactiveDraft(typeof result.enabled === 'boolean' ? result.enabled : next);
                      const savedRate = clampProactiveRate(result.rate);
                      if (savedRate !== null) setProactiveRateDraft(savedRate);
                      return;
                    }
                    // 失败回滚：清掉乐观值，界面回到 status.vision.proactive.enabled。
                    setProactiveDraft(null);
                    setProactiveError(String(result?.error ?? '保存失败'));
                  },
                }, proactiveOn ? '已开启' : '已关闭')),
              h('div', { style: styles.row },
                h('span', { style: styles.label },
                  '主动回应通过率',
                  h('span', { style: { ...styles.value, marginLeft: 6 } }, '（每个候选只抽一次，100% 必过）')),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('input', {
                    type: 'number',
                    min: 0,
                    max: 100,
                    step: 5,
                    value: proactiveRate,
                    'data-settings-input': 'vision-proactive-rate',
                    'aria-label': '主动回应通过率',
                    style: { ...styles.input, width: 76 },
                    // 关闭主动回应时通过率没有意义：禁用，但保留已保存的数字。
                    disabled: busyNow || !proactiveOn,
                    onChange: (event) => {
                      const next = clampProactiveRate(event.target.value);
                      if (next !== null) setProactiveRateDraft(next);
                    },
                    onBlur: () => {
                      void commitProactiveRate();
                    },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    },
                  }),
                  h('span', { style: styles.value }, '%'),
                ),
              ),
              proactiveError !== ''
                ? h('div', { style: { ...styles.hint, color: DANGER } }, `主动回应保存失败：${proactiveError}`)
                : null,
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
              settingsActions(h,
                h('button', {
                  style: { ...(capturing ? styles.btnActive : styles.btnPrimary), ...(busyNow ? styles.off : {}) },
                  disabled: busyNow || locked,
                  onClick: async () => {
                    const result = capturing
                      ? await act({ action: 'vision.watch.stop' }, 'vision-watch')
                      : await act({ action: 'vision.watch.start', source, scene: vm.scene || '' }, 'vision-watch');
                    if (result.ok) show(capturing ? '已停止即时观看' : '已开始即时观看');
                  },
                }, capturing ? '停止即时观看' : '启动即时观看'),
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
            ),
            settingsGroup(h, 'typed-companion', '文字陪伴归属',
              h('div', { style: styles.row },
                h('span', { style: styles.label },
                  '已登记会话的文字能力',
                  h('span', { style: { ...styles.value, marginLeft: 6 } }, '（默认开启；关闭不取消登记）')),
                h('button', {
                  'data-settings-toggle': 'companion-typed-enabled',
                  style: { ...(typedEnabledOn ? styles.btnActive : styles.btn), ...(busyNow ? styles.off : {}) },
                  disabled: busyNow,
                  onClick: () => void commitTypedEnabled(),
                }, typedEnabledOn ? '已开启' : '已关闭')),
              h('div', { style: styles.hint },
                `归属只认这里的登记，不再用“没有 coding 标记”反推陪伴；编码、子代理、后台/压缩/摘要轮即使 id 在列表里也不会注入。登记表最多 ${typedSessionLimit} 条，最近登记的排在最前。`),
              h('div', {
                'data-settings-list': 'companion-typed-sessions',
                style: { display: 'flex', flexDirection: 'column', gap: 6 },
              },
                typedSessions.length === 0
                  ? h('div', { style: styles.hint }, '尚未登记任何文字陪伴会话：所有普通文字会话都不会收到画面理解/评论证据。')
                  : typedSessions.map((id) => h('div', {
                    key: id,
                    'data-typed-session-id': id,
                    style: { display: 'flex', alignItems: 'center', gap: 8 },
                  },
                    h('span', { style: { ...styles.value, flex: '1 1 0', wordBreak: 'break-all' } }, id),
                    h('button', {
                      style: { ...styles.btn, ...(busyNow ? styles.off : {}) },
                      disabled: busyNow,
                      onClick: () => void commitTypedRemove(id),
                    }, '移除'))),
              ),
              h('div', { style: styles.field },
                h('span', { style: styles.value }, '手动登记会话 ID'),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', {
                    'data-settings-input': 'companion-typed-session-id',
                    'aria-label': '文字陪伴会话 ID',
                    style: styles.input,
                    value: typedSessionDraft,
                    placeholder: '粘贴 session / agent id',
                    disabled: busyNow,
                    onChange: (event) => setTypedSessionDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void commitTypedRegister(typedSessionDraft);
                      }
                    },
                  }),
                  h('button', {
                    'data-companion-action': 'register',
                    style: { ...styles.btnPrimary, ...(busyNow ? styles.off : {}) },
                    disabled: busyNow,
                    onClick: () => void commitTypedRegister(typedSessionDraft),
                  }, '登记'))),
              lastTypedSessionId !== ''
                ? h('div', { style: styles.row },
                  h('span', { style: styles.label }, '最近一次文字会话'),
                  h('span', { style: { ...styles.value, flex: '1 1 0', wordBreak: 'break-all' } }, lastTypedSessionId),
                  h('button', {
                    'data-companion-action': 'register-last',
                    style: { ...styles.btn, ...(busyNow ? styles.off : {}) },
                    disabled: busyNow || typedSessions.includes(lastTypedSessionId),
                    onClick: () => void commitTypedRegister(lastTypedSessionId),
                  }, typedSessions.includes(lastTypedSessionId) ? '已登记' : '登记最近一次'))
                : null,
              h('div', {
                style: styles.hint,
                'data-settings-note': 'typed-companion-registration',
              }, '设置页拿不到当前会话 ID：请从 DSH 会话信息复制后登记，或点「登记最近一次」。普通会话不会静默自动登记；移除登记后下一次文字轮立即失去画面理解/评论证据。'),
              typedCompanionError !== ''
                ? h('div', { style: { ...styles.hint, color: DANGER } }, `文字陪伴保存失败：${typedCompanionError}`)
                : null,
              typedCompanionNotice !== ''
                ? h('div', { style: styles.hint }, typedCompanionNotice)
                : null,
            ),
            ];
          })(),
        )),
        settingsBlock('hearing', settingsCard(h, 'hearing', '听觉',
          settingsGroup(h, 'mic', '麦克风与门限',
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
                settingsField(h, '输入设备',
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
                  }, '刷新')),
                hasLoopback
                  ? h('div', { style: styles.hint }, '回环输入不可作为麦克风：置灰的「立体声混音」「CABLE Output」等设备只能用于环境声音。')
                  : null,
              );
            })(),
            settingsActions(h,
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
          ),
          (() => {
            // 环境声音：系统音频单独走一条 ASR，只进上下文，不触发回复。
            const loopbacks = status.loopbackDevices ?? [];
            const ambientOn = status.ambient?.running === true;
            const deferred = status.ambient?.deferred;
            const deferredSuffix = deferred?.reason ? `（${deferred.reason}）` : '';
            const missing = loopbacks.length === 0;
            return settingsGroup(h, 'ambient', '环境声音（系统音频）',
              line('状态', ambientOn ? `采集中 · ${status.ambient.device}` : `未启动${deferredSuffix}`),
              ambientRecentRow(h, {
                recent: status.ambient?.recent ?? [],
                expanded: expandedAmbient,
                onToggle: setExpandedAmbient,
              }),
              settingsField(h, '回环设备',
                h('select', {
                  style: styles.input,
                  value: loopbacks[0] ?? '',
                  disabled: ambientOn || busy !== '' || missing,
                  onChange: (event) => act({ action: 'ambient.start', device: event.target.value }),
                },
                  missing
                    ? h('option', { value: '' }, '（未检测到回环设备）')
                    : loopbacks.map((device) => h('option', { key: device, value: device }, device)),
                )),
              settingsActions(h,
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
        )),
        settingsBlock('avatar', (() => {
          // 形象卡片在 v1 里是自带 IIFE 的；重排到分区数组时快照定义跟着卡片走，
          // 否则 ready / l / hotkeys 会在渲染时 ReferenceError（设置页整块崩掉）。
          const l = status.live2d ?? {};
          const ready = l.ready === true;
          const socketOpen = l.socketOpen === true;
          const hotkeys = l.hotkeys ?? [];
          const expressions = l.expressions ?? [];
          // 视线映射的显式验证结果只来自 status.avatar.mapping（一次动作一条记录，不轮询）。
          // 没有记录 = 还没验证，不是失败；失败也不隐藏/清空其它已发现通道。
          const mappingView = (() => {
            const record = status.avatar?.mapping ?? null;
            if (record === null || record.lastAt === null || record.lastAt === undefined) {
              return { state: 'none', text: '尚未验证（点按钮实测）' };
            }
            if (record.stale === true) {
              const reason = String(record.staleReason ?? '');
              return {
                state: 'stale',
                text: `旧探测已丢弃${reason === '' ? '' : `（${reason}）`}；当前映射未被修改`,
              };
            }
            const entries = Object.entries(record.channels ?? {});
            // The probe now covers head (and eyes while the plugin owns blinking), so the result row
            // uses human labels instead of raw channel ids.
            const channelLabel = {
              gazeX: '视线X',
              gazeY: '视线Y',
              headX: '头部X',
              headY: '头部Y',
              headZ: '头部Z',
              eyeOpenL: '左眼',
              eyeOpenR: '右眼',
            };
            const labelOf = (name) => channelLabel[name] ?? name;
            if (record.ok === false) {
              const reason = entries
                .map(([, row]) => String(row?.error ?? ''))
                .find((text) => text.length > 0)
                ?? (entries.length === 0 ? 'VTS 未连接或没有可探测的动作参数' : '探测失败');
              return { state: 'failed', text: `失败：${reason}` };
            }
            const changed = entries.filter(([, row]) => row?.changed === true).map(([name]) => labelOf(name));
            const unchanged = entries.filter(([, row]) => row?.changed !== true).map(([name]) => labelOf(name));
            if (entries.length > 0 && unchanged.length === 0) {
              return { state: 'connected', text: `已连通：${changed.join('、')}` };
            }
            return {
              state: 'unchanged',
              text: `未变化：${unchanged.join('、') || '动作通道'}（注入后参数未变）`,
            };
          })();
          // 启动时自动验证：设置只影响“下一次连接/能力发现”的一次自动探测，不会立即重试，
          // 也不会把 verified 永久写进 settings。失败时回滚到 status 的已确认值。
          const autoVerifySaved = status.avatar?.verifyMappingsOnStartup !== false;
          const autoVerifyOn = avatarAutoVerifyDraft ?? autoVerifySaved;
          const setAutoVerify = async () => {
            const next = !autoVerifyOn;
            setAvatarAutoVerifyDraft(next);
            const result = await act(
              { action: 'avatar.verifyMappingsOnStartup.set', enabled: next },
              'avatar-auto-verify',
            );
            if (result?.ok === true) {
              setAvatarAutoVerifyDraft(result.verifyMappingsOnStartup !== false);
              show(result.verifyMappingsOnStartup !== false
                ? '已开启启动时自动验证动作映射（下次连接生效）'
                : '已关闭启动时自动验证动作映射');
            } else {
              setAvatarAutoVerifyDraft(autoVerifySaved);
              show(`保存启动时自动验证设置失败：${result?.error ?? '设置未保存'}`);
            }
          };
          return settingsCard(h, 'avatar', '形象与动作',
              settingsGroup(h, 'vts', 'VTS 连接与表情',
                line('VTS', ready
                  ? `已连接 · ${l.model || '未知模型'}`
                  : socketOpen
                    ? 'WebSocket 已打开，但认证未完成（未就绪）'
                    : '未连接（VTube Studio 需开启 API 8001）'),
                line('授权状态', l.needsAuth === true
                  ? `需要重新授权${l.authError ? `（${l.authError}）` : ''}`
                  : ready
                    ? '已授权'
                    : l.authorizePending === true
                      ? '等待在 VTube Studio 中点「允许」'
                      : '未授权（连接后需在 VTube Studio 中允许）'),
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
                  h('button', {
                    style: { ...(l.needsAuth === true ? styles.btnPrimary : styles.btn), ...(busy !== '' ? styles.off : {}) },
                    disabled: busy !== '',
                    title: '清除本地授权并让 VTS 重新弹出授权提示；宿主未提供该动作时只提示，不影响其它设置',
                    onClick: async () => {
                      // 宿主还没有 vts.authorize 时（旧版本 / 尚未合并 VTS 任务）只提示，不发请求也不抛错。
                      if (status.vtsAuth === undefined && l.needsAuth === undefined) {
                        show('当前宿主还不支持重新授权；等 VTS 任务更新后再试');
                        return;
                      }
                      const result = await act({ action: 'vts.authorize' }, 'vts-authorize');
                      if (result?.ok === true) {
                        show(result.needsUserApproval === true
                          ? '已请求授权：请在 VTube Studio 里点「允许」'
                          : '已重新授权 VTS');
                      }
                    },
                  }, '重新授权'),
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
                    h('div', { style: { ...styles.row, marginTop: 6 } },
                      settingsField(h, '启动时自动验证动作映射',
                        h('button', {
                          'data-settings-toggle': 'avatar-verify-mappings-on-startup',
                          style: { ...(autoVerifyOn ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                          disabled: busy !== '',
                          title: '每次 VTS 连接/能力发现完成后自动验证一次（视线与头部，插件接管眨眼时也测眨眼）；失败不重试，也不永久写入验证结果',
                          onClick: () => void setAutoVerify(),
                        }, autoVerifyOn ? '已开启' : '已关闭')),
                      h('span', { style: styles.hint }, '每次连接只自动验证一次；失败不重试，可随时手动验证。'),
                    ),
                    h('div', { style: { ...styles.row, marginTop: 6 } },
                      h('button', {
                        style: { ...styles.btn, ...(busy !== '' ? styles.off : {}) },
                        disabled: busy !== '',
                        title: ready
                          ? '短暂暂停动作约数秒，注入测试值检查视线、头部（插件接管眨眼时也测眨眼）输入是否真的驱动模型参数（只执行一次）'
                          : 'VTS 未连接：点击会返回失败原因，不影响其它设置',
                        onClick: () => act({ action: 'avatar.mapping.probe' }, 'avatar-mapping'),
                      }, '验证动作映射'),
                      h('span', {
                        style: mappingView.state === 'failed'
                          ? { ...styles.value, color: DANGER }
                          : styles.hint,
                        'data-avatar-mapping': mappingView.state,
                      }, mappingView.text),
                    ),
                    h('div', { style: styles.hint }, '验证会短暂暂停动作，测视线、头部与眨眼（仅插件接管时）；只增加映射证据，不改变基础层幅度或组件。'),
                    h('div', { style: styles.hint }, '「可注入」只说明值能发出去；「已验证」才说明有证据它驱动该部位。模型是否响应取决于 VTS 内的参数映射。'),
                  );
                })(),
                (() => {
                  // 显式视线输入映射：只暴露 gazeX/gazeY 两个 input 名。保存/清除都走同一个
                  // `avatar.channelMap.set` 动作；宿主按当前 VTS InputParameterList 校验，非法即拒绝。
                  const saved = status.avatar?.channelMap ?? {};
                  const current = {
                    gazeX: String(saved.gazeX ?? ''),
                    gazeY: String(saved.gazeY ?? ''),
                  };
                  const draft = avatarChannelMapDraft ?? current;
                  const caps = l.capabilities ?? null;
                  const verifiedSet = new Set(Array.isArray(caps?.verified) ? caps.verified : []);
                  const invalidSet = new Set(Array.isArray(caps?.mappingInvalid) ? caps.mappingInvalid : []);
                  const configured = [['gazeX', '视线 X'], ['gazeY', '视线 Y']]
                    .filter(([channel]) => current[channel].length > 0);
                  const needsProbe = configured.filter(([channel]) => !verifiedSet.has(channel));
                  const invalidConfigured = configured.filter(([channel]) => invalidSet.has(channel));
                  const statusState = configured.length === 0
                    ? 'none'
                    : invalidConfigured.length > 0
                      ? 'invalid'
                      : needsProbe.length > 0
                        ? 'unverified'
                        : 'verified';
                  const statusText = configured.length === 0
                    ? '当前未配置显式映射，仍使用 VTS 候选名；行为不变。'
                    : `${configured.map(([channel, label]) => `${label} → ${current[channel]}`).join(' · ')}`
                      + (invalidConfigured.length > 0
                        ? ` · 配置无效：${invalidConfigured.map(([channel]) => channel).join('、')} 不在 VTS 输入列表，未启用`
                        : needsProbe.length > 0
                          ? ' · 仍需验证（点「验证动作映射」实测后才算接通）'
                          : ' · 已通过运行期验证');
                  const channelRow = (channel, label) => settingsField(h, label,
                    h('input', {
                      style: styles.input,
                      type: 'text',
                      value: draft[channel] ?? '',
                      placeholder: 'VTS 输入名，如 EyeRightX',
                      disabled: busy !== '',
                      'data-avatar-channel-map': channel,
                      onChange: (event) => {
                        setAvatarChannelMapDraft({ ...draft, [channel]: event.target.value });
                      },
                    }));
                  const rollback = () => {
                    const settled = status.avatar?.channelMap ?? {};
                    setAvatarChannelMapDraft({
                      gazeX: String(settled.gazeX ?? ''),
                      gazeY: String(settled.gazeY ?? ''),
                    });
                  };
                  const save = async () => {
                    const result = await act({
                      action: 'avatar.channelMap.set',
                      gazeX: draft.gazeX ?? '',
                      gazeY: draft.gazeY ?? '',
                    }, 'avatar-channel-map');
                    if (result?.ok === true) {
                      setAvatarChannelMapDraft({
                        gazeX: String(result.channelMap?.gazeX ?? ''),
                        gazeY: String(result.channelMap?.gazeY ?? ''),
                      });
                      show('视线映射已保存，仍需运行期验证');
                    } else {
                      // 失败回滚：输入框回到宿主当前持久化的值，不停留在被拒绝的名字上。
                      rollback();
                    }
                  };
                  const clear = async () => {
                    const result = await act({ action: 'avatar.channelMap.set', clear: true }, 'avatar-channel-map');
                    if (result?.ok === true) {
                      setAvatarChannelMapDraft({ gazeX: '', gazeY: '' });
                      show('视线映射已清除');
                    } else {
                      rollback();
                    }
                  };
                  return h('div', { style: { marginTop: 10 } },
                    h('div', { style: styles.label }, '显式视线输入映射'),
                    h('div', { style: styles.hint },
                      '可选：把逻辑通道直接绑定到 VTS 输入名。只接受 VTS 已列出的输入；保存后仍需运行期验证。'),
                    h('div', { style: styles.field },
                      channelRow('gazeX', '视线 X 输入名'),
                      channelRow('gazeY', '视线 Y 输入名')),
                    settingsActions(h,
                      h('button', {
                        style: { ...styles.btnPrimary, ...(busy !== '' ? styles.off : {}) },
                        disabled: busy !== '',
                        onClick: save,
                      }, '保存视线映射'),
                      h('button', {
                        style: { ...styles.btn, ...(busy !== '' ? styles.off : {}) },
                        disabled: busy !== '',
                        onClick: clear,
                      }, '清除视线映射')),
                    h('div', {
                      style: invalidConfigured.length > 0
                        ? { ...styles.value, color: DANGER }
                        : styles.hint,
                      'data-avatar-channel-map-status': statusState,
                    }, statusText),
                  );
                })(),
                (() => {
                  // 眨眼控制方：显式设置（settings.avatar.blinkOwner），不根据 VTS 原生 idle 是否
                  // 运行来推断。当前值来自 status.avatar.blink；眼输入未验证时插件按钮禁用。
                  const blink = status.avatar?.blink ?? {};
                  const savedOwner = blink.setting === 'plugin' ? 'plugin' : 'vts';
                  const selected = avatarBlinkOwnerDraft ?? savedOwner;
                  const eyeVerified = blink.eyeVerified === true;
                  const setOwner = async (owner) => {
                    if (owner === 'plugin' && !eyeVerified) {
                      setAvatarBlinkOwnerDraft(savedOwner);
                      show('眼输入尚未验证：需要 eyeOpenL 与 eyeOpenR 都通过验证');
                      return;
                    }
                    setAvatarBlinkOwnerDraft(owner); // 乐观选择；成功后由 status 确认
                    const result = await act(
                      { action: 'avatar.blinkOwner.set', owner },
                      'avatar-blink-owner',
                    );
                    if (result?.ok === true) {
                      const settled = result.blink?.setting === 'plugin' ? 'plugin' : 'vts';
                      setAvatarBlinkOwnerDraft(settled);
                      show(settled === 'plugin' ? '眨眼已由插件控制' : '眨眼已交回 VTS');
                    } else {
                      // 失败回滚：回到 status 的最近确认值，不留在被拒绝的选择上。
                      setAvatarBlinkOwnerDraft(savedOwner);
                      if (result?.code === 'eye-unverified') show('眼输入未验证：已保持 VTS 控制');
                    }
                  };
                  const reason = String(blink.eyeWriteOptInReason ?? '');
                  const fallback = savedOwner === 'plugin' && blink.owner !== 'plugin';
                  const statusText = fallback
                    ? `已请求插件控制，但眼输入未验证（${reason || 'eye-unverified'}），当前由 VTS 控制。`
                    : eyeVerified
                      ? (savedOwner === 'plugin'
                        ? `当前：插件控制（眼输入已验证）· 已发 ${Number(blink.sent ?? 0)} / 生成 ${Number(blink.generated ?? 0)}`
                        : `当前：VTS 控制 · 可选插件控制（眼输入已验证）· 已发 ${Number(blink.sent ?? 0)} / 生成 ${Number(blink.generated ?? 0)}`)
                      : '眼输入未验证（需要 eyeOpenL / eyeOpenR 都通过探测），插件控制不可用；当前由 VTS 控制。';
                  return h('div', { style: { marginTop: 10 } },
                    h('div', { style: styles.label }, '眨眼控制'),
                    h('div', { style: styles.hint },
                      '显式选择谁写眨眼。默认由 VTS 控制；插件控制只在眼输入已验证时可用，避免双重眨眼。'),
                    settingsActions(h,
                      h('button', {
                        style: {
                          ...(selected === 'plugin' ? styles.btnPrimary : styles.btn),
                          ...(busy !== '' || !eyeVerified ? styles.off : {}),
                        },
                        disabled: busy !== '' || !eyeVerified,
                        title: eyeVerified ? '插件写眨眼（眼输入已验证）' : '眼输入未验证：暂不可用',
                        'data-avatar-blink-owner': 'plugin',
                        onClick: () => setOwner('plugin'),
                      }, '眨眼由插件控制'),
                      h('button', {
                        style: {
                          ...(selected === 'vts' ? styles.btnPrimary : styles.btn),
                          ...(busy !== '' ? styles.off : {}),
                        },
                        disabled: busy !== '',
                        'data-avatar-blink-owner': 'vts',
                        onClick: () => setOwner('vts'),
                      }, '由 VTS 控制')),
                    h('div', {
                      style: fallback ? { ...styles.value, color: DANGER } : styles.hint,
                      'data-avatar-blink-owner-status': fallback ? 'fallback' : selected,
                    }, statusText),
                  );
                })(),
              ),
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
                  avatarGeometry: status.avatarLayer?.geometry ?? null,
                }, {
                  // 切换由宿主串行执行：可用性检查 → 停旧后端并确认退出 → 启新后端。
                  switchBackend: (backend) => {
                    void act({ action: 'layer.backend', backend, electronExecutable: draftPath }, 'layer-backend');
                  },
                  setField: (key, value) => setLayerDraft({ ...draft, [key]: value }),
                  // 编辑与沉底和透明化同属一个子容器：按钮仍是原来的 layer.edit.enter / layer.edit.exit。
                  toggleEditMode: () => act({
                    action: lay.editMode === true ? 'layer.edit.exit' : 'layer.edit.enter',
                  }, 'avatarLayer'),
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
        })()),
        settingsBlock('memory', (() => {
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
        })()),
        settingsBlock('memory', settingsCard(h, 'memory-people', '记忆与人设',
          settingsGroup(h, 'resources', '固定记忆',
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
          (() => {
            // 记忆：容量条 + 清晰度分布 + 归档管理（归档不进检索，可手动删）。
            const mem = status.memory ?? {};
            const usage = mem.usage ?? { records: 0, capacity: 5000, ratio: 0, archived: 0 };
            const clarity = mem.clarity ?? {};
            const auto = mem.auto ?? { enabled: true, minChars: 1, maxChars: 400, includeReply: true };
            const pct = Math.round((usage.ratio ?? 0) * 100);
            const barColor = pct >= 90 ? '#dc2626' : pct >= 60 ? '#d98324' : '#2f9e44';
            return settingsGroup(h, 'memory', '记忆容量与维护',
              line('容量', `${usage.records} / ${usage.capacity} 条（${pct}%）`),
              h('div', { style: { height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden', margin: '4px 0 8px' } },
                h('div', { style: { height: '100%', width: `${Math.min(100, pct)}%`, background: barColor } }),
              ),
              line('清晰度', `清晰 ${clarity.vivid ?? 0} · 清楚 ${clarity.clear ?? 0} · 模糊 ${clarity.fuzzy ?? 0} · 印象 ${clarity.trace ?? 0}`),
              line('自动记忆', auto.enabled === false
                ? '关（只保留手动提炼）'
                : `开（≥${auto.minChars ?? 1} 字全量入库，展示单条 ≤${auto.maxChars ?? 400} 字，${auto.includeReply === false ? '只记用户原话' : '原话与回复都记'}）`),
              line('归档', `${usage.archived ?? 0} 条（不参与检索，可手动删除）`),
              settingsActions(h,
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
          lexiconSection(h, {
            data: lexiconData,
            busy,
            dialog: lexiconDialog,
            pending: lexiconPending,
            speakerId: lexiconSpeakerId(status),
            // The voiceprint library unlocks only for enrollment's confirmed self, never for a
            // shadow match or a settings hint.
            confirmedSelfId: String(speakerEnroll?.list?.selfId ?? '').trim(),
            draft: lexiconDraft,
          }, {
            refresh: () => void loadLexicon(),
            changeDraft: changeLexiconDraft,
            add: (draft) => void addLexiconEntry(draft),
            move: (id, library) => void moveLexicon(id, library),
            openConfirm: openLexiconConfirm,
            openEdit: openLexiconEdit,
            closeDialog: (dialog) => void closeLexiconDialog(dialog),
            changeDialog: changeLexiconDialog,
            removeWrongForm: removeLexiconWrongForm,
            saveDialog: (dialog, speakerId) => void saveLexiconDialog(dialog, speakerId),
            retrySave: (dialog) => void retryLexiconSave(dialog),
            askIgnore: (id) => setLexiconPending({ kind: 'ignore', id: String(id) }),
            ignore: (id) => void ignoreLexicon(id),
            askRemove: (id) => setLexiconPending({ kind: 'remove', id: String(id) }),
            remove: (id) => void removeLexicon(id),
            cancelWrite: () => setLexiconPending(null),
          }),
        )),
        settingsBlock('speaker', settingsCard(h, 'speaker', '声纹登记与影子观测',
          speakerEnrollSection(h, {
            data: speakerEnroll,
            busy: busy !== '',
            notice: speakerEnrollNotice,
            onRefresh: () => void loadSpeakerEnroll(),
            onRecord: startSpeakerEnroll,
            onConfirm: (speakerId) => void runSpeakerEnroll('confirm', speakerId),
            onReject: (speakerId) => void runSpeakerEnroll('reject', speakerId),
            onRemove: (speakerId) => void runSpeakerEnroll('remove', speakerId),
            onCopy: () => void copySpeakerEnroll(),
            candidateData: speakerCandidates,
            candidateBusy: speakerCandidateBusy !== '',
            candidateSelection: speakerCandidateSelection,
            candidateAudio: speakerCandidateAudio,
            candidatePreview: speakerCandidatePreview,
            candidateNotice: speakerCandidateNotice,
            shadowEnabled: status?.speaker?.enabled === true,
            label: speakerCandidateLabel,
            onCandidateToggle: toggleSpeakerCandidate,
            onCandidateAudio: (id) => void loadSpeakerCandidateAudio(id),
            onCandidateRemove: (id) => void removeSpeakerCandidate(id),
            onCandidateClear: () => void clearSpeakerCandidates(),
            onCandidatePreview: (ids) => void previewSpeakerCandidates(ids),
            onCandidateBuild: (ids, label) => void buildSpeakerBase(ids, label),
            onTemplateStrengthen: (ids, label) => void strengthenSpeakerTemplate(ids, label),
            onCandidateRefresh: () => void loadSpeakerCandidates(),
            rollbackAsk: speakerTemplateRollback,
            onTemplateRollbackAsk: (version) => setSpeakerTemplateRollback(version),
            onTemplateRollbackCancel: () => setSpeakerTemplateRollback(null),
            onTemplateRollback: (version) => void rollbackSpeakerTemplate(version),
            onCandidateRename: (label) => void renameSpeakerLibrary(label),
            onCandidateLabel: setSpeakerCandidateLabel,
          }),
          settingsGroup(h, 'speaker-shadow', '',
            speakerShadowRow(h, { status, busy, act }),
          ),
        )),
        settingsBlock('voice', settingsCard(h, 'voice', '语音',
          (() => {
            // 语种：语音与字幕分开配置，来源是 /assistant/status 的 langs。
            const langOptions = [['zh', '中文'], ['ja', '日语'], ['en', '英语'], ['ko', '韩语'], ['yue', '粤语']];
            const langRow = (label, key) => settingsField(h, label,
              h('select', {
                style: { ...styles.input, width: 140 },
                value: langs[key] ?? 'zh',
                disabled: busy !== '',
                onChange: (event) => act({ action: 'langs.set', [key]: event.target.value }, `langs:${key}`),
              }, langOptions.map(([value, text]) => h('option', { key: value, value }, text))));
            return settingsGroup(h, 'language', '语种（语音 / 字幕）',
              langRow('语音语种', 'speech'),
              langRow('字幕语种', 'subtitle'),
              h('div', { style: styles.hint }, langs.speech === langs.subtitle
                ? '两者一致：按普通文本输出即可，不必为了字幕调用工具。'
                : '两者不同：agent 会把语音文本放进 text、字幕文本放进 subtitle 调用 assistant_say。'),
            );
          })(),
          settingsGroup(h, 'tts', '语音合成与候音',
            h('div', { style: { ...styles.hint, marginTop: 0, marginBottom: 6 } }, '更好的音色：支持 GPT-SoVITS 可运行模型'),
            h('div', { 'data-tts-warmup': 'status', style: styles.row },
              h('span', { style: styles.label }, '预热状态'),
              h('span', {
                style: { ...styles.value, textAlign: 'right', ...(ttsWarmupView.stale ? { color: DANGER } : {}) },
                title: '只读状态：仅作可见性展示，不宣称提速，也不自动重试',
              }, ttsWarmupView.text)),
            h('div', { style: styles.hint }, '只读：预热不代表首音会更快；切换模型 / 参考音频 / 语言后旧状态会标为 stale，真实收益需重启后采样。'),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '语音播报'),
              h('button', {
                style: { ...(status.tts?.playbackEnabled !== false ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: () => act({ action: 'voice.playback', enabled: status.tts?.playbackEnabled === false }, 'voice-playback'),
              }, status.tts?.playbackEnabled !== false ? '已开启' : '已关闭')),
            h('div', { style: styles.hint }, '「语音合成」是父组件：关闭它会先停播报，再关 GPT 音色并释放插件启动的 GPT-SoVITS；只关 GPT 音色不会关闭播报或组件。'),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, '用户输入时打断当前回复'),
              h('button', {
                style: { ...(inputInterrupts ? styles.btnActive : styles.btn), ...(busy !== '' ? styles.off : {}) },
                disabled: busy !== '',
                onClick: async () => {
                  const result = await act({
                    action: 'voice.inputInterruptsReply',
                    enabled: !inputInterrupts,
                  }, 'voice-input-interrupt');
                  if (result.ok) show(result.inputInterruptsReply === false ? '已关闭：输入会等当前回复播完' : '已开启：输入立即打断当前回复');
                },
              }, inputInterrupts ? '已开启' : '已关闭')),
            h('div', { style: styles.hint }, '关闭后，语音和文字输入不再打断正在播放的回复（包括主动回应）：当前这句播完再播下一句，新回复排队，不叠音。停止、静音、隐私、断连和关闭组件仍会立即停止播报。'),
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
        )),
        settingsBlock('call', settingsCard(h, 'call', '通话模式',
          callModeSection(h, {
            status,
            busy,
            act,
            draft: callNameDraft,
            onDraft: setCallNameDraft,
            onShow: show,
          }),
        )),
        settingsBlock('subtitle', settingsCard(h, 'subtitle', '字幕',
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
            return settingsGroup(h, 'subtitle', '字幕显示',
              line('状态', subtitleOn ? (sub.running ? '显示中' : '已启用') : '未启用'),
              line('模式', bubble ? '气泡 · 跟随悬浮窗' : '区域 · 固定位置'),
              settingsActions(h,
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
              settingsActions(h,
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
                      settingsField(h, '字体',
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
                        }, '刷新字体列表')),
                      h('div', { style: styles.hint }, fonts.length === 0
                        ? '正在读取本机已安装字体…'
                        : `本机已安装 ${fonts.length} 个字体族${sub.truncatedFonts === true ? '（仅列出前 1000 个）' : ''}`),
                    ),
                    h('div', { style: styles.field },
                      settingsField(h, '字号上限',
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
                        })),
                    ),
                  ),
              h('div', { style: styles.hint }, feature('subtitle')
                ? '区域模式：拖选后启用；气泡模式：锚在悬浮窗左上角，气泡色取自模型区域，文字取对比色。关闭「字幕」组件会先隐藏字幕，再连同区域/显示开关一起置为关。'
                : '字幕组件当前关闭：上面的按钮仍可点，会先启用「字幕显示」组件，再执行字幕动作。'),
            );
          })(),
        )),
        settingsBlock('diagnostics', settingsCard(h, 'diagnostics', '运行诊断',
          diagnosticsSection(h, {
            data: diagnostics,
            clientVersion: CLIENT_VERSION,
            restart: lastRestart,
            busy: busy !== '',
            recover: recoverOutcome,
            onRefresh: () => void loadDiagnostics(),
            onCopy: () => void copyDiagnostics(),
          }),
          timelineSection(h, { data: timeline }),
          settingsGroup(h, 'latency', '语音延迟测量',
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
        )),
        settingsBlock('diagnostics', settingsCard(h, 'maintenance', '维护与恢复',
          recoverSessionSection(h, {
            confirm: recoverConfirm,
            busy: recoverBusy,
            outcome: recoverOutcome,
            onAsk: askRecoverSession,
            onCancel: cancelRecoverSession,
            onConfirm: () => void confirmRecoverSession(),
          }),
          retentionSection(h, {
            status,
            data: retentionData,
            busy,
            preview: retentionPreview,
            confirm: retentionConfirm,
            onToggle: (enabled) => void toggleRetention(enabled),
            onPreview: (id) => void previewRetention(id),
            onAskDelete: (id) => setRetentionConfirm(String(id)),
            onDelete: (id) => void deleteRetention(id),
            onCancel: () => setRetentionConfirm(''),
            onDeleteAll: () => void deleteRetention('all'),
          }),
        )),
        settingsBlock('misc', settingsCard(h, 'misc', '其他设置',
          h('div', { style: styles.hint }, '日常不用改：连带启动、全局快捷键与闲聊模式，设置一次后很少再动。'),
          settingsGroup(h, 'autostart', '连带启动',
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
              gptAutostartRow('pythonPath', 'Python 路径', 'D:\\GPT-SoVITS\\runtime\\python.exe', () => void pickGptAutostartFile('pythonPath', 'exe', 'Python 路径')),
              gptAutostartRow('scriptPath', 'api_v2.py 路径', 'D:\\GPT-SoVITS\\api_v2.py', () => void pickGptAutostartFile('scriptPath', 'script', 'api_v2.py 路径')),
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
          settingsGroup(h, 'hotkeys', '全局快捷键',
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
          (() => {
          // 闲聊模式（快路）：只聊天、不接工具与感知，用于明确要"陪聊"的场合。
          const fp = status.fastpath ?? {};
          const ready = fp.available === true;
          const on = fp.enabled === true;
          return settingsGroup(h, 'fastpath', '闲聊模式（可选）',
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
        )),
      ];

      // ---- 渲染：外层 toast/dialog + 首次使用提示 + 12 个分区 ------------------------------
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
              `当前数据会写到 ${status.root ?? '默认目录'}。选一个你自己的位置后，数据会放在 <所选目录>\\Seirein 下；保存后需重启 DSH 生效，不会自动重启，也不会自动迁移已有数据。`),
            h('div', { style: styles.row },
              h('button', {
                style: { ...styles.btnPrimary, ...(rootBusy ? styles.off : {}) },
                disabled: rootBusy,
                onClick: openRootDialog,
              }, '选择存放位置'),
              h('button', {
                style: { ...styles.btn, ...(rootBusy ? styles.off : {}) },
                disabled: rootBusy,
                onClick: () => void applyDefaultRoot(),
              }, '使用默认位置'),
            ),
          )
          : null,

        groupSettingsBlocks(h, settingsBlocks),
      );
    }

    return {
      inject: ['slots'],
      __panel: Panel,
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
