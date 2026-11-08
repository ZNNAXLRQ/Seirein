# Seirein

> 基于 DeepSeek Harness（DSH）实现的 Nano 版类 Neuro 多模态助手插件，尝试实现可能没那么智能的基本功能：语音输入、语音输出、人设维持、长期记忆、视觉与听觉、Live2D 形象驱动、字幕展示，以及DSH本身具有的各种功能。

| 名称 | 具体内容 |
| --- | --- |
| 包名 | `@local/dsh-assistant` |
| 插件 id | `dsh-assistant` |
| 版本 | `0.99.0` |
| 宿主 | DeepSeek Harness（DSH）Desktop，Host 运行在 Node 模式子进程 |
| 平台 | Windows（依赖 PowerShell / WPF / DPAPI / DirectShow） |
| 许可证 | MIT |

项目目前还在长期使用测试阶段，欢迎提出反馈，开发和维护看空闲进行

**本文四部分：**

- [1. 项目简介与参考对象](#1-项目简介与参考对象)
- [2. 对用户的简单使用说明](#2-针对用户的简单使用说明)
- [3. 项目设计与实现思路](#3-项目设计与实现思路)
- [4. 对后续开发者的简单补充](#4-对后续开发者的简单补充)

---

## 1. 项目简介与参考对象

### 1.1 Seirein 是什么

Seirein 是 DSH 的一个 **bundle 插件**（不是独立应用）：它随 DSH 启动，把自己注册进宿主进程，向外提供 24 个工具、一套 HTTP 设置接口和一个 Web 设置页。

它将 DSH 变成了一个多模态助手, 完成了「把一个能听见、能看见、有人设、有记忆、有形象、会说话、能做事的桌面助手装进 DSH」这件事，而不只是再造一个语音聊天前端。DSH 负责模型、会话、工具循环与 Agent 生命周期；Seirein 负责把语音、感知、形象与人设接到这条循环上。

必须知道的运行边界：

- **Host 是 Node 模式子进程**，拿不到 Electron API（`BrowserWindow`、`globalShortcut`、`Tray` 都不可用）。因此字幕、透明层、窗口几何走 PowerShell / WPF，热键走 `koffi` 轮询 Win32，形象走 VTube Studio WebSocket，配音走 Edge TTS 或本机 GPT-SoVITS HTTP 服务。
- **插件不 import 任何 Harness 包**，只通过宿主注入的 `ctx` 服务工作：工具注册、会话事件、`agent/pre-step`、`webServer`、客户端 slots、Agent preset 注册表等。
- **Windows 专属实现很多**：麦克风枚举与采集、DPAPI 凭据、Windows 字体枚举、WPF 叠加层、窗口矩形读取。非 Windows 环境至少语音 / 视觉 / 字幕链路不可用。
- **一个进程内的一套状态**：插件卸载或 DSH 重启后语音、采集、字幕、形象进程都会重建；数据保留在 `<root>` 下。

### 1.2 功能模块

`src/host` 根目录只有 `index.js`，实现按功能域分目录；`client.js` 在仓库根（DSH 会缓存客户端入口路径）。

| 模块 | 目录 | 职责 | 对外表现 |
| --- | --- | --- | --- |
| 语音 | `speech/` | TTS（Edge / GPT-SoVITS）、翻译双流、口语版、候音、播放账本、分块与预取 | 「说」：回答、候音、工具播报、打字回合播报 |
| 听觉 | `hearing/` | 麦克风 / 回环采集、ASR worker、VAD、端点、声纹影子、通话模式、环境音、音频保留 | 「听」：实时转写、连续对话缓冲、打断判定 |
| 记忆 | `memory/` | 分域情节记忆（SQLite + FTS5）、固定记忆、自动记录、召回 / 纠正 / 归档 / 容量衰退 | 「记得」：相关记忆、固定约束、历史检索 |
| 视觉 | `vision/` | 截图、故事板、桌面 / OBS 虚拟摄像头、隐私锁、OBS 连接、黑帧检查 | 「看见」：按需截屏、连续观看、场景查看 |
| 形象动作 | `avatar/` | VTS 连接 / 热键 / 表情 / 口型 / 参数、行为运行时、动作预设库、WPF 透明层、Spout 独立进程 | 「动」：说话口型、语义动作、待机生命感 |
| 字幕 | `subtitle/` | WPF 叠加层、区域 / 气泡模式、字体枚举、对比色、分页 | 「显示」：语音字幕与原文对照 |
| 平台 | `platform/` | 全局热键（`koffi`）、硬件探测、模型下载、Windows 窗口矩形 | 系统层适配 |
| 运行时 | `runtime/` | 组件开关、依赖引用计数、工具执行、HTTP、诊断、关闭编排 | 插件骨架与可观测性 |
| 会话 | `session/` | 投递与结果绑定、快路 / 轻量模型通道、请求前上下文、连续台词、待回应组、日切、压缩 | 与 DSH Agent 的接缝 |
| 画像 | `profile/` | 人设与用户画像、画像库分类 / 评分 / 整理、初始问卷 | 长期人设与偏好 |
| 共享 | `shared/` | 纯文本与时间函数 | 跨域复用，不持有状态 |

组件开关（`data/features.json`，不是 `cordis.patch.yml`）共 8 个，默认值如下：

| id | 名称 | 默认 | 作用 |
| --- | --- | --- | --- |
| `hearing` | 听觉 | 开 | 麦克风采集与流式识别 |
| `ambient` | 环境声音 | 开 | 回环端点采集，只作上下文，不触发回复 |
| `voice` | 语音合成 | 开 | 让助手出声；关闭后只输出文字 |
| `vision` | 视觉 | 开 | 截图与故事板 |
| `subtitle` | 字幕显示 | 开 | 屏幕叠加字幕 |
| `avatar` | 形象 | 开 | VTS 表情 / 口型 / 动作 |
| `memory` | 记忆 | 开 | 记忆读写与检索 |
| `fastpath` | 闲聊模式 | **关** | 绕过 agent、直连 LLM 的纯闲聊通道 |

工具面共 **24 个**（`test/smoke.mjs` 会断言数量）：

| 分组 | 工具 |
| --- | --- |
| 语音 / 听觉 | `assistant_say`、`assistant_listen`、`assistant_ambient`、`assistant_call_mode` |
| 视觉 | `assistant_see`、`assistant_watch`、`assistant_vision`、`assistant_obs`、`assistant_obs_status` |
| 形象 | `assistant_live2d`、`assistant_hotkeys` |
| 记忆 / 画像 | `assistant_remember`、`assistant_recall`、`assistant_memory_brief`、`assistant_memory_correct`、`assistant_archive_search`、`assistant_resource_set/get/list/forget`、`assistant_persona_view/append`、`assistant_prompt_preview` |
| 运行时 | `assistant_doctor` |

### 1.3 实现了什么效果

以下描述的功能都能在代码、事件日志或测试里找到对应，是目前认为确定实现的功能。

| 效果 | 实际行为 | 可核对位置 |
| --- | --- | --- |
| 语音对话闭环 | 说完一句 → ASR 终稿 → 投递到当天的 `seirein-YYYY-MM-DD` 会话 → Agent 回答 → 自动生成口语版 → TTS 播放，字幕与口型跟随同一句音频 | `voice.injected`、`voice.reply`、`voice.first-sentence` 事件 |
| 可打断 | 默认只允许**通过校验的成句 final** 停播；单个 partial、咳嗽、回声、重复句不会打断。`voice.bargeInPartial` 是可选项，开启后才接受连续响亮 partial | `hearing.bargein`、`hearing.bargein.skipped` |
| 候音 | 用户消息投递后计时，默认 **3000 ms**（可在 500–15000 ms 调）回答仍未出声，就说一句简短等待语；正文音频就绪时未播放的等待语会被取消 | `voice.ack.*` 事件 |
| 一次只播一个版本 | 短答原样播；长答最多一次轻量模型改写为口语版；改写失败回落**完整正文**，不截断成摘要 | `voice.spoken.version` |
| 压缩上下文 | 当天语音会话挂载只含压缩能力的 `seirein-voice` preset；接近窗口 80% 时置 `near-limit` 并写节流事件 | `voice.compaction.*` |
| 动作预设 | 动作库按状态 / 事件 / 语义 / 已验证通道硬过滤，设置页可禁用、调优先级、恢复默认；不可用项跳过而不是降级成热键 | `motion.presets.*`、`avatar.*` |
| 视觉观看 | 桌面用 ffmpeg ddagrab（gdigrab 兜底）；场景模式读 OBS 虚拟摄像头；`assistant_watch` 把 4–8 个变化帧拼成一张故事板；隐私模式下所有 agent 捕获被拒绝 | `assistant_see` / `assistant_watch` / `vision.*` 事件 |
| 字幕 | 区域模式或气泡模式（跟随统一形象几何）；字幕语言与语音语言独立 | `subtitle.*` 事件 |
| 记忆 | 相关记忆在 `agent/pre-step` 注入；固定记忆每轮注入（加密项只给索引）；普通记忆按容量衰退并归档 | `memory.recall`、`resource.inject.truncated`、`memory.*` |
| 设置页 + 热键 | 插件页 / 设置分区里可切换组件、设备、语种、TTS、字幕、VTS、热键、记忆、人设；默认热键 `Ctrl+Alt+M`（麦克风）、`Ctrl+Alt+V`（视觉）、`Ctrl+Alt+E`（图层编辑）、`Ctrl+Alt+A`（环境音） | `client.js`、`assistant_hotkeys` |

### 1.4 参考对象

以下是在项目设计与实现过程中提供重要思路的仓库，非常感谢这些作者的开源，让我的后续实现成为可能

| 仓库 | 作者 | 参考类别 | 具体内容 | 仓库链接 | B站视频链接 |
| :---: | :---: | :---: | :---: | :---: | :---: |
| ZerolanLiveRobot | 赤川鶴鳴 | 架构设计参考 + 语音链路参考 | 多模态助手架构、模型连接、语音流水线与降低延迟的思路 | https://github.com/AkagawaTsurunaki/ZerolanLiveRobot | https://bilibili.com/video/BV1aRq6BtE2M |
| dsh-see-now | SAOS-3624 | 视觉实现参考 | 持续采集、变化帧筛选、多帧故事板；甚至代码直接使用其采集与管道模块 | https://github.com/SAOS-3624/dsh-see-now | https://www.bilibili.com/video/BV1c3xb6UEWE |
| surfcore | Mieksido | 记忆设计参考 | 记忆清晰度、重要性、强化与衰退的源头思路；后续库机制在此基础上发展 | https://github.com/Mieksido/surfcore | https://www.bilibili.com/video/BV1Rbxg6WER5 |
| airi | moeru-ai | 动作实现参考 | 	眨眼状态机、弹簧运动、视线平滑、口型释放与交接等多种动作的实现 | https://github.com/moeru-ai/airi | —— |

### 1.5 依赖对象

| 仓库 | 作者 | 实际用途 | 仓库链接 |
| :---: | :---: | :---: | :---: |
| deepseek-harness | deepseek-ai | 插件宿主、agent功能、会话、工具、事件、权限与压缩能力 | https://github.com/deepseek-ai/deepseek-harness|
| VTubeStudio | DenchiSoft | Live2D 参数注入、认证、模型事件、热键和表情 | https://github.com/DenchiSoft/VTubeStudio |
| electron-texture-bridge | naporin0624 | 	@napolab/texture-bridge，Spout 共享纹理接收 | https://github.com/naporin0624/electron-texture-bridge |
| electron | electron | 可选独立透明显示窗口与 GPU 纹理呈现 | https://github.com/electron/electron |
| obs-studio | obsproject | 可选场景选择、虚拟摄像头与场景视觉；通过 WebSocket 对接 | https://github.com/obsproject/obs-studio |
| FFmpeg | FFmpeg | 音视频采集、截图、转码和播放 | https://github.com/FFmpeg/FFmpeg|
| GPT-SoVITS | RVC-Boss | 可选本地语音合成与音色克隆 | https://github.com/RVC-Boss/GPT-SoVITS |
| MsEdgeTTS | Migushthe2nd | msedge-tts，Edge 语音合成接入 | https://github.com/Migushthe2nd/MsEdgeTTS |
| sherpa-onnx | k2-fsa | sherpa-onnx-node，流式／离线识别、VAD 和声纹推理 | https://github.com/k2-fsa/sherpa-onnx |
| koffi | Koromix | Windows 原生接口调用，如热键与窗口相关能力 | https://github.com/Koromix/koffi |
| ws | websockets | WebSocket 通信 | https://github.com/websockets/ws |
| SenseVoice | QwenAudio | 离线终稿识别、语言与音频事件标签 | https://github.com/QwenAudio/SenseVoice |
| silero-vad  | snakers4 | 语音活动检测 | https://github.com/snakers4/silero-vad |
| 3D-Speaker | modelscope | 声纹特征提取；当前使用 sherpa 发布的 ONNX 模型 | https://github.com/modelscope/3D-Speaker |

其他依赖：Node.js／SQLite、PowerShell／WPF（数据存储、宿主运行与 Windows 窗口／字幕／播放能力）、Zipformer，当前从 sherpa-onnx 模型发布取得（流式语音识别）

---

## 2. 针对用户的简单使用说明

### 2.1 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11 x64 | PowerShell、WPF、DPAPI、DirectShow 采集均按 Windows 实现 |
| 宿主 | DSH Desktop | 插件是 DSH bundle；Host 以 Node 模式子进程运行 |
| Node（仅开发） | `>=22.5` | `package.json` 的 `engines`；记忆与声纹使用内置 `node:sqlite` |
| 包管理（仅开发） | pnpm | 仓库有 `pnpm-lock.yaml` |
| DSH 版本 | 未在 `package.json` 里锁版本 | 开发记录使用 DSH `0.2.1-rc.5`、Electron `44.7.0` / Node `24.21.0` |

### 2.2 安装插件

#### 面向普通用户：不需要克隆仓库

DSH 的插件安装框（侧栏 **插件** → **添加插件**）接受四种 spec，前三种都不需要用户手动克隆：

| 方式 | 用户操作 | 适用 | 备注 |
| --- | --- | --- | --- |
| **已发布包名** | 输入 `包名@版本` → 安装 → 立即启用 | 已发布到 npm / 插件市场 | 需要维护者先发布；见 2.2.1 |
| **压缩包 `.tgz`** | 下载 Release 里的 `*.tgz` → 安装框填该文件绝对路径 | 尚未发布、但想“下载即装” | 不需要克隆、不需要手动 `pnpm install` |
| **Git 地址（推荐）** | 输入仓库 URL（`https://…/Seirein.git`） | 仓库公开可访问 | DSH 会自行拉取；需要 git 可用与网络；私有仓库常因禁用凭据提示而失败 |
| **本地目录** | 填仓库绝对路径 | 开发者 / 本机已克隆 | 需要仓库在磁盘上，见下方“开发者安装” |

> 当前仓库已公开发布在 GitHub，普通用户可直接用 **Git 地址** 安装；尚未发布到 npm，所以“包名”方式要等发布。
> `package.json` 里的 `"private": true` 只是 npm 发布保护，不影响 Git 安装，发布前去掉即可；
> 维护者打包与发布步骤见下方 2.2.1。

##### 2.2.1 维护者发布（普通用户可安装的前提）

1. 打包：`pnpm pack` 生成 `dsh-assistant-0.99.0.tgz`（`package.json.files` 已包含 `client.js`、`src/host/**`、`cordis.patch.yml`、`locale/*.json`、图标）。
2. 验证：在一个干净的 DSH profile 里用 tarball 安装一次，确认组合包出现、可启用、状态正常。
3. 发布到 npm：改 `name` 为可发布 scope、去掉 `"private": true`、补 `repository`，再 `npm publish`；或把 tarball 传到 GitHub Release 页面（不需要改 `private`）。
4. 之后普通用户即可用「包名」或「压缩包」安装，无需接触仓库与 pnpm。

#### 面向开发者：本地仓库安装

1. 插件页 **添加插件** → 填仓库 **本地绝对路径**（例如 `D:\Programs\Others\Seirein`）→ 安装 → **立即启用**。
   首次以本地目录安装时，DSH 会把它保存为 `link:<仓库目录>` 依赖。
2. 开发中的更新：Host 代码改动 → `remove_bundle` → `install_bundle`（target 与安装 spec 相同）；
   只改 `client.js` → 刷新页面；首次安装或组合包/服务/preset 变化后需要重启。
3. CLI 形态的 DSH 用同一段 spec：`dsh plugin add D:\Programs\Others\Seirein`。

##### 非官方调试方式：手动 `link:`

profile 的 `package.json` 里以 `link:` 指向仓库，并把包加入 bundle 列表（只列相关行，其余 bundle 省略）：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-assistant"
      ]
    }
  },
  "dependencies": {
    "@local/dsh-assistant": "link:<仓库目录>"
  }
}
```

link 方式 **不会**安装插件自己的依赖；第一次装好后要在仓库目录手动装一次：

```powershell
pnpm install
```

改 Host 代码用 `remove_bundle` → `install_bundle`；只改 `client.js` 时刷新页面。

#### 更新已安装的插件

- 桌面端：插件页打开 **Seirein** → 重新安装/更新（或先卸载再安装）。
- CLI：对同一 spec 再执行一次 `dsh plugin add`。
- 开发中：Host 代码改动 → `remove_bundle` → `install_bundle`；只改 `client.js` → 刷新页面。
- 需要重启：首次安装、Host 组合包变化、插件注册的服务/preset/压缩能力变更；安装结果会明确提示。

#### 安装后确认

- 打开 DSH 侧栏 → **插件**，确认 **Seirein** 组合包已出现且启用。
- 首次使用先选「存放位置」；数据根默认是 `%LOCALAPPDATA%\Seirein`，旧目录 `%LOCALAPPDATA%\dsh-assistant` 会做一次可恢复的复制迁移。
- `GET /assistant/status` 的 `version` 应为 `0.99.0`；工具面是 24 个（`node test/smoke.mjs` 会断言）。
- 插件会写 `<root>/data/status.json`，可用来快速判断加载是否成功。

#### `cordis.patch.yml` 配置项

仓库自带配置如下（键名与默认值均来自文件）：

| 键 | 默认 | 作用 / 备注 |
| --- | --- | --- |
| `root` | `null` | 数据根；`null` 时用 `%LOCALAPPDATA%\Seirein`，显式路径优先 |
| `enabled` | `true` | 当前入口未读取，保留为声明字段 |
| `defaultDomain` | `chat` | 记忆默认域 |
| `obsPort` | `4455` | OBS WebSocket 端口 |
| `obsPassword` | `null` | OBS WebSocket 密码；没开认证就留空 |
| `privacyScene` | `隐私` | 兼容 / 展示字段。当前隐私模式是**采集锁**，不会切 OBS 场景 |
| `ttsPlayback` | `true` | 自动播报开关 |
| `asrMergeWindowMs` | `600` | 连续语音合并窗口（代码内兜底默认是 1200，文件里的值优先） |
| `memoryCapacity` | `5000` | 记忆活跃表容量；30/60/90% 触发容量衰退 |
| `autoMemory.enabled` | `true` | 自动记忆总开关 |
| `autoMemory.minChars` / `maxChars` | `1` / `400` | 自动记录的文本长度范围 |
| `autoMemory.includeReply` | `true` | 是否把助手回复也纳入自动记忆 |
| `subtitle.enabled` | `false` | 当前入口未读取这个块；字幕默认值在代码与设置页，见下方说明 |
| `subtitle.font` / `sizeMax` / `colorMode` | `Microsoft YaHei UI` / `32` / `auto` | 同上，以设置页实际值为准 |
| `hotkeys.mic` / `hotkeys.vision` | `Ctrl+Alt+M` / `Ctrl+Alt+V` | 全局热键；`layerEdit`、`ambient` 可另配 |

> **组件开关不在 `cordis.patch.yml`。** `hearing` / `ambient` / `voice` / `vision` / `subtitle` / `avatar` / `memory` / `fastpath` 存在 `<root>/data/features.json`，由设置页的「组件开关」读写。手工改 `settings.json` 不会关组件，也不会覆盖已有的 `features.json`。

代码还读取一批**未写进默认文件**的可选键，按需再加：

| 键 | 作用 |
| --- | --- |
| `ffmpegPath` | ffmpeg 可执行文件路径；也接受环境变量 `DSH_FFMPEG_PATH` / `FFMPEG_PATH` |
| `asrDevice` | 麦克风设备名 |
| `asrMinRmsDb` | 麦克风噪声门限（dB，越小声越敏感） |
| `asrModelDir` / `asrFinalModelDir` | 流式 / 精识别模型目录，默认在 `<root>/models/…` |
| `vtsPort` | VTS WebSocket 端口，默认 `8001` |
| `obsPath` | OBS 可执行文件路径；不填会扫描常见安装位置 |
| `virtualCamera` | OBS 虚拟摄像头设备名，默认 `OBS Virtual Camera` |
| `ttsVoice` | Edge TTS 声音；不填按语种选默认声音 |
| `sessionRolloverHour` | 日切小时，默认 `4`（凌晨 4 点） |
| `voice.speechMaxChars` | 语音预算，默认 1200；`0` 表示不截 |
| `voice.prefetchDepth` | 句间预取深度，`1–3`，默认 `2` |
| `voice.ackDelayMs` | 候音等待，`500–15000`，默认 `3000` |
| `voice.speakerShadow` | 声纹影子开关，默认关；开启后触发模型下载 |
| `voice.audioRetention`（仅 `settings.json`） | 诊断音频保留开关，默认关；这一项没有插件 config 兜底 |
| `diagnostics` / `diagnosticsEnabled` | 受控诊断通道开关，默认关 |
| 视觉采集：`visionWidth` / `visionHeight` / `visionFps` / `visionMaxAttachmentBytes` | 截图尺寸、帧率与附件上限 |

### 2.3 必须设置的内容

建议全部走设置页，不要手写 YAML（这是项目当前的产品约定）。

| 项 | 在哪里 | 动作 / 键 | 说明 |
| --- | --- | --- | --- |
| 存放位置 | 设置页「首次使用：请先选择存放位置」 | `root` / `instance.json` | 决定 `<root>`；换位置不会自动搬旧数据，旧目录会被一次性复制迁移 |
| 麦克风设备 | 听觉 → 麦克风设备 | `hearing.device`（存 `asrDevice`） | 回环端点会被拒绝，避免把自己的声音再喂回助手 |
| 麦克风阈值 | 听觉 → 阈值 | `hearing.threshold`，body `{ db }` | 允许 `-90` 到 `-10`；保存后重启采集，返回值就是重启的真实结果 |
| 语音 / 字幕语言 | 语种 | `langs.set`，body `{ speech, subtitle }` | 可选 `zh` / `ja` / `en` / `ko` / `yue`；两者可不同，字幕与语音走两条流 |
| 人设与用户画像 | 人设与画像 | `persona.set` / `profile.save`，或工具 `assistant_persona_append` | 人设存 `<root>/memory/persona.md`，画像存 `user.md`；画像库另存 `memory.db` 的 `profile_*` 表 |
| VTS 连接 | 形象 → 测试连接 | `live2d.connect`；`vtsPort` | 需要 VTS 打开 API；token 落到 `<root>/vts-token.json`。透明层还要求 VTS 开启「透明推流」 |
| OBS 场景 / 虚拟摄像头 | 视觉与隐私 | `vision.scenes`、`vision.mode`；`obsPort` / `obsPassword` | 场景模式按需连接 OBS 并启动虚拟摄像头；插件启动的摄像头在空闲 60 s 后停止，用户自己启动的不会被停 |
| ffmpeg 路径 | 设置页选择文件或配置 | `ffmpegPath` / `DSH_FFMPEG_PATH` / `<root>/bin/ffmpeg.exe` | ffplay 在 ffmpeg 同目录时优先用它播放；没有 ffplay 会退回 WPF 播放 |
| TTS 引擎 | 语音合成 | `tts.config` | 默认 Edge TTS，无需本地安装；要克隆音色再开 GPT-SoVITS |
| GPT-SoVITS 参考音频 | 语音合成 | `tts.config` 的 `refAudioPath` / `promptText` | 参考音频需 **3–10 秒**；官方 API 低于 3 秒或高于 10 秒会拒绝 |
| GPT-SoVITS 模型（可选） | 语音合成 → 模型 | `tts.config.models` + `gptSovits.applyModels` | 只保存路径不会加载；「应用模型」是唯一显式加载入口 |
| ASR 模型 | 模型目录 | `asrModelDir` / `asrFinalModelDir` | 默认找 `<root>/models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23` 与 `<root>/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`；缺失时 `hearing.start` 直接失败 |
| 声纹（可选） | 听觉 → 声纹影子 | `voice.speakerShadow` | 默认关；开启后按需下载 CAM++ 模型，只给麦克风通道打分，**不参与投递** |
| 环境声音（可选） | 环境声音 | `ambient.start` / `ambient.autoListen` | 需要回环端点（Stereo Mix / VB-CABLE / VoiceMeeter 等）；不触发回复 |
| 字幕（可选） | 字幕 | `subtitle.config` / `subtitle.select` | 默认关闭；区域或气泡模式，字体与字号上限可调 |
| 热键 | 全局快捷键 | `hotkey.set` / `hotkey.reset` | 默认四项见 §1.3；`koffi` 轮询 `GetAsyncKeyState` |

### 2.4 可选插件与官方渠道

链接只给官方主页；无法确认的标 `TODO(确认链接)`。

| 软件 / 项目 | 用途 | 是否必需 | 官方渠道 |
| --- | --- | --- | --- |
| VTube Studio | Live2D 形象、热键 / 表情 / 口型 | 可选（要形象才装） | <https://denchisoft.com/> ；Steam：<https://store.steampowered.com/app/1325860/VTube_Studio/> |
| OBS Studio 30+ | 场景模式、虚拟摄像头 | 可选（要场景视觉才装） | <https://obsproject.com/> |
| GPT-SoVITS | 本地 TTS / 音色克隆 | 可选（默认 Edge TTS） | <https://github.com/RVC-Boss/GPT-SoVITS> |
| FFmpeg（含 ffplay） | 采集、转码、截图、故事板、播放 | **必需**（语音采集 / 视觉依赖；无 ffplay 时播放可退回 WPF） | <https://ffmpeg.org/> ；下载页 <https://ffmpeg.org/download.html>（Windows 构建来源 `TODO(确认推荐构建)`) |
| VB-Audio Virtual Cable | 没有 Stereo Mix 时提供回环端点，供环境声音使用 | 可选 | <https://vb-audio.com/Cable/> |
| sherpa-onnx | ASR / VAD / 声纹推理运行时与模型发布 | 必需（随包依赖 `sherpa-onnx-node`） | <https://github.com/k2-fsa/sherpa-onnx> ；模型发布 <https://github.com/k2-fsa/sherpa-onnx/releases> |
| DSH（DeepSeek Harness） | 宿主 | 必需 | `TODO(确认链接)` |

安装顺序建议：OBS / VTS（按需）→ FFmpeg 与 ASR 模型就位 → 安装插件 → 设置页选存放位置 → 试麦克风 → 再开 TTS / 字幕 / 形象。

### 2.5 使用注意事项

1. **隐私锁只管视觉。** `privacy` 是插件侧采集锁：两种视觉来源都停、在途截图取消、所有 agent 截图 / 故事板 / 切场景请求被拒绝（`/assistant/shot` 返回 403）。它**不切换 OBS 场景，也不关麦克风**。进入后只有用户能用 `Ctrl+Alt+V` 或设置页退出；agent 不能自行退出。
2. **回声与设备串音。** 麦克风下拉会拒绝回环端点；环境声音则必须用回环端点。开着音箱时，助手自己的声音可能被麦克风收回去，`voice.bargeInPartial` 默认关闭就是为了避免呼吸 / 回声误打断。建议戴耳机。
3. **TTS 是单槽队列。** 所有播报（自动回答、`assistant_say`、候音、打字回合）共享一个播放所有权和一个合成队列；同一时刻不会双播，后到的请求要排队。GPT-SoVITS 首次启用/换模型有冷启动，别把它当成故障。
4. **上下文有上限。** 语音会话挂的是 `seirein-voice` 压缩 preset；压缩不可用时是**降级**状态而不是「已压缩」。接近窗口 80% 会写 `voice.compaction.near-limit`，但没有「最终答复阶段」的宿主协议保证（见 P-89），不要宣称 token 级首句流式。
5. **动作预设依赖已验证通道。** 预设只声明符号操作，执行前要检查当前模型是否真的映射了对应参数 / 热键 / 表情。没有验证输入的身体、呼吸、注视目标条目会被跳过；不会为了「看起来动了」降级成热键。
6. **重载会中断语音。** `remove_bundle` / 重装 / 插件卸载会拆掉采集、播放、字幕、形象进程；正在说的话不会跨重载续播。已存在的语音会话若压缩 preset 未装配，需要重启 DSH，或在没有 live agent 时用 `voice.session.recover`。
7. **GUI 端口每次重启会变。** 调试接口从 DSH 的 runtime context 取当前端口，不要写死。
8. **事件日志会被高频状态刷掉。** `data/events.jsonl` 是 10 MB × 5 轮转；Spout 状态通道曾占约 96% 的行（已知问题 P-128，节流已提交、仍待审查）。排查时先确认时间窗是否已被刷走，不要把「日志里没有」当成「事件没发生」。
9. **ffmpeg 与 ASR 模型目前要自己准备。** 代码只做路径解析（`ffmpegPath` / 环境变量 / `<root>/bin/ffmpeg.exe`），没有看到自动下载 ffmpeg 或 ASR 模型的实现；VAD 与声纹模型才会按需下载。自动下载 ffmpeg / ASR 是否由安装器负责，`TODO(确认)`。
10. **不要在 PowerShell 里用 `Set-Content` 改源码**：会写 BOM 并破坏中文。用编辑器或 Node 写。
11. **客户端入口必须在仓库根 `client.js`。** DSH 会缓存入口路径；挪到 `src/client/` 会一直加载旧 bundle。
12. **`docs/` 不进 git。** `PLAN.md`、`WORKLOG.md`、`DESIGN.md` 与报告只在本地；提交只包含代码、测试与本文。

---

## 3. 项目设计与实现思路

### 3.1 总体框架

```text
DSH Host（Node 模式子进程）
└─ @local/dsh-assistant（src/host/index.js）
   ├─ cordis.patch.yml  → 插入 dsh-assistant 插件行（id / name / config）
   ├─ FeatureStore      → data/features.json（8 个组件开关）
   ├─ 服务层            → hearing / speech / memory / vision / avatar / subtitle / session / profile
   ├─ 工具面            → ctx.tools.register × 24（定义在 index.js，执行在 runtime/tools.js）
   ├─ 事件接缝          → ctx.on('session/event') / ctx.on('agent/pre-step') / ctx.on('agent/created')
   ├─ HTTP              → /assistant/status、/assistant/action、/assistant/shot
   ├─ 客户端            → package.json dsh.client → client.js（settings.plugins.tab + settings.section）
   └─ 外部进程 / 服务    → ffmpeg / ffplay、PowerShell + WPF、VTS WebSocket、OBS WebSocket、GPT-SoVITS HTTP、Edge TTS
