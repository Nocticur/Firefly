# 博客与后台统一部署

博客、`/admin/`、`/api/` 和 Workflow 部署在同一个 Vercel 项目 `firefly`。根构建命令保持 `pnpm build:vercel`，生成一份 `.vercel/output`；后台源码在 `apps/admin`，不需要第二个托管项目。后台直接读写你的 GitHub 仓库并通过令牌提交到 `master`，图片存 CloudFlare-ImgBed。不使用数据库、Cloudflare KV、Vercel Blob 或 Upstash。

## 前置服务

| 服务 | 用途 | 必需 |
| --- | --- | --- |
| Vercel 项目 `firefly` | 托管博客、后台、API 与 Workflow | 是 |
| GitHub 仓库 + PAT | 后台唯一数据源；读取基线、提交 `master`、更新检查 | 是 |
| CloudFlare-ImgBed | 图片上传与外链导入 | 使用媒体库时必需 |
| Vercel Token | 发布后核验生产部署与清单 | 发布时必需 |
| Turnstile | 公开评论与友链申请校验 | 开启公开互动时必需 |

## 连接你的 Git 仓库

后台以 Git 仓库为唯一数据源，不需要数据库或 Cloudflare KV。

1. 在 GitHub 创建 **Fine-grained personal access token**：打开 <https://github.com/settings/personal-access-tokens/new>，只授权**本项目仓库** `Nocticur/Firefly`（后台与博客在同一个仓库）。
   - 已有令牌的权限或有效期要改，用 <https://github.com/settings/personal-access-tokens> 编辑，或删除后新建。
   - 需要更换令牌时，新建一个再替换 Vercel 里的 `GITHUB_TOKEN` 即可，旧令牌随后删除。
2. 权限：**Contents = Read and write**（提交文章与设置）、**Metadata = Read**（GitHub 强制要求）。
3. 在 Vercel 项目里配置（Project → Settings → Environment Variables，<https://vercel.com/dashboard>）：
   - `GITHUB_TOKEN`：上一步的令牌（Secret，仅 Production）
   - `GITHUB_REPOSITORY`：默认值就是 `Nocticur/Firefly`，**通常无需填写**。若填写，必须与实际拥有权限的仓库一致，否则会因 404 报「无法读取」
   - `GITHUB_BRANCH`：默认 `master`，通常无需填写
4. 改完环境变量必须 **重新部署**（Redeploy）才会生效。
5. 部署后打开 `/admin/` 输入 `ADMIN_ENTRY_PASSWORD` 登录，后台会自动导入仓库现有文章与设置，不会显示空白。

仓库需要至少有一篇文章（`src/content/posts/**`），并且设置来源满足其一：已有 `src/data/managed-settings.json`（本项目已包含），或可解析的 `src/config/siteConfig.ts`（后台会从 `title`、`subtitle`、`site_url`、`description`、`siteStartDate`、`timezone`、`navbar.logo.value`、`pages.*` 推导初始值）。

Cloudflare KV 已不再需要；若历史上配置过 `CF_*`，可以删除。开发/预览默认也不需要任何存储配置。

## 排查「GitHub 仓库暂时无法读取」

这条提示说明后台拿到了 HTTP 错误，具体原因由状态码决定。先在本地跑自检脚本（它只读环境变量，不会打印令牌）：

```bash
# 在仓库根目录（本项目 GITHUB_REPOSITORY 默认就是 Nocticur/Firefly，可省略）
GITHUB_TOKEN=... GITHUB_REPOSITORY=Nocticur/Firefly GITHUB_BRANCH=master node scripts/check-github-access.mjs
```

也可以把变量写进本地 `.env`，脚本会自动读取。输出会指出仓库、分支、文章数、设置来源和令牌权限。

| 状态码 | 含义 | 处理 |
| --- | --- | --- |
| `401` | 令牌无效、已过期或已被撤销 | 到 <https://github.com/settings/personal-access-tokens> 重新生成，更新 Vercel 的 `GITHUB_TOKEN` 后重新部署 |
| `403` | 令牌权限不足或触发限流 | 确认该令牌对目标仓库有 **Contents: Read and write**；限流通常等待后自动恢复 |
| `404` | 仓库/分支不存在，或令牌未授权该仓库 | 核对 `GITHUB_REPOSITORY`、`GITHUB_BRANCH`，并检查令牌的 **Repository access** 是否包含该仓库 |
| `0` / 超时 | 无法连接 `api.github.com` | 检查部署环境的出网访问与 DNS |

最常见的原因有两个：**令牌授权的仓库与 `GITHUB_REPOSITORY` 不是同一个**（令牌只授权了 A 仓库，却让后台读 B 仓库）；以及**改了环境变量却没重新部署**。后台现在会在错误信息里带上实际状态码、仓库与分支，不再是笼统的一句话。

GitHub App 路径仍然保留，但只在完全没有 `GITHUB_TOKEN` 时才会使用；那条路径要求 App 已安装到 `GITHUB_REPOSITORY` 指定的仓库。**推荐直接配置 PAT，把 `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` 删掉**，避免走错分支。

## 配置 CloudFlare-ImgBed

