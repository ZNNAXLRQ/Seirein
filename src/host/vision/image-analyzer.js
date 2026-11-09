/**
 * P-187 阶段 4 —— 后台图片分析器（可注入、可测试、无宿主依赖）。
 *
 * 这一层只负责“把已经落盘的帧交给一次独立的模型请求”，不直接读全局 ctx、不截图、不写文件、
 * 不创建真实定时器；所有外部能力都从 `getService` / `readFile` / `setTimer` 注入，因此单测
 * 不需要 Harness 运行时，导入模块也没有副作用。
 *
 * 与 DSH 图片输入契约的对应关系（静态源码核对）：
 *
 *   - 图片内容块只能引用附件：`{ type: 'image', attachment: ref }`；
 *   - 图片必须先通过 `attachments.saveImage({ data, mediaType: 'image/png', name })` 保存；
 *   - 图片能力必须由 `llm.resolveModelInfo(provider, model, signal)?.inputModalities` **明确**
 *     包含 `'image'`，缺省、抛错或未知一律按不支持处理（绝不“先发过去再说”）；
 *   - provider/model 取自 `agentDefaultModel.currentSelection()`（直接字段或 `route` 字段）；
 *   - 只消费 `text-delta` 与 `finish` 两种分片，结束原因从 `finish.reason.kind` 读取；
 *   - 等待“下一片”与内部期限/外部取消竞速，provider 不响应 abort 也不会永久挂起。
 *
 * 失败策略：**整体失败**。只要一帧读不出来或保存失败，就不发起模型请求，返回
 * `read-failed` / `save-failed` 且 `images: 0`。少一张图却让模型按“看到全部帧”回答，会把
 * 局部观察伪装成完整观察；调用方拿到明确失败后可以重试或退化为纯文本，比悄悄缺图更安全。
 * 已经保存成功的附件不会在这里删除（契约没有暴露删除方法），由调用方按需清理。
 *
 * 输出里只有机器原因码：`reason` 永不包含文件路径、异常 message 或模型正文；`errorCode`
 * 只透传 provider 的 `failure.code`（以及内部的 `'empty'` 哨兵），并限制为 ≤64 个
 * 无空白、无路径语义的机器码字符。
 */

import { basename } from 'node:path';

/** 默认预算：最多 3 张、单次 800 token、模型请求 30 秒。 */
export const IMAGE_ANALYZER_DEFAULTS = Object.freeze({
  maxImages: 3,
  maxTokens: 800,
  timeoutMs: 30_000,
});

/** provider 错误码只保留为短机器码，避免正文/路径混进结果。 */
const MAX_ERROR_CODE_CHARS = 64;
const MACHINE_CODE = /^[A-Za-z0-9_.:-]+$/u;

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

/**
 * 只接受 provider 声明的短机器码。超过 64 字符、含空白/斜杠等可能夹带正文或路径的值一律丢弃；
 * 宁可不给错误码，也不把不可信文本透出成 reason/errorCode。
 */
function providerErrorCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim();
  if (code.length === 0 || code.length > MAX_ERROR_CODE_CHARS) return '';
  if (!MACHINE_CODE.test(code)) return '';
  return code;
}

/** 流式请求同步/异步抛出的错误码，同样只取机器码字段，不读取 message。 */
function thrownErrorCode(error) {
  return error?.code ?? error?.failure?.code;
}

/**
 * 尽力释放异步迭代器/流。刻意**不等待** return()：provider 不响应取消时，等待 return()
 * 同样会永久挂起。迟到的拒绝必须自行消费，避免成为未处理拒绝。
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
 * 按输入顺序挑出前 `limit` 个有文件的帧。没有 `file` 的条目不是“可用帧”，直接跳过；
 * 跳过不会改变其余帧的相对顺序。返回副本，避免把外部数组对象带进请求。
 */
function selectFrames(frames, limit) {
  const source = Array.isArray(frames) ? frames : [];
  const selected = [];
  for (let index = 0; index < source.length && selected.length < limit; index += 1) {
    const frame = source[index];
    if (!isObject(frame)) continue;
    const file = nonEmptyString(frame.file);
    if (file.length === 0) continue;
    selected.push({ file });
  }
  return selected;
}

/** 附件显示名：优先真实 basename，取不到时用稳定的 frame-N.png。 */
function attachmentName(file, index) {
  const name = basename(file);
  return name.length > 0 ? name : `frame-${index}.png`;
}

