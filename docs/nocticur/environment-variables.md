# 环境变量

博客、`/admin/` 和 `/api/` 部署在同一个 Vercel `firefly` 项目。后台私有状态存 **Upstash Redis KV 或 Cloudflare KV**（二选一），图片走 CloudFlare-ImgBed；不需要数据库连接、建表或 SQL 迁移，也不使用 Vercel Blob。

变量在 Vercel 项目 **Settings → Environment Variables** 中配置。生产 Secret 只勾选 **Production**；Vercel 需开启 **Enable access to System Environment Variables**，否则读不到平台注入的地址与项目编号。

## 生产基础必填

| 变量 | 填什么 | 用途 |
| --- | --- | --- |
| `ADMIN_ENTRY_PASSWORD` | 自己设置的 3～10 个字符密码，建议 10 位随机字符；设为 **Secret** | 后台登录；服务端自动加盐 scrypt 哈希后核对 |
| `KV_PROVIDER` | 可选：`cloudflare` 或 `upstash`；两种都配置时用它指定 | 选择 KV 后端 |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID（32 位十六进制） | **Cloudflare 方案**：账户标识 |
| `CF_KV_NAMESPACE_ID` | Cloudflare KV 命名空间 ID（32 位十六进制） | **Cloudflare 方案**：KV 命名空间 |
| `CF_API_TOKEN` | Cloudflare API Token，权限至少 **Workers KV Storage:Edit**；设为 **Secret** | **Cloudflare 方案**：读写 KV |
| `KV_REST_API_URL` | Upstash 数据库页面的 **Endpoint**，形如 `https://xxx.upstash.io`（只填这一段） | **Upstash 方案**：REST 地址 |
| `KV_REST_API_TOKEN` | Upstash REST token；设为 **Secret** | **Upstash 方案**：写请求鉴权 |
| `IMGBED_API_TOKEN` | CloudFlare-ImgBed API Token；使用媒体库时必填，设为 **Secret** | 服务端上传图片到图床 |
| `IMGBED_BASE_URL` | 可选，默认 `https://image.nocticur.eu.cc` | 图床地址；只有地址改变时才填 |

**KV 二选一**：只填 Cloudflare 的 `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_API_TOKEN`，或只填 Upstash 的 `KV_REST_API_URL` / `KV_REST_API_TOKEN`。两者都填时默认使用 Cloudflare，可用 `KV_PROVIDER=upstash` 切回 Upstash。也接受 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_KV_NAMESPACE_ID`、`CLOUDFLARE_API_TOKEN` 别名。

生产缺少所选 KV 配置时后台明确报配置错误并拒绝保存，不会回退到内存或临时磁盘。首次写入自动创建状态文档，无需初始化。

> Cloudflare KV 是最终一致、无原子 CAS、同 key 约 1 次/秒写入；并发写可能后写覆盖、跨区域可能短暂读到旧值。个人单管理员博客通常可用，但高并发后台不适合。Upstash 提供强一致和原子 CAS，是更稳的选择。

## 发布与仓库

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GITHUB_APP_ID` | 发布/导入时 | GitHub App 编号，只安装到 `Nocticur/Firefly` |
| `GITHUB_APP_PRIVATE_KEY` | 发布/导入时 | App 私钥完整 PEM；设为 **Secret**；换行可写成 `\n` |
| `GITHUB_INSTALLATION_ID` | 可选 | 不填时由目标仓库接口自动查询 |
| `VERCEL_TOKEN` | 生产发布核验时必填 | Vercel Token，选择当前项目团队作用域；设为 **Secret** |
| `VERCEL_PROJECT_ID` | 可选 | Vercel 自动提供；也接受 `VERCEL_BLOG_PROJECT_ID` |
| `VERCEL_TEAM_ID` | 可选 | 团队作用域标识，仅有团队项目时需要 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 可选 | 生产域名启用 Deployment Protection 时，发布核验用它读取受保护清单 |

App 权限：Contents read/write、Metadata read。服务密钥不能填写到公开 JSON、文章、后台表单或 Git；后台只保存服务开关状态，不接收密钥。

## 互动

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | 开启评论/友链申请时 | Turnstile 小组件公钥，构建时注入前端；普通变量 |
| `TURNSTILE_SECRET_KEY` | 开启评论/友链申请时 | 对应私钥；设为 **Secret** |
| `INTERACTION_HASH_SECRET` | 可选 | 互动数据哈希密钥；不填默认复用 `TURNSTILE_SECRET_KEY` |
| `ENABLE_PUBLIC_COMMENTS` | 可选 | `true`/`false`；不填时跟随站点评论配置（当前为 Nocticur 评论） |
| `MEDIA_IMPORT_HOSTS` | 可选 | 外链导入允许的域名，逗号分隔；不填时用博客域名与已发布图片主机 |

公开写入还要求正确站点源、Turnstile 校验和限流；访客邮箱只用于人工联系，不公开展示。

