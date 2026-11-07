# 开发探针

这些脚本只用于本地排查，不参与插件运行。

| 脚本 | 用途 |
|---|---|
| `api-smoke.mjs` | 通过 HTTP 验证设置接口（status / feature / snapshot / resource） |
| `asar-peek.mjs` | 从 Electron `app.asar` 里取单个文件并做正则统计（shell 与 rg 读不了 asar） |
| `asr-probe.mjs` | 用流式 14M 模型离线识别一个 16 kHz WAV |
| `asr-final-probe.mjs` | 用 SenseVoice 离线识别同一个 WAV，用来对比准确率 |
| `tts-to-wav.mjs` | 合成一句话并转成 16 kHz WAV（喂给上面两个探针） |
| `tts-probe.mjs` | 探测 Edge TTS 输出格式（WAV 被服务端拒绝，只有 MP3 可用） |
| `obs-seed.mjs` | 在 OBS 里确保某场景存在（默认「隐私」） |
| `vision-scene-probe.mjs` | 启停 OBS 虚拟摄像头并从 dshow 抓一帧，验证场景模式取景链路 |
| `set-persona.mjs` | 用 UTF-8 安全的方式写入人设（PowerShell 会破坏中文） |

## 典型用法

```powershell
# 语音链路对比
node tools/tts-to-wav.mjs "你好，我是你的助手"
node tools/asr-probe.mjs .tmp-asr/speech.wav
node tools/asr-final-probe.mjs .tmp-asr/speech.wav

# 设置接口
node tools/api-smoke.mjs http://127.0.0.1:64016

# 审计 DSH 桌面端
node tools/asar-peek.mjs "<DeepSeekHarness>\resources\app.asar" "lib/main.js" "new Tray" "ELECTRON_RUN_AS_NODE"
```

`.tmp-*` 目录是这些脚本的临时输出，已在 `.gitignore` 中忽略。
