# ASR 切点丢字测试集（15 s / 30 s）

这套 fixture 回答一个问题：**`src/host/hearing/hearing.js` 的离线终稿把长语音按 `decodeCapSec=15` 切段识别再拼接时，正好跨过 15 s / 30 s 切点的词会不会丢字或变字？**

- 生成脚本：`node tools/asr-cutpoint-fixture.mjs`
- 校验脚本：`node tools/asr-cutpoint-check.mjs`
- 静态自检（不需要模型）：`node tools/asr-cutpoint-check.mjs --self-check`
- 无模型静态回归测试：`node --test test/asr-cutpoint.mjs`

## 文件

| 文件 | 说明 |
|---|---|
| `manifest.json` | 版本名、静音偏移、期望整段文本、定位词及归一时间范围、每段 sha256、检查项 |
| `offset-0.0.wav` | 基准：两个定位词压在 15.000 s / 30.000 s 切点上（真的跨切点） |
| `offset-0.3.wav` | 整体前置 300 ms 静音：定位词落到切点之后 |
| `offset-0.6.wav` | 整体前置 600 ms 静音：定位词落到切点之后 |
| `offset-0.9.wav` | 整体前置 900 ms 静音：定位词落到切点之后 |
| `trim-0.45.wav` | 对照组：削掉 450 ms 前导静音（整体前移）：定位词落到切点之前 |

**wav 不入库**：`test/fixtures/asr-cutpoint/*.wav` 已在 `.gitignore` 里，克隆仓库后先用下方命令重建（需要 Edge TTS 网络和 ffmpeg）；只有 `manifest.json` 入库，它记录期望文本、定位词时间范围、时长与 sha256，重建后 sha256 会变（TTS 不是逐位确定的），这是预期行为。每个 wav 约 1.25–1.30 MB（16 kHz / 单声道 / 16-bit），总计约 6.4 MB。

## 音频内容

固定文本，包含：

- 数字与否定词：「第三十七号房间不是四十二号，请确认一万二千五百这个数。」
- 连读与重复词：「非常非常重要，非常非常重要，这一点非常关键。」
- 两个定位词：`橙子`（压 15 s 切点）、`雷达`（压 30 s 切点）；
- 中间与结尾用中性连接句填满时间线，避免变成「很长静音 + 两个词」。

时间线：40.5 s 左右，前导 1.2 s 静音（留给 `trim` 对照前移），语音片段之间约 120 ms 间隔。定位词按**实测有声起点**摆位，而不是按 TTS 文件的起点（TTS 自带 160–220 ms 前导静音）。

## 生成

```powershell
node tools/asr-cutpoint-fixture.mjs
```

- 需要 Edge TTS 网络（宿主 `src/host/speech/tts.js`，声音 `zh-CN-XiaoxiaoNeural`）和 ffmpeg。
- TTS 片段按文本缓存在 `.tmp-asr-cutpoint/`（已被 `.gitignore` 的 `.tmp-*` 覆盖），重复运行不会重新合成。
- 脚本会打印每个定位词的**实测有声范围**、切点前后余量、切点 ±30 ms 的能量，并在基准版本没有真正跨切点 / 切点落在停顿里时**直接失败退出**。
- 想换脚本或换声音后重新生成时，`manifest.json` 会一起更新；TTS 不是逐位确定的，sha256 会变，这是预期行为。

当前生成结果（同一台机器，基准版本）：

```
marker1「橙子」cut 15.000s 实测 14.760–15.260s（跨切点，前 240 ms / 后 260 ms），切点±30 ms 能量 -10.3 / -10.9 dBFS
marker2「雷达」cut 30.000s 实测 29.860–30.360s（跨切点，前 140 ms / 后 360 ms），切点±30 ms 能量 -10.3 / -13.4 dBFS
```

## 怎么确认「真的跨切点」

1. 每段 TTS 先转成 16 kHz 单声道 PCM WAV，用 20 ms 帧 / 10 ms 跳的 RMS 找出这段音频自己的有声区间（阈值 = 该段能量 p95 的 10%，下限 -54 dBFS），把有声起点作为摆位基准。
2. 拼好每个版本后，再对**成品波形**做一次同样的能量分析：在定位词附近 ±60 ms 的窗口里找有声区间，得到实测范围，判断 `起点 < 切点 < 终点` 且两侧各 ≥ 40 ms。
3. 额外检查切点 `-30 ms` / `+30 ms` 两处的 20 ms 窗口能量，确认切点落在音节内部而不是词间停顿里（两个值都要高于 -35 dBFS）。所以「切点恰好落在停顿里」会让生成脚本失败，而不是产生一个假的「跨切点」。

