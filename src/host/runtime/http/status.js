/** Settings status projection over live per-mount state. */
import { WPF_KEY } from '../../avatar/avatarLayer.js';
import { normalizeLayerBackend } from '../../avatar/layer-controls.js';
import { resolveAckDelayMs } from '../../speech/ack-speech.js';


export function createStatusBuilder(services) {
  const handler = async () => {
    const level = services.hearing?.stats?.() ?? null;
    const watchStats = services.watcher?.stats?.() ?? null;
    const devices = await (0, services.getDevices)();
    const statusWorkspaceId = (await (0, services.currentWorkspaceId)()) || services.fallbackWorkspaceId;
    const status = {
      ok: true,
      version: services.VERSION,
      root: services.root,
      firstRun: !services.instanceChosen,
      uptimeMs: Date.now() - services.startedAt,
      hearing: {
        running: services.hearing !== null,
        enabled: (0, services.containerEnabled)('hearing'),
        autoListen: (0, services.hearingAutoListen)(),
        device: services.hearing?.device ?? '',
        thresholdDb: Number(services.runtime?.asrMinRmsDb ?? services.config?.asrMinRmsDb ?? -50),
        rmsDb: level?.rmsDb ?? -100,
        peakDb: level?.peakDb ?? -100,
        // Round-1 audio diagnostics (VAD shadow counts, delivery latency, queue/heap samples),
        // read-only: null when no session runs. Nothing in the delivery path reads this back.
        diagnostics: level?.diagnostics ?? null,
        // Autostart could not open the mic; the settings card shows why.
        deferred: services.hearingAutostart?.deferred ?? null,
      },
      // Speaker-voice shadow: last verdict + per-session-ish counters; read-only for the card.
      speaker: (0, services.speakerStatus)(),
      watch: {
        running: services.watcher !== null,
        engine: watchStats?.engine ?? '',
        frames: watchStats?.frames ?? 0,
      },
      ambient: {
        running: services.ambient !== null,
        enabled: (0, services.containerEnabled)('ambient'),
        autoListen: (0, services.readSettings)().ambient?.autoListen === true,
        device: services.ambient?.device ?? services.ambientSource.device,
        // `loopback` = system playback replay, `mic` = real surroundings.
        source: services.ambient !== null ? services.ambientSource.source : '',
        partial: services.ambientState.partial,
        recent: services.ambientState.recent.slice(-3).map((entry) => entry.text),
        // Autostart could not open the cable; the settings card shows why.
        deferred: services.ambientAutostart?.deferred ?? null,
      },
      subtitle: (() => {
        const settings = (0, services.subtitleSettings)();
        // The enumeration is async, but this route stays a synchronous cache read: kick the first
        // load and report what is known now, so the next 3 s poll renders the picker.
        void services.subtitleFontCatalog.ensure().catch(() => {});
        const fonts = services.subtitleFontCatalog.snapshot();
        return {
          enabled: settings.enabled,
          mode: settings.mode,
          running: services.subtitleOverlay?.running === true,
          region: settings.region,
          font: settings.font,
          sizeMax: settings.sizeMax,
          colorMode: settings.colorMode,
          // How long the last line stays after its audio ended (never the duration estimate).
          holdMs: settings.holdMs,
          // The one rectangle the bubble anchors on, and where it came from.
          geometry: services.subtitleGeometry.current,
          geometrySource: services.subtitleGeometry.source,
          availableFonts: fonts.fonts,
          truncatedFonts: fonts.truncated,
        };
      })(),
      live2d: {
        // `connected` is the honest, user-facing answer: a socket that failed to authenticate is
        // not a connection. socketOpen/authenticated/ready expose the three underlying states.
        connected: services.vts?.ready === true,
        socketOpen: services.vts?.connected === true,
        authenticated: services.vts?.authenticated === true,
        ready: services.vts?.ready === true,
        // A revoked token triggers one AuthorizationTokenRequest; the UI needs the wait state.
        authPending: services.vts?.authPending === true,
        authRenewed: services.vts?.authRenewed === true,
        model: services.vts?.model?.modelName ?? '',
        modelId: services.vts?.modelId ?? '',
        hotkeys: (services.vts?.hotkeys ?? []).map((entry) => entry.name),
        expressions: (services.vts?.expressions ?? []).map((entry) => entry.name),
        eventsSubscribed: services.vts?.eventsSubscribed === true,
        subscribedEvents: [...(services.vts?.subscribedEvents ?? [])],
        // Diagnostics for a subscription that did not confirm: '' means healthy, and the raw
        // answer is clipped so /assistant/status never returns an unbounded payload.
        subscriptionError: String(services.vts?.subscriptionError ?? ''),
        subscriptionResponse: (0, services.clipText)(services.vts?.subscriptionResponse ?? '', 400),
        transport: services.vts?.getTransportStats?.() ?? { sent: 0, dropped: 0, lastSentAt: 0, computedHz: 0 },
        // Sync read of the cached discovery; never awaits VTS inside the status route.
        capabilities: (0, services.avatarCapabilitiesStatus)(),
        // Single-writer diagnostics: mouth writes only ever come from this runtime.
        runtime: (0, services.avatarRuntimeStatus)(),
        // Cached persona style + build counters; reading this never calls a model.
        style: (0, services.avatarStyleStatus)(),
        /** Idle provenance also at the section level: 'param' is the engine, 'hotkey' is fallback. */
        idleSource: services.avatarRuntime?.snapshot().idleSource ?? 'none',
        // Phase-0 Spout display process: read-only snapshot, no probe and no await.
        spoutLayer: services.spoutLayer.snapshot(),
        // Bounded teardown policy: one shared deadline; external programs are never listed here.
        shutdown: {
          deadlineMs: services.shutdown.deadlineMs,
        },
      },
      voicePending: services.pendingVoice.length > 0 ? services.pendingVoice[0].text : '',
      voiceMuted: (0, services.readSettings)().voiceMuted === true,
      // 候音等待（0.5–15 秒）：设置页显示的当前值；下一轮直接按这个值计时。
      voiceAckDelayMs: resolveAckDelayMs((0, services.readSettings)(), services.config),
      // 通话模式：运行时模式（启动默认 normal）+ 已配置称呼；设置页据此显示、手动切换与增删。
      call: (0, services.callModeStatus)(),
      // Last 20 rounds with p50/p95 per stage; the event log keeps every round.
      voiceLatency: services.voiceLatencyLog.snapshot(),
      // Waiting-line stages: prepare -> text -> audio -> played (and droppedMs/reason when unplayed).
      voiceAck: services.ackLane?.status?.() ?? [],
      tts: {
        playbackEnabled: (0, services.voicePlaybackEnabled)(),
        gptSovits: await (0, services.gptSovitsStatus)(),
      },
      langs: (0, services.langSettings)(),
      rollover: services.pendingRollover,
      workspace: { id: statusWorkspaceId, path: services.workspacePath },
      workspaceScope: (0, services.workspaceScope)(),
      avatarLayer: services.avatarLayerController?.snapshot() ?? { running: false, editMode: false, geometry: null, error: '' },
      fastpath: (() => {
        const selection = services.fastPath.selection();
        return {
          available: services.fastPath.available(),
          enabled: services.features.enabled('fastpath'),
          provider: selection.provider,
          model: selection.model,
          turns: services.fastPath.history.length,
          busy: services.fastPath.busy,
          speaking: services.fastActive !== null,
        };
      })(),
      transparent: (() => {
        const settings = (0, services.transparentSettings)();
        return { running: services.transparentChild !== null, pid: services.transparentChild?.pid ?? 0, ...settings };
      })(),
      // One merged snapshot for the「透明化」card: the stored backend choice (default wpf), which
      // backend is actually running, whether a switch is in flight, and why Spout is unusable.
      layer: (() => {
        const spout = services.spoutLayer.snapshot();
        const availability = (0, services.spoutAvailability)();
        const wpfSettings = (0, services.transparentSettings)();
        const wpfRunning = services.transparentChild !== null;
        const backend = normalizeLayerBackend((0, services.readSettings)().layer?.backend);
        // The hotkey session belongs to the active backend only; `editBackend` is null when idle.
        const editing = services.layerEdit.status();
        return {
          backend,
          editMode: editing.editMode,
          editBackend: editing.editBackend,
          // The session's actual rectangle (diagnostics/subtitle only; never the saved geometry).
          editRect: services.editRect === null ? null : { ...services.editRect },
          switching: services.layerSwitch.switching(),
          running: backend === 'spout' ? spout.running === true : wpfRunning,
          // The capture position is reported on its own and never doubles as the user rectangle.
          captureRect: { ...services.captureRect },
          geometryFixes: services.geometryFixes,
          wpf: {
            running: wpfRunning,
            pid: services.transparentChild?.pid ?? 0,
            ...wpfSettings,
            key: { ...WPF_KEY },
            keyMismatch: services.wpfKeyState?.matches === false
              ? { ...services.wpfKeyState }
              : (services.avatarLayerController?.snapshot?.()?.keyMismatch ?? null),
          },
          spout: {
            running: spout.running === true,
            pid: spout.pid,
            configured: spout.configured,
            electronExecutable: spout.electronExecutable,
            readyPhase: spout.readyPhase,
            error: spout.error,
            versions: spout.versions,
            lastExit: spout.lastExit,
            captureRect: spout.captureRect ?? null,
            alphaSample: spout.alphaSample ?? null,
          },
          available: { wpf: true, spout: availability.ok },
          reason: { wpf: '', spout: availability.reason },
        };
      })(),
      privacy: {
        active: services.vision.mode === 'privacy',
        scene: (0, services.privacySceneName)(),
      },
      autostart: (0, services.autostartStatus)(),
      vision: (0, services.visionStatus)(),
      // P-56: perception evidence stays readable after it expires but is never presented as
      // current; the counters make failures/refusals/merges observable from one status read.
      perception: {
        lastVision: (0, services.currentVisionView)(),
        stats: (0, services.perceptionStatsView)(),
      },
      obsScene: services.lastObsScene,
      hotkeys: Object.entries(services.hotkeyState.bindings).map(([action, combo]) => ({ action, combo })),
      resources: services.resources.list({}).map((row) => ({
        key: row.key,
        title: row.title,
        tags: row.tags,
        secret: row.secret,
      })),
      personaChars: services.persona.render({ budget: 4000 }).length,
      memory: {
        domains: services.memory.stats(),
        usage: services.memory.usage(),
        clarity: services.memory.clarityCounts(),
        auto: (0, services.autoMemorySettings)(),
      },
      // 人设库 (the memory card's child container): capacity, schedule switch and at most
      // PROFILE_STATUS_ENTRY_LIMIT entries so one poll stays bounded.
      profile: (0, services.profileStatus)(),
      features: services.features.list(),
      devices,
      // Picker rows: `loopback: true` means the entry is a replay endpoint and cannot be a mic.
      deviceList: (0, services.deviceRows)(devices),
      loopbackDevices: (0, services.findLoopback)(devices),
      selectedDevice: services.hearing?.device ?? services.runtime.asrDevice ?? '',
    };
    // Keep data/status.json fresh for external tooling; the HTTP route stays authoritative.
    if (Date.now() - services.obsScenesAt > 20000) void (0, services.refreshObsScenes)();
    void (0, services.writeStatus)(services.root, status).catch(() => {});
    return status;
  };
  return handler;
}
