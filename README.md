# DSH Companion

基于 DeepSeek Harness 的功能集成助手：语音、视觉、长期记忆、OBS 控制，以及一个 Web 设置页。

当前版本 **v0.91.0**。已可用：语音合成、双通道语音识别、屏幕快照/故事板、三模式视觉、快路对话（LLM 直连 + 语音闭环）、助手流水（明细/审阅）、透明层（实验）、OBS 场景控制、全局热键、四层记忆、对话式资源与 persona、设置页。已移除：提示音（chime）、按住说话（PTT）与 `dispatch.task` 工具。

## 目录结构

```text
dsh-assistant/
├─ src/host/
│  ├─ index.js       插件入口、工具注册、设置接口与宿主接线
│  ├─ memory/        对话记忆、召回、纠正、固定记忆与归档
│  ├─ profile/       人设、用户画像、评分与后台整理
│  ├─ speech/        语音合成、翻译、口语版、候音与播放账本
│  ├─ hearing/       麦克风、环境音、ASR worker、VAD 与非语言线索
│  ├─ vision/        截图、故事板、视觉模式与 OBS
│  ├─ avatar/        Live2D 运动、VTS、WPF 透明层与 Spout
│  │  └─ spout-layer/  独立 Electron 显示进程及页面资源
│  ├─ subtitle/      字幕窗口、字体与显示脚本
│  ├─ session/       会话编排
│  │  ├─ delivery/      投递与结果绑定
│  │  ├─ inference/     快路与轻量模型通道
│  │  └─ conversation/  连续台词、摘要和请求前上下文
│  ├─ runtime/       组件、工具执行与生命周期
│  │  ├─ http/          状态投影、设置路由和请求解析
│  │  └─ diagnostics/   受控诊断与关闭资源记录
│  ├─ platform/      Windows 窗口、全局热键、硬件探测和模型下载
│  └─ shared/        text.js / time.js：共用文本与时间处理
├─ client.js         Web 设置页
├─ locale/           界面语言
├─ test/             回归测试；按功能前缀由分批执行器分组
├─ tools/            开发探针与辅助命令
├─ scripts/          测试分批与基线检查
├─ docs/host-modules.md  模块边界与依赖说明
├─ package.json      插件入口、依赖与发布文件清单
└─ cordis.patch.yml  Loader 插件配置
```

### 代码阅读入口

- 想知道「agent 能做什么」→ `src/host/index.js` 的工具定义，以及 `src/host/runtime/tools.js` 的执行实现。
- 想知道「设置页怎么工作」→ `client.js`、`src/host/runtime/http/` 和各功能目录的 `settings-actions.js`。
- 想知道「记忆和人设怎么存」→ `src/host/memory/`、`src/host/profile/`。
- 想知道「语音如何输入和输出」→ `src/host/hearing/`、`src/host/speech/`。
- 想知道「如何驱动或显示形象」→ `src/host/avatar/`。
- 更详细的职责边界见 [宿主模块说明](docs/host-modules.md)。

## 工具面（22 个）

| 工具 | 作用 |
|---|---|
| `assistant_say` | 语音合成并播放（Edge TTS） |
| `assistant_listen` | devices / start / poll / stop / status |
| `assistant_see` | 截屏到 PNG（按当前视觉模式取景） |
| `assistant_watch` | 持续观看 + 变化筛帧故事板（需 ffmpeg） |
| `assistant_vision` | 视觉三模式：status / set（watch / scene / privacy） |
| `assistant_remember` / `assistant_recall` | 分域记忆读写（SQLite + FTS5） |
| `assistant_resource_set/get/list/forget` | 长期资源与凭据（凭据 DPAPI 加密） |
| `assistant_persona_view/append` | 人设与用户画像 |
| `assistant_hotkeys` | 热键查看/改键/重置/模拟 |
| `assistant_obs` / `assistant_obs_status` | OBS 场景控制与探测 |
| `assistant_doctor` | 运行时与原生模块探针 |
| `assistant_prompt_preview` | 查看注入系统提示的资源索引 |

热键实际行为：`mic` 开关麦克风、`vision` 在隐私 / 观看之间切换、`pauseAll` 停/恢复采集、`settings` 语音播报当前状态、`avatar` 触发形象热键。

\* 上表按能力归类；实际工具名以 `assistant_listen` 为准。

## 运行数据

