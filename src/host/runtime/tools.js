/**
 * Tool behaviour: the execute bodies of the assistant_* tools.
 *
 * The 24 tool definitions themselves (name, description, parameters, output schema and render)
 * stay in index.js: the baseline snapshot counts `register({` and the tool names in that file,
 * and bump-version reads its version constant. This module owns only the behaviour half, so
 * neither check moves.
 *
 * `createHostTools(deps)` returns one function per moved tool, named after that tool. `deps` is
 * the host's live tool dependency view (built once in `apply` with getters): several entries are
 * `let` bindings the host reassigns, and several are declared after the view itself, so a plain
 * value would pin the wrong one. Each function destructures exactly the entries it needs at call
 * time; the body below is the original `execute` body unchanged, except that the identifiers now
 * come from `deps` instead of closing over `apply`.
 */
import { AVATAR_ERROR_CODES } from '../avatar/avatarRuntime.js';
import { truncationNotice } from '../hearing/hearing.js';
import { deliveredRecallRows, memoryReferentRecord } from '../memory/memory-injection.js';
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, parseBinding } from '../platform/hotkeys.js';
import { displayMessageSnippet, normalizeDomain, scoreImportance, tokenizeQuery } from '../memory/store.js';

export function createHostTools(deps) {
  return {
    async executeSee(args, exec) {
      const {
        assertVisionToken, captureForAgent, capturedTokens, deliverSight, discardUndelivered,
        features, log, perceptionEvent, perceptionStat, sightDeliveryCheck, sightFailure, vision,
        visionChanging, visionDisposed,
      } = deps;
      if (!features.enabled('vision')) {
        perceptionStat('rejected');
        perceptionEvent('perception.rejected', { reason: '视觉组件已关闭', stage: 'preflight' });
        await log.emit('vision.delivery.refused', { reason: '视觉组件已关闭', stage: 'preflight' });
        return sightFailure('视觉组件已关闭');
      }
      const callSignal = exec?.signal;
      if (callSignal?.aborted === true) {
        perceptionStat('rejected');
        perceptionEvent('perception.rejected', { reason: '工具调用已取消：未采集截图', stage: 'preflight' });
        await log.emit('vision.delivery.refused', { reason: '工具调用已取消：未采集截图', stage: 'preflight' });
        return sightFailure('工具调用已取消：未采集截图');
      }
      // Capability first: an unavailable attachment lane or a route that cannot take images must
      // not touch the screen, and a privacy switch must not be raced by a fresh capture.
      const ready = await sightDeliveryCheck(exec, callSignal);
      if (!ready.ok) {
        perceptionStat('rejected');
        perceptionEvent('perception.rejected', { reason: ready.reason, stage: 'preflight' });
        const eventType = ready.unknown === true ? 'vision.capability.unknown-rejected' : 'vision.delivery.refused';
        await log.emit(eventType, {
          reason: ready.reason,
          stage: 'preflight',
          provider: ready.capability?.provider ?? '',
          model: ready.capability?.model ?? '',
        });
        // Legacy outcome event: callers treat assistant_see as attempted once captured/failed is
        // recorded, so a pre-capture capability refusal still reports that generic outcome.
        if (ready.unknown === true) await log.emit('vision.failed', { reason: ready.reason, phase: 'capability' });
        return sightFailure(ready.reason);
      }
      let shot = null;
      let stage = 'capture';
      try {
        shot = await captureForAgent(args.reason, callSignal);
        const token = capturedTokens.get(shot);
        stage = 'precheck';
        assertVisionToken(token);
        stage = 'delivery';
        return await deliverSight(shot, token, exec, ready.capability);
      } catch (error) {
        const reason = error?.message ?? String(error);
        // deliverSight already cleaned up its own refusals; this covers capture and unexpected
        // throws so a frame can never survive its tool call.
        await discardUndelivered(shot?.file, stage);
        const refused = visionDisposed || visionChanging || vision.mode === 'privacy' || callSignal?.aborted === true;
        if (refused) {
          perceptionStat('rejected');
          perceptionEvent('perception.rejected', { reason, stage });
        } else {
          perceptionStat('failed');
        }
        await log.emit(refused ? 'vision.delivery.refused' : 'vision.failed', { reason, stage });
        return sightFailure(reason);
      }
    },
    async executeRemember(args, exec) {
      const {
        SCOPE_ERROR, config, emitMemoryNormalize, features, log, memory, memoryContextOf,
        memoryNormalizeSafe, memoryTurnScope, scopeBlocksTool,
      } = deps;
      if (scopeBlocksTool(exec)) {
        return { id: '', domain: '', ts: '', ok: false, error: SCOPE_ERROR };
      }
      if (!features.enabled('memory')) {
        return { id: '', domain: '', ts: '', error: '记忆组件已关闭' };
      }
      const domain = normalizeDomain(args.domain, config);
      // Manual lane: the model supplies the distilled text and (optionally) the importance,
      // clamped to >= 50 so the user's explicit confirmation outranks an auto original. Without
      // an explicit value the deterministic heuristic is used (still clamped to the manual band).
      // It runs through the SAME normalizer as the automatic lane, so a manual fact also carries
      // an absolute date and no dangling pronoun. The context is captured once so the `referent`
      // link (stage 3) points at the row the pronoun was resolved from.
      const { sessionId } = memoryTurnScope(exec);
      const context = memoryContextOf(sessionId);
      const normalized = memoryNormalizeSafe(args.text, { sessionId, context });
      const kind = args.kind ?? 'fact';
      const modelImportance = Number(args.importance);
      const importance = Number.isFinite(modelImportance)
        ? Math.min(100, Math.max(50, Math.round(modelImportance)))
        : Math.min(100, Math.max(50, scoreImportance(normalized.text, kind)));
      const record = memory.add(domain, normalized.text, kind, {
        source: 'manual',
        importance,
        rawText: normalized.text === normalized.rawText ? null : normalized.rawText,
        unresolved: normalized.unresolved,
        tzUsed: normalized.tz,
      });
      if (typeof memory.addLink === 'function') {
        const referentId = memoryReferentRecord(normalized);
        if (referentId.length > 0) {
          try {
            memory.addLink(record.id, referentId, 'referent');
          } catch {
            /* a link is an enhancement; the memory is already stored */
          }
        }
      }
      await emitMemoryNormalize(normalized);
      // A manual entry that restates an auto original (or names its id) lifts that record out of
      // the permanent importance-30 band; the auto source is never a life sentence.
      if (typeof args.id === 'string' && args.id.length > 0) memory.promote(args.id, { importance });
      const promoted = memory.promoteByText(record.text, importance);
      await log.emit('memory.write', {
        id: record.id,
        domain,
        kind: record.kind,
        importance: record.importance,
        source: 'manual',
        promoted: promoted.length,
      });
      return { id: record.id, domain, ts: record.ts };
    },
    async executeMemoryCorrect(args, exec) {
      const {
        SCOPE_ERROR, currentUserMessageId, emitMemoryNormalize, features, log, memory,
        memoryNormalizeSafe, memoryTurnLedger, memoryTurnScope, scopeBlocksTool,
      } = deps;
      const shape = {
        ok: false,
        error: '',
        id: '',
        version: 0,
        from: '',
        to: '',
        sourceMessageId: '',
        sourceMerged: false,
        mergeReason: '',
        idempotent: false,
        extraId: '',
        revisionId: '',
        supersededId: '',
        currentVersion: 0,
        text: '',
        candidates: [],
      };
      if (scopeBlocksTool(exec)) return { ...shape, error: SCOPE_ERROR };
      if (!features.enabled('memory')) return { ...shape, error: '记忆组件已关闭' };
      // Host-side source completion: the model rarely knows the current message id, but the
      // session does. A caller-supplied id always wins; otherwise the turn's own user message is
      // injected so the already-recorded correction statement is merged (hidden + refunded).
      const providedSource = typeof args.sourceMessageId === 'string' ? args.sourceMessageId.trim() : '';
      const sourceMessageId = providedSource.length > 0 ? providedSource : currentUserMessageId(exec);
      // A correction only rewrites an existing fragment, so it gets the time normalization but
      // NEVER pronoun expansion: resolving a pronoun here would change more than the user asked.
      const replacement = memoryNormalizeSafe(String(args.replacement ?? ''), { expand: false });
      const result = memory.correct({
        targetId: args.targetId,
        expectedVersion: args.expectedVersion,
        expectedText: args.expectedText,
        replacement: replacement.text,
        sourceMessageId,
        extraText: args.extraText,
      });
      if (result.ok === true && result.idempotent !== true) await emitMemoryNormalize(replacement);
      // E: remember the new version for this turn. The next lookup for that id must re-query
      // and show the corrected body; the version bump itself never reinforces again.
      if (result.ok === true) {
        try {
          const { sessionId, turn } = memoryTurnScope(exec);
          memoryTurnLedger.noteCorrection({
            sessionId,
            turn,
            id: typeof result.id === 'string' && result.id.length > 0 ? result.id : args.targetId,
            version: Number(result.version) || Number(result.currentVersion) || 1,
          });
          // F: a corrected body can move a record into a query's match set; an empty cached
          // result has no version, so the whole turn's queries must be re-answered from the DB.
          memoryTurnLedger.invalidateQueries({ sessionId, turn });
          await log.emit('memory.cache.invalidated', { sessionId, turn, reason: 'correction' });
        } catch {
          /* ledger bookkeeping only */
        }
      }
      return {
        ...shape,
        ...result,
        sourceMerged: result.sourceMerged === true,
        mergeReason: result.mergeReason || (sourceMessageId.length > 0 ? '' : 'no-source'),
      };
    },
    async executeRecall(args, exec) {
      const {
        SCOPE_ERROR, config, features, log, markCorrectedRows, memory, memoryQueryWindow,
        memoryTurnLedger, memoryTurnScope, scopeBlocksTool, strengthenOnce,
      } = deps;
      // D2 projection helpers live first: the error/disabled exits below must satisfy the same
      // required `assembly` shape as a successful recall.
      const KINDS = ['hit', 'link', 'pair', 'neighbor', 'upcoming'];
      const assemblyOf = (source) => {
        const raw = source !== null && typeof source === 'object' ? source : {};
        const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
        // `dropped` arrives as the store's candidate list; a legacy row may carry a bare count.
        const dropped = Array.isArray(raw.dropped) ? raw.dropped.length : count(raw.dropped);
        return {
          hits: count(raw.hits),
          links: count(raw.links),
          pairs: count(raw.pairs),
          neighbors: count(raw.neighbors),
          upcoming: count(raw.upcoming),
          delivered: count(raw.delivered),
          skippedByBudget: count(raw.skippedByBudget),
          chars: count(raw.chars),
          limit: count(raw.limit ?? raw.charLimit),
          dropped,
          rowLimit: count(raw.rowLimit),
          charLimit: count(raw.charLimit ?? raw.limit),
        };
      };
      if (scopeBlocksTool(exec)) {
        return { scope: '', scanned: 0, hits: [], assembly: assemblyOf(null), ok: false, error: SCOPE_ERROR };
      }
      if (!features.enabled('memory')) {
        return { scope: '', scanned: 0, hits: [], assembly: assemblyOf(null), error: '记忆组件已关闭' };
      }
      // An explicit domain narrows the search; omitting it means "every domain".
      const scoped = typeof args.domain === 'string' && args.domain.trim().length > 0;
      const domains = scoped ? [normalizeDomain(args.domain, config)] : null;
      const limit = Number.isInteger(args.limit) ? Math.min(20, Math.max(1, args.limit)) : 5;
      const { sessionId, turn } = memoryTurnScope(exec);
      const { range } = memoryQueryWindow(args.query);
      const lookup = {
        sessionId, turn, kind: 'recall', query: args.query,
        fromIso: range?.fromIso ?? null, toIso: range?.toIso ?? null, limit, domains,
      };
      // C: the same query/window/page C2 already ran this turn is not queried twice.
      const cached = memoryTurnLedger.lookup(lookup);
      let recalled;
      if (cached !== null) {
        recalled = cached;
        await log.emit('memory.query.reused', { key: memoryTurnLedger.key(lookup), source: 'c2' });
      } else {
        recalled = memory.recall({
          query: args.query,
          domains,
          limit,
          budgetChars: 600,
          maxRecords: 6,
          window: 1,
        });
      }
      const hits = markCorrectedRows(exec, recalled.hits);
      const { scanned, mode, roles, window } = recalled;
      // Recall feedback: only memories whose body was actually delivered get stickier (matters
      // once decay is on). D: an id C2 already reinforced this turn is not reinforced again.
      const delivered = deliveredRecallRows(hits);
      if (delivered.length > 0) strengthenOnce(exec, delivered.map((hit) => hit.id));
      await log.emit('memory.recall', {
        scope: domains === null ? 'all' : domains[0],
        query: args.query,
        hits: hits.length,
        scanned,
        mode,
        roles,
        window,
      });
      // D2 projection: the store already decided every row's fate; the tool only whitelists the
      // fields it declared. `kind` is always one of the five assembly kinds, so a future store
      // row cannot smuggle an arbitrary label through `additionalProperties: false`.
      return {
        scope: domains === null ? 'all domains' : `"${domains[0]}"`,
        scanned,
        mode,
        roles,
        window,
        assembly: assemblyOf(recalled.assembly),
        hits: hits.map(({
          id, ts, domain, text, importance, clarity, version, matched, score, role, source,
          kind, group, delivered, unresolved, displayStart, displayEnd, displayTruncated,
          containsEvidence, budgetOverflow, skippedByBudget, turnUpdated,
        }) => ({
          id,
          ts,
          domain,
          text,
          importance,
          clarity: clarity ?? '',
          version: Number.isInteger(version) ? version : 1,
          matched: matched ?? 0,
          score: score ?? 0,
          role: typeof role === 'string' ? role : '',
          source: typeof source === 'string' ? source : '',
          kind: KINDS.includes(kind) ? kind : 'hit',
          // The group is the direct hit a context row was expanded from. A legacy row without it
          // (or a hit that is the source itself) simply omits the field; nothing is invented.
          ...(typeof group === 'string' && group.length > 0 ? { group } : {}),
          delivered: delivered === true,
          unresolved: unresolved === 1 ? 1 : 0,
          displayStart: displayStart ?? 0,
          displayEnd: displayEnd ?? text.length,
          displayTruncated: displayTruncated === true,
          containsEvidence: containsEvidence === true,
          budgetOverflow: budgetOverflow === true,
          skippedByBudget: skippedByBudget === true,
          turnUpdated: turnUpdated === true,
        })),
      };
    },
    async executeMemoryBrief(args, exec) {
      const {
        SCOPE_ERROR, autoMemorySettings, features, log, memory, scopeBlocksTool, strengthenOnce,
      } = deps;
      if (scopeBlocksTool(exec)) {
        return { text: '', fixed: 0, matched: 0, terms: [], ok: false, error: SCOPE_ERROR };
      }
      if (!features.enabled('memory')) {
        return { text: '', fixed: 0, matched: 0, terms: [], error: '记忆组件已关闭' };
      }
      const limit = Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 5;
      const brief = memory.brief({ query: args.query, limit, displayChars: autoMemorySettings().maxChars });
      // The fixed layer's SELECT does not carry clarity; '' reports "not tracked here" instead
      // of inventing a level.
      const toRecord = (row) => ({
        id: typeof row.id === 'string' ? row.id : '',
        text: row.text,
        domain: row.domain,
        importance: row.importance,
        clarity: row.clarity ?? '',
        version: Number.isInteger(row.version) ? row.version : 1,
        ts: row.ts,
      });
      // Only the related hits count as "used"; the fixed layer is shown, not re-recalled. Again,
      // reinforce only bodies that actually reached the model, and only once per turn (D).
      const delivered = deliveredRecallRows(brief.matched);
      if (delivered.length > 0) strengthenOnce(exec, delivered.map((hit) => hit.id));
      await log.emit('memory.brief', {
        query: args.query,
        fixed: brief.fixed.length,
        matched: brief.matched.length,
        terms: brief.terms.length,
      });
      return {
        text: brief.text,
        fixed: brief.fixed.length,
        matched: brief.matched.length,
        terms: brief.terms,
        fixedRecords: brief.fixed.map(toRecord),
        matchedRecords: brief.matched.map(toRecord),
      };
    },
    async executeArchiveSearch(args, exec) {
      const {
        SCOPE_ERROR, autoMemorySettings, features, log, markCorrectedRows, memory,
        memoryQueryWindow, memoryTurnLedger, memoryTurnScope, scopeBlocksTool,
      } = deps;
      if (scopeBlocksTool(exec)) {
        return { query: args.query, count: 0, hits: [], ok: false, error: SCOPE_ERROR };
      }
      if (!features.enabled('memory')) {
        return { query: args.query, count: 0, hits: [], error: '记忆组件已关闭' };
      }
      const limit = Number.isInteger(args.limit) ? Math.min(10, Math.max(1, args.limit)) : 5;
      const { sessionId, turn } = memoryTurnScope(exec);
      const { range } = memoryQueryWindow(args.query);
      const lookup = {
        sessionId, turn, kind: 'archive', query: args.query,
        fromIso: range?.fromIso ?? null, toIso: range?.toIso ?? null, limit,
      };
      // C: reuse the window C2 already fetched this turn; only a new/deeper query hits SQL.
      const cached = memoryTurnLedger.lookup(lookup);
      let hits;
      if (cached !== null) {
        hits = Array.isArray(cached.rows) ? cached.rows.slice(0, limit) : [];
        await log.emit('memory.query.reused', { key: memoryTurnLedger.key(lookup), source: 'c2' });
      } else {
        hits = memory.searchArchive(args.query, limit);
      }
      hits = markCorrectedRows(exec, hits);
      const terms = tokenizeQuery(args.query);
      await log.emit('memory.archive.search', { query: args.query, hits: hits.length });
      return {
        query: args.query,
        count: hits.length,
        hits: hits.map((row) => {
          const shown = displayMessageSnippet(row.text, {
            query: args.query,
            terms,
            maxChars: autoMemorySettings().maxChars,
          });
          return {
            id: row.id,
            ts: row.ts,
            domain: row.domain,
            text: shown.text,
            role: row.role ?? null,
            session_id: row.session_id ?? row.sessionId ?? null,
            turn_id: Number.isInteger(row.turn_id) ? row.turn_id : (Number.isInteger(row.turnId) ? row.turnId : null),
            message_id: row.message_id ?? row.messageId ?? null,
            truncated: Number.isInteger(row.truncated) ? row.truncated : 0,
            displayStart: shown.displayStart,
            displayEnd: shown.displayEnd,
            displayTruncated: shown.displayTruncated,
            containsEvidence: shown.containsEvidence,
            budgetOverflow: shown.budgetOverflow === true,
            turnUpdated: row.turnUpdated === true,
          };
        }),
      };
    },
    async executeDoctor() {
      const { probeModules, root } = deps;
      const modules = await probeModules();
      return {
        root,
        node: process.versions.node,
        electron: process.versions.electron ?? '',
        platform: process.platform,
        arch: process.arch,
        modules,
      };
    },
    async executeObsStatus() {
      const { config, findObs, log, probePort } = deps;
      const path = findObs(config);
      const port = Number(config?.obsPort ?? 4455);
      const reachable = await probePort('127.0.0.1', port);
      await log.emit('obs.status', { installed: Boolean(path), reachable, port });
      return { installed: path !== null, path: path ?? '', port, reachable };
    },
    async executeVision(args) {
      const {
        applyVisionMode, obsScenes, refreshObsScenes, virtualCamOn, vision, visionStatus,
      } = deps;
      if (args.action === 'status') {
        const state = visionStatus();
        void refreshObsScenes();
        return { ok: true, ...state, warning: '', error: '' };
      }
      if (args.action === 'set') {
        if (typeof args.mode !== 'string' || args.mode.length === 0) {
          return { ok: false, ...vision.snapshot(), virtualCam: virtualCamOn, scenes: obsScenes, error: 'action=set 需要 mode' };
        }
        const result = await applyVisionMode(args.mode, args.scene, { by: 'agent' });
        return {
          ok: result.ok,
          mode: result.mode,
          scene: result.scene,
          locked: result.locked,
          virtualCam: virtualCamOn,
          scenes: obsScenes,
          warning: result.warning ?? '',
          error: result.error ?? '',
        };
      }
      return {
        ok: false,
        ...vision.snapshot(),
        virtualCam: virtualCamOn,
        scenes: obsScenes,
        error: `unknown action: ${String(args.action)}`,
      };
    },
    async executeHotkeys(args) {
      const { hotkeyState, log, poller, saveBindings, startPoller } = deps;
      const snapshot = () =>
        Object.entries(hotkeyState.bindings).map(([action, combo]) => {
          let valid = true;
          try {
            parseBinding(combo);
          } catch {
            valid = false;
          }
          return { action, combo, valid };
        });
      const last = () => ({
        lastAction: hotkeyState.lastTrigger?.action ?? '',
        lastCombo: hotkeyState.lastTrigger?.combo ?? '',
        lastAt: hotkeyState.lastTrigger?.ts ?? '',
      });
      const reply = (ok, error) => ({
        ok,
        running: poller.running,
        pollerError: poller.error ?? '',
        bindings: snapshot(),
        ...last(),
        ...(error === undefined ? {} : { error }),
      });

      if (args.action === 'status') return reply(true);

      if (args.action === 'restart') {
        // Recovery path: a poller that failed at mount (native module, permissions) can be
        // started again without reinstalling the bundle.
        poller.stop();
        const started = await startPoller();
        return reply(started, started ? undefined : (poller.error ?? 'start failed'));
      }

      if (args.action === 'set') {
        if (typeof args.name !== 'string' || !HOTKEY_ACTIONS.includes(args.name)) {
          return reply(false, `unknown hotkey name: ${String(args.name)}`);
        }
        try {
          parseBinding(args.combo);
        } catch (error) {
          return reply(false, error.message);
        }
        hotkeyState.bindings = { ...hotkeyState.bindings, [args.name]: args.combo };
        saveBindings(hotkeyState.bindings);
        poller.refresh(hotkeyState.bindings);
        await log.emit('hotkey.bindings', { name: args.name, combo: args.combo });
        return reply(true);
      }

      if (args.action === 'reset') {
        hotkeyState.bindings = { ...DEFAULT_HOTKEYS };
        saveBindings(hotkeyState.bindings);
        poller.refresh(hotkeyState.bindings);
        await log.emit('hotkey.bindings', { reset: true });
        return reply(true);
      }

      if (args.action === 'simulate') {
        try {
          await poller.simulate(args.combo, Number.isInteger(args.holdMs) ? args.holdMs : 120);
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          return reply(false, error.message);
        }
        return reply(true);
      }

      return reply(false, `unknown action: ${args.action}`);
    },
    async executeCallMode(args) {
      const { callModeStatus, enterCallMode, exitCallMode } = deps;
      if (args.action === 'status') return { ok: true, ...callModeStatus() };
      if (args.action === 'enter') return enterCallMode('agent');
      if (args.action === 'exit') return exitCallMode('agent');
      return {
        ok: false,
        ...callModeStatus(),
        reason: 'unknown-action',
        error: `unknown action: ${String(args.action)}`,
      };
    },
    async executeResourceSet(args) {
      const { log, resources } = deps;
      try {
        const saved = await resources.set({
          key: args.key,
          value: args.value,
          kind: args.kind ?? 'note',
          title: args.title ?? '',
          tags: args.tags ?? '',
          secret: args.secret === true,
        });
        await log.emit('resource.set', { key: saved.key, kind: saved.kind, secret: saved.secret });
        return { ok: true, key: saved.key, kind: saved.kind, secret: saved.secret };
      } catch (error) {
        return { ok: false, key: args.key, kind: '', secret: false, error: error?.message ?? String(error) };
      }
    },
    async executeResourceGet(args) {
      const { resources } = deps;
      try {
        const row = await resources.get(args.key, { reveal: args.reveal === true });
        if (row === null) return { ok: true, found: false, key: args.key, value: '', secret: false };
        return { ok: true, found: true, key: row.key, value: row.value, secret: row.secret };
      } catch (error) {
        return { ok: false, found: false, key: args.key, value: '', secret: false, error: error?.message ?? String(error) };
      }
    },
    async executeResourceList(args) {
      const { resources } = deps;
      const entries = resources.list({ tag: args.tag ?? '' }).map((entry) => ({
        key: entry.key,
        kind: entry.kind,
        title: entry.title,
        tags: entry.tags,
        secret: entry.secret,
      }));
      return { ok: true, count: entries.length, entries };
    },
    async executeResourceForget(args) {
      const { log, resources } = deps;
      const removed = resources.forget(args.key);
      await log.emit('resource.forget', { key: args.key, removed });
      return { ok: true, removed, key: args.key };
    },
    async executePromptPreview(_args, exec) {
      const {
        HEARING_CONVENTION, MEMORY_CONVENTION, SCOPE_ERROR, VOICE_OUTPUT_CONVENTION, persona,
        renderLanguageConvention, renderResources, scopeBlocksTool,
      } = deps;
      if (scopeBlocksTool(exec)) {
        return { ok: false, chars: 0, text: '', error: SCOPE_ERROR };
      }
      const text = [persona.render(), MEMORY_CONVENTION, HEARING_CONVENTION, VOICE_OUTPUT_CONVENTION, renderLanguageConvention(), renderResources()]
        .filter(Boolean)
        .join('\n\n');
      return { ok: true, chars: text.length, text };
    },
    async executePersonaView(args, exec) {
      const { SCOPE_ERROR, persona, scopeBlocksTool } = deps;
      if (scopeBlocksTool(exec)) {
        return { ok: false, chars: 0, text: '', agentPersona: '', userProfile: '', error: SCOPE_ERROR };
      }
      const which = args.which === 'agent' || args.which === 'user' ? args.which : 'both';
      // Full bodies, never the render() budget: the tool exists to show exactly what is stored.
      const agentPersona = which === 'user' ? '' : persona.read('agent').trim();
      const userProfile = which === 'agent' ? '' : persona.read('user').trim();
      const parts = [];
      if (agentPersona.length > 0) parts.push(`## 你的设定\n${agentPersona}`);
      if (userProfile.length > 0) parts.push(`## 关于用户\n${userProfile}`);
      const text = parts.join('\n\n');
      return { ok: true, chars: text.length, text, agentPersona, userProfile };
    },
    async executePersonaAppend(args, exec) {
      const {
        SCOPE_ERROR, log, persona, profileMaintainer, scheduleAvatarStyleRefresh, scopeBlocksTool,
      } = deps;
      if (scopeBlocksTool(exec)) {
        return { ok: false, which: args.which, line: '', error: SCOPE_ERROR };
      }
      try {
        const line = persona.append(args.which, args.text);
        // A chat-driven persona append during a trial is a trial-text edit, not a new library
        // entry: keep the no-auto-import guard and the trial text in step with the file.
        if (args.which === 'agent' && profileMaintainer !== null
          && profileMaintainer.personaTrialState().active === true) {
          try {
            profileMaintainer.updatePersonaQuizTrialText({ text: persona.read('agent') });
          } catch {
            /* the append already succeeded; the trial marker repairs on the next edit */
          }
        }
        await log.emit('persona.append', { which: args.which });
        // The persona text changed: rebuild the motion style in the background (never sync).
        scheduleAvatarStyleRefresh();
        return { ok: true, which: args.which, line };
      } catch (error) {
        return { ok: false, which: args.which, line: '', error: error?.message ?? String(error) };
      }
    },
    async executeAmbient(args) {
      const { ambient, ambientSource, ambientState, features } = deps;
      if (!features.enabled('ambient')) {
        return { ok: false, running: false, device: '', source: '', partial: '', lines: [], error: '环境声音组件已关闭' };
      }
      const recent = args.action === 'poll' ? ambientState.recent.slice(-10) : ambientState.recent.slice(-3);
      // The text carries the truncation hint; the structured metadata stays in ambient.utterance.
      const lines = recent.map((entry) =>
        entry.truncated ? `${entry.text}${truncationNotice(entry.maxUtteranceSec || 90)}` : entry.text,
      );
      // Ambient utterances keep their own join detail; `lines` stays plain text for every caller.
      const joinFallbacks = recent.filter((entry) => entry.joinFallback === true).length;
      return {
        ok: true,
        running: ambient !== null,
        device: ambient?.device ?? ambientSource.device,
        source: ambient !== null ? ambientSource.source : '',
        partial: ambientState.partial,
        lines,
        joinFallback: joinFallbacks > 0,
        joinFallbacks,
      };
    },
    async executeLive2d(args) {
      const {
        ensureAvatarRuntime, ensureAvatarRuntimeConnected, features, log, vtsClient, vtsConnect,
      } = deps;
      if (!features.enabled('avatar')) {
        return { ok: false, connected: false, error: '形象组件已关闭' };
      }
      const client = vtsClient();
      try {
        if (args.action === 'status') {
          return {
            ok: true,
            connected: client.ready,
            model: client.model?.modelName ?? '',
            hotkeys: client.hotkeys.map((entry) => entry.name),
            expressions: client.expressions.map((entry) => entry.name),
            error: '',
          };
        }
        const connected = await vtsConnect();
        if (!connected.ok) {
          return { ok: false, connected: client.ready, error: connected.error ?? '未连接' };
        }
        if (args.action === 'connect') {
          return {
            ok: true,
            connected: true,
            model: client.model?.modelName ?? '',
            hotkeys: client.hotkeys.map((entry) => entry.name),
            expressions: client.expressions.map((entry) => entry.name),
            error: '',
          };
        }
        let mouth = null;
        let gesture = null;
        // Hotkey / expression / move are discrete VTS commands: they carry no parameter value, so
        // they can never compete with the runtime's single parameter writer. The mouth and the
        // one-shot gesture below are the only parameter paths; both go through the runtime.
        if (args.action === 'hotkey') await client.triggerHotkey(args.name ?? '');
        if (args.action === 'expression') await client.triggerExpression(args.name ?? '');
        if (args.action === 'move') {
          await client.moveModel({ x: args.x, y: args.y, rotation: args.rotation, size: args.size });
        }
        if (args.action === 'mouth') {
          // Submit an intent to the behavior runtime; it is the single writer of this parameter.
          // No direct `client.setMouth()` exists any more, so a second writer cannot appear here.
          const runtimeReady = await ensureAvatarRuntimeConnected();
          if (runtimeReady.ok !== true) {
            mouth = { ok: false, error: runtimeReady.message ?? '形象运行时未连接', acknowledged: false };
          } else {
            const written = await ensureAvatarRuntime().writeMouth(args.value ?? 0, { owner: 'avatar-tool' });
            if (written.ok === true) {
              mouth = { ok: true, error: '', acknowledged: false };
            } else if (written.code === AVATAR_ERROR_CODES.UNMAPPED) {
              // Nothing was sent: record the skipped channel so a missing VTS mapping is visible.
              await log.emit('avatar.channel.skipped', { channel: 'mouth', reason: 'unmapped' }).catch(() => {});
              mouth = { ok: false, error: 'mouth channel not mapped', acknowledged: false };
            } else {
              mouth = { ok: false, error: written.message ?? 'mouth write failed', acknowledged: false };
            }
          }
        }
        if (args.action === 'intent') {
          // The gesture is one-shot and style-scaled; an unadapted channel is skipped/recorded by
          // the runtime, never written with a guessed input name.
          const runtimeReady = await ensureAvatarRuntimeConnected();
          if (runtimeReady.ok !== true) {
            gesture = { ok: false, error: runtimeReady.message ?? '形象运行时未连接' };
          } else {
            const kind = String(args.intent ?? 'nod');
            const played = ensureAvatarRuntime().intent(kind);
            gesture = played.ok === true
              ? { ok: true, kind, durationMs: played.durationMs, amplitude: played.amplitude, error: '' }
              : { ok: false, kind, error: played.message ?? 'intent not available' };
          }
        }
        await log.emit('live2d.action', { action: args.action, name: args.name ?? '', intent: args.intent ?? '' });
        return {
          ok: (mouth === null || mouth.ok === true) && (gesture === null || gesture.ok === true),
          connected: true,
          model: client.model?.modelName ?? '',
          hotkeys: client.hotkeys.map((entry) => entry.name),
          expressions: client.expressions.map((entry) => entry.name),
          error: mouth?.error ?? gesture?.error ?? '',
          ...(mouth === null ? {} : { mouth: Number(args.value ?? 0), acknowledged: mouth.acknowledged === true }),
          ...(gesture === null ? {} : {
            intent: gesture.kind,
            durationMs: gesture.durationMs ?? 0,
            amplitude: gesture.amplitude ?? 0,
          }),
        };
      } catch (error) {
        return { ok: false, connected: client.ready, error: error?.message ?? String(error) };
      }
    },
  };
}