## 校验

```powershell
node tools/asr-cutpoint-check.mjs            # 表格 + 退出码
node tools/asr-cutpoint-check.mjs --verbose  # 再打印每个版本的整段/修复前/修复后文本与拼接点
node tools/asr-cutpoint-check.mjs --overlap 1200   # 换共享音频长度（默认 800 ms）
node tools/asr-cutpoint-check.mjs --json     # 末尾输出机器可读结果
```

对每个版本跑三次识别：

1. **整段基线**：整份 wav 一次 SenseVoice 离线识别，不分段；
2. **修复后**：`startHearing()` + `decodeCapSec=15` + `asrSegmentOverlapMs=800`，通过可注入 seam（假 ffmpeg 子进程 + 假流式识别器）驱动，真正执行 `planSegmentedDecodes()` / `joinSegmentedTexts()`：每段两侧各多 800 ms 共享音频，每个拼接点再单独识别一次共享音频当裁判，用裁判文本对齐裁掉重复的一段，终稿用真实 SenseVoice；
3. **修复前**：同一套生产代码把 `asrSegmentOverlapMs` 设成 0，也就是旧的硬切，用来打印「修改前后对照」。

脚本会断言：生产路径的离线识别次数与计划一致、每次喂的采样区间与 `planSegmentedDecodes()` 完全一致、final 等于 `joinSegmentedTexts(各段文本)`，并记录每段与每个裁判的真实时间范围。

表格列：版本 | 偏移 | 定位词 | 数字 | 否定词 | 重复词 | 修复前 | fallback | 重复检测 | 整段耗时 | 分段耗时 | 分段次数 | 结论。

判定比「出现过」严格：

- 定位词按**准确次数**比对（`橙子` 必须恰好 1 次，`雷达` 必须恰好 1 次），多一次就是拼接重复 → `FAIL`；
- `非常` 必须**恰好** `checks.veryCount` 次（=5），重复段必须完整；数字序列、否定词、尾句同样按准确次数；
- **重复检测**：归一化文本里出现期望文本没有的连续重复块（≥2 字，例如 `橙子橙子`）→ `FAIL`；
- `fallback` 列是拼接点回退次数：裁判无法确认时保留两段原文（保字、可能重复）。这种版本不判失败但标成 `PASS(回退)`，不算真正修复。

判定规则与退出码：

- 定位词丢失、次数不符或出现重复 → `FAIL`，打印失败的检查项、每个拼接点的裁判文本与处理方式；退出码 **1**。
- 两者都缺失 → `SKIP(基线也缺)`，提示「非切点问题」，不算失败。
- 模型缺失 → 打印缺哪个文件、怎么补，跑静态自检后**跳过**，退出码 **0**（`--require-model` 时退出 2），不误报失败。
- fixture 自身坏掉（文件/校验和/时长/切点范围不一致）→ 退出码 **3**。

已知限制：

- 测试集是 **TTS 清晰发音**，只覆盖「清晰、偏慢、无自然连读/停顿」的情况，不能替代真人验证。
- 语音片段之间留了约 120 ms 间隔，定位词两侧不是完全连续的语流。
- 重叠只能保证「切点不再劈开词」；拼接去重靠重叠区那 1.6 s 的裁判解码。裁判音频很短，SenseVoice 会出 `橙eng子`、`ら` 这类劣化结果：脚本对此有明确回退（保留两段原文 + `joinFallback: true`），所以偶尔会看到 `PASS(回退)` 而不是 `PASS`。
- `startHearing` 的 seam 强制长语音作为一个 40 s utterance 进入终稿，以便同时覆盖 15 s 和 30 s 切点。实时链路上流式端点（`rule3MinUtteranceLength=20`）通常会更早分段，所以 30 s 切点在生产里更多是防御性场景。

## 接真人录音（下一步）

脚本可以直接吃任意 16 kHz 单声道 wav：

```powershell
node tools/asr-cutpoint-check.mjs --wav .\my-talk.wav --expected "整段期望文本" --marker 橙子 --cut 15000 --marker 雷达 --cut 30000
```

`--expected` 用来生成数字/重复词/定位词检查；不带 `--expected` 时只输出整段与分段文本、耗时（表格结论为「仅文本」）。真人录音建议：自然语速、连读、词内停顿都保留，并让目标词真的压在同一段音频的 15 s / 30 s 附近（可以先用 `--wav` 直接跑，再用波形能量确认）。
