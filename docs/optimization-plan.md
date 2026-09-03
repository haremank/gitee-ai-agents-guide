# Gitee AI 工作台优化方案

> 基于 2026-09-03 两轮独立代码/文档审查的遗留问题制定，适用版本 v2.9.4（本地未推送）。
> 行号以当前工作区为准，重构后会漂移，以函数名为锚。

## 现状小结

- 主脚本 `gitee-ai-workbench.user.js` 约 4790 行单文件 IIFE：CSS 约 800 行、三套弹窗 DOM 模板约 500 行、生成流程与云端任务各 400+ 行。
- 两轮审查已修复：状态栏 XSS、控制台表单崩溃与注入、任务 URL 令牌校验、轮询瞬断容错、`text_result` 全链路、时间戳归一化、IndexedDB `onblocked`、额度扣减覆盖异步任务等。
- 遗留：性能（本地库全量载入、全页扫描探测）、生命周期清理不完整、单文件巨石与三份重复的生成流程、构建数据断链、无 CI/测试、发布靠手工。

---

## P0 发布链路（立即，约半天）

**目标：让直装链接停止分发带 XSS 的 v2.9.3。**

| # | 事项 | 说明 |
|---|---|---|
| 1 | 推送本地 4 笔提交 | 需用户批准（仓库 AGENTS.md 凭证治理） |
| 2 | 打 `v2.9.4` Release | 上传 `gitee-ai-workbench.user.js`，**资产名必须与 README 直装链接一致** |
| 3 | 验证 | `releases/latest/download/gitee-ai-workbench.user.js` 返回的 `@version` 为 2.9.4 |

## P1 性能与稳定性（每项独立可交付，合计 1–2 天）

1. **本地生成库分页加载**（当前 `refreshLibrary` 用 `getAll()` 把全部记录含 blob 一次性载入内存，并为其全部创建 objectURL）
   - 游标 + 分页渲染（每页约 30 条，滚动加载更多）；
   - 图片入库时生成缩略图小 blob，列表用缩略图、点开才加载原图；
   - objectURL 按需创建、翻页/关闭时 revoke。
   - 验收：100+ 条记录面板秒开，内存平稳。
2. **令牌/额度探测性能**（现用 `querySelectorAll('*')` 全页扫描 + 逐元素 `innerText`）
   - 收窄选择器（`input[type=password]`、含"令牌/额度"文案的有限标签），或 TreeWalker 限深 6 层；
   - 强制刷新路径加节流（如 5s 内只扫一次）。
3. **生命周期治理**
   - `__Z_IMAGE_DESTROY__` 补：移除 window 级 mousemove/mouseup/touch/keydown 监听、`clearInterval(generateTimer)`、revoke 全部 objectURL；
   - 重复注入保护：头部检测 `window.__Z_IMAGE_VERSION__` 已存在则先调旧 destroy；
   - `GM_registerMenuCommand` 重复注入会累积菜单项，随注入保护一并解决。
4. **流式对话超时**：`timeout: 120000` 对 SSE 是总时长上限，长回复会被腰斩 → 改为空闲超时（每个 chunk 重置 60s 计时器）。
5. **本地库容量治理**：面板显示占用统计（条数/字节）；提供可配置上限，超限默认**提示清理**而非自动删除（自动淘汰最旧作为可选项）。

## P2 结构重构（2–4 天，动手前先落 P3.3 的测试）

前置决策见 D2（单文件 vs 打包）。

1. **抽公共层**（消灭重复热点）：
   - `notify(type, msg, { sticky })`：统一 11 处 `setTimeout(... statusBox.style.display='none')`；
   - `extFallback(kind)`：统一 3 处 `{video:'mp4',audio:'mpeg',model:'glb'}[kind]||'bin'`；
   - `requestErr(status, data)`：统一 10 处 `requestErrorMessage(status, data, data && data.raw)`；
   - `openDb(name, version, upgrade)`：合并 `openLibrary`/`openSettingsDb` 双份样板。
