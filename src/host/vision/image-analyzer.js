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
 *
 * 另挂一个**非枚举** `meta`（安全请求元数据，兼容旧结果形状）：provider/model/imageCount/
 * contentBlockTypes/maxTokens/maxImages/budget/textChars/reasoningChars/finishKind/finishReason/
 * errorCode/timedOut/aborted/streamOpened/chunkCount/attempts/durationMs。`budget` 记录本次
 * 分析器的图片数/Token/时限上限，供同材料双探针等诊断独立对照。meta 不复制正文或路径；
 * `errorCode:'empty'` 只表示“本次没有可用正文”，`finishKind` 始终来自真实 finish 分片，
 * 不能反推成“模型空生成”。
 *
 * 截断归因与单次成本上限：
 *
 *   - 默认输出预算 4096 token；`finishKind` 为 `max-tokens`/`max_tokens`/`length`（token 上限）
 *     时最多再请求一次，预算提高到至少 8192（且不超过单次总预算 16384）；
 *   - 重试仍是同一 provider/model，不自动换模型；最多 2 次，绝不无限重试；
 *   - 最终仍是截断时返回 `{ok:false, reason:'truncated', errorCode:'max-tokens'}`，而不是把
 *     半截正文交给解析器变成 `bad-json`；`meta.finishKind` 保留真实结束原因。
 */

import { basename } from 'node:path';

/**
 * 默认预算：最多 3 张、单次 4096 token、模型请求 30 秒。
 *
 * 4096 是推理型模型的最低可用正文预算：800 token 常被 reasoning 吃光，正文只剩半截 JSON。
 * `retryMaxTokens` 是 token 上限截断后唯一一次重试的最低预算，`maxTotalTokens` 约束同一次
 * analyze 两次请求的 token 上限之和（成本上限）。
 */
export const IMAGE_ANALYZER_DEFAULTS = Object.freeze({
  maxImages: 3,
  maxTokens: 4096,
  timeoutMs: 30_000,
  retryMaxTokens: 8192,
  maxTotalTokens: 16_384,
});

/** provider 错误码只保留为短机器码，避免正文/路径混进结果。 */
const MAX_ERROR_CODE_CHARS = 64;
const MACHINE_CODE = /^[A-Za-z0-9_.:-]+$/u;
/** provider/model 是路由标识；允许常见分隔符，但拒绝空白、反斜杠与控制字符。 */
const MAX_ROUTE_CHARS = 80;
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u;
/** meta 中的内容块类型最多记录这么多；类型本身只接受短机器标识。 */
const MAX_BLOCK_TYPES = 8;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * token 上限截断的 finish 机器码。不同 provider 用 `max-tokens` / `max_tokens` / `length`
 * 表达同一件事；只比较归一化后的字母，避免分隔符差异让截断被误判成普通 bad-json。
 */
const TRUNCATION_FINISH = new Set(['maxtokens', 'length', 'tokenlimit']);

function isTruncationFinish(value) {
  if (typeof value !== 'string') return false;
  return TRUNCATION_FINISH.has(value.toLowerCase().replace(/[^a-z]/gu, ''));
}

/** 路由标识：超出上限或含空白/反斜杠时留空，绝不把路径/正文塞进 meta。 */
function metaRoute(value) {
  const text = nonEmptyString(value);
  if (text.length === 0 || text.length > MAX_ROUTE_CHARS) return '';
  return ROUTE_ID.test(text) ? text : '';
}

/** finish 原因只接受短机器码；没有机器码时留空，不猜模型意图。 */
function metaToken(value) {
  if (typeof value !== 'string') return '';
  return providerErrorCode(value.toLowerCase());
}

/** 去重后的内容块类型；调用方传入的列表本身有界。 */
function blockTypesOf(blocks) {
  const types = [];
  for (const block of blocks) {
    if (types.length >= MAX_BLOCK_TYPES) break;
    if (!isObject(block) || typeof block.type !== 'string') continue;
    const type = metaToken(block.type);
    if (type.length === 0 || types.includes(type)) continue;
    types.push(type);
  }
  return Object.freeze(types);
}

/**
 * 把 meta 作为**非枚举**字段挂到结果上。
 *
 * 旧调用只读 `ok/text/reason/images`，甚至用 `deepEqual` 比较整个结果；非枚举字段不会改变
 * `Object.keys`/`JSON.stringify`/`deepEqual` 的旧行为，但调用方仍可显式读 `result.meta`。
 * 这是“meta 可选、不影响成功结果”的兼容方式。
 */
