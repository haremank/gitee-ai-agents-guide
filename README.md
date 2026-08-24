# Gitee AI Serverless API — Agent 调用指南

一份面向 AI 编程助手（Codex、Claude Code、Cursor 等）的 Gitee AI Serverless API 调用指南，覆盖文本对话、文生图、语音识别、语音合成、文生视频、图生视频、图片转 3D 等能力的 HTTP 调用方式、异步任务轮询流程与错误处理约定。

## 内容

- **同步接口**：文本对话（OpenAI 兼容格式）、文生图、语音识别
- **异步接口**：提交任务 → 每 4 秒轮询 → 取回结果的统一流程
- **Agent 行为约定**：免费模型优先、轮询纪律、错误退避重试、产物落地规范
- **端点速查表**：全部已整理端点的一览表

## 使用前配置

1. 登录 https://ai.gitee.com/serverless-api 创建 API Token（36-44 位大写字母数字）。
2. 通过环境变量提供令牌，切勿写入任何文件：

```bash
# Linux / macOS
export GITEE_AI_TOKEN=<你的令牌>
```

```powershell
# Windows PowerShell
$env:GITEE_AI_TOKEN = "<你的令牌>"
```

3. 文档中的 curl 示例使用 `$TOKEN` 占位，执行前先 `export TOKEN=$GITEE_AI_TOKEN`。

## 注意事项

- 标注 🆓 的模型为免费模型，优先使用；其余模型按量计费，调用前确认费用。
- 含真实令牌的文件禁止提交到任何仓库；`.env` 等密钥文件必须加入 `.gitignore`。
- 使用本指南即表示同意遵守 Gitee AI 服务条款及各模型的授权协议。

## 许可

仅供个人学习与内部使用。