## 维护

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CRON_SECRET` | 启用每日维护时必填 | 独立随机值；设为 **Secret**；Cron 接口以 `Authorization: Bearer` 校验 |

根 `vercel.json` 的 Cron 为 `/api/maintenance/cron`，时间 `0 19 * * *`（UTC，北京时间次日 03:00）。维护业务开关默认关闭，需在后台“服务设置”中显式开启；每日维护同时执行 30 天历史清理。

## 开发与预览可选

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_DEV_ORIGIN` | `http://localhost:3000` | 开发时管理 API 允许的源；用 Vite 5173 发起有会话写请求时改为 `http://localhost:5173` |
| `PUBLIC_DEV_ORIGIN` | `http://localhost:4321` | 开发时博客源 |
| `ADMIN_PREVIEW_ORIGIN` | 平台 `VERCEL_URL` | 预览环境管理源覆盖 |
| `PUBLIC_PREVIEW_ORIGIN` | 平台 `VERCEL_URL` | 预览环境博客源覆盖 |
| `ADMIN_DEV_KV_REST_API_URL` / `ADMIN_DEV_KV_REST_API_TOKEN` | 不填用内存存储 | 开发环境独立 Upstash |
| `ADMIN_DEV_CF_ACCOUNT_ID` / `ADMIN_DEV_CF_KV_NAMESPACE_ID` / `ADMIN_DEV_CF_API_TOKEN` | 不填用内存存储 | 开发环境独立 Cloudflare KV |
| `ADMIN_PREVIEW_KV_REST_API_URL` / `ADMIN_PREVIEW_KV_REST_API_TOKEN` | 不填用内存存储 | 预览环境独立 Upstash |
| `ADMIN_PREVIEW_CF_ACCOUNT_ID` / `ADMIN_PREVIEW_CF_KV_NAMESPACE_ID` / `ADMIN_PREVIEW_CF_API_TOKEN` | 不填用内存存储 | 预览环境独立 Cloudflare KV |

开发/预览未配置独立 KV 时使用内存存储，重启清空；两者都必须与生产 KV 不同，否则后台拒绝启动。每个非生产环境还需自己的后台密码与第三方服务凭据。本地默认 `development`，不需要 `APP_ENV`。

## Vercel 自动提供，不要手填

以下由平台注入，通常只在本地调试时手动导出：

`VERCEL_ENV`、`VERCEL_URL`、`VERCEL_PROJECT_PRODUCTION_URL`、`VERCEL_PROJECT_ID`、`VERCEL_GIT_COMMIT_SHA`、`VERCEL`。

`GITHUB_REPOSITORY` 默认 `Nocticur/Firefly`，只有改仓库名时才需要填写；它也参与 `siteId`，改动会指向新的 KV key。

## 必须删除的旧变量

- `BLOB_PRIVATE_READ_WRITE_TOKEN`、`BLOB_PUBLIC_READ_WRITE_TOKEN`
- `ADMIN_DEV_PRIVATE_BLOB_TOKEN`、`ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN`
- `ADMIN_ORIGIN`、`PUBLIC_SITE_ORIGIN`（已改为读取 Vercel 项目地址）
- 所有数据库变量（`DATABASE_URL`、`POSTGRES_*`、Neon 连接串等）

从 Blob 迁移期间可临时保留 `BLOB_PRIVATE_READ_WRITE_TOKEN`，用生产凭据在本地运行 `pnpm exec tsx scripts/migrate-blob-to-kv.ts`（需要所选 KV 的凭据：Cloudflare 三件套或 Upstash URL/TOKEN；脚本通过原始 HTTPS 读取 Blob，不依赖 `@vercel/blob`）；迁移完成并验证后删除该脚本与 `BLOB_PRIVATE_READ_WRITE_TOKEN`。不要再新增任何 Blob 或数据库变量。

## KV 的定位

Upstash / Cloudflare KV 在这里只当键值存储使用，**不是关系型数据库**：没有表、索引、SQL、连接池或迁移命令。后台把整个状态文档压缩后写入键值；Upstash 用 Redis 脚本按 ETag 原子交换，Cloudflare KV 只能读后写并在写入前比较内容摘要（无原子 CAS）。备份是 `admin-backup:<sha256(siteId)>:<sha256(backupId)>:<checksum>` 的不可变对象。状态文档解码后上限 16 MiB、编码后上限 8 MiB，单个备份上限 8 MiB；达到上限会返回 `507` 并拒绝写入，应清理历史而不是升级套餐。

## 服务开关与隔离

登录 `/admin/` 的“服务设置”，按需开启生产发布和生产维护，两项默认关闭；保存后立即生效。写入继续校验管理员会话、同源 Origin、CSRF 和修订号。Preview/Development 永远不能开启生产操作，也不会读取生产 KV。

## 个人邮箱

个人联系邮箱 `youjinmian@outlook.com` 通过博客邮箱链接联系，无需发信服务变量。评论和友链申请中的访客邮箱用于必要时人工联系，不公开展示；后台不自动发送回复、审核或上线邮件。

配置和代码修改需要重新部署才会在线上生效；完整统一构建命令为 `pnpm build:vercel`。部署步骤见 [统一部署](./deployment.md)，额度见 [免费部署说明](./free-deployment.md)。