```

| 接入面 | 实现方式 | 说明 |
| --- | --- | --- |
| 工具注册 | `ctx.tools.register` | 工具定义与 description / schema 在 `index.js`，execute 在 `runtime/tools.js` |
| 会话事件 | `ctx.on('session/event', …)` | 观察回答、工具、turn、stream，驱动语音与记忆；不修改宿主事件 |
| 请求前上下文 | `ctx.on('agent/pre-step', …)` | 记忆、日切摘要注入；只追加，不改宿主的决定 |
| Agent 生命周期 | `ctx.on('agent/created', …)` | 给语音会话挂压缩 preset；兼容新建、恢复、重载扫描 |
| HTTP | `ctx.webServer.register({ kind: 'exact', … })` | 状态、动作、截图缓存三个端点 |
| 客户端 | `dsh.client` + slots | `client.js` 注册 `settings.plugins.tab` 与 `settings.section`，面板通过 HTTP 读写 |
| 组件开关 | `FeatureStore` | `data/features.json`；启用 / 关闭有生命周期钩子，不是单纯的 UI 状态 |
| 生命周期 | `ctx.effect` | 采集、播放、字幕、WebSocket、子进程、计时器都挂在 effect/disposer 上 |
| 外部服务 | 直接 HTTP / WebSocket / 子进程 | 不依赖 Harness 包；失败时降级或报错，不静默 |

> 设计文档 `docs/DESIGN.md` 里画的「事件总线（L2）」是概念层。当前实现没有独立消息总线：宿主事件用 `ctx.on` 订阅，插件自己的观测写 `data/events.jsonl`（`{id, ts, type, corr_id, payload}`）。

### 3.2 项目结构详细说明

```text
Seirein/
├─ client.js                 Web 设置页（必须在仓库根）
├─ cordis.patch.yml          bundle 插入行与默认配置
├─ package.json              main / exports / files / engines / dsh
├─ locale/                   zh.json / en.json（界面元数据）
├─ src/host/
│  ├─ index.js               唯一入口：装配服务、工具、事件、HTTP、生命周期
│  ├─ avatar/                形象与动作
│  ├─ hearing/               听觉
│  ├─ memory/                记忆与固定记忆
│  ├─ platform/              Windows / 热键 / 模型下载
│  ├─ profile/               人设与画像
│  ├─ runtime/               组件、依赖、HTTP、诊断、关闭
│  ├─ session/               投递、推理、上下文、压缩
│  ├─ shared/                纯函数
│  ├─ speech/                语音输出
│  ├─ subtitle/              字幕
│  └─ vision/                视觉
├─ test/                     node:test 回归（200+ 个 .mjs）
├─ scripts/                  test-batch.mjs / baseline-snapshot.mjs
├─ tools/                    开发探针（不进发布包）
└─ docs/                     本地设计、计划、报告（.gitignore）
```

#### `src/host/avatar/` — 形象与动作

| 文件 | 职责 / 思路 |
| --- | --- |
| `vts.js` | VTube Studio WebSocket 客户端：认证、token、热键、表情、参数、模型移动、重连 |
| `avatarRuntime.js` | 行为运行时门面：连接 epoch、已验证通道、**唯一参数写者**、传输与生命周期 |
| `motion-controller.js` / `style.js` / `dynamics.js` / `mixer.js` / `motion-primitives.js` | 行为状态机、人设风格、帧数学与通道仲裁；低频决策、高频插值 |
| `presets/` | 动作预设库：`recipes.js`（编舞与 `requires`）、`styles.js`（16 种风格标签）、`catalog.js`（编舞 × 节奏变体）、`index.js` 查询入口 |
| `preset-selector.js` | 预设硬过滤 + 家族/变体打分；只输出候选，不直接写参数 |
| `avatarLayer.js` / `transparent.ps1` | WPF 透明置顶层：`PrintWindow` + 洋红键控镜像 VTS 窗口 |
| `spoutLayer.js` / `spout-layer/` | 实验性 Spout 显示进程（独立 Electron / CommonJS 边界）；只有阶段 0 经真机验收 |
| `layer-controls.js` | WPF / Spout 单所有者切换、编辑几何校验 |

关键点：动作数据（`presets/`）是只读源码；用户覆盖写 `<root>/data/motion-presets.json`。预设不携带 VTS 参数名，也不允许第二个参数写者。

#### `src/host/hearing/` — 听觉

| 文件 | 职责 / 思路 |
| --- | --- |
| `hearing.js` | 采集会话编排：设备 → ffmpeg dshow → 16 kHz 单声道 PCM → 流式识别 + 精识别终稿；端点、投递、低证据影子、打断判定都在这里汇合 |
| `asr-worker.js` / `worker-client.js` | ASR worker 生命周期、模型加载、线程/解码上限；主线程不阻塞 |
| `vad.js` | Silero VAD（缺模型时降级能量判定），端点规则与语音比例 |
| `audio-evidence.js` | 声学观测：噪声影子、`wouldDrop` 证据、低证据判定、麦克风复核；**只记录，默认不拦截投递** |
| `devices.js` / `transcript.js` | 设备枚举（回环识别）、ASR 标签拆分、重叠拼接、截断语义 |
| `speakerVoice.js` | CAM++ 声纹模板：登记、匹配、`match/unsure/no-match`；只做影子，不参与路由 |
| `ambient.js` / `capture-autostart.js` | 环境音来源分类、自启动与有限重试、手动切换 |
| `dialogue-capture.js` | 连续台词缓冲：跨设备共用一个 Host 级缓冲，供摘要与注入 |
| `interaction/callMode.js` / `callNames.js` | 通话模式：只有被称呼的句子才进入；称呼的新增 / 删除 / 启停 |
| `audio-retention.js` | 可选诊断音频：只保留可疑语句的 16 kHz PCM，FIFO 限额，隐私时不写 |

#### `src/host/memory/` — 记忆

| 文件 | 职责 / 思路 |
| --- | --- |
| `store.js` | 单个 `memory.db`，domain 是列不是分库；FTS5 trigram 子串检索，短查询降级 LIKE；容量驱动的 30/60/90% 衰退与归档；版本、纠正、链接、归档表 |
| `query.js` | 查询解释（时间范围、角色、意图）、检索词、排序与摘要片段 |
| `pre-step.js` | `agent/pre-step` 的唯一注入通道：按轮记账、子代理排除、预算与事件 |
| `memory-injection.js` | 注入块格式、预算裁剪、交付行、状态文本 |
| `auto-recorder.js` | 消息级自动记忆：用户与助手消息都可在消息边界入库，不占热路径 |
| `resources.js` | 固定记忆 vault：键 / 标签 / 类型，凭据用 Windows DPAPI 加密；每轮注入正文或索引 |
| `memory-normalize.js` / `dedup-candidates.js` | 文本规范化、候选去重 |

记忆分层要分清：`fixed` 是用户显式写入、每轮注入；`persona` 是人设 / 画像、每轮注入；`importance` 只影响自动记忆排序与衰退，不再让记录常驻；`pinned` 机制已删除。

#### `src/host/vision/` — 视觉

| 文件 | 职责 / 思路 |
| --- | --- |
| `vision.js` | 三模式状态机：`watch`（桌面）/ `scene`（OBS）/ `privacy`（采集锁）；agent 可进隐私、不可出 |
| `sight.js` | 截图与故事板：桌面 ddagrab（gdigrab 兜底）、OBS 虚拟摄像头、超限缩放、观测时效（默认 30 s）、可取消 |
| `obs.js` | OBS WebSocket v5：握手、场景列表、场景切换 |
| `black-frame.js` | 虚拟摄像头黑帧 / 未就绪判断：在交付前按像素判断，不拿黑图冒充「看到的画面」 |
| `attention-source.js` | 鼠标位置作为注意目标；没读到就是 `verified:false`，不编造目标 |

#### `src/host/speech/` — 语音输出

| 文件 | 职责 / 思路 |
| --- | --- |
| `tts.js` | Edge TTS（`msedge-tts`）与 GPT-SoVITS HTTP；串行合成队列、取消、超时、参考音频探测、失败回落 Edge、ffplay 流式播放 |
| `translate.js` | 语音 / 字幕双流翻译、逐句完整性校验、缓存、超时；`prepareSpeech` 与 `prepareCaption` 分开 |
| `spokenPipeline.js` / `reply-speaker.js` / `spoken-dedupe.js` | 口语版单元流、逐句说话人、预取深度、轮次所有权、相似度去重 |
| `speech-text.js` / `format.js` | Markdown 一次解析 → 语音 lane / 字幕 lane；句界预算；不把推理、工具参数、隐藏标签读出来 |
| `chunk-capabilities.js` | 逗号 / 首块切分能力探测（P-65 / P-148），缺失时退回整句 |
| `ack-speech.js` / `ack-lane.js` / `ack-warmup.js` | 候音：草稿、预热池、固定兜底；每轮最多一句；正文就绪即让位 |
| `speech-ledger.js` | 语音账本：接纳、顺序、播放归属、取消与完成；等待 / 取消是独立动作 |
| `typed-reply.js` | 打字回合的语音播报：与自动语音共用同一条出口 |
| `lexicon-*.js` | 个人语言库：候选 → 用户确认 → 生效；没确认不写词 |
| `events.js` / `settings-actions.js` | 语音事件观察与设置动作 |

#### `src/host/subtitle/` — 字幕

| 文件 | 职责 / 思路 |
| --- | --- |
| `subtitle.js` | 字幕驱动：与独立 PowerShell/WPF 进程用文件协议通信（`state.json` 原子写、`selection.json` 回传） |
| `overlay.ps1` | 透明置顶、点击穿透的 WPF 叠加层；自动缩字号、分页、拖选区域 |
| `geometry.js` / `subtitle-fonts.js` | 区域校验、统一形象几何、Windows 字体枚举与缓存 |
| `settings-actions.js` | 选择区域、字体 / 字号 / 颜色模式、预览、隐藏 |

气泡模式锚定统一形象几何（WPF / Spout / 编辑中的 VTS 共用），不是旧文档里的「锚 VTS 左上角」。

#### `src/host/platform/` — 平台适配

| 文件 | 职责 / 思路 |
| --- | --- |
| `hotkeys.js` | `koffi` 轮询 `GetAsyncKeyState`，支持组合键、numpad、按住/释放语义；保存前校验与裁剪 |
| `hardware.js` | 探测 CPU / 内存，推导 ASR 线程数与解码上限 |
| `modelDownload.js` | 固定 URL + 字节数 + sha256 的下载器：Silero VAD、CAM++ 声纹；原子替换、镜像/重试、单任务共享 |
| `windows.js` / `window-move.ps1` | 窗口矩形、虚拟屏幕、DPI 感知的移动与置顶 |

#### `src/host/runtime/` — 运行时

| 文件 | 职责 / 思路 |
| --- | --- |
| `features.js` | 组件注册表与开关；状态写 `features.json`，钩子失败保留 `lastHookError` |
| `dependency-registry.js` | 外部依赖引用计数、串行启停、进程所有权；不关闭用户自己启动的程序 |
| `tools.js` | 24 个工具的 execute：参数解析、调用服务、返回结构；定义仍在 `index.js` |
| `http/routes.js` / `status.js` / `actions.js` / `request.js` | 三个端点、状态投影、精确动作分派、JSON body 限流 |
| `settings/system-actions.js` | 选文件、自启动、热键、组件开关、诊断查询 |
| `diagnostics/query.js` | 受控只读诊断：固定探针 + 字段白名单 + 行数/时间/字节上限；不吐原始事件行 |
| `diagnostics/shutdown-resources.js` | 关闭期资源快照（只观测） |
| `shutdown.js` | 关闭预算、逐个 stop、子进程确认 |
| `root.js` | 数据根解析、`instance.json`、旧目录一次性迁移 |
| `event-log.js` | JSONL 事件日志，10 MB × 5 轮转 |

#### `src/host/profile/` — 人设与画像

| 文件 | 职责 / 思路 |
| --- | --- |
| `persona.js` | `persona.md` / `user.md` 读写与预算截断；文件是实现细节，用户通过对话或设置页维护 |
| `profileStore.js` | 画像库表（与 `memory.db` 同连接，但不计入记忆容量）；分类、条目、版本、导入 |
| `profileRank.js` | 评分与预算编译：哪些条目进入提示词、顺序与截断 |
| `profileMaintain.js` + `maintain-config.js` / `maintain-busy.js` / `model-response.js` / `prompt-splitting.js` | 后台整理工作流：空闲、7 天、忙判定、草案/试用/采用 |
| `classification.js` / `compose.js` / `tone.js` / `evidence.js` | 分类、合成、语气修复、证据记录 |
| `persona-quiz.js` | 初始参考人设问卷：生成、试用、编辑、采用 / 丢弃 |
| `profile-actions.js` / `settings-actions.js` | 设置页与工具共享的动作实现 |

#### `src/host/session/` — 会话

| 文件 | 职责 / 思路 |
| --- | --- |
| `delivery/dispatch.js` | 会话事件适配、结果等待、busy 判定、流式帧过滤、`voice.latency` 字段与未观测 `null` |
| `inference/fastpath.js` | 闲聊快路：直连 DSH LLM、上下文包、历史落盘、域分组 |
| `inference/lightweight.js` | 轻量通道：口语版、摘要、语气修复等辅助任务，有截止时间 |
| `conversation/pre-step.js` | 用户请求前的上下文装配（与记忆 C2 协作） |
| `conversation/dialogueContext.js` / `dialogue-summary.js` | 连续台词缓冲与滚动摘要；摘要只读启动，不阻塞请求 |
| `conversation/responseGroup.js` | 待回应组：连续发言、版本、待传达要点、显式取消 |
| `conversation/rollover-digest.js` | 日切摘要：在目标会话首个请求注入一次，不新开回合 |
| `compaction/voice-compaction.js` | `seirein-voice` 压缩 preset 的注册、挂载、近限告警、手动恢复 |
| `events/voice-context.js` | 会话事件观察：turn、deliveryMessageId、已播句子 |
| `settings-actions.js` | 客户端握手、日切、作用域、快路历史等动作 |

#### `src/host/shared/`

只有纯文本与时间函数：`text.js`（句子拆分、注入消息识别、语音预算、口语版规范化）、`time.js`（日切、时区、日期范围）。不持状态、不导入宿主入口。

#### 根目录与配套

| 路径 | 职责 |
| --- | --- |
| `client.js` | 单个 Panel：状态、组件、听觉、语种、语音合成、环境声音、记忆、固定记忆、人设画像、形象、动作预设、字幕、视觉、热键、诊断等卡片；每 1500 ms 轮询一次日切桥 |
| `package.json` | `main` / `exports` / `files` / `engines` / `dsh.bundle` / `dsh.client` |
| `cordis.patch.yml` | 插件行插入与默认配置 |
| `test/` | node:test 回归，按文件名前缀分组 |
| `scripts/test-batch.mjs` | 分批回归执行器（避免整批并行停滞） |
| `scripts/baseline-snapshot.mjs` | 构建 / 模型 / 协议 / TTS 基线快照与对比 |
| `tools/` | 探针与辅助脚本，不进 npm 包 |
| `locale/*.json` | 插件元数据（标题 / 描述） |

### 3.3 工作总流程：一次语音交互

```text
热键 / 设置页开麦
  → capture-autostart 启动采集（ffmpeg dshow，16 kHz 单声道）
  → 流式 ASR（部分结果）+ VAD / 端点
  → 终稿（SenseVoice）+ 噪声 / 低证据影子（只记录）
  → noteBargeInFinal：正在播报时，只有通过校验的成句 final 才能打断
  → 投递：当天 seirein-YYYY-MM-DD 会话（<root>/workspace）
  → agent/pre-step：人设 / 画像 / 固定记忆 / 环境事实 / 相关记忆 / 日切摘要
  → Agent 循环（工具调用、会话结果）
  → 正文完成 → 口语版决策（短答原样 / 长答一次改写 / 失败回落全文）
  → 语音语言翻译 + 字幕语言翻译（两条流，可复用缓存）
  → TTS 合成（Edge / GPT-SoVITS，逗号块 / 预取）→ ffplay 播放
  → 字幕叠加 + 口型 / 动作 + 记忆写入
```

按阶段拆分：

| 阶段 | 入口 | 实现要点 | 观测 |
| --- | --- | --- | --- |
| 采集 | `startListening` / `ambient.start` | 设备名 → ffmpeg dshow；回环端点只允许环境音；采集失败有有限重试 | `hearing.*`、`ambient.source` |
| 端点 / 识别 | `hearing.js` + `asr-worker.js` | 流式 + 精识别双通道；端点用 VAD 比例与尾静音规则；短答白名单 | `hearing.noise.shadow`、`hearing.low-evidence.*` |
| 投递 | `prepareVoiceTurn` / `deliverVoiceRequest` | 先取会话所有权再建流水线；上一个回合未完成时**拒绝**并说「上一条还在处理…」，不排队 | `voice.delivery.busy`、`voice.injected` |
| 上下文 | `agent/pre-step` | 记忆、固定记忆、画像、环境事实、连续台词；只追加，不改宿主决定 | `memory.recall`、`resource.inject.truncated` |
| 生成 | Agent / 快路 | 快路可绕过 agent（默认关）；轻量通道只做辅助任务 | `voice.reply`、`voice.latency` |
| 口语版 | `decideSpokenVersion` | 短答（≤60 字且 ≤2 句）或用户要求全文 → 原样；否则一次轻量改写；失败回落全文；待传达要点单独合并 | `voice.spoken.version` |
| 翻译 | `prepareSpeech` / `prepareCaption` | 语音语种与字幕语种独立；逐句完整性校验；缓存命中不重复请求 | `voice.translate` |
| 合成 / 播放 | `reply-speaker` + `tts.js` | 一句一个说话人；预取 1–3；首块可切；单播放所有权；取消后不启动旧块 | `voice.first-sentence`、`voice.tts.request`、`voice.prefetch` |
| 字幕 / 形象 | `subtitle.js` + `avatarRuntime` | 字幕与音频同一句；口型跟播放边界；动作在句间 / 首句触发 | `subtitle.*`、`avatar.*` |
| 记忆 | `auto-recorder` | 消息边界自动记录；召回反馈只对真正注入的行生效 | `memory.auto`、`memory.recall` |

并行的旁路：

- **文字回合播报**：用户在 GUI 里打字时，回合结束仍可走同一条语音出口；与语音回合共享预算与播放账本。
- **视觉旁路**：`assistant_see` / `assistant_watch` 只在被调用时取图；普通闲聊不会自动附图。P-48 的「请求前视觉准备」尚未接线。
- **动作旁路**：动作运行时在播放 / 句间事件上选预设；它不阻塞文本与音频，只写已验证参数通道。
- **压缩旁路**：压缩在 `agent/pre-step` / 空闲时进行；不打断正在播放的句子；不可用是可见降级。
- **环境音旁路**：环境音只进上下文，不触发回复，也不占用麦克风的投递所有权。

### 3.4 关键设计取舍

| 取舍 | 做法 | 原因 | 代价 |
| --- | --- | --- | --- |
| 统一语音出口 | 自动回答、`assistant_say`、候音、打字播报都走 `speech-ledger` + 一个播放所有权 | 避免双播、抢麦、字幕与口型错位 | 所有播报串行，长队列会等 |
| 候音草稿优先 | 到点先看本轮草稿（文本 + 音频），再看预热池，最后固定兜底；不等待慢草稿 | 等待语不能拖住正文，也不能说一句空泛的话 | 草稿经常来不及，最终常用兜底 |
| 上下文走 runtime-context | 环境事实 / 非语言线索 / 连续台词走 `systemPrompt.context` 的按步快照；人设 / 画像 / 固定记忆走 section | 变化的观测不反复写进系统提示；历史不被污染 | 快照每步重放，模型侧仍要读 |
| 记忆只在 `agent/pre-step` 注入 | 用户原话原样投递，记忆作为额外上下文追加 | 避免「拼在用户消息里」导致原话被改写、重复召回 | 注入时机受宿主 pre-step 预算约束 |
| 压缩 preset 随插件走 | 插件注册 `seirein-voice`（只含 compaction 三件套），挂到当天语音会话 | 新机器不需要手写 profile patch；不打开宿主全局压缩 | preset 冲突 / 未装配时降级；需重启或恢复 |
| 动作单一写者 | `avatarRuntime` 是唯一参数写者；预设只给候选 | 防止两个循环抢同一参数、抖动、旧代次复活 | 预设必须经过能力过滤，可用动作变少 |
| 隐私只锁视觉 | `privacy` 停采集 / 拒截图 / 取消在途；不动麦克风、不切 OBS | 用户要的是「别看我」，不是「别听我」；OBS 场景由用户控制 | 语音仍在工作，用户需自己静音 |
| 未观测写 `null` | 延迟字段、记忆命中、首音声道等没测到就是 `null` | 不把缺失当 0，避免统计被拉低 | 报表要处理空值 |
| 失败不静默 | GPT-SoVITS 失败回落 Edge；压缩失败报 `enabled:false + reason`；黑帧拒绝交付 | 宁可降级也要可见 | 状态更复杂，需要读原因 |

---

## 4. 对后续开发者的简单补充

### 4.1 环境与依赖

| 项 | 值 |
| --- | --- |
| Node | `>=22.5`（`package.json` `engines`；`node:sqlite` 需要） |
| 包管理 | pnpm（仓库有 `pnpm-lock.yaml`） |
| 宿主运行时 | 开发记录：Node `24.21.0` / Electron `44.7.0`（2026-11-07） |
| 运行时依赖 | `@napolab/texture-bridge` `0.17.0`、`dsh-see-now`、`koffi` `3.1.1`、`msedge-tts`、`sherpa-onnx-node`、`ws` |
| 原生模块 | `koffi`（热键）、`sherpa-onnx-node`（ASR / VAD / 声纹）、`@napolab/texture-bridge`（Spout）；`node:sqlite` 为内置 |
| 外部程序 | FFmpeg / ffplay、PowerShell、OBS、VTS、GPT-SoVITS（可选） |

常用命令：

```powershell
# 安装仓库依赖（link 安装不会代装）
pnpm install

# 冒烟：工具数量、记忆、资源
node test/smoke.mjs

# 单个文件
node --test test/voice-lanes.mjs

# 分批全量（默认排除真机 / 重测试）
node scripts/test-batch.mjs

# 只跑前缀 / 组
node scripts/test-batch.mjs --only=voice
node scripts/test-batch.mjs --repeat=2 --only=tts
node scripts/test-batch.mjs --list
node scripts/test-batch.mjs --include-live

# 基线快照
node scripts/baseline-snapshot.mjs
node scripts/baseline-snapshot.mjs --compare <baseline.json>

# 发布文件清单
npm pack --dry-run --json
```

### 4.2 目录与模块约定

- **`src/host/index.js` 只做装配**：创建服务、注册工具 / 事件 / HTTP、跨域接线、生命周期。业务逻辑放功能目录；`test/module-layout.mjs` 会断言 host 根只有一个入口。
- **领域模块不反向 import 入口**：功能模块不得 `import '../index.js'`；依赖通过参数或 getter 注入，避免循环依赖。只有同时被两个以上功能域使用的纯文本 / 时间函数才放 `shared/`。
- **领域模块尽量纯**：解析、计算、状态机不直接启动设备、进程或模型；有外部副作用的服务由宿主创建并通过参数注入，模块导入本身不产生副作用（见 `docs/host-modules.md`）。
- **跨域生命周期放 `runtime/`**：依赖引用计数、关闭顺序、HTTP、诊断。不要为「方便 import」把业务模块塞进 `runtime/`。
- **presets 只读**：`avatar/presets/` 是版本控制的数据与查询模块；用户覆盖写 `data/motion-presets.json`，不写回源码。预设不携带模型参数名，不创建第二套参数写者。
- **`docs/` 不入库**：`PLAN.md`、`WORKLOG.md`、`DESIGN.md`、`reports/**` 都在 `.gitignore`；计划与报告放 `docs/`，不放仓库根。
- **`test/` 必须上传**：测试是提交的一部分；新增行为要有对应 `test/*.mjs`，真机脚本在文件头标 `// @live` 或加入 `scripts/test-batch.mjs` 的 `LIVE_FILES`。
- **发布清单**：`package.json.files` 是 `client.js`、`src/host/**`、`cordis.patch.yml`、`locale/*.json`、`Seirein.ico`、`Seirein.png`；`exports` 暴露入口、`client`、`locale` 与 `icon`。新增运行资源要放进这些路径，不能只留在仓库根。
- **客户端入口固定在根 `client.js`**；`CLIENT_VERSION` 与 `package.json.version` / `PLUGIN_VERSION` 一起升。
- **不要用 PowerShell 写源码**（BOM / 乱码）。

### 4.3 开发流程

#### 加一个工具

1. 在 `src/host/index.js` 的工具定义区加 `name` / `description` / `parameters` / `outputSchema` 与 `render`。
2. 在 `src/host/runtime/tools.js` 加 execute 实现（参数解析、调用服务、返回结构）；工具实现不持有宿主状态。
3. 更新 `test/smoke.mjs` 的工具数量断言（当前 24）与相关 schema 测试。
4. 如果工具有跨域副作用，补一条定向测试（参考 `test/tool-content.mjs`、`test/tool-schema-vision.mjs`）。

#### 加一个模块

1. 按功能域落位（`hearing/`、`speech/`、`memory/` 等）；只有纯文本 / 时间函数进 `shared/`，跨域生命周期进 `runtime/`。
2. 模块只接收显式依赖，不 import `index.js`；导入本身不启动设备 / 进程 / 模型。
3. 如果需要对外暴露，在 `index.js` 里 re-export（保持原入口导出面）；不需要就只做内部导入。
4. 在 `test/` 加同前缀测试；跑 `node --test test/module-layout.mjs` 确认资源与导入路径可解析。

#### 加一个动作预设

1. 在 `avatar/presets/recipes.js` 增加 `recipe`：`operations` 只写符号编舞，`requires` 只写当前运行时验证过的语义通道。
2. `catalog.js` 会按 recipe × 4 种节奏展开变体；稳定 ID 用 `recipe.variant`，不要依赖显示名。
3. 只使用已声明通道（头 / 眼 / 眉 / 身体 / 呼吸）；没有验证输入的部位不要假装可用，也不要把动作降级成热键。
4. 设置页的启用 / 禁用 / 优先级通过 `motion.presets.*` 写入 `data/motion-presets.json`；不要改源码数据。
5. 跑 `test/motion-preset-library.mjs`、`test/preset-execution.mjs`、`test/motion-presets-native-unmapped.mjs`。

#### 加一个设置页项

1. 在对应功能的 `settings-actions.js` 的 `ACTIONS` 里加动作名，并实现 handler；重复动作名会在 `createSettingsRouter` 里直接抛错。
2. 需要新持久化字段时写入 `<root>/data/settings.json`（运行设置）或 `features.json`（组件开关），不要混用。
3. 在 `client.js` 加卡片 / 行，用 `act({ action, ... })` 调 `/assistant/action`；状态从 `/assistant/status` 读。
4. 补动作测试（参考 `test/hearing-ui.mjs`、`test/tts-ui.mjs`、`test/profile-ui.mjs`）。

#### 加一个组件开关

1. 在 `runtime/features.js` 的 `DEFAULT_FEATURES` 注册 `{ id, label, description, default }`。
2. 需要启停资源时提供 `onEnable` / `onDisable` 钩子；状态持久化到 `features.json`。
3. 组件关闭必须真正停止采集 / 播放 / 子进程，不能只改 UI。

#### 测试与基线

- 定向：`node --test test/<file>.mjs`。
- 全量：`node scripts/test-batch.mjs`（按前缀分批、批间 2000 ms、失败不阻断；EBUSY / ENOTEMPTY / EPERM 自动重跑一次，flaky 单独计数）。
- 真机：`--include-live`；默认排除 `spout-layer`、`spout-dispose`、`facefound-live`、`reasoning-off-live` 与 `*-live.mjs`。
- 基线：`node scripts/baseline-snapshot.mjs` 产出 `<root>/cache/baseline-<时间戳>.json` 与 `.md`；`--compare` 在可比较投影变化时退出码为 1。
- 发布前：`npm pack --dry-run --json` 检查 `files` 清单，确认 worker、PowerShell、Spout 资源都在包里。

### 4.4 已知限制与待办方向

以下条目来自 `docs/PLAN.md`（本地文档，不入库）；不要把它们当成已完成。

| 项 | 现状 | 影响 / 方向 |
| --- | --- | --- |
| P-46 逐轮时间线 | `stageMs` / `asrMs` 已改为未观测 `null`，`translateMs` / `translateCached` 已投影；工具开始/结束、模型往返、`ttsQueueMs`、`residualMs` 与逐轮串联**未完成** | 还无法完整回答「时间花在模型、工具还是合成」 |
| P-48 视觉准备复用请求前通道 | 尚未接线；视觉仍靠工具触发 | 「看看这个」类请求多一次工具往返，首字之前拿不到图 |
| P-50 关键等待路径 | 只做了观测底座（`a327a47` 等），**优化开发未开始** | 等待位置靠日志逐轮拼，缺统一时间链 |
| P-59 分层上下文预算 | 未实现；快路仍是整体字符上限 | 人设 / 固定约束 / 记忆 / 近期会话 / 感知没有各自配额 |
| P-89 宿主协议门槛 | 有实时正文增量，但**没有**「已进入最终答复阶段」的协议保证，也没有可等待的正文入口 | 不能宣称 token 级首句流式；A2 用「缓冲到 step 提交」实现 |
| P-65 句内流式 | B 档（逗号切块）已实现、待审查；C 档（句内流式）未做，需先核实 GPT-SoVITS 能否增量输出 | 长句首音仍受整块合成影响 |
| 低证据门禁 | `lowEvidenceVerdict` 已有完整判定，但 `voice.lowEvidenceGate` **默认关**，只写影子 | 静音幻觉仍会投递；开启前需要更多真实设备证据 |
| 声纹身份 | CAM++ 模型、影子打分，仅麦克风通道，阈值未按本机校准；不参与投递 | 不能用于「只认主人」；误匹配风险未量化 |
| 上下文容量 | 压缩 preset 失败会降级；窗口默认 128k（无 token meter 时）；80% 只告警 | 长会话可能贴近上限，需重启或手动恢复 |
| P-128 日志噪声 | Spout 状态通道节流已提交、仍待审查 | 事件日志可能被刷到只剩约 50 分钟 |
| 透明层 | `PrintWindow` + 色键能用；移动 VTS 出屏会破坏透明推流；WGC 需原生帮助程序（P-68，条件触发） | 实验性，不适合作为稳定直播层 |
| OBS 场景截图 | `GetSourceScreenshot` 对场景返回空 | 场景模式只能走虚拟摄像头，首帧 0.5–1.5 s |
| 真机 / 真实库 | 麦克风、环境音自启、字幕字体、透明层、真实记忆库未全部复核 | 单测通过 ≠ 真机通过；发布前按 V-xx 清单复验 |
| FFmpeg / ASR 模型分发 | 代码只解析路径；ASR 模型缺失会直接报错 | 发布包需要额外说明模型来源与放置位置，`TODO(确认安装器是否负责)` |

### 4.5 调试入口

| 入口 | 用法 | 说明 |
| --- | --- | --- |
| `GET /assistant/status` | `Invoke-RestMethod "http://127.0.0.1:<GUI端口>/assistant/status"` | 状态投影：版本、组件、设备、视觉、TTS、字幕、人设、记忆、热键、诊断 |
| `POST /assistant/action` | body `{ "action": "…", … }` | 设置动作统一入口；未知动作返回 `unknown action` |
| `GET /assistant/shot?path=…` | 预览缓存图 | 只允许 `<root>/cache` 下且登记过的文件；隐私 / 切换中返回 403 |
| `data/status.json` | 直接读文件 | 启动时写入的状态快照，便于外部工具检查 |
| `data/events.jsonl` | JSONL，10 MB × 5 轮转 | `{id, ts, type, corr_id, payload}`；语音链路优先看 `voice.*`、`hearing.*`、`memory.recall` |
| 设置页「诊断（客户端）」 | 打开插件页 → 诊断卡片 | 卡片本身只读一次 `/assistant/status`，可复制诊断报告；不单独加轮询 |
| `diagnostics.query` | `{"action":"diagnostics.query","probe":"voice.latency","limit":20}` | 受控探针：`voice.latency` / `noise.shadow` / `hotkeys` / `memory.stats` / `spout`；默认关闭，需 `settings.json` 的 `diagnostics.enabled` 或 config `diagnosticsEnabled` |
| 音频保留 | `voice.audioRetention` + `audio.retention.list` | 只保留可疑语句的 16 kHz WAV，存 `<root>/cache/retention/`；默认关，隐私时不写 |
| `tools/` 探针 | `node tools/api-smoke.mjs http://127.0.0.1:<GUI端口>`、`tools/memory-debug.mjs`、`tools/tts-probe.mjs`、`tools/vts-probe.mjs`、`tools/asr-probe.mjs`、`tools/obs-seed.mjs`、`tools/subtitle-probe.mjs` | 开发探针，不进发布包 |
| `scripts/baseline-snapshot.mjs` | 见 §4.1 | 构建 / 模型 / 协议 / TTS 基线与对比 |

示例：

```powershell
$base = 'http://127.0.0.1:<GUI端口>'
Invoke-RestMethod "$base/assistant/status" | ConvertTo-Json -Depth 6

Invoke-RestMethod "$base/assistant/action" -Method Post -ContentType 'application/json' `
  -Body '{"action":"diagnostics.query","probe":"voice.latency","limit":20}' |
  ConvertTo-Json -Depth 6

Invoke-RestMethod "$base/assistant/action" -Method Post -ContentType 'application/json' `
  -Body '{"action":"audio.retention.list"}' | ConvertTo-Json -Depth 6
```

---

### 延伸阅读（本地文档，`docs/` 不入库）

- [宿主模块边界](docs/host-modules.md)：目录、职责、依赖方向、入口保留职责。
- [计划（单一权威）](docs/PLAN.md)：P 编号、状态、待办与已知问题。
- [设计文档](docs/DESIGN.md)：目标、事件、对话链路、记忆与配置的历史设计口径（部分内容已被实现更新，读时以代码为准）。
- [环境与前置验证](docs/ENVIRONMENT.md)：宿主实测、安装坑、分批回归说明。
- [执行记录](docs/WORKLOG.md)：按提交分组的实现流水。
- [声纹登记与语言库设计](docs/speaker-enrollment-design.md)。
- [C2 请求前上下文设计](docs/c2-pre-request-context-design.md)。