1. 部署好自己的 CloudFlare-ImgBed 实例，取得 API Token 和站点地址。
2. 配置 `IMGBED_API_TOKEN`（Secret，仅 Production）与 `IMGBED_BASE_URL`（可选，默认 `https://image.nocticur.eu.cc`）。
3. 后台调用 `POST <IMGBED_BASE_URL>/upload?returnFormat=full&autoRetry=false`，以 `Authorization: Bearer <IMGBED_API_TOKEN>` 上传，并保存返回的 HTTPS 图片地址。
4. 图片由 ImgBed 直接提供；Vercel 函数请求体约 4.5 MiB，因此直接上传限制 4 MiB，更大的图片请用外链导入（最大 32 MiB）。

## 配置 GitHub 令牌与 Vercel

- GitHub：优先使用 `GITHUB_TOKEN`（细粒度 PAT，权限 Contents read/write + Metadata read）。GitHub App（`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`，`GITHUB_INSTALLATION_ID` 可选）只在没有 PAT 时作为回退。
- 生产核验：配置 `VERCEL_TOKEN`（Secret，选择当前项目团队作用域）、可选 `VERCEL_TEAM_ID`；项目编号读取系统变量 `VERCEL_PROJECT_ID`（也接受 `VERCEL_BLOG_PROJECT_ID`）。
- 若生产域名启用了 Deployment Protection，配置可选 `VERCEL_AUTOMATION_BYPASS_SECRET`，供发布核验读取受保护清单。
- Vercel 项目需开启 **Enable access to System Environment Variables**，否则读不到 `VERCEL_ENV`、`VERCEL_URL`、`VERCEL_PROJECT_PRODUCTION_URL`、`VERCEL_PROJECT_ID`、`VERCEL_GIT_COMMIT_SHA` 等。

完整变量清单见 [环境变量说明](./environment-variables.md)。

## Cron 与维护

根 `vercel.json` 已声明每日 Cron：路径 `/api/maintenance/cron`，时间 `0 19 * * *`（UTC），即北京时间次日 03:00。启用时配置 `CRON_SECRET`（Secret，仅 Production），接口以 `Authorization: Bearer` 校验。维护开关默认关闭，需管理员在后台“服务设置”中开启；每日维护会清理超过 30 天的文章历史、已结束发布任务与备份对象，当前文章、未完成任务和待核验记录保留。

## 首次部署

1. 安装依赖：`pnpm install --frozen-lockfile`。
2. 本地校验：`pnpm check`、`pnpm type-check`、`pnpm test:site`、`pnpm --filter @nocticur/admin type-check`、`pnpm --filter @nocticur/admin test`。
3. 执行一次 `pnpm build:vercel`，确认生成 `.vercel/output` 且包含博客静态文件、管理资源、API 与 Workflow。
4. 在 Vercel 导入仓库，项目根目录构建命令保持 `pnpm build:vercel`，安装命令 `pnpm install --frozen-lockfile`；不要为 `apps/admin` 另建项目。
5. 按上节添加 `ADMIN_ENTRY_PASSWORD`、`GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`GITHUB_BRANCH`、ImgBed、Vercel Token 等变量；生产 Secret 只勾选 Production。
6. 部署后先登录 `/admin/`，依次验证会话刷新、退出、草稿保存与重读、媒体上传、一次显式发布、生产核验与备份；确认无误后再开启生产发布与每日维护。

## 从 Cloudflare KV 版本迁移

本版本不再需要任何数据库或键值存储。若你此前配置过 Cloudflare KV：

1. 删除 Vercel 项目里的 `CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`、`CF_API_TOKEN`（以及 `ADMIN_DEV_CF_*` / `ADMIN_PREVIEW_CF_*`）。残留不会改变行为，但会掩盖配置错误。
2. 确认 `GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`GITHUB_BRANCH` 已配置，且仓库里确实有文章与设置来源，否则后台会以 `BASELINE_CONFIGURATION_REQUIRED` / `REPOSITORY_POSTS_MISSING` 明确报错而不是显示空白。
3. 旧 KV 里的私有草稿不会被自动迁移到 Git；如需保留，先在旧版本里导出，再在新版本中重新保存。旧命名空间确认无用后再删除。

## 验证步骤

1. `pnpm build:vercel` 通过，产物含静态博客、`/admin/`、`/api/` 与 Workflow。
2. 登录 `/admin/` 后获得服务端签名 Cookie 会话；错误密码被拒绝，写请求在缺少 CSRF 或跨源时失败。
3. 未配置任何 KV 时后台正常启动，文章与设置直接从 Git 读取；配置残缺的 KV 三件套时报 `KV_CONFIGURATION_REQUIRED`，不会静默切换存储。
4. 保存草稿、刷新页面后仍可读取；并发保存返回冲突而不是覆盖。
5. 上传图片成功并返回 ImgBed HTTPS 地址；超过 4 MiB 的直接上传和外链导入超过 32 MiB 时报 413。
6. 发布任务提交到 Git `master`，核验生产域名、Git SHA 与发布清单；未配置 KV 时发布在同一请求内直接完成提交与核验，失败或结果未知时可核查。
7. Cron 仅在生产以正确的 Bearer 密钥执行；维护与发布开关默认关闭。
8. 设置保存后可用 `POST /api/settings/commit` 立即提交回仓库，提交后基线同步推进，下一次发布不会误报外部改动。

## 回滚

代码回滚使用新的 Git revert 提交并重新完整构建，不使用 force push 重写历史。Vercel 回滚代码不会自动回滚 Git 提交或 ImgBed 图片；回滚前先核对内容与设置文件的兼容性。套餐与额度见 [免费部署说明](./free-deployment.md)。