/**
 * @param {object} [options]
 * @param {(name: string) => any} [options.getService] 与插件 ctx.get 同义。
 * @param {(path: string) => Promise<Uint8Array>} [options.readFile] 读取帧字节（测试注入）。
 * @param {() => number} [options.now] 保留的确定性时钟注入位；本版结果不返回耗时。
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(timer: any) => void} [options.clearTimer]
 * @param {number} [options.maxImages]
 * @param {number} [options.maxTokens]
 * @param {number} [options.timeoutMs] 只约束模型请求阶段；本地读图/保存不占模型时限。
 */
export function createImageAnalyzer({
  getService,
  readFile,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxImages,
  maxTokens,
  timeoutMs,
} = {}) {
  const imageLimit = toLimit(maxImages, IMAGE_ANALYZER_DEFAULTS.maxImages);
  const tokenLimit = toLimit(maxTokens, IMAGE_ANALYZER_DEFAULTS.maxTokens);
  const deadlineMs = toLimit(timeoutMs, IMAGE_ANALYZER_DEFAULTS.timeoutMs);

  // 时钟目前只作为注入契约保留：结果不含耗时字段，测试也不需要真实时间。
  void now;

  /** 统一失败形状：ok=false、text 为空、images 是“真正进入请求的图片数”。 */
  const failure = (reason, images = 0, errorCode = '') => {
    const result = { ok: false, text: '', reason, images };
    const code = providerErrorCode(errorCode);
    if (code.length > 0) result.errorCode = code;
    return result;
  };

  return {
    /**
     * 一次独立的后台理解请求。任何输入畸形或依赖失败都返回 `{ok:false, reason}`，不抛错。
     *
     * 顺序固定为：服务存在 → selection/provider/model → 明确图像能力 → 前 N 帧读取并保存
     * → 组装 text + image 内容块 → llm.stream → 收集 text-delta → finish 判定。
     */
    async analyze(options = {}) {
      // 允许 analyze(null) / analyze('x')：参数不是对象时按空参数处理。
      const input = isObject(options) ? options : {};
      const signal = input.signal;
      const system = typeof input.system === 'string' ? input.system : '';
      const user = typeof input.user === 'string' ? input.user : '';
      const frames = selectFrames(input.frames, imageLimit);

      // 1. 两个服务都必须可用：llm 发请求，attachments 保存图片。
      //    先查服务再看取消，保持“服务存在 → selection → 能力 → 帧”的既定顺序。
      const llm = serviceOf(getService, 'llm');
      if (!isObject(llm) || typeof llm.stream !== 'function') return failure('no-llm');
      const attachments = serviceOf(getService, 'attachments');
      if (!isObject(attachments) || typeof attachments.saveImage !== 'function') {
        return failure('no-attachments');
      }

      // 外部取消不应继续读图或保存附件；这里先于任何文件 I/O。
      if (signal?.aborted === true) return failure('aborted');

      // 2. 取默认模型路由；provider/model 任一为空都视为没有模型。
      const { provider, model } = readRoute(getService);
      if (provider.length === 0 || model.length === 0) return failure('no-model');

      // 3. 能力必须“明确”支持图片；未知、缺省、探测抛错都按不支持处理。
      let info;
      try {
        info = typeof llm.resolveModelInfo === 'function'
          ? await llm.resolveModelInfo(provider, model, signal)
          : undefined;
      } catch {
        return failure(signal?.aborted === true ? 'aborted' : 'no-image-support');
      }
      if (signal?.aborted === true) return failure('aborted');
      const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null;
      if (modalities === null || !modalities.includes('image')) return failure('no-image-support');

      // 4. 能力通过后才检查帧，避免为一次必然失败的请求读盘。
      if (frames.length === 0) return failure('no-frames');
      if (typeof readFile !== 'function') return failure('read-failed');

      // 5. 逐帧读取并保存。任何一帧失败都整体失败：不能少图却假装看全。
      const images = [];
      for (let index = 0; index < frames.length; index += 1) {
        if (signal?.aborted === true) return failure('aborted');
        let data;
        try {
          data = await readFile(frames[index].file);
        } catch {
          return failure('read-failed');
        }
        // 契约要求 saveImage 的 data 是 Uint8Array（Node Buffer 满足）；其他形状视为读失败。
        if (!(data instanceof Uint8Array)) return failure('read-failed');
        if (signal?.aborted === true) return failure('aborted');

        let attachment;
        try {
          attachment = await attachments.saveImage({
            data,
            mediaType: 'image/png',
            name: attachmentName(frames[index].file, index),
          });
        } catch {
          return failure('save-failed');
        }
        if (attachment === undefined || attachment === null) return failure('save-failed');
        images.push({ type: 'image', attachment });
      }
      if (signal?.aborted === true) return failure('aborted');

      // 6. 模型请求阶段：内部 AbortController 同时承载“超时”和“外部取消”，
      //    对外只把 controller.signal 交给 llm，避免 provider 直接依赖调用方对象。
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
      const externalSignal = signal !== undefined && signal !== null && typeof signal.addEventListener === 'function'
        ? signal
        : null;
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
        if (beforeTimer !== '') return failure(beforeTimer, images.length);

        // 超时是同步定时器也要能被测试：先登记，再发请求；真实 setTimeout 会在本轮同步代码
        // 结束后才触发，所以生产路径不会出现“未发请求先超时”。
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
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: user }, ...images],
            }],
            maxTokens: tokenLimit,
            signal: controller.signal,
          });
        } catch (error) {
          const reason = reasonNow();
          return failure(
            reason || 'stream-error',
            images.length,
            reason ? '' : thrownErrorCode(error),
          );
        }

        const afterStream = reasonNow();
        if (afterStream !== '') return failure(afterStream, images.length);

        // 7. 收集文本。等待“下一片”必须同时受期限与取消控制：provider 不响应 abort 时，
        //    直接 await iterator.next() 会永久挂起并占住在途锁，所以这里与取消令牌竞速。
        try {
          const factory = streamIteratorFactory(stream);
          if (factory === null) return failure('stream-error', images.length);
          iterator = factory.call(stream);
          if (!isObject(iterator) || typeof iterator.next !== 'function') {
            return failure('stream-error', images.length);
          }
        } catch (error) {
          const reason = reasonNow();
          return failure(
            reason || 'stream-error',
            images.length,
            reason ? '' : thrownErrorCode(error),
          );
        }

        let text = '';
        try {
          for (;;) {
            const beforeNext = reasonNow();
            if (beforeNext !== '') return failure(beforeNext, images.length);

            let next;
            try {
              const pending = iterator.next();
              // 竞速输掉的 next() 仍可能在之后拒绝；显式挂处理器，避免未处理拒绝。
              if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
                pending.then(undefined, () => {});
              }
              next = await Promise.race([pending, cancelWait]);
            } catch (error) {
              const reason = reasonNow();
              return failure(
                reason || 'stream-error',
                images.length,
                reason ? '' : thrownErrorCode(error),
              );
            }

            // 取消先到：丢弃已经在途的迟到分片，立即返回，不再拼接任何文本。
            if (next === cancelToken) return failure(reasonNow() || 'timeout', images.length);
            const afterNext = reasonNow();
            if (afterNext !== '') return failure(afterNext, images.length);
            if (!isObject(next)) return failure('stream-error', images.length);
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
              if (kind === 'error') {
                return failure('stream-error', images.length, reason?.failure?.code ?? chunk?.failure?.code);
              }
              if (kind === 'aborted') return failure('aborted', images.length);
              break;
            }
            // 其他分片（usage 等）与图片分析结果无关，忽略。
          }
        } catch (error) {
          const reason = reasonNow();
          return failure(
            reason || 'stream-error',
            images.length,
            reason ? '' : thrownErrorCode(error),
          );
        }

        const finalReason = reasonNow();
        if (finalReason !== '') return failure(finalReason, images.length);

        // 空文本绝不能当作“模型看懂了”：调用方会把它渲染成空的理解结果。
        if (text.trim().length === 0) return failure('stream-error', images.length, 'empty');
        return { ok: true, text, reason: 'ok', images: images.length };
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

    /**
     * 只读能力探测：不读图、不保存附件、不发起 stream 请求。
     *
     * `ok` 表示探测过程本身给出了结论；`usable` 才表示模型明确声明支持图片。
     * 按契约只检查 llm / selection / resolveModelInfo，不检查 attachments；真正的投递可行性
     * 由 analyze 的返回值决定。
     */
    async capability() {
      const llm = serviceOf(getService, 'llm');
      if (!isObject(llm)) {
        return { ok: false, usable: false, reason: 'no-llm', provider: '', model: '' };
      }
      const { provider, model } = readRoute(getService);
      if (provider.length === 0 || model.length === 0) {
        return { ok: false, usable: false, reason: 'no-model', provider, model };
      }
      if (typeof llm.resolveModelInfo !== 'function') {
        return { ok: false, usable: false, reason: 'no-image-support', provider, model };
      }
      let info;
      try {
        info = await llm.resolveModelInfo(provider, model);
      } catch {
        return { ok: false, usable: false, reason: 'no-image-support', provider, model };
      }
      const usable = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
      return {
        ok: true,
        usable,
        reason: usable ? 'ok' : 'no-image-support',
        provider,
        model,
      };
    },
  };
}
