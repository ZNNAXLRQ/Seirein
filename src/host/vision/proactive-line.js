/**
 * P-187 阶段 5 —— 主动回应短句生成器（可注入、可测试、无宿主依赖）。
 *
 * 设计文档第十节要求“确需表达时才生成短句，避免每个事件都多调用一次模型”。因此本模块不在
 * 候选登记、隐私切换或定时器里做任何事：只有调用方真正决定开口、并调用 `generate()` 时，才发出
 * **一次**纯文本的短请求。它不截图、不读文件、不写记忆、不创建对话，也不修改人设。
 *
 * 输入只有已经归一化的主动候选（`event`）与当前共享理解状态（`state`，本版不参与提示词）：
 *   - `event.description` 是这一事件的事实描述；
 *   - `event.reaction` 是后台理解给出的观察角度，可选；
 *   - 两者已经足够，请求里**不带图片**，避免为一句反应重复发送画面证据。
 *
 * 与 DSH 模型调用契约的对应关系：
 *   - provider/model 取自 `agentDefaultModel.currentSelection()`（直接字段或 `route` 字段）；
 *   - 只消费 `text-delta` 与 `finish` 两种分片，结束原因从 `finish.reason.kind` 读取；
 *   - 超时与外部取消都通过内部 AbortController 合并，定时器 `unref()`，不会拖住宿主退出；
 *   - 等待“下一片”与期限/取消竞速：provider 不响应 abort 时也不会永久占住在途锁。
 *
 * 失败策略：任何错误都不外抛，只返回机器原因码，绝不把异常 message、路径或模型正文塞进
 * `reason`。调用方拿到非 `ok` 结果时直接放弃这一条候选即可。
 */

/** 默认预算：一句最多 60 字、单次 120 token、模型请求 8 秒。 */
export const PROACTIVE_LINE_DEFAULTS = Object.freeze({
  maxChars: 60,
  maxTokens: 120,
  timeoutMs: 8_000,
});

/** user 文本（描述 + 观察角度）的硬上限，防止后台状态把超长描述带进请求。 */
const USER_TEXT_MAX = 600;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 正数上限：非法值退回默认值，正数向下取整。 */
function toLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.floor(number));
}

/** 非空字符串（去首尾空白）；其他类型一律视为未提供。 */
function nonEmptyString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** getService 失败或未注入都只是“服务不存在”，不向调用方抛错。 */
function serviceOf(getService, name) {
  if (typeof getService !== 'function') return undefined;
  try {
    return getService(name);
  } catch {
    return undefined;
  }
}

/**
 * 当前默认模型路由。直接字段优先，缺失时再读 `selection.route`；空白值按未选择处理。
 * currentSelection 抛错等价于没有选择。
 */
function readRoute(getService) {
  const selectionService = serviceOf(getService, 'agentDefaultModel');
  let selection = null;
  try {
    selection = selectionService?.currentSelection?.() ?? null;
  } catch {
    selection = null;
  }
  const direct = isObject(selection) ? selection : {};
  const route = isObject(direct.route) ? direct.route : {};
  return {
    provider: nonEmptyString(direct.provider) || nonEmptyString(route.provider),
    model: nonEmptyString(direct.model) || nonEmptyString(route.model),
  };
}

/** 按码点截断，避免把代理对/表情截成半个字符。 */
function codePointClip(value, max) {
  if (typeof value !== 'string') return '';
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/**
 * 尽力释放异步迭代器/流。这里刻意**不等待** return() 完成：provider 不响应取消时，
 * 等待 return() 本身同样会永久挂起，与不等待 next() 的问题一样。迟到的拒绝必须自行消费，
 * 否则会成为未处理拒绝。
 */
function releaseStream(stream, iterator) {
  const candidates = [iterator, stream];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const close = candidate.return;
    if (typeof close !== 'function') continue;
    try {
      const returned = close.call(candidate);
      if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
        returned.then(undefined, () => {});
      }
      return;
    } catch {
      /* 释放失败不改变已经得出的结果；继续尝试下一个候选 */
    }
  }
}

/** 与 for await...of 一致：优先 Symbol.asyncIterator，其次退化为同步 iterator。 */
function streamIteratorFactory(value) {
  if (!isObject(value)) return null;
  if (typeof value[Symbol.asyncIterator] === 'function') return value[Symbol.asyncIterator];
  if (typeof value[Symbol.iterator] === 'function') return value[Symbol.iterator];
  return null;
}

/**
 * 创建主动回应短句生成器。
 *
 * @param {object} [options]
 * @param {(name: string) => any} [options.getService] 与插件 ctx.get 同义。
 * @param {() => string} [options.personaText] 人设文本；每次生成时延迟读取。
 * @param {() => number} [options.now] 保留的确定性时钟注入位；结果不含耗时。
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 * @param {number} [options.maxChars]
 * @param {number} [options.maxTokens]
 * @param {number} [options.timeoutMs]
 */
