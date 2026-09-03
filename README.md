# Gitee AI 多模型生成工作台

[![GitHub](https://img.shields.io/badge/GitHub-haremank%2Fgitee--ai--agents--guide-blue?style=flat&logo=github)](https://github.com/haremank/gitee-ai-agents-guide)
[![Version](https://img.shields.io/badge/版本-v2.9.5-green)](https://github.com/haremank/gitee-ai-agents-guide/releases/latest)
[![Usage](https://img.shields.io/badge/用途-仅限个人学习-red)](https://github.com/haremank/gitee-ai-agents-guide#readme)

基于 Tampermonkey 的油猴脚本：在任意网页提供可拖拽的多模型生成面板，自动获取令牌与额度，支持异步任务轮询、结果预览下载与 Agent 提示词一键导出。
分辨率与参数由官方模型元数据驱动；部分图像模型提供 4K 档。也能把接口指南交给 Codex、Claude Code 等 Agent 直接调用。

> **免责声明**：本项目仅供个人学习与研究，严禁商业用途；请遵守 Gitee AI 平台服务条款及各模型授权协议。生成内容的版权与合规性以及使用产生的一切后果，均由使用者自行承担。

## 下载安装

- 前置：浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
- 一键安装：登录 GitHub 后点击 [最新版直装链接](https://github.com/haremank/gitee-ai-agents-guide/releases/latest/download/gitee-ai-workbench.user.js)
- 手动安装：从 [Releases](https://github.com/haremank/gitee-ai-agents-guide/releases/latest) 下载脚本，粘贴进 Tampermonkey 新建脚本并保存

## 核心功能

- **七种模式**：文生图 / 文生视频 / 图生视频 / 语音合成 / 图片转 3D / 文本对话 / 语音识别
- **模型化参数**：步数、帧数、fps、分辨率和枚举项随所选模型适配，不做无依据的通用能力承诺
- **令牌自动管理**：自动提取体验令牌与剩余额度，也可手动填入个人 Key，仅存浏览器本地
- **全参数控制台**：按端点与操作展开 OpenAPI 参数表单，同步接口可直接调用，异步任务可查询 / 取消；付费调用前需二次确认
- **Agent 提示词导出**：一键导出接口指南（内容与 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md) 基本一致），供 Codex / Claude Code 直接调用
- **异步全流程**：提交任务 → 自动轮询 → 结果预览 / 下载 / 本地生成库 / 固定目录自动保存

### 本地生成库

生成结果会自动保存到当前浏览器的 IndexedDB，图片、视频、音频、文本和 3D 文件可在面板内预览、搜索、按类型筛选、单独删除或一键清空。已下载到本地的副本不依赖 Gitee/BOS 签名 URL，因此远程链接过期后仍能打开；旧版 12 条 URL 历史会在首次打开面板时自动迁移。

在 Chrome / Edge 等支持 File System Access API 的浏览器中，可以设置一个固定的自动保存目录。新生成或导入成功的内容会先进入 IndexedDB 本地库，再自动写入该目录；Firefox / Safari 等不支持的浏览器仍会保存到本地库，并在面板中提示降级。单独删除或清空本地库时，脚本会同步尝试删除已写入固定目录的文件；如果目录授权已失效，会保留本地记录并提示重新授权，避免误以为文件已删除。

面板还会读取 Gitee 官方异步任务列表和并发配额，但只显示近 24 小时内创建的任务，展示等待、进行中、成功、失败、取消数量。移除或取消后的云端卡片会记住状态，刷新后不再重新出现。成功任务可单条或批量下载并导入本地库；导入按 `task_id` 去重，不会重新提交付费任务。失败和取消项只显示原因。

IndexedDB 按浏览器 Profile、站点源点和隐私模式隔离，不会跨浏览器或跨设备同步，也不是备份存储。清理浏览器站点数据会删除本地库；重要产物建议使用固定目录自动保存。

### 标准参数查询

```bash
# 可用模型目录
curl https://ai.gitee.com/v1/models -H "Authorization: Bearer $GITEE_AI_TOKEN"

# Serverless OpenAPI
curl https://ai.gitee.com/v1/json -H "Authorization: Bearer $GITEE_AI_TOKEN"

# 指定模型的操作元数据（替换 {model}）
curl "https://ai.gitee.com/api/pay/service/operations?service_ident={model}" \
  -H "Authorization: Bearer $GITEE_AI_TOKEN"
```

## 教程

把工作台导出的接口指南交给 Codex、Claude Code 等 Agent，让它们直接帮你调接口。

### 第一步：获取 Gitee AI 访问令牌

1. 登录 [Gitee AI](https://ai.gitee.com)，打开 [Serverless API 页面](https://ai.gitee.com/serverless-api)。
2. 创建访问令牌并复制。它通常是一串大写字母数字，请当作密码保管。
3. 在终端设置环境变量；Agent 会从环境变量读取令牌：

```bash
# Linux / macOS
export GITEE_AI_TOKEN="<你的令牌>"
```

```powershell
# Windows PowerShell
$env:GITEE_AI_TOKEN = "<你的令牌>"
```

不要把真实令牌写进 `AGENTS.md`、README、代码、截图或提交到 Git。如果令牌已经泄露，立刻回到平台删除并重建。

### 第二步：导出指南

点击工作台上的「🤖 Agent 提示词」按钮，弹窗中可以：

- 一键复制全文；或
- 点击下载，得到 Markdown 文件（内容与本仓库 [`docs/gitee-ai-agents.md`](docs/gitee-ai-agents.md) 基本一致，导出版附带当日日期与令牌占位符）

### 第三步：放入你的项目

任选一种方式放置指南文件：

```
your-project/
├── AGENTS.md          ← 把指南全文追加到末尾
├── CLAUDE.md          ← 或并入 Claude Code 的项目说明
└── docs/
    └── gitee-ai-agents.md ← 或作为独立文档存放
```

Agent 会自动读取项目根目录的 `AGENTS.md` / `CLAUDE.md`；放在 `docs/` 下时，首次使用前告诉 Agent「参考 docs/gitee-ai-agents.md 调用 Gitee AI 接口」即可。

### 第四步：验证

启动 Agent 后让它执行一条测试指令，例如：

> 参考 gitee-ai 指南，用 Qwen3-8B 回复"你好"

Agent 能正常返回结果，说明导入完成。之后就可以直接下发生图、生视频等任务了。

### 快捷用法：直接把文件丢给 AI

先在项目里建一个输入目录，把参考图、音频或其他素材放进去：

```
your-project/
├── input/
│   ├── photo.png
│   └── meeting.mp3
└── output/
```

然后对 Agent 说清楚输入文件和期望结果即可：

> 参考 docs/gitee-ai-agents.md，用 LTX-2 把 input/photo.png 转成约 5 秒横屏视频（fps=24，num_frames=121），下载保存到 output/photo.mp4。

> 参考 docs/gitee-ai-agents.md，转写 input/meeting.mp3，整理成 Markdown 后保存到 output/meeting.md。

Agent 会按指南选择对应接口：上传 multipart 文件、提交异步任务、轮询状态，最后把产物下载到指定位置。涉及付费模型时，应先向你确认再调用。

## 调用模型

使用官方体验令牌时，总额度为 **100 次 / 天**，面板会实时显示当日剩余次数（以本地记录估算，文生图即时扣减，异步任务在成功后扣减；请以 Gitee AI 官网页面为准）；文本对话、语音识别和语音合成不占用该额度（平台免费开放）。

| 模式 | 模型 | 画质 / 规格 |
|---|---|---|
| 文生图 | Z-Image Turbo ⭐、FLUX.1 Schnell ⭐、FLUX.1/2 Dev、FLUX.2 Klein 4B/9B、FLUX.1 Krea Dev、CogView4 6B、GLM Image、HiDream I1 Full、Kolors、LongCat Image、Qwen Image / 2512、SD 3 Medium / 3.5 Large Turbo、SDXL Base、Z-Image（共 18 款） | 快速面板默认 **1024 × 1024**，另提供 256–1024 常用档；更高或特殊比例以全参数控制台中的模型元数据为准 |
| 文生视频 | HunyuanVideo 1.5、Wan2.1 T2V 14B | HunyuanVideo 支持 81–241 帧、16/24 fps 和画面比例；Wan2.1 支持 25/50/75/100 帧 |
| 图生视频 | LTX-2、Wan2.2 I2V A14B | LTX-2 支持 25–241 帧、16/24 fps；Wan2.2 支持 25/33/50 帧；常见宽高上限 2048 |
| 语音合成 🆓 | Spark TTS 0.5B | 支持男女声、音调与语速 1-5 级调节，全部免费 |
| 图片转 3D | Hunyuan3D 2、Hi3DGen | 输出 GLB / STL；Hunyuan3D 步数 2–50，Octree 16/64/128/256/400 |
| 文本对话 🆓 | Qwen3 系列、GLM4 系列、DeepSeek R1 蒸馏系列、书生·浦语3、DeepSeek Prover（数学）、华佗 GPT / 灵枢 / HealthGPT（医疗）等 14 款 | 多轮对话自动携带上下文，全部免费 |
| 语音识别 🆓 | GLM-ASR（轻量中文）、SenseVoice Small（中英日韩多语种） | 支持 mp3 / wav / m4a，全部免费 |

文生图面板中，Z-Image Turbo 和 FLUX.1 Schnell 为实测验证过的推荐模型，出图速度快、质量稳定。代码与文档不含明文密钥，令牌仅存于浏览器本地或环境变量。

## 许可证

本项目以 [MIT License](LICENSE) 开源。请配合上方免责声明理解：代码可自由使用与修改，但使用本项目访问 Gitee AI 平台产生的内容、费用与合规责任由使用者自行承担。
