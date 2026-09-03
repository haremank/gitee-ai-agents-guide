# 贡献指南

## 环境要求

- Node.js 20+（无任何 npm 依赖，脚本直接跑 Node 标准库）
- 发布资产需 GitHub CLI（`gh`）或网页操作

## 本地检查

改动 `gitee-ai-workbench.user.js` 后，提交前请过一遍（与 CI 相同的四项检查）：

```bash
node --check gitee-ai-workbench.user.js   # 语法
npm test                                  # 纯函数回归测试（tests/ 从脚本源码按名提取被测函数）
node scripts/check-version.mjs            # 脚本 @version 与 README 徽章一致
node -e "JSON.parse(require('node:fs').readFileSync('assets/gitee-serverless-controls.compact.json','utf8'))"
```

## 参数元数据再生成

`assets/gitee-serverless-controls.compact.json` 由两段脚本产出：

```bash
GITEE_AI_TOKEN=<令牌> npm run fetch-controls   # 抓取三个官方端点，聚合出 grouped.json（首次建议加 --raw 核对字段）
npm run build-controls -- grouped.json         # 压缩为 compact JSON 写入 assets/
```

令牌在 [Gitee AI Serverless API 页面](https://ai.gitee.com/serverless-api) 创建；不要把令牌写入任何文件、脚本或提交记录。

## 发布流程

1. 更新脚本头部 `@version`，并同步 README 顶部版本徽章（CI 校验两者一致）
2. 提交并推送 `main`
3. 打 Release 并附上脚本资产，**资产名必须是 `gitee-ai-workbench.user.js`**（README 直装链接按此名解析最新版）：

```bash
gh release create vX.Y.Z gitee-ai-workbench.user.js --title "..." --notes "..."
```

## 凭证与安全

- 任何情况下不得把令牌明文写入仓库、日志、脚本、环境变量、README、备份或全局 Git 配置（见 `AGENTS.md`）
- 文档与代码中的令牌一律使用占位符（`$GITEE_AI_TOKEN`、`<你的令牌>`）

## 测试说明

`tests/pure-functions.test.mjs` 通过按名提取脚本内的纯函数源码并隔离求值来断言行为，
覆盖 `safeTaskUrl`、`cloudTaskTimestamp`、`mediaKind` 等历次重构中出过回归的函数。
修改这些函数时请同步更新用例；函数重命名后需同步修改测试中的提取清单。