2. **统一异步生成流程**：`runJsonGeneration` / imageVideo / threeD 三份"提交 → 轮询 → 结果分发 → showResult → addToHistory → 扣额度"合并为一个 `runAsyncGeneration(endpoint, payload, {mode, model, prompt})`，URL/text 分支只写一处。
3. **死代码与冗余清理**：`historyList` 仅服务旧数据迁移（保留但加注释标注）；`safeGM.getValue` 内部已有 localStorage 回退，调用处双重回退冗余；静态 HTML 中被 `QUICK_IMAGE_SIZES` 覆盖的死尺寸选项（1536x864 / 2048x2048）删除或并入常量。
4. **CSS 与 DOM 模板外置**：若采纳 D2 打包方案，移到 `src/style.css` / 模板函数，构建时内联；否则至少切成带分隔的常量区块。

## P3 工程化与 CI（1–2 天，可与 P1/P2 并行穿插）

1. **补齐数据管线断链**：新增 `scripts/fetch-controls.mjs`，从 `GET /v1/models`、`GET /v1/json`、`GET /api/pay/service/operations?service_ident={model}` 抓取并聚合出 grouped JSON，替换现在依赖 `%TEMP%` 手工文件的输入。
2. **构建可复现**：`generatedAt` 改取源数据抓取日期（同输入同输出）；`build-controls-schema.mjs` 对冲突 key `console.warn`；把每个 operation 的真实 HTTP method 编码进 JSON 的 `o` 字段，消除"全按 POST 调用"的假设。
3. **纯函数测试**（`node:test`）：优先覆盖 `safeTaskUrl`、`cloudTaskTimestamp`、`cloudTaskLinkExpired`、`mediaKind`、`extFromUrl`、`sanitizeFilename`、`buildTextVideoPayload` 等——为此需把纯函数抽到可 import 的模块（依赖 D2）。
4. **GitHub Actions**：
   - PR/push：`node --check` + 测试 + 版本一致性校验（脚本头部 `@version` == README 徽章）；
   - tag `v*`：自动创建 Release 并上传 `.user.js` 资产（消除 P0 那类手工发布风险）。
5. **版本单一来源**：以脚本头部 `@version` 为准，README 徽章由校验脚本守护。

## P4 文档与数据（约半天）

1. `docs/gitee-ai-agents.md` 中 `/v1/async/text-to-3d`：实测确认存在则保留，否则删除。
2. README 增加 FAQ：IndexedDB 清理后果、固定目录授权失效处理、令牌安全（已有基础，整合成节）。
3. docs 增加"已知限制"：控制台 operations 元数据当前按 POST 处理、资源快照的回退策略、额度计数为本地估算。

---

## 里程碑

M1 = P0（发布止血）→ M2 = P1（性能稳定）→ M3 = P2（重构，依赖测试先行的部分 P3.3）→ M4 = P3/P4 收尾。

## 待确认决策

- **D1 推送与发布批准**：P0 需要；按仓库 AGENTS.md，使用 `github key token` 前须在本对话中获得明确批准。
- **D2 单文件 vs 构建打包**：推荐 `src/` 多模块 + esbuild 打包出单个 `.user.js`（直装体验不变，重构与测试才有落点）；不打包则 P2 只做函数级抽取，收益打折。
- **D3 容量治理策略**：推荐默认"超限提示"，自动淘汰最旧做成可选项。

## 风险与对策

- 无浏览器自动化测试 → 重构分小步、每步过"手动回归清单"；纯函数先测后动。
- 打包引入构建门槛 → CONTRIBUTING 写明 `npm run build` 一条命令出产物。
- 额度估算与平台语义差异 → 文档保持"以官网为准"措辞。

## 手动回归清单（每次发布前过一遍）

1. ai.gitee.com 与任一普通网站：悬浮球出现、面板打开、七种模式切换。
2. 文生图一次成功（额度 -1）、一次故意失败（错误为纯文本无 HTML 注入）。
3. 文生视频提交后立即取消；不带 `urls` 的场景（模拟）走规范轮询地址。
4. 控制台：断网时提示加载失败而非白屏；表单渲染文本/滑条/下拉/文件控件。
5. 云端任务：读取、预览、单条导入、批量导入、过期标记、移除后刷新不复现。
6. 本地库：新增、搜索、筛选、删除、清空；固定目录保存与授权失效提示。
7. Agent 指南导出与复制。
8. 控制台执行 `__Z_IMAGE_DESTROY__()` 后重载脚本，无重复悬浮球/菜单项。
