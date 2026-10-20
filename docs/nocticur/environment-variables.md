# 环境变量

博客、`/admin/` 和 `/api/` 部署在同一个 Vercel `firefly` 项目。后台私有状态与备份存 **Cloudflare KV**（REST API），图片走 CloudFlare-ImgBed；不需要数据库连接、建表或 SQL 迁移，也不使用 Vercel Blob 或 Upstash。

变量在 Vercel 项目 **Settings → Environment Variables** 中配置。生产 Secret 只勾选 **Production**；Vercel 需开启 **Enable access to System Environment Variables**，否则读不到平台注入的地址与项目编号。

## 生产基础必填

| 变量 | 填什么 | 用途 |
| --- | --- | --- |
| `ADMIN_ENTRY_PASSWORD` | 自己设置的 3～10 个字符密码，建议 10 位随机字符；设为 **Secret** | 后台登录；服务端自动加盐 scrypt 哈希后核对 |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID（32 位十六进制） | 账户标识；也接受 `CLOUDFLARE_ACCOUNT_ID` 别名 |
| `CF_KV_NAMESPACE_ID` | Cloudflare KV 命名空间 ID（32 位十六进制） | KV 命名空间；也接受 `CLOUDFLARE_KV_NAMESPACE_ID` 别名 |
| `CF_API_TOKEN` | Cloudflare API Token，权限至少 **Workers KV Storage:Edit**；设为 **Secret** | 读写 KV；也接受 `CLOUDFLARE_API_TOKEN` 别名 |
| `IMGBED_API_TOKEN` | CloudFlare-ImgBed API Token；使用媒体库时必填，设为 **Secret** | 服务端上传图片到图床 |
| `IMGBED_BASE_URL` | 可选，默认 `https://image.nocticur.eu.cc` | 图床地址；只有地址改变时才填 |

Cloudflare KV 是唯一后端，三项 `CF_*` 要么全部配置，要么全部不配置；只配一部分会明确报 `KV_CONFIGURATION_REQUIRED`。

生产缺少 Cloudflare KV 时后台明确报配置错误并拒绝保存，不会回退到内存或临时磁盘。首次写入自动创建状态文档，无需初始化。

> Cloudflare KV 是最终一致、无原子 CAS、同 key 约 1 次/秒写入；并发写可能后写覆盖、跨区域可能短暂读到旧值。后台按单人管理场景处理：保存时校验修订号与内容摘要，冲突返回 `409` 并提示刷新后重新编辑，不做分布式锁，也不声称强一致。

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
| `ADMIN_DEV_CF_ACCOUNT_ID` / `ADMIN_DEV_CF_KV_NAMESPACE_ID` / `ADMIN_DEV_CF_API_TOKEN` | 不填用内存存储 | 开发环境独立 Cloudflare KV |
| `ADMIN_PREVIEW_CF_ACCOUNT_ID` / `ADMIN_PREVIEW_CF_KV_NAMESPACE_ID` / `ADMIN_PREVIEW_CF_API_TOKEN` | 不填用内存存储 | 预览环境独立 Cloudflare KV |

开发/预览未配置独立 KV 时使用内存存储，重启清空；两者都必须与生产 KV 不同（比较账户 ID 与命名空间 ID），否则后台拒绝启动。每个非生产环境还需自己的后台密码与第三方服务凭据。本地默认 `development`，不需要 `APP_ENV`。

## Vercel 自动提供，不要手填

以下由平台注入，通常只在本地调试时手动导出：

`VERCEL_ENV`、`VERCEL_URL`、`VERCEL_PROJECT_PRODUCTION_URL`、`VERCEL_PROJECT_ID`、`VERCEL_GIT_COMMIT_SHA`、`VERCEL`。

`GITHUB_REPOSITORY` 默认 `Nocticur/Firefly`，只有改仓库名时才需要填写；它也参与 `siteId`，改动会指向新的 KV key。

## 必须删除的旧变量

