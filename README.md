# Gitee AI 多模型生成工作台

[![GitHub](https://img.shields.io/badge/GitHub-haremank%2Fgitee--ai--agents--guide-blue?style=flat&logo=github)](https://github.com/haremank/gitee-ai-agents-guide)
[![Version](https://img.shields.io/badge/版本-v2.6.3-green)](https://github.com/haremank/gitee-ai-agents-guide/releases/latest)
[![Usage](https://img.shields.io/badge/用途-仅限个人学习-red)](https://github.com/haremank/gitee-ai-agents-guide#readme)

基于 Tampermonkey 的油猴脚本：在任意网页提供可拖拽的多模型生成面板，自动获取令牌与额度，支持异步任务轮询、结果预览下载与 Agent 提示词一键导出。

> **免责声明**：本项目仅供个人学习与研究，严禁商业用途；请遵守 Gitee AI 平台服务条款及各模型授权协议。生成内容的版权与合规性以及使用产生的一切后果，均由使用者自行承担。

## 下载安装

- 前置：浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
- 一键安装：登录 GitHub 后点击 [最新版直装链接](https://github.com/haremank/gitee-ai-agents-guide/releases/latest/download/gitee-ai-workbench.user.js)
- 手动安装：从 [Releases](https://github.com/haremank/gitee-ai-agents-guide/releases/latest) 下载脚本，粘贴进 Tampermonkey 新建脚本并保存

## 核心功能

- **七种模式**：文生图 / 文生视频 / 图生视频 / 语音合成 / 图片转 3D / 文本对话 / 语音识别
- **令牌自动管理**：自动提取体验令牌与剩余额度，也可手动填入个人 Key，仅存浏览器本地
- **Agent 提示词导出**：一键导出接口指南（即 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md)），供 Codex / Claude Code 直接调用
- **异步全流程**：提交任务 → 自动轮询 → 结果预览 / 下载 / 历史记录

## 教程

把工作台导出的接口指南交给 Codex、Claude Code 等 Agent，让它们直接帮你调接口。

### 第一步：导出指南

点击工作台上的「🤖 Agent 提示词」按钮，弹窗中可以：

- 一键复制全文；或
- 点击下载，得到 Markdown 文件（即本仓库 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md) 的内容）

### 第二步：放入你的项目

任选一种方式放置指南文件：

```
your-project/
├── AGENTS.md          ← 把指南全文追加到末尾
├── CLAUDE.md          ← 或并入 Claude Code 的项目说明
└── docs/
    └── gitee-ai-agents.md ← 或作为独立文档存放
```

Agent 会自动读取项目根目录的 `AGENTS.md` / `CLAUDE.md`；放在 `docs/` 下时，首次使用前告诉 Agent「参考 docs/gitee-ai-agents.md 调用 Gitee AI 接口」即可。

### 第三步：配置令牌

在终端设置环境变量，**不要**把令牌写进任何文件：

```bash
# Linux / macOS
export GITEE_AI_TOKEN=<你的令牌>
```

```powershell
# Windows PowerShell
$env:GITEE_AI_TOKEN = "<你的令牌>"
```

### 第四步：验证

启动 Agent 后让它执行一条测试指令，例如：

> 参考 gitee-ai 指南，用 Qwen3-8B 回复"你好"

Agent 能正常返回结果，说明导入完成。之后就可以直接下发生图、生视频等任务了。

## 调用模型

使用官方体验令牌时，总额度为 **100 次 / 天**，面板会实时显示当日剩余次数；文本对话、语音识别和语音合成不占用该额度（平台免费开放）。

| 模式 | 模型 | 画质 / 规格 |
|---|---|---|
| 文生图 | Z-Image Turbo ⭐、FLUX.1 Schnell ⭐、FLUX.1/2 Dev、FLUX.2 Klein 4B/9B、FLUX.1 Krea Dev、CogView4 6B、GLM Image、HiDream I1 Full、Kolors、LongCat Image、Qwen Image / 2512、SD 3 Medium / 3.5 Large Turbo、SDXL Base、Z-Image（共 18 款） | 默认 **1024 × 1024 高清**；可选 1024×768 (4:3)、768×1024 (3:4)、**1536×864 (16:9)** |
| 文生视频 | HunyuanVideo 1.5、Wan2.1 T2V 14B | 最长 81 帧，16/24 fps，16:9 / 9:16 / 1:1 |
| 图生视频 | LTX-2、Wan2.2 I2V A14B | 最长 73 帧，最高 32 fps |
| 语音合成 🆓 | Spark TTS 0.5B | 支持男女声、音调与语速 1-5 级调节，全部免费 |
| 图片转 3D | Hunyuan3D 2、Hi3DGen | 输出 GLB / STL；MC 分辨率默认 512，面数约 8 万 |
| 文本对话 🆓 | Qwen3 系列、GLM4 系列、DeepSeek R1 蒸馏系列、书生·浦语3、DeepSeek Prover（数学）、华佗 GPT / 灵枢 / HealthGPT（医疗）等 14 款 | 多轮对话自动携带上下文，全部免费 |
| 语音识别 🆓 | GLM-ASR（轻量中文）、SenseVoice Small（中英日韩多语种） | 支持 mp3 / wav / m4a，全部免费 |

文生图面板中，Z-Image Turbo 和 FLUX.1 Schnell 为实测验证过的推荐模型，出图速度快、质量稳定。代码与文档不含明文密钥，令牌仅存于浏览器本地或环境变量。
