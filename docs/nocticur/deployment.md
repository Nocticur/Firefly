# 博客与后台统一部署

博客、`/admin/`、`/api/` 和 Workflow 部署在同一个 Vercel 项目 `firefly`。根构建命令保持 `pnpm build:vercel`，生成一份 `.vercel/output`；后台源码在 `apps/admin`，不需要第二个托管项目。正式内容由 GitHub App 提交到 GitHub `master`，后台私有状态与备份存 Cloudflare KV（REST API），图片存 CloudFlare-ImgBed。不使用 Vercel Blob、Upstash，也不使用数据库。

## 前置服务

| 服务 | 用途 | 必需 |
| --- | --- | --- |
| Vercel 项目 `firefly` | 托管博客、后台、API 与 Workflow | 是 |
| Cloudflare KV | 后台私有状态与备份对象；通过 REST API 访问 | 是（生产唯一存储） |
| CloudFlare-ImgBed | 图片上传与外链导入 | 使用媒体库时必需 |
| GitHub App | 读取基线、原子提交 `master`、更新检查 | 发布文章/设置时必需 |
| Vercel Token | 发布后核验生产部署与清单 | 发布时必需 |
| Turnstile | 公开评论与友链申请校验 | 开启公开互动时必需 |

## 添加 Cloudflare KV

1. 在 Cloudflare 控制台创建或选择一个 **KV namespace**。
2. 创建 API Token，权限至少 **Workers KV Storage:Edit**，并记录：
   - `CF_ACCOUNT_ID`：Cloudflare 账户 ID（32 位十六进制）
   - `CF_KV_NAMESPACE_ID`：KV 命名空间 ID（32 位十六进制）
   - `CF_API_TOKEN`：上一步的 Token（Secret，仅 Production）
3. 三项必须同时配置；只配一部分会报 `KV_CONFIGURATION_REQUIRED`。不再有 `KV_PROVIDER` 切换开关。
4. 说明：Cloudflare KV 是最终一致、无原子 CAS、同 key 约 1 次/秒写入。个人单管理员博客通常可用；并发写可能后写覆盖，跨区域可能短暂读到旧值，后台以修订号与内容摘要检测冲突并返回 `409`。

开发/预览需要独立数据时，配置 `ADMIN_DEV_CF_*` / `ADMIN_PREVIEW_CF_*`（账户 ID、命名空间 ID、Token 三件套）。不配置时开发/预览使用内存存储，重启即清空；生产不会回退到内存，也不会与开发/预览共用同一个命名空间。

## 配置 CloudFlare-ImgBed

1. 部署好自己的 CloudFlare-ImgBed 实例，取得 API Token 和站点地址。
2. 配置 `IMGBED_API_TOKEN`（Secret，仅 Production）与 `IMGBED_BASE_URL`（可选，默认 `https://image.nocticur.eu.cc`）。
3. 后台调用 `POST <IMGBED_BASE_URL>/upload?returnFormat=full&autoRetry=false`，以 `Authorization: Bearer <IMGBED_API_TOKEN>` 上传，并保存返回的 HTTPS 图片地址。
4. 图片由 ImgBed 直接提供；Vercel 函数请求体约 4.5 MiB，因此直接上传限制 4 MiB，更大的图片请用外链导入（最大 32 MiB）。

## 配置 GitHub App 与 Vercel

- GitHub App：安装到 `Nocticur/Firefly`，权限为 Contents read/write、Metadata read；配置 `GITHUB_APP_ID` 与完整 PEM 的 `GITHUB_APP_PRIVATE_KEY`（Secret）。`GITHUB_INSTALLATION_ID` 可选，不填时由目标仓库接口自动查询。
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
5. 按上节添加 Cloudflare KV、ImgBed、GitHub App、Vercel Token 等变量；生产 Secret 只勾选 Production。
6. 部署后先登录 `/admin/`，依次验证会话刷新、退出、草稿保存与重读、媒体上传、一次显式发布、生产核验与备份；确认无误后再开启生产发布与每日维护。

## 从 Vercel Blob 一次性切换

本版本只支持 Cloudflare KV，不做 Blob/KV 双写，也不保留运行时 Blob 回退。切换顺序如下，旧 Blob 数据在新版本验证通过前不要删除：

1. **迁移脚本**：用生产凭据在本地运行 `pnpm exec tsx scripts/migrate-blob-to-kv.ts`（需要 `BLOB_PRIVATE_READ_WRITE_TOKEN`、ImgBed 变量，以及 `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_API_TOKEN`；并设置 `APP_ENV=production` 与 `GITHUB_REPOSITORY`）。脚本通过原始 HTTPS 读取旧 Blob 私有状态（不依赖 `@vercel/blob`），把旧草稿媒体上传到 ImgBed 并写入 Cloudflare KV，最后校验读回校验和；已有 KV 状态时拒绝覆盖。旧 Blob 备份对象不会被复制。
2. **部署**：配置 Cloudflare KV 三件套与 ImgBed 变量后部署新版本。新版本运行时不再读取任何 Blob 变量。
3. **验证**：登录后台，核对草稿、历史、会话、评论/友链审核、发布任务、备份索引与备份恢复；上传一张图片确认进入 ImgBed；创建并完成一次生产发布，检查 Git 提交、部署 SHA 与发布清单。
4. **清理**：删除 Vercel 项目里的 `BLOB_PRIVATE_READ_WRITE_TOKEN`、`BLOB_PUBLIC_READ_WRITE_TOKEN` 及开发/预览 Blob token，删除旧 Blob store 与 `scripts/migrate-blob-to-kv.ts`。

无法访问旧 Blob 凭据或迁移校验失败时必须阻断切换，不要直接部署，否则旧草稿与媒体记录会静默丢失。

## 验证步骤

1. `pnpm build:vercel` 通过，产物含静态博客、`/admin/`、`/api/` 与 Workflow。
2. 登录 `/admin/` 后获得服务端会话；错误密码被拒绝，写请求在缺少 CSRF 或跨源时失败。
3. 生产环境缺少 `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_API_TOKEN` 时后台明确报配置错误，而不是静默使用内存；开发/预览未配置独立 KV 时使用内存存储且重启清空。
4. 保存草稿、刷新页面后仍可读取；并发保存返回冲突而不是覆盖。
5. 上传图片成功并返回 ImgBed HTTPS 地址；超过 4 MiB 的直接上传和外链导入超过 32 MiB 时报 413。
6. 发布任务提交到 Git `master`，Workflow 核验生产域名、Git SHA 与发布清单；失败或结果未知时可核查。
7. Cron 仅在生产以正确的 Bearer 密钥执行；维护与发布开关默认关闭。
8. 创建备份后在 KV 中可见 `admin-backup:...` 对象，恢复前会校验站点、版本与校验和。

## 回滚

代码回滚使用新的 Git revert 提交并重新完整构建，不使用 force push 重写历史。Vercel 回滚代码不会自动回滚 Git 提交、KV 状态或 ImgBed 图片；回滚前先核对状态版本兼容性，必要时用迁移期备份恢复。套餐与额度见 [免费部署说明](./free-deployment.md)。