- `BLOB_PRIVATE_READ_WRITE_TOKEN`、`BLOB_PUBLIC_READ_WRITE_TOKEN`
- `ADMIN_DEV_PRIVATE_BLOB_TOKEN`、`ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN`
- `KV_PROVIDER`、`KV_REST_API_URL`、`KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`、`ADMIN_DEV_KV_REST_API_*`、`ADMIN_PREVIEW_KV_REST_API_*`
- `ADMIN_ORIGIN`、`PUBLIC_SITE_ORIGIN`（已改为读取 Vercel 项目地址）
- 所有数据库变量（`DATABASE_URL`、`POSTGRES_*`、Neon 连接串等）

以上变量在运行时不再被读取，残留不会改变行为；保留它们只会掩盖配置错误，应尽快清理。

旧 Vercel Blob 里如果还有历史草稿或媒体，切换前用一次性脚本 `pnpm exec tsx scripts/migrate-blob-to-kv.ts` 迁移（需要 `BLOB_PRIVATE_READ_WRITE_TOKEN`、ImgBed 变量与 Cloudflare 三件套，并设置 `APP_ENV=production`、`GITHUB_REPOSITORY`）。脚本只走原始 HTTPS，不依赖 `@vercel/blob`，把旧草稿媒体上传到 ImgBed 并写入 Cloudflare KV 后再校验读回校验和；如果 KV 已有状态则拒绝覆盖。迁移校验通过后删除脚本与 `BLOB_PRIVATE_READ_WRITE_TOKEN`，线上运行时不访问 Blob。

## KV 的定位

Cloudflare KV 在这里只当键值存储使用，**不是关系型数据库**：没有表、索引、SQL、连接池或迁移命令。后台把整个状态文档 JSON 压缩后写入 `admin-state:<sha256(siteId)>:data`；KV 没有原子 CAS，只能读后写并在写入前比较内容摘要与修订号。备份是 `admin-backup:<sha256(siteId)>:<sha256(backupId)>:<checksum>` 的不可变对象，写入后回读校验 SHA-256。状态文档解码后上限 16 MiB、编码后上限 8 MiB，单个备份上限 8 MiB；达到上限会返回 `507` 并拒绝写入，应清理历史而不是升级套餐。

## 错误语义

| 情况 | 返回 | 后台表现 |
| --- | --- | --- |
| 未配置或配置不完整 | `503 KV_CONFIGURATION_REQUIRED` | 明确提示补充 `CF_*` 变量 |
| Cloudflare 请求失败或重试耗尽 | `503 KV_UNAVAILABLE` | 提示存储暂不可用、稍后重试 |
| 环境隔离校验失败 | `503 KV_ENVIRONMENT_NOT_ISOLATED` | 拒绝启动，提示换用独立命名空间 |
| 修订号/摘要冲突 | `409 FILE_STORE_CONFLICT` | 提示刷新后重新编辑，不覆盖服务器版本 |
| 状态或备份过大 | `507 FILE_STORE_TOO_LARGE` | 提示清理历史或减少媒体记录 |
| 状态内容损坏 | `503 FILE_STORE_INVALID` | 停止写入，需从备份恢复 |

## 服务开关与隔离

登录 `/admin/` 的“服务设置”，按需开启生产发布和生产维护，两项默认关闭；保存后立即生效。写入继续校验管理员会话、同源 Origin、CSRF 和修订号。Preview/Development 永远不能开启生产操作，也不会读取生产 KV。

## 个人邮箱

个人联系邮箱 `youjinmian@outlook.com` 通过博客邮箱链接联系，无需发信服务变量。评论和友链申请中的访客邮箱用于必要时人工联系，不公开展示；后台不自动发送回复、审核或上线邮件。

配置和代码修改需要重新部署才会在线上生效；完整统一构建命令为 `pnpm build:vercel`。部署步骤见 [统一部署](./deployment.md)，额度见 [免费部署说明](./free-deployment.md)。
