# Gitee AI 多模型生成工作台

[![GitHub](https://img.shields.io/badge/GitHub-haremank%2Fgitee--ai--agents--guide-blue?style=flat&logo=github)](https://github.com/haremank/gitee-ai-agents-guide)
[![Version](https://img.shields.io/badge/版本-v2.6.2-green)](https://github.com/haremank/gitee-ai-agents-guide/releases/latest)
[![Usage](https://img.shields.io/badge/用途-仅限个人学习-red)](#免责声明)

基于 Tampermonkey 的油猴脚本：在任意网页提供可拖拽的多模型生成面板，自动获取令牌与额度，支持异步任务轮询、结果预览下载与 Agent 提示词一键导出。

> **免责声明**：本项目仅供个人学习与研究，严禁商业用途；请遵守 Gitee AI 平台服务条款及各模型授权协议。生成内容的版权与合规性以及使用产生的一切后果，均由使用者自行承担。

## 下载安装

- 前置：浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
- 一键安装：登录 GitHub 后点击 [最新版直装链接](https://github.com/haremank/gitee-ai-agents-guide/releases/latest/download/gitee-ai-workbench.user.js)
- 手动安装：从 [Releases](https://github.com/haremank/gitee-ai-agents-guide/releases/latest) 下载脚本，粘贴进 Tampermonkey 新建脚本并保存

## 核心功能

- **七种模式**：文生图 / 文生视频 / 图生视频 / 语音合成 / 图片转 3D / 文本对话 / 语音识别
- **令牌自动管理**：自动提取体验令牌与剩余额度（100 次 / 天，文本与语音识别免费），也可手动填入个人 Key，仅存浏览器本地
- **Agent 提示词导出**：一键导出接口指南（即 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md)），供 Codex / Claude Code 直接调用
- **异步全流程**：提交任务 → 自动轮询 → 结果预览 / 下载 / 历史记录

## 教程

1. 点击面板「🤖 Agent 提示词」按钮，复制或下载导出的指南 Markdown
2. 把指南全文并入项目根目录的 `AGENTS.md` 或 `CLAUDE.md`；或存为 `docs/gitee-ai.md` 后告知 Agent 参考该文件
3. 在终端设置环境变量提供令牌（切勿写进文件或提交 `.env`）：`export GITEE_AI_TOKEN=<你的令牌>`
4. 让 Agent 执行一条测试指令（如「参考 gitee-ai 指南，用 Qwen3-8B 回复你好」），返回正常即接入完成

## 调用模型

| 模式 | 模型 | 画质 / 规格 |
|---|---|---|
| 文生图 | Z-Image Turbo ⭐、FLUX.1 Schnell ⭐ 等 18 款 | 默认 1024×1024，可选 16:9（1536×864）等 |
| 文生视频 | HunyuanVideo 1.5、Wan2.1 T2V 14B | 最长 81 帧，16/24 fps，16:9 / 9:16 / 1:1 |
| 图生视频 | LTX-2、Wan2.2 I2V A14B | 最长 73 帧，最高 32 fps |
| 语音合成 | Spark TTS 0.5B | 男女声，音调 / 语速 1-5 级 |
| 图片转 3D | Hunyuan3D 2、Hi3DGen | 输出 GLB / STL |
| 文本对话 🆓 | Qwen3、GLM4、DeepSeek R1 蒸馏等 14 款 | 全部免费，多轮上下文 |
| 语音识别 🆓 | GLM-ASR、SenseVoice Small | 全部免费，mp3 / wav / m4a |

⭐ 实测推荐：出图速度快、质量稳定。代码与文档不含明文密钥，令牌仅存于浏览器本地或环境变量。