function attachMeta(result, meta) {
  try {
    Object.defineProperty(result, 'meta', {
      value: Object.freeze(meta),
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    /* 极端宿主对象不允许扩展时，失败结果仍然是合法的机器原因 */
  }
  return result;
}

/**
 * 失败样本需要原始输出 head+tail 时使用；同样是非枚举字段，不进入 JSON、status 或日志正文。
 * 只在失败分支挂载，成功结果不复制模型正文。
 */
function attachDiagnosticText(result, text) {
  if (typeof text !== 'string' || text.length === 0) return result;
  try {
    Object.defineProperty(result, 'diagnosticText', {
      value: text,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    /* 不复制正文比挂载失败更重要 */
  }
  return result;
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
 * @param {number} [options.maxTokens] 首次请求的输出 token 上限；默认 4096。
 * @param {number} [options.retryMaxTokens] 截断后唯一一次重试的最低预算；默认 8192。
 * @param {number} [options.maxTotalTokens] 单次 analyze 两次请求的 token 上限之和；默认 16384。
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
  retryMaxTokens,
  maxTotalTokens,
  timeoutMs,
} = {}) {
  const imageLimit = toLimit(maxImages, IMAGE_ANALYZER_DEFAULTS.maxImages);
  const tokenLimit = toLimit(maxTokens, IMAGE_ANALYZER_DEFAULTS.maxTokens);
  const deadlineMs = toLimit(timeoutMs, IMAGE_ANALYZER_DEFAULTS.timeoutMs);
  const retryFloor = toLimit(retryMaxTokens, IMAGE_ANALYZER_DEFAULTS.retryMaxTokens);
  const totalTokenLimit = toLimit(maxTotalTokens, IMAGE_ANALYZER_DEFAULTS.maxTotalTokens);
  // 只有预算还能真正提高时才允许重试；总预算封顶保证一次 analyze 最多花这些 token。
  const retryTokenLimit = Math.min(
    Math.max(retryFloor, tokenLimit * 2),
    Math.max(0, totalTokenLimit - tokenLimit),
  );
  const canRetry = retryTokenLimit > tokenLimit;

  /** 注入时钟只用于 durationMs；时钟失败退回真实时间，不让诊断字段把请求弄崩。 */
  const clock = () => {
    try {
      const value = Number(now());
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* 不能因为诊断时钟失败而改变请求语义 */
    }
    return Date.now();
  };

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

      // 诊断状态全部是局部变量：请求失败/成功都只产出数字、布尔和短机器码。
      // `text` 只用于计算 textChars 与失败样本；meta 本身不复制正文。
      const startedAt = clock();
      let text = '';
      let reasoningChars = 0;
      let finishKind = '';
      let finishReason = '';
      let finishAborted = false;
      let streamOpened = false;
      let chunkCount = 0;
      let provider = '';
      let model = '';
      let terminalReason = '';
      // 最终一次请求真正使用的预算；重试后 meta.maxTokens 反映实际值，budget 仍记录配置上限。
      let requestMaxTokens = tokenLimit;
      let attempts = 0;
      // 尚未组装请求时为空；真正发请求前才写入 text/image，避免把“计划”说成“实际请求”。
      let contentBlockTypes = Object.freeze([]);

      /**
       * 完成一次结果：统一挂 meta；失败时按需挂非枚举 diagnosticText。
       * **绝不**从 `text.trim()===''` 反推“模型空生成”：finishKind 只来自真实 finish 分片，
       * errorCode 的 `empty` 只是“本次没有可用正文”的哨兵。
       */
      const buildMeta = (images, errorCode) => {
        const meta = {
          provider: metaRoute(provider),
          model: metaRoute(model),
          imageCount: Math.max(0, Math.floor(Number(images) || 0)),
          contentBlockTypes,
          maxTokens: requestMaxTokens,
          // 预算与“实际送去几张图”分开记录：imageCount 是本次实际数，budget 是分析器上限。
          maxImages: imageLimit,
          budget: Object.freeze({
            maxImages: imageLimit,
            maxTokens: tokenLimit,
            timeoutMs: deadlineMs,
          }),
          textChars: text.length,
          reasoningChars,
          finishKind,
          finishReason: finishReason || finishKind,
          errorCode: providerErrorCode(errorCode),
          timedOut: terminalReason === 'timeout',
          aborted: terminalReason === 'aborted'
            || finishAborted
            || signal?.aborted === true,
          streamOpened,
          chunkCount,
          attempts,
          durationMs: Math.max(0, Math.floor(clock() - startedAt)),
        };
        return meta;
      };
      const fail = (reason, images = 0, errorCode = '') => {
        const result = failure(reason, images, errorCode);
        attachMeta(result, buildMeta(images, result.errorCode || ''));
        attachDiagnosticText(result, text);
        return result;
      };

      // 1. 两个服务都必须可用：llm 发请求，attachments 保存图片。
      //    先查服务再看取消，保持“服务存在 → selection → 能力 → 帧”的既定顺序。
      const llm = serviceOf(getService, 'llm');
      if (!isObject(llm) || typeof llm.stream !== 'function') return fail('no-llm');
      const attachments = serviceOf(getService, 'attachments');
      if (!isObject(attachments) || typeof attachments.saveImage !== 'function') {
        return fail('no-attachments');
      }

      // 外部取消不应继续读图或保存附件；这里先于任何文件 I/O。
      if (signal?.aborted === true) return fail('aborted');

      // 2. 取默认模型路由；provider/model 任一为空都视为没有模型。
      ({ provider, model } = readRoute(getService));
      if (provider.length === 0 || model.length === 0) return fail('no-model');

      // 3. 能力必须“明确”支持图片；未知、缺省、探测抛错都按不支持处理。
      let info;
      try {
        info = typeof llm.resolveModelInfo === 'function'
          ? await llm.resolveModelInfo(provider, model, signal)
          : undefined;
      } catch {
        return fail(signal?.aborted === true ? 'aborted' : 'no-image-support');
      }
      if (signal?.aborted === true) return fail('aborted');
      const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null;
      if (modalities === null || !modalities.includes('image')) return fail('no-image-support');

      // 4. 能力通过后才检查帧，避免为一次必然失败的请求读盘。
      if (frames.length === 0) return fail('no-frames');
      if (typeof readFile !== 'function') return fail('read-failed');

      // 5. 逐帧读取并保存。任何一帧失败都整体失败：不能少图却假装看全。
      const images = [];
      for (let index = 0; index < frames.length; index += 1) {
        if (signal?.aborted === true) return fail('aborted');
        let data;
        try {
          data = await readFile(frames[index].file);
        } catch {
          return fail('read-failed');
        }
        // 契约要求 saveImage 的 data 是 Uint8Array（Node Buffer 满足）；其他形状视为读失败。
        if (!(data instanceof Uint8Array)) return fail('read-failed');
        if (signal?.aborted === true) return fail('aborted');

        let attachment;
        try {
          attachment = await attachments.saveImage({
            data,
            mediaType: 'image/png',
            name: attachmentName(frames[index].file, index),
          });
        } catch {
          return fail('save-failed');
        }
        if (attachment === undefined || attachment === null) return fail('save-failed');
        images.push({ type: 'image', attachment });
      }
      if (signal?.aborted === true) return fail('aborted');
      contentBlockTypes = blockTypesOf([{ type: 'text' }, ...images]);

      /**
       * 发起一次模型请求。重试时复用已经保存的图片附件，只重置本次请求的诊断状态；
       * 每次请求都有自己的 AbortController/期限，外部取消对两次尝试都有效。
       */
      const runAttempt = async (attemptTokens) => {
        requestMaxTokens = attemptTokens;
        attempts += 1;
        text = '';
        reasoningChars = 0;
        finishKind = '';
        finishReason = '';
        finishAborted = false;
        streamOpened = false;
        chunkCount = 0;
        terminalReason = '';

        // 6. 模型请求阶段：内部 AbortController 同时承载“超时”和“外部取消”，
        //    对外只把 controller.signal 交给 llm，避免 provider 直接依赖调用方对象。
        const controller = new AbortController();
        // terminalReason 在 analyze 开头声明：早期失败也要能生成一致的 meta。
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
          if (beforeTimer !== '') return fail(beforeTimer, images.length);

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
              maxTokens: attemptTokens,
              signal: controller.signal,
            });
          } catch (error) {
            const reason = reasonNow();
            return fail(
              reason || 'stream-error',
              images.length,
              reason ? '' : thrownErrorCode(error),
            );
          }
          // 只要 provider 返回了 stream 对象，就记录“流已打开”；即使迭代器随后不可用。
          streamOpened = stream !== null && stream !== undefined;

          const afterStream = reasonNow();
          if (afterStream !== '') return fail(afterStream, images.length);

          // 7. 收集文本。等待“下一片”必须同时受期限与取消控制：provider 不响应 abort 时，
          //    直接 await iterator.next() 会永久挂起并占住在途锁，所以这里与取消令牌竞速。
          try {
            const factory = streamIteratorFactory(stream);
            if (factory === null) return fail('stream-error', images.length);
            iterator = factory.call(stream);
            if (!isObject(iterator) || typeof iterator.next !== 'function') {
              return fail('stream-error', images.length);
            }
          } catch (error) {
            const reason = reasonNow();
            return fail(
              reason || 'stream-error',
              images.length,
              reason ? '' : thrownErrorCode(error),
            );
          }

          try {
            for (;;) {
              const beforeNext = reasonNow();
              if (beforeNext !== '') return fail(beforeNext, images.length);

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
                return fail(
                  reason || 'stream-error',
                  images.length,
                  reason ? '' : thrownErrorCode(error),
                );
              }

              // 取消先到：丢弃已经在途的迟到分片，立即返回，不再拼接任何文本。
              if (next === cancelToken) return fail(reasonNow() || 'timeout', images.length);
              const afterNext = reasonNow();
              if (afterNext !== '') return fail(afterNext, images.length);
              if (!isObject(next)) return fail('stream-error', images.length);
              if (next.done === true) break;

              const chunk = next.value;
              chunkCount += 1;
              const type = typeof chunk?.type === 'string' ? chunk.type.toLowerCase() : '';
              if (type === 'text-delta') {
                if (typeof chunk.text === 'string') text += chunk.text;
                continue;
              }
              // 私密推理只计数，绝不拼进正文；不同 provider 可能用 text 或 delta 承载分片。
              if (/^(reasoning|thinking|thought|analysis)/u.test(type)) {
                const reasoningText = typeof chunk?.text === 'string'
                  ? chunk.text
                  : (typeof chunk?.delta === 'string' ? chunk.delta : '');
                reasoningChars += reasoningText.length;
                continue;
              }
              if (type === 'finish') {
                const reason = chunk?.reason;
                const kind = typeof reason?.kind === 'string'
                  ? reason.kind.toLowerCase()
                  : (typeof reason === 'string' ? reason.toLowerCase() : '');
                // 只记录真实 finish 分片里的机器码；没有 finish 就留空，不凭文本为空猜生成结果。
                finishKind = metaToken(kind);
                finishReason = metaToken(typeof reason === 'string' ? reason : reason?.kind) || finishKind;
                if (kind === 'error') {
                  return fail('stream-error', images.length, reason?.failure?.code ?? chunk?.failure?.code);
                }
                if (kind === 'aborted') {
                  finishAborted = true;
                  return fail('aborted', images.length);
                }
                break;
              }
              // 其他分片（usage 等）与图片分析结果无关，忽略。
            }
          } catch (error) {
            const reason = reasonNow();
            return fail(
              reason || 'stream-error',
              images.length,
              reason ? '' : thrownErrorCode(error),
            );
          }

          const finalReason = reasonNow();
          if (finalReason !== '') return fail(finalReason, images.length);

          // 空文本绝不能当作“模型看懂了”：调用方会把它渲染成空的理解结果。
          // errorCode:'empty' 只是“没有可用正文”，不等于“模型空生成”；meta.finishKind 保留真实结束原因。
          if (text.trim().length === 0) return fail('stream-error', images.length, 'empty');
          const result = { ok: true, text, reason: 'ok', images: images.length };
          attachMeta(result, buildMeta(images.length, ''));
          return result;
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
      };

      let outcome = await runAttempt(tokenLimit);
      // 首次请求被 token 上限截断：同 provider/model 提高预算重试一次。绝不换模型、绝不无限重试。
      if (canRetry && attempts < 2 && isTruncationFinish(outcome?.meta?.finishKind)) {
        if (signal?.aborted === true) {
          // 取消发生在两次尝试之间：不能把上一次的 max-tokens 留在 aborted 结果里，
          // 否则运行时会把它误归因为截断。
          finishKind = '';
          finishReason = '';
          return fail('aborted', images.length);
        }
        outcome = await runAttempt(retryTokenLimit);
      }
      // 最终仍是 token 上限截断：明确归因 truncated/max-tokens，不把半截正文交给 JSON 解析。
      if (isTruncationFinish(outcome?.meta?.finishKind)) {
        return fail('truncated', images.length, 'max-tokens');
      }
      return outcome;
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