export function createProactiveLineGenerator({
  getService,
  personaText,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxChars,
  maxTokens,
  timeoutMs,
} = {}) {
  const charLimit = toLimit(maxChars, PROACTIVE_LINE_DEFAULTS.maxChars);
  const tokenLimit = toLimit(maxTokens, PROACTIVE_LINE_DEFAULTS.maxTokens);
  const deadlineMs = toLimit(timeoutMs, PROACTIVE_LINE_DEFAULTS.timeoutMs);

  // 时钟目前只作为注入契约保留：结果不含耗时字段，测试也不需要真实时间。
  void now;

  /** 统一失败形状：ok=false、text 为空，reason 只允许本模块定义的机器码。 */
  const failure = (reason) => ({ ok: false, text: '', reason });

  return {
    /**
     * 生成一句主动反应。任何输入畸形、依赖缺失、流错误或超时都返回 `{ok:false, reason}`，不抛错。
     *
     * @param {object} [options]
     * @param {object} [options.event] 归一化后的主动候选（需要非空 description）。
     * @param {object|null} [options.state] 当前共享理解状态；本版只保留在契约里。
     * @param {AbortSignal} [options.signal] 外部取消信号（隐私/切源/卸载）。
     */
    async generate(options = {}) {
      // 允许 generate(null) / generate('x')：参数不是对象时按空参数处理。
      const input = isObject(options) ? options : {};
      const event = isObject(input.event) ? input.event : null;
      const description = event !== null && typeof event.description === 'string'
        ? event.description.trim()
        : '';
      // 没有事件描述就没有可说的东西；在碰任何服务之前就拒绝，避免无意义调用。
      if (description.length === 0) return failure('bad-input');
      const reaction = typeof event.reaction === 'string' ? event.reaction.trim() : '';
      // The two-stage gate may have looked up a more detailed local event. That evidence must
      // reach the actual generation request, not only the diagnostic status: otherwise the
      // "detail" round is paid for but the line is still written from the short macro summary.
      const detail = isObject(input.detail) ? input.detail : null;
      const detailDescription = detail !== null && typeof detail.description === 'string'
        ? detail.description.trim() : '';
      const detailDialogue = detail !== null && typeof detail.keyDialogue === 'string'
        ? detail.keyDialogue.trim() : '';
      const externalSignal = input.signal !== null
        && typeof input.signal === 'object'
        && typeof input.signal.addEventListener === 'function'
        ? input.signal
        : null;

      // 1. 模型服务必须可用；selection 缺失视为没有模型。先查依赖再看取消，顺序稳定可测。
      const llm = serviceOf(getService, 'llm');
      if (!isObject(llm) || typeof llm.stream !== 'function') return failure('no-llm');
      const { provider, model } = readRoute(getService);
      if (provider.length === 0 || model.length === 0) return failure('no-model');
      if (externalSignal?.aborted === true) return failure('aborted');

      // 2. 人设延迟读取：宿主里 persona 在更后段才初始化，生成时一定已就绪。
      let persona = '';
      if (typeof personaText === 'function') {
        try {
          persona = nonEmptyString(personaText());
        } catch {
          persona = '';
        }
      }
      const instruction = `你正和用户一起看屏幕，刚看到一件事。用一句自然口语说出你的反应（不超过 ${charLimit} 个字）。只输出这一句：不解说剧情、不总结、不提问、不剧透没看到的内容；凡是推断都必须说得不确定。`;
      const system = persona.length > 0 ? `${persona}\n\n${instruction}` : instruction;

      // 3. user 文本只包含事实描述与可选反应角度，截断到 600 字（按码点）。
      const observed = `刚看到：${description}`;
      const detailLines = [];
      if (detailDescription.length > 0 && detailDescription !== description) {
        detailLines.push(`补充细节：${codePointClip(detailDescription, 200)}`);
      }
      if (detailDialogue.length > 0) {
        detailLines.push(`关键台词：${codePointClip(detailDialogue, 120)}`);
      }
      const userText = codePointClip(
        [
          observed,
          ...(reaction.length > 0 ? [`你的观察角度：${reaction}`] : []),
          ...detailLines,
        ].join('\n'),
        USER_TEXT_MAX,
      );

      // 4. 请求阶段：内部 controller 同时承载“超时”和“外部取消”，对外只交出它的 signal。
      const controller = new AbortController();
      // 先到的原因生效：timeout / aborted 只写入一次，后到的取消不会改写已经得出的结果。
      let terminalReason = '';
      let timer = null;
      let listening = false;
      // 与“下一片”竞速的取消令牌；期限与外部取消都只 resolve 它一次。
      const cancelToken = Symbol('cancelled');
      let resolveCancel;
      const cancelWait = new Promise((resolve) => {
        resolveCancel = resolve;
      });
      const abortWith = (reason) => {
        if (terminalReason !== '') return;
        terminalReason = reason;
        try {
          controller.abort();
        } catch {
          /* abort 不应影响结果码 */
        }
        resolveCancel(cancelToken);
      };
      const onExternalAbort = () => abortWith('aborted');
      if (externalSignal !== null) {
        try {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
          listening = true;
        } catch {
          listening = false;
        }
      }
      const stopTimer = () => {
        if (timer === null) return;
        try {
          clearTimer(timer);
        } catch {
          /* 清理失败不改变已经得出的结果 */
        }
        timer = null;
      };
      // 已到期的原因；监听器注册失败时仍用 signal.aborted 兜底。
      const reasonNow = () => terminalReason
        || (externalSignal?.aborted === true ? 'aborted' : '');

      let stream = null;
      let iterator = null;
      try {
        // 外部取消可能刚好发生在 addEventListener 之前；注册后再确认一次，先于内部期限。
        const beforeTimer = reasonNow();
        if (beforeTimer !== '') return failure(beforeTimer);

        // 先登记定时器再发请求：真实 setTimeout 在本轮同步代码结束后才触发，生产路径不会
        // 出现“未发请求先超时”；测试注入的同步定时器也能稳定复核 timeout 分支。
        try {
          timer = setTimer(() => abortWith('timeout'), deadlineMs);
          timer?.unref?.();
        } catch {
          // 定时器不可用时退化：仍发请求，只是没有内部 deadline（外部 signal 仍有效）。
          timer = null;
        }

        try {
          stream = llm.stream({
            provider,
            model,
            system,
            // 只发文本：事件描述与 reaction 已经足够，不带图片。
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: userText }],
            }],
            maxTokens: tokenLimit,
            signal: controller.signal,
          });
        } catch {
          const reason = reasonNow();
          return failure(reason || 'stream-error');
        }

        const afterStream = reasonNow();
        if (afterStream !== '') return failure(afterStream);

        // 5. 收集文本。等待“下一片”必须同时受期限与取消控制：provider 不响应 abort 时，
        //    直接 await iterator.next() 会永久挂起并占住在途锁，所以这里与取消令牌竞速。
        try {
          const factory = streamIteratorFactory(stream);
          if (factory === null) return failure('stream-error');
          iterator = factory.call(stream);
          if (!isObject(iterator) || typeof iterator.next !== 'function') {
            return failure('stream-error');
          }
        } catch {
          return failure('stream-error');
        }

        let text = '';
        try {
          for (;;) {
            const beforeNext = reasonNow();
            if (beforeNext !== '') return failure(beforeNext);

            let next;
            try {
              const pending = iterator.next();
              // 竞速输掉的 next() 仍可能在之后拒绝；显式挂处理器，避免未处理拒绝。
              if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
                pending.then(undefined, () => {});
              }
              next = await Promise.race([pending, cancelWait]);
            } catch {
              const reason = reasonNow();
              return failure(reason || 'stream-error');
            }

            // 取消先到：丢弃已经在途的迟到分片，立即返回，不再拼接任何文本。
            if (next === cancelToken) return failure(reasonNow() || 'timeout');
            const afterNext = reasonNow();
            if (afterNext !== '') return failure(afterNext);
            if (!isObject(next)) return failure('stream-error');
            if (next.done === true) break;

            const chunk = next.value;
            const type = typeof chunk?.type === 'string' ? chunk.type.toLowerCase() : '';
            if (type === 'text-delta') {
              if (typeof chunk.text === 'string') text += chunk.text;
              continue;
            }
            if (type === 'finish') {
              const reason = chunk?.reason;
              const kind = typeof reason?.kind === 'string'
                ? reason.kind.toLowerCase()
                : (typeof reason === 'string' ? reason.toLowerCase() : '');
              if (kind === 'error') return failure('stream-error');
              if (kind === 'aborted') return failure(reasonNow() || 'aborted');
              break;
            }
            // 其他分片（usage 等）与一句短反应无关，忽略。
          }
        } catch {
          const reason = reasonNow();
          return failure(reason || 'stream-error');
        }

        const finalReason = reasonNow();
        if (finalReason !== '') return failure(finalReason);

        // 空/纯空白不能当作“模型说了什么”：调用方会把它发进语音出口。
        const trimmed = text.trim();
        if (trimmed.length === 0) return failure('empty');

        return { ok: true, text: codePointClip(trimmed, charLimit), reason: 'ok' };
      } finally {
        // 尽力释放：不等待 return() 完成，否则 provider 不响应时又会挂起。
        releaseStream(stream, iterator);
        stopTimer();
        if (listening) {
          try {
            externalSignal.removeEventListener('abort', onExternalAbort);
          } catch {
            /* 清理失败不影响结果 */
          }
        }
      }
    },
  };
}
