# Gitee AI Serverless API — Agent 调用指南

> 本文档面向 AI 编程助手（Codex、Claude Code、Cursor 等）。你（Agent）可以在任务需要时，
> 按下述约定直接通过 HTTP 调用这些接口完成图片 / 视频 / 语音 / 3D / 文本生成任务。
> 文档生成日期：2026-08-24

## 0. 基础约定

- Base URL：`https://ai.gitee.com`
- 认证方式：所有请求携带请求头 `Authorization: Bearer <TOKEN>`
- TOKEN：请勿在文档或代码中硬编码。使用前通过环境变量提供：`export GITEE_AI_TOKEN=<你的令牌>`（Windows PowerShell：`$env:GITEE_AI_TOKEN = "<你的令牌>"`）
- 令牌获取：https://ai.gitee.com/serverless-api （登录后创建，形如 36-44 位大写字母数字）
- ⚠️ 含真实令牌的文件禁止提交公开仓库；`.env` 等密钥文件必须加入 `.gitignore`
- 标注 🆓 的模型为当前免费模型，优先使用；其余模型按量计费，调用前先向使用者确认
- 示例约定：下文所有 curl 中的 `$TOKEN` 即环境变量 `GITEE_AI_TOKEN` 的值。执行前先 `export TOKEN=$GITEE_AI_TOKEN`，或逐条替换；切勿在命令中原样写入令牌
- 端点纪律：仅使用本文档列出的端点与参数，不要凭记忆猜测未列出的接口；若实际响应与本文档不符，以响应为准并向使用者报告
- multipart 上传（curl 的 `-F`、fetch/requests 的 form-data）不要手工设置 `Content-Type`，由 HTTP 客户端自动生成 boundary，否则上传必失败
- 错误响应统一为 JSON，错误信息在 `message` 或 `error_message` 字段

## 1. 同步接口（一次请求直接返回结果）

### 1.1 文本对话（🆓 全部免费）— `POST /v1/chat/completions`

OpenAI Chat Completions 兼容格式，支持多轮 messages 与 stream 流式返回；也可直接用 OpenAI SDK（`base_url="https://ai.gitee.com/v1"`、`api_key=$GITEE_AI_TOKEN`）。

免费模型：`Qwen3-8B`、`Qwen3-4B`、`Qwen3-0.6B`、`DeepSeek-R1-Distill-Qwen-14B`、`DeepSeek-R1-Distill-Qwen-7B`、`DeepSeek-R1-Distill-Qwen-1.5B`、`glm-4-9b-chat`、`GLM-4-9B-0414`、`Qwen2-7B-Instruct`、`internlm3-8b-instruct`、`DeepSeek-Prover-V2-7B`、`HuatuoGPT-o1-7B`、`Lingshu-32B`、`HealthGPT-L14`

```bash
curl https://ai.gitee.com/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3-8B",
    "messages": [
      {"role": "system", "content": "你是一个简洁的中文助手"},
      {"role": "user", "content": "用两句话介绍你自己"}
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'
```

可调参数：`temperature`(0-2)、`top_p`、`max_tokens`、`frequency_penalty`、`presence_penalty`、`top_k`(OpenAI SDK 经 `extra_body` 传入)、`stream`(SSE, `data: {...}` 增量, 以 `data: [DONE]` 结束)。

成功响应示例（截选）：

```json
{"choices":[{"message":{"role":"assistant","content":"回复内容"}}],"usage":{"total_tokens":123}}
```

回复文本取 `choices[0].message.content`；DeepSeek-R1 蒸馏模型的思考过程在 `choices[0].message.reasoning_content`；流式时增量在 `choices[0].delta.content`。

### 1.2 文生图 — `POST /v1/images/generations`

模型：`z-image-turbo`、`flux-1-schnell`、`CogView4_6B`、`FLUX_1-Krea-dev`、`FLUX.1-dev`、`FLUX.2-dev`、`FLUX.2-klein-4B`、`FLUX.2-klein-9B`、`GLM-Image`、`HiDream-I1-Full`、`Kolors`、`LongCat-Image`、`Qwen-Image`、`Qwen-Image-2512`、`stable-diffusion-3-medium`、`stable-diffusion-3.5-large-turbo`、`stable-diffusion-xl-base-1.0`、`Z-Image`

```bash
curl https://ai.gitee.com/v1/images/generations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-image-turbo",
    "prompt": "一只戴宇航头盔的柴犬，摄影质感",
    "size": "1024x1024",
    "num_inference_steps": 9,
    "response_format": "url"
  }'
```

可调参数：`size`(如 1024x1024 / 1536x864)、`width`/`height`、`num_inference_steps`、`negative_prompt`、`guidance_scale`、`seed`、`num_images_per_prompt`、`response_format`(`url` 或 `b64_json`)。
响应：`data[0].url` 或 `data[0].b64_json`；`b64_json` 数据量大，除非要离线保存，优先用 `url`。

### 1.3 语音识别（🆓 全部免费）— `POST /v1/audio/transcriptions`

multipart/form-data 上传音频转文字。模型：`GLM-ASR`、`SenseVoiceSmall`

```bash
curl https://ai.gitee.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@audio.mp3 \
  -F model=SenseVoiceSmall \
  -F language=zh        # 可选，留空自动检测
```

