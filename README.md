# Gitee AI 多模型生成工作台

  基于 Tampermonkey 开发的油猴用户脚本，在任意网页提供可拖拽的多模型生成入口；自动获取访问令牌与额度，支持异步任务轮询、结果预览、下载与历史记录，并可一键导出 Agent 提示词供 Codex / Claude Code 直接调用接口。

  [![GitHub](https://img.shields.io/badge/GitHub-haremank%2Fgitee--ai--agents--guide-blue?style=flat&logo=github)](https://github.com/haremank/gitee-ai-agents-guide)
[![Version](https://img.shields.io/badge/版本-v2.6.2-green)](https://github.com/haremank/gitee-ai-agents-guide/releases/latest)
[![Usage](https://img.shields.io/badge/用途-仅限个人学习-red)](#免责声明)
<br /><br />

## 下载安装

- **一键安装**：登录 GitHub 后点击 [最新版脚本直装链接](https://github.com/haremank/gitee-ai-agents-guide/releases/latest/download/gitee-ai-workbench.user.js)，Tampermonkey 自动弹出安装页
- **手动安装**：前往 [Releases 页面](https://github.com/haremank/gitee-ai-agents-guide/releases/latest) 下载 `gitee-ai-workbench.user.js`，在 Tampermonkey 面板 → 添加新脚本 → 粘贴全部内容并保存

> 前置要求：浏览器需已安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。安装完成后打开任意网页即可看到悬浮工作台入口。

<br />

## 免责声明

**本项目仅供个人学习与研究使用，严禁用于任何商业用途。**

- 生成内容（图片 / 视频 / 3D 模型 / 音频）的版权与合规性由使用者自行负责
- 请遵守 Gitee AI 平台服务条款及各模型的授权协议
- 请勿利用本工具生成违法违规内容
- 使用本脚本产生的一切后果由使用者自行承担

<br />

## 可调用模型与画质

使用官方体验令牌时，总额度为 **100 次 / 天**，面板会实时显示当日剩余次数；文本对话与语音识别不占用该额度（平台免费开放）。

| 模式 | 模型 | 画质 / 规格 |
|---|---|---|
| 文生图 | Z-Image Turbo、FLUX.1 Schnell、FLUX.1/2 Dev、FLUX.2 Klein 4B/9B、FLUX.1 Krea Dev、CogView4 6B、GLM Image、HiDream I1 Full、Kolors、LongCat Image、Qwen Image / 2512、SD 3 Medium / 3.5 Large Turbo、SDXL Base、Z-Image（共 18 款） | 默认 **1024 × 1024 高清**；可选 1024×768 (4:3)、768×1024 (3:4)、**1536×864 (16:9)** |
| 文生视频 | HunyuanVideo 1.5、Wan2.1 T2V 14B | 最长 81 帧，16/24 fps，支持 16:9 / 9:16 / 1:1 |
| 图生视频 | LTX-2、Wan2.2 I2V A14B | 最长 73 帧，最高 32 fps |
| 语音合成 | Spark TTS 0.5B | 支持男女声、音调与语速 1-5 级调节 |
| 图片转 3D | Hunyuan3D 2、Hi3DGen | 输出 GLB / STL；MC 分辨率默认 512，面数约 8 万 |
| 文本对话 🆓 | Qwen3 系列、GLM4 系列、DeepSeek R1 蒸馏系列、书生·浦语3、DeepSeek Prover（数学）、华佗 GPT / 灵枢 / HealthGPT（医疗）等 14 款 | 多轮对话自动携带上下文，全部免费 |
| 语音识别 🆓 | GLM-ASR（轻量中文）、SenseVoice Small（中英日韩多语种） | 支持 mp3 / wav / m4a，全部免费 |

文生图面板中，Z-Image Turbo 和 FLUX.1 Schnell 为实测验证过的推荐模型，出图速度快、质量稳定。

<br />

## 核心功能

- **多模式面板**：按文生图 / 文生视频 / 图生视频 / 语音合成 / 图片转 3D / 文本对话 / 语音识别显示对应参数面板
- **令牌自动管理**：自动从 Gitee AI 页面提取体验令牌与剩余额度，也可手动粘贴个人专属 API Key；输入框为密码框，令牌仅保存在浏览器本地存储
- **一键导出 Agent 提示词**：生成 Markdown 格式的 API 调用指南，供 Codex / Claude Code 等 Agent 直接调用接口；导出的指南见 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md)
- **异步任务全流程**：提交任务 → 自动轮询 → 结果预览 / 下载 / 历史记录

<br />

## 导入 Agent 教学

把工作台导出的接口指南交给 Codex、Claude Code 等 Agent，让它们直接帮你调接口：

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
    └── gitee-ai.md    ← 或作为独立文档存放
```

Agent 会自动读取项目根目录的 `AGENTS.md` / `CLAUDE.md`；放在 `docs/` 下时，首次使用前告诉 Agent「参考 docs/gitee-ai.md 调用 Gitee AI 接口」即可。

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

<br />

## 密钥安全约定

- 本仓库的代码与文档中不含任何明文密钥
- 脚本内置假令牌黑名单过滤，避免误用文档示例 Token
- 通过脚本使用时，令牌仅存于浏览器本地（GM 存储 / localStorage），不写入文件
- 若参考导出指南写自己的调用代码，请通过环境变量提供令牌（如 `GITEE_AI_TOKEN`），切勿硬编码或提交 `.env`