```
<root>                       默认 %LOCALAPPDATA%\dsh-assistant
  data/events.jsonl          所有动作的事件流
  data/status.json           最近一次状态
  data/features.json         组件开关
  data/hotkeys.json          热键绑定
  data/settings.json         运行期设置（当前是所选麦克风）
  memory/<domain>.db         分域情节记忆（SQLite）
  memory/profile.db          长期资源（含加密凭据）
  memory/persona.md          user.md  人设与画像
  cache/tts/*.mp3            语音文件
  cache/screens/*.png        截图与故事板
```

## 设置页

DSH → 设置 → 插件 → **伴生助手**（也出现在设置导航里）。提供：

- 状态（版本、运行时长、资源数）
- 听觉：输入设备选择、测试麦克风、实时电平
- 助手流水：助手自己发起的调用（直连 LLM / Edge TTS / 本地 ASR），今日/累计、环形构成图、**明细弹窗**（按天/按模型/最近明细）、CSV；价格每 12 小时从 DeepSeek 官方价目表自动更新（高峰/空闲自动区分），不含 Harness 会话用量
- 快路审阅：**查看对话**弹窗（关键词过滤、逐条删除）；快路对话不进 DSH 会话日志
- 视觉：当前模式徽标（隐私锁定 / 场景·名称 / 观看）、视觉来源下拉（固定列「屏幕 + 全部 OBS 场景 + 隐私」，选中即切模式）、截图测试、切换隐私模式、最近取景预览（场景模式黑帧一眼可见）
- 快路对话：设置页直接对助手说话（复用 DSH `llm` + 默认模型，底层 DeepSeek；不创建 DSH 会话），上下文含人设/画像/相关记忆/最近对话；响应 `usage` 自动记入助手流水；**语音回答**走流式分句 TTS，说话即打断（abort 流 + 停播）
- 透明层（实验）：`PrintWindow` 抓 VTS 窗口 + 洋红键控，在透明置顶、点击穿透的窗口里镜像模型；可调位置/尺寸；不移动 VTS。VTS 需开启「透明推流」，动作按钮放屏幕中间避免被裁进画面
- 形象：VTS 连接状态、模型、热键/表情按钮、口型（说话时自动）
- 字幕：区域模式 / 气泡模式（锚 VTS 窗口左上角，气泡色取自模型区域）
- 组件开关：听觉 / 语音合成 / 视觉 / 字幕 / 形象 / 记忆，各自独立启停
- 全局快捷键：点「改键」直接按组合键即可改绑
- 长期资源：列表 + 新增/修改/删除（弹窗编辑）
- 记忆归档：弹窗查看/搜索/删除（不再内联撑高卡片）
- 人设与用户画像：直接编辑并保存

## 视觉三模式

| 模式 | 取景 | 行为 |
|---|---|---|
| `watch` | ffmpeg ddagrab（gdigrab 兜底） | 默认模式；`assistant_see` 截桌面，`assistant_watch` 走桌面故事板；不经过 OBS |
| `scene` | OBS 虚拟摄像头 | 看指定 OBS 场景（后台窗口也能看）；设置页下拉框直接改来源；OBS 与虚拟摄像头按需启动，空闲 60 秒自动停止 |
| `privacy` | 无 | 切到 OBS 隐私场景；agent 的截图、故事板、切场景一律拒绝，且 agent 不能切出 |

隐私模式只有用户能离开：热键 `Ctrl+Alt+V` 或设置页的「退出隐私模式」按钮（按钮态由实际模式推导，agent 切入后自动高亮）。模式与场景会持久化到 `data/settings.json`，重启后在 OBS 可用时重新锁定隐私场景。

## 自测

```powershell
node test/smoke.mjs
node --test test/fastpath-history.mjs
node --test test/usage-pricing.mjs
```

覆盖：工具注册、域隔离、非法域名回落、事件落盘、SQLite 与 FTS 索引、资源读写与凭据打码、prompt 注入；快路历史（当前句只出现一次、存多少用多少）；流水计价（三项口径、abort 仍记账、价格版本快照）。

## 本地开发

本目录以 `link:` 方式装进 DSH profile，pnpm **不会**安装它自己的依赖，先手动装一次：

```powershell
node "<DeepSeekHarness>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
```

改完 Host 代码后 `remove_bundle` → `install_bundle` 即可生效；改 `src/client/index.js` 后需要刷新页面。

**不要用 PowerShell 的 `Set-Content` 改源码**：它会写 BOM 并把中文变成乱码。用编辑器或 Node 写。

## 下一步

- 透明层：把「移动/隐藏 VTS」做安全（目前不自动动 VTS，否则需重启并重开透明推流）
- 按域分组（需要 conversation 记录 domain）