响应：`{"text": "识别出的文字"}`。支持 mp3 / wav / m4a 等常见格式。

## 2. 异步接口（提交任务 → 轮询结果）

统一流程：

1. POST 提交任务，成功响应示例（`task_id` 为 32 位大写字母数字串；`urls` 内直接给出轮询与取消地址，可直接使用）：

```json
{"task_id": "SBOMLX0YXU8SVJQXY6CNWVJ7OJAND5TK", "status": "waiting", "created_at": 1787474128023,
 "urls": {"get": "https://ai.gitee.com/api/v1/task/SBOM...", "cancel": "https://ai.gitee.com/api/v1/task/SBOM.../cancel"}}
```

2. 携带同一认证头轮询任务状态（每 4 秒一次，最长 15 分钟）：

```bash
curl https://ai.gitee.com/api/v1/task/$TASK_ID -H "Authorization: Bearer $TOKEN"
```

3. 响应中的 `status` 字段状态机：
   - `success` → 终态成功。完整响应示例：`{"task_id":"...","status":"success","output":{"file_url":"https://gitee-ai.su.bcebos.com/..."},"price":0.0,"currency":"CNY","urls":{...}}`，结果取 `output.file_url`（或 `output.url`）；
   - `failed` / `cancelled` → 终态失败，原因在 `message` 字段，据此修正参数后可重新提交一次；
   - 其它取值（如 `waiting`）→ 仍在排队 / 处理中，继续轮询，不要提前放弃。

4. 需要中止时：`POST /api/v1/task/{task_id}/cancel`。

### 2.1 文生视频 — `POST /v1/async/videos/generations`

模型：`HunyuanVideo-1.5`、`Wan2.1-T2V-14B`

JSON 参数：`model`、`prompt`、`num_frames`(如 81)、`num_inference_steps`、`negative_prompt`、`seed`、`aspect_ratio`("16:9"/"9:16"/"1:1")、`fps`(16/24)。

### 2.2 图生视频 — `POST /v1/async/videos/image-to-video`

模型：`LTX-2`、`Wan2_2-I2V-A14B`

multipart 参数：`model`、`image`(图片文件)、`prompt`、`num_frames`、`width`、`height`、`num_inference_steps`、`fps`、`guidance_scale`、`seed`、`negative_prompt`。

### 2.3 语音合成（🆓 免费）— `POST /v1/async/audio/speech`

模型：`Spark-TTS-0.5B`

```bash
curl https://ai.gitee.com/v1/async/audio/speech \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Spark-TTS-0.5B",
    "inputs": "你好，这是一段测试语音。",
    "gender": "female",
    "pitch": 3,
    "speed": 3,
    "response_format": "url"
  }'
```

`gender` 为 `female` / `male`，`pitch` / `speed` 取 1-5。

### 2.4 图片转 3D — `POST /v1/async/image-to-3d`

模型：`Hunyuan3D-2`、`Hi3DGen`

multipart 参数：`model`、`image`、`seed`、`file_format`(`glb`/`stl`)。
Hunyuan3D-2 追加：`type`、`num_inference_steps`(1-20)、`octree_resolution`(64/128/256)、`guidance_scale`、`texture`(`true`/`false`)、`foreground_detection`、`mc_resolution`(默认 512)、`face_count`(默认 80000)。

## 3. Agent 行为约定

1. **免费优先**：文本、语音识别、语音合成优先选 🆓 模型；图像 / 视频 / 3D 为付费模型，调用前先向使用者确认。
2. **轮询纪律**：异步任务每 4 秒 GET 一次任务状态，最多 15 分钟；不要小于 1 秒的频率轰炸接口。
3. **错误处理**：HTTP 401 → 令牌无效，停止重试并提示使用者；429 / 5xx → 指数退避重试（最多 3 次）；其余 4xx 按 message 修正参数。
4. **产物落地**：结果 URL 直接交给使用者，或下载保存到项目 `output/` 目录；`file_url` 为百度云 BOS 签名链接，有效期约 7 天，需长期保留请及时下载。
5. **勿泄露令牌**：不要把 TOKEN 打印到日志、注释或对外输出中。

## 4. 端点速查表

| 功能 | 方法与路径 | 类型 | 费用 |
|---|---|---|---|
| 文本对话 | `POST /v1/chat/completions` | 同步 | 🆓 免费 |
| 文生图 | `POST /v1/images/generations` | 同步 | 付费 |
| 语音识别 | `POST /v1/audio/transcriptions` | 同步 | 🆓 免费 |
| 文生视频 | `POST /v1/async/videos/generations` | 异步 | 付费 |
| 图生视频 | `POST /v1/async/videos/image-to-video` | 异步 | 付费 |
| 语音合成 | `POST /v1/async/audio/speech` | 异步 | 🆓 免费 |
| 图片转 3D | `POST /v1/async/image-to-3d` | 异步 | 付费 |
| 文生图（大图异步） | `POST /v1/async/images/generations` | 异步 | 付费 |
| 任务轮询 | `GET /api/v1/task/{task_id}` | — | — |
| 取消任务 | `POST /api/v1/task/{task_id}/cancel` | — | — |

另有一些平台已知端点（人脸迁移 `/v1/images/face-migration`、文转 3D `/v1/async/text-to-3d`、文档解析 `/v1/async/documents/parse` 等），本文档未展开；使用前先向使用者确认需求与费用。
