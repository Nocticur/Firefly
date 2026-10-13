# Vercel 环境变量添加回执与完整填写清单（2026-10-12 历史记录）

> **当前方案已更新（2026-10-13）：** 博客、`/admin/` 后台和 `/api/` 一起部署到现有 `firefly` 项目，根构建命令为 `pnpm build:vercel`。两个 Production origin 都填写 `https://blog.mourn.top`。以下项目数量、空值状态、旧后台域名及配置步骤仅记录 2026-10-12 的两项目操作，不代表当前平台状态，也不再作为部署指引。现行说明见 [deployment.md](./deployment.md) 与 [environment-variables.md](./environment-variables.md)。原 `firefly-admin` 的 Sensitive 值需从原服务安全填写到 `firefly`；本文不证明已迁移变量、删除旧项目或完成部署。

已于 2026-10-12 读取云端「Firefly」会话 `01a11bc4-1b2a-7705-aa6b-bc9ace087098` 的最新完成结果（提交 `77f00f6`），并与本地模板和源码核对。

- 博客 [firefly 环境变量](https://vercel.com/ymian3865-5221s-projects/firefly/settings/environment-variables)：15 个变量名、15 条记录。
- 新建后台 [firefly-admin 环境变量](https://vercel.com/ymian3865-5221s-projects/firefly-admin/settings/environment-variables)：38 个变量名、46 条记录；同名密码、摘要和 Turnstile 密钥按 Production / Preview / Development 分开。
- API 回读确认全部键名及目标环境存在，没有缺项。每条记录均有中文用途说明。
- 所有密码、连接串、私钥和 token 留空；仅填已知公开配置与默认关闭开关。填写空项时直接编辑原记录，不必重新添加。
- 当前账户页面显示 Hobby。没有升级套餐、购买附加项或创建数据库、Blob、邮件、Turnstile 服务，也没有创建后台部署或绑定新域名。

## 历史方案：先准备哪些

登录与编辑先填后台 Production 的 `ADMIN_ENTRY_PASSWORD`（3～10 个字符原密码）和 `ADMIN_PRODUCTION_DATABASE_URL`（Neon Free TLS 连接串）；数据库另须完成 4 条迁移。已有公开固定值已填。导入/发布再填 GitHub App 三项与 `VERCEL_TOKEN`；互动、媒体、邮件、维护等服务按需填写下表中的可选项。

后台项目 Root Directory 为 `apps/admin`，框架 Other，安装命令 `pnpm install --frozen-lockfile`，构建命令 `NITRO_PRESET=vercel pnpm build`，连接 `Nocticur/Firefly`。目前未部署，填写变量不等于已完成上线验收。

## 历史博客项目：全部 15 项

| 变量 | 环境 | 当前值/状态 | 用途与来源 |
| --- | --- | --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | Production、Preview、Development | 空值，待按需填写 | 待填写：Cloudflare Turnstile Free 的 Site key。生产允许 blog.mourn.top，与后台 TURNSTILE_SECRET_KEY 配对；隔离环境另用小组件。空值关闭提交，不开通付费服务。 |
| `PUBLIC_SITE_LANG` | Production、Preview、Development | 空值，待按需填写 | 可选：zh_CN/zh_TW/en/ja/ko/ru；留空保留当前中文配置。 |
| `PUBLIC_DISPLAY_SETTINGS` | Production、Preview、Development | 空值，待按需填写 | 可选：true/false 覆盖主题显示设置入口；空值沿用现配置。 |
| `PUBLIC_PAGES_FRIENDS` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_DYNAMIC` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_PROJECTS` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_GALLERY` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_BOOKNAV` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_BILIBILI` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_BANGUMI` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_VNDB` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_MAL` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `PUBLIC_PAGES_SPONSOR` | Production、Preview、Development | 空值，待按需填写 | 可选页面开关：true/false；空值沿用代码中的现有开关。 |
| `GITHUB_TOKEN` | Production | 空值，待按需填写 | 可选：博客构建时只读 GitHub API token，用于避免匿名限流；无需仓库写权限，不是后台发布凭据。 |

## 历史独立后台项目：全部 38 个变量名 / 46 条记录

| 变量 | 环境 | 当前值/状态 | 用途与来源 |
| --- | --- | --- | --- |
| `APP_ENV` | Production | `production` | 已填写：production；须与平台自动提供的 VERCEL_ENV 一致。 |
| `APP_ENV` | Preview | `preview` | 已填写：preview；须与平台自动提供的 VERCEL_ENV 一致。 |
| `APP_ENV` | Development | `development` | 已填写：development；须与平台自动提供的 VERCEL_ENV 一致。 |
| `GITHUB_REPOSITORY` | Production、Preview、Development | `Nocticur/Firefly` | 固定公开值：本站仓库，发布分支 master。 |
| `ADMIN_ENTRY_PASSWORD` | Production | 空值，待按需填写 | 待填写｜登录必需：3～10 个字符原密码，建议 10 位随机字符；后台自动加盐哈希，无需手工加密。production 使用独立密码。 |
| `ADMIN_ENTRY_PASSWORD` | Preview | 空值，待按需填写 | 待填写｜登录必需：3～10 个字符原密码，建议 10 位随机字符；后台自动加盐哈希，无需手工加密。preview 使用独立密码。 |
| `ADMIN_ENTRY_PASSWORD` | Development | 空值，待按需填写 | 待填写｜登录必需：3～10 个字符原密码，建议 10 位随机字符；后台自动加盐哈希，无需手工加密。development 使用独立密码。 |
| `ADMIN_ORIGIN` | Production | `https://admin.mourn.top` | 已填写：生产后台 HTTPS origin，无末尾 /；域名尚未在本次任务绑定。 |
| `PUBLIC_SITE_ORIGIN` | Production | `https://blog.mourn.top` | 已填写：生产博客 HTTPS origin，无末尾 /；域名尚未在本次任务绑定。 |
| `ADMIN_DEV_ORIGIN` | Development | `http://localhost:3000` | 本地后台默认 origin；使用 Vite 界面时改为 http://localhost:5173。 |
| `PUBLIC_DEV_ORIGIN` | Development | `http://localhost:4321` | 本地博客默认 origin。 |
| `ADMIN_PREVIEW_ORIGIN` | Preview | 空值，待按需填写 | 待填写｜隔离预览后台的精确 HTTPS origin，无末尾 /。 |
| `PUBLIC_PREVIEW_ORIGIN` | Preview | 空值，待按需填写 | 待填写｜隔离预览博客的精确 HTTPS origin；互动联调还需单独 API 转发。 |
| `ADMIN_PRODUCTION_DATABASE_URL` | Production | 空值，待按需填写 | 待填写｜登录和编辑必需：Neon Free 生产 PostgreSQL TLS 连接串。若已使用 DATABASE_URL 别名，两者不必重复填。 |
| `ADMIN_PREVIEW_DATABASE_URL` | Preview | 空值，待按需填写 | 待填写｜预览登录/编辑必需：独立 Neon Free 预览数据库，禁止复用生产连接。 |
| `ADMIN_DEVELOPMENT_DATABASE_URL` | Development | 空值，待按需填写 | 待填写｜开发登录/编辑必需：独立 PostgreSQL / Neon Free 开发数据库。 |
| `ADMIN_TEST_DATABASE_URL` | Development | 空值，待按需填写 | 可选｜仅自动化测试：专用隔离测试实例，禁止使用生产实例。 |
| `RESTORE_DATABASE_URL` | Production | 空值，待按需填写 | 可选｜恢复演练：独立 Free 数据库连接，数据库名须与生产不同并应用全部 4 条迁移。 |
| `GITHUB_APP_ID` | Production | 空值，待按需填写 | 待填写｜导入/发布：GitHub App 数字 App ID；免费使用，仅安装到 Nocticur/Firefly。 |
| `GITHUB_INSTALLATION_ID` | Production | 空值，待按需填写 | 待填写｜导入/发布：GitHub App 仓库安装 ID，不是 Client ID。 |
| `GITHUB_APP_PRIVATE_KEY` | Production | 空值，待按需填写 | 待填写｜导入/发布：GitHub App 多行 PEM 私钥；Contents read/write、Metadata read；不参与密码登录。 |
| `VERCEL_TOKEN` | Production | 空值，待按需填写 | 待填写｜发布核验：有权读取博客项目和部署的 Vercel Access Token；不是数据库/Blob token。 |
| `VERCEL_BLOG_PROJECT_ID` | Production | `prj_lIQjUgfWVL6f8XUdyOK7wsttWJZG` | 已填写：firefly 博客项目 ID（不是 firefly-admin 后台项目）。 |
| `VERCEL_TEAM_ID` | Production | `team_09F7sDf0p1hCd9apVLcHC2iU` | 已填写：ymian3865-5221s-projects 所属 Team ID；当前页面显示 Hobby。 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Production | 空值，待按需填写 | 可选｜仅博客部署保护阻止清单核验时填写专用绕过秘密；不需此功能可留空。 |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | Production | 空值，待按需填写 | 可选｜生产 private Blob store token：草稿原图和备份。仅在确认 Hobby 免费额度后填写；与公开 store 分开。 |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | Production | 空值，待按需填写 | 可选｜生产 public Blob store token：显式发布图片。仅在确认 Hobby 免费额度后填写；与私有 store 分开。 |
| `ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN` | Preview | 空值，待按需填写 | 可选｜Preview 独立 private Blob store token，不能复用生产或公开 store。 |
| `ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN` | Preview | 空值，待按需填写 | 可选｜Preview 独立 public Blob store token，不能复用生产或私有 store。 |
| `ADMIN_DEV_PRIVATE_BLOB_TOKEN` | Development | 空值，待按需填写 | 可选｜Development 独立 private Blob store token，不能复用生产或公开 store。 |
| `ADMIN_DEV_PUBLIC_BLOB_TOKEN` | Development | 空值，待按需填写 | 可选｜Development 独立 public Blob store token，不能复用生产或私有 store。 |
| `MEDIA_IMPORT_HOSTS` | Production、Preview、Development | 空值，待按需填写 | 可选｜外链图片导入的精确 HTTPS 主机白名单，逗号分隔，不填 URL/通配符；留空关闭导入。 |
| `TURNSTILE_SECRET_KEY` | Production | 空值，待按需填写 | 可选｜Cloudflare Turnstile Free 私钥，与当前环境博客 PUBLIC_TURNSTILE_SITE_KEY 配对；仅服务端填写。production 使用独立小组件。 |
| `INTERACTION_HASH_SECRET` | Production | 空值，待按需填写 | 建议单独填写｜至少 32 随机字节的稳定摘要密钥（例如 64 位随机十六进制）；不是付费 API key；轮换会影响访客封禁。production 使用独立值。 |
| `TURNSTILE_SECRET_KEY` | Preview | 空值，待按需填写 | 可选｜Cloudflare Turnstile Free 私钥，与当前环境博客 PUBLIC_TURNSTILE_SITE_KEY 配对；仅服务端填写。preview 使用独立小组件。 |
| `INTERACTION_HASH_SECRET` | Preview | 空值，待按需填写 | 建议单独填写｜至少 32 随机字节的稳定摘要密钥（例如 64 位随机十六进制）；不是付费 API key；轮换会影响访客封禁。preview 使用独立值。 |
| `TURNSTILE_SECRET_KEY` | Development | 空值，待按需填写 | 可选｜Cloudflare Turnstile Free 私钥，与当前环境博客 PUBLIC_TURNSTILE_SITE_KEY 配对；仅服务端填写。development 使用独立小组件。 |
| `INTERACTION_HASH_SECRET` | Development | 空值，待按需填写 | 建议单独填写｜至少 32 随机字节的稳定摘要密钥（例如 64 位随机十六进制）；不是付费 API key；轮换会影响访客封禁。development 使用独立值。 |
| `ENABLE_PUBLIC_COMMENTS` | Production、Preview、Development | `false` | 初始关闭：启用需 true、Turnstile 配置和前台 commentConfig.type=nocticur；友链申请不依赖此开关。 |
| `RESEND_API_KEY` | Production | 空值，待按需填写 | 可选｜Resend Free API key；邮件开关保持 false 时无需填写，不开通付费套餐。 |
| `RESEND_FROM` | Production | 空值，待按需填写 | 可选｜Resend 已验证发件人，如 Nocticur <nocticur@mourn.top>；不是收件地址。 |
| `RESEND_WEBHOOK_SECRET` | Production | 空值，待按需填写 | 可选｜Resend endpoint https://admin.mourn.top/api/webhooks/resend 的 Signing secret（whsec_…）。 |
| `CRON_SECRET` | Production | 空值，待按需填写 | 可选｜维护鉴权：自行生成独立至少 32 随机字节的密钥；维护关闭时无需填写。 |
| `ENABLE_PRODUCTION_PUBLISH` | Production | `false` | 初始关闭：只在配置和验收完成且确认免费额度后按需设 true；不升级套餐，不购买附加项。 |
| `ENABLE_PRODUCTION_EMAIL` | Production | `false` | 初始关闭：只在配置和验收完成且确认免费额度后按需设 true；不升级套餐，不购买附加项。 |
| `ENABLE_PRODUCTION_MAINTENANCE` | Production | `false` | 初始关闭：只在配置和验收完成且确认免费额度后按需设 true；不升级套餐，不购买附加项。 |

## 免费服务选择

本次只保存空值配置，不开通服务。后续保持 Vercel Hobby、Neon Free、Turnstile Free、Resend Free；Blob 和 Workflow 只在 Hobby 包含额度内使用。四个功能开关目前均为 `false`，所需服务未准备好时继续关闭。免费额度有上限，遇到要求付款或升级的功能则保持关闭。

- [Vercel Hobby 免费方案与超额暂停说明](https://vercel.com/docs/plans/hobby)
- [Blob Hobby 免费额度，public/private 均支持](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Workflow Hobby 包含额度](https://vercel.com/docs/workflows/pricing)
- [Neon Free PostgreSQL](https://neon.com/blog/neon-free-plan-1-gb-per-project)
- [Turnstile Free](https://developers.cloudflare.com/turnstile/plans/)
- [Resend Free](https://resend.com/pricing)

## 不需要填写的变量

Vercel 自动提供 `VERCEL`、`VERCEL_ENV`、`VERCEL_GIT_COMMIT_SHA`。构建工具提供 `NODE_ENV`、`DEV`、`PROD`、`BASE_URL`、`SITE`。`NITRO_PRESET=vercel` 已在后台构建命令中。

旧的 `ADMIN_GITHUB_USER_ID`、`GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET` 不再读取；也无需 `SESSION_SECRET`、`JWT_SECRET` 或 Workflow token。未创建 `CF_WORKERS`，因为包括字符串 `false` 在内的任何非空值都会切换到 Cloudflare adapter。

本次自动审批曾拦截含 `fluid: true` 设置的创建请求；已改用不含该设置的项目创建请求并成功。上线时 Workflow 所需的 Fluid compute 平台设置及免费适用性仍须核对，本次没有启用该设置。

逐项原始说明：`docs/nocticur/environment-variables.md`；部署与数据库迁移：`docs/nocticur/deployment.md`。真实秘密仅在对应服务的安全页面填写，不发送到聊天或提交到 Git。

