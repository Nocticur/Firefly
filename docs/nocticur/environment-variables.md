# 环境变量填写清单

博客和后台是两个 Vercel 项目。除博客构建变量外，其余均填在**管理项目**的 Settings → Environment Variables。生产秘密只勾选 Production；Preview、Development 使用隔离服务。秘密值不要发到聊天或写入 Git。当前云环境没有配置这些生产凭据；本清单不是配置成功回执。

## 博客项目

身份、域名、文章和头像已经写入代码，静态博客构建不需要后台服务秘密。

| 变量 | 条件 | 填什么 / 从哪里取得 |
| --- | --- | --- |
| `PUBLIC_TURNSTILE_SITE_KEY` | 友链申请/评论需要 | Cloudflare Turnstile 的 **Site key**，允许主机 `blog.mourn.top`；与后台 Secret key 来自同一小组件。这是可公开的公钥 |
| `PUBLIC_SITE_LANG` | 可选 | `zh_CN`、`zh_TW`、`en`、`ja`、`ko`、`ru`；留空沿用中文 |
| `PUBLIC_DISPLAY_SETTINGS` | 可选 | `true` / `false`，覆盖主题显示设置入口；留空保留现配置 |
| `PUBLIC_PAGES_<KEY>` | 可选 | 页面开关 `true` / `false`；完整键名见下文 |
| `GITHUB_TOKEN` | 可选，仅构建 | GitHub 卡片脚本的 API 读取凭据，用于减少匿名限流，不需要仓库写权限；不是后台登录/发布凭据，不加 `PUBLIC_` 前缀 |

页面键名：`PUBLIC_PAGES_FRIENDS`、`PUBLIC_PAGES_GUESTBOOK`、`PUBLIC_PAGES_DYNAMIC`、`PUBLIC_PAGES_PROJECTS`、`PUBLIC_PAGES_GALLERY`、`PUBLIC_PAGES_BOOKNAV`、`PUBLIC_PAGES_BILIBILI`、`PUBLIC_PAGES_BANGUMI`、`PUBLIC_PAGES_VNDB`、`PUBLIC_PAGES_MAL`、`PUBLIC_PAGES_SPONSOR`。留空保留现有开关。

**删除 `CF_WORKERS`，包括字符串 `false`**；它的存在会选择 Cloudflare adapter。博客完整 Build Command 为 `pnpm build`。

## 管理项目：基本配置与数据库

| 变量 | 条件 | 填什么 / 从哪里取得 |
| --- | --- | --- |
| `APP_ENV` | 各环境必填 | Production 填 `production`，Preview 填 `preview`，本地填 `development`；与平台 `VERCEL_ENV` 一致 |
| `GITHUB_REPOSITORY` | 固定值 | `Nocticur/Firefly`，用于站点/环境数据命名空间；发布目标固定为该仓库 `master` |
| `ADMIN_GITHUB_USER_ID` | 登录必填 | `285582250`，你的 GitHub **数字用户 ID**，不是用户名或 App ID |
| `ADMIN_ENTRY_PASSWORD` | 登录必填，秘密 | 你自行设置的后台入口密码，至少 12 个字符、UTF-8 最多 256 字节；建议密码管理器生成 16 位以上随机密码。仅在**管理项目**填写，不加 `PUBLIC_` / `VITE_` 前缀，各环境使用不同值 |
| `ADMIN_ORIGIN` | Production 固定值 | `https://admin.mourn.top`，后台 HTTPS origin，不含末尾 `/` |
| `PUBLIC_SITE_ORIGIN` | Production 固定值 | `https://blog.mourn.top`，博客 HTTPS origin，不含末尾 `/` |
| `ADMIN_PRODUCTION_DATABASE_URL` | 后台必填，秘密 | Neon 生产 PostgreSQL TLS 连接串，保存草稿、历史、会话、任务和通知。也接受 Marketplace 别名 `DATABASE_URL`，两者无需重复填 |
| `RESTORE_DATABASE_URL` | 恢复功能需要，秘密 | 独立恢复演练库连接，**数据库名与生产不同**且已应用 001–004 迁移；仅换同名 `neondb` 分支不满足要求 |

数据库连接示意：`postgresql://<用户>:<密码>@<Neon主机>/<数据库名>?sslmode=require`，使用 Neon 提供的值。`/api/health` 正常不证明数据库已连接或迁移完成。

博客作者卡片和手机导航菜单的“后台管理”按钮指向 `https://admin.mourn.top/`。先输入 `ADMIN_ENTRY_PASSWORD`，通过后继续 GitHub 身份验证；密码不能代替管理员账号验证。密码未配置、过短或超长时入口关闭。校验通过的 HttpOnly / Secure Cookie 有效 12 小时；旧 GitHub 会话也必须补做密码校验。修改密码并重新部署后旧入口凭证失效；退出登录同时清除两种 Cookie。密码不写入数据库、Git 或浏览器存储。

Vercel 保存新变量后，重新部署**管理项目**，现有部署不会自动更新密码。保持 Hobby 免费套餐；免费服务选择及额度约束见 [免费部署说明](./free-deployment.md)。

## 管理项目：GitHub

OAuth App 用于登录；GitHub App 用于读取仓库与提交内容，分别创建与填写。

| 变量 | 条件 | 填什么 / 从哪里取得 |
| --- | --- | --- |
| `GITHUB_OAUTH_CLIENT_ID` | 登录必填 | GitHub → Settings → Developer settings → OAuth Apps 的 Client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | 登录必填，秘密 | 同一个 OAuth App 的 Client secret |
| `GITHUB_APP_ID` | 导入/核查/发布需要 | GitHub App 数字 App ID，不是 OAuth Client ID |
| `GITHUB_INSTALLATION_ID` | 同上 | App 安装到目标仓库后的数字 installation ID，可从安装设置页 URL 取得 |
| `GITHUB_APP_PRIVATE_KEY` | 同上，秘密 | GitHub App 的 PEM 私钥；填写原始多行 PEM 或带字面量 `\n` 的 PEM，不是文件路径 |

OAuth Homepage URL 为 `https://admin.mourn.top`，Authorization callback URL 精确为 `https://admin.mourn.top/api/auth/callback`。GitHub App 只安装到 `Nocticur/Firefly`，Contents: read/write、Metadata: read。不要以个人 PAT 代替后台发布身份。本地/临时 Preview 域名不满足固定 OAuth 回调，不要复制生产会话测试登录。

## 管理项目：Vercel 与 Blob

| 变量 | 条件 | 填什么 / 从哪里取得 |
| --- | --- | --- |
| `VERCEL_TOKEN` | 正式发布核验需要，秘密 | Vercel Access Token，有权读取博客项目、部署及生产别名 |
| `VERCEL_BLOG_PROJECT_ID` | 同上 | **博客项目** Settings → General → Project ID，通常为 `prj_…`，不是后台项目或 deployment ID |
| `VERCEL_TEAM_ID` | 团队项目需要 | 所属 Team ID，通常为 `team_…`；个人项目留空 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 可选，秘密 | 博客 Deployment Protection 的自动化绕过秘密，仅保护阻挡清单核验时需要 |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | Production 媒体/备份需要，秘密 | **private Blob store** token，保存草稿原图和私有数据库备份 |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | Production 媒体发布需要，秘密 | 另一个 **public Blob store** token，保存显式发布的不可变图片/图标 |
| `MEDIA_IMPORT_HOSTS` | 可选 | 精确 HTTPS 图片主机白名单，如 `images.example.com,cdn.example.com`；不填完整 URL、路径或通配符。空值关闭外链导入 |

两项 Blob token 须指向两个不同且访问级别正确的 store，单个 `BLOB_READ_WRITE_TOKEN` 不满足要求；轮换同一个 store 的 token 不会形成隔离。当前 `handleUpload` 使用 HMAC 验签，不需要 `BLOB_WEBHOOK_PUBLIC_KEY`。

## 管理项目：互动、邮件与维护

| 变量 | 条件 | 填什么 / 从哪里取得 |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | 友链申请/评论需要，秘密 | Cloudflare Turnstile **Secret key**，与博客 Site key 来自同一小组件 |
| `INTERACTION_HASH_SECRET` | 建议单独填写，秘密 | 自行生成至少 32 随机字节的稳定密钥，如密码管理器生成的 64 位随机十六进制值；用于访客 IP 摘要/封禁，不是 API key。更换会影响既有封禁；留空回退 Turnstile 私钥 |
| `ENABLE_PUBLIC_COMMENTS` | 按需 | 默认 `false`；开放评论时设 `true`，同时将 `commentConfig.type` 改为 `nocticur` 并完整重建。友链申请不依赖此开关 |
| `RESEND_API_KEY` | 正式邮件需要，秘密 | Resend API key，支持发送及本项目的邮件记录查询 |
| `RESEND_FROM` | 同上 | 已验证发件域/发件人，如 `Nocticur <nocticur@mourn.top>`，不是收件地址或登录邮箱 |
| `RESEND_WEBHOOK_SECRET` | 同上，秘密 | Resend endpoint `https://admin.mourn.top/api/webhooks/resend` 的 Signing secret，通常为 `whsec_…`，不是 API key |
| `CRON_SECRET` | 每日维护需要，秘密 | 自行生成独立的高熵密钥，建议至少 32 随机字节；Vercel 调用 `/api/maintenance/cron` 时发送 Bearer header |
| `ENABLE_PRODUCTION_PUBLISH` | Production 按需 | `true` 才允许正式发布；初始空值/`false`，按受控验收需求开启 |
| `ENABLE_PRODUCTION_EMAIL` | Production 按需 | `true` 才允许正式邮件；先验收发件域、回调与幂等 |
| `ENABLE_PRODUCTION_MAINTENANCE` | Production 按需 | `true` 才允许维护；先准备数据库、私有 Blob、Cron 与恢复 |

Turnstile action 分别为 `comments` 和 `friend_request`；后台核验 action 和 hostname。填写密钥不会自动启用评论。维护 Cron 为 `0 19 * * *`（北京时间次日 03:00），与已取消的聊天任务唤醒安排无关。

## Preview、Development 与测试

以下只在相应环境填写，不能用生产值替代。

| 变量 | 范围 | 指向哪里 |
| --- | --- | --- |
| `ADMIN_PREVIEW_ORIGIN` / `PUBLIC_PREVIEW_ORIGIN` | Preview | 隔离后台/博客的精确 HTTPS origin，无末尾 `/` |
| `ADMIN_PREVIEW_DATABASE_URL` | Preview | 独立 Neon Preview 连接；兼容 `PREVIEW_DATABASE_URL`，不会回退生产连接 |
| `ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN` / `ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN` | Preview | Preview 专属 private/public stores |
| `ADMIN_DEV_ORIGIN` / `PUBLIC_DEV_ORIGIN` | 本地 | 默认 `http://localhost:3000` / `http://localhost:4321`；通过 Vite 界面写入时前者显式设为 `http://localhost:5173` |
| `ADMIN_DEVELOPMENT_DATABASE_URL` | Development | 独立开发 PostgreSQL/Neon 连接；兼容 `ADMIN_DATABASE_URL` |
| `ADMIN_DEV_PRIVATE_BLOB_TOKEN` / `ADMIN_DEV_PUBLIC_BLOB_TOKEN` | Development | 开发专属 private/public stores |
| `ADMIN_TEST_DATABASE_URL` | 测试 | 专用测试实例；维护测试角色可创建/删除临时测试库，不得使用生产实例 |

互动联调还需独立 Turnstile 小组件和摘要密钥。当前博客 Preview 转发到生产后台，只作静态审阅；可写隔离联调还需独立 API 转发和测试登录方案，仅填 Preview origins 不够。

## 无需手动填写

Vercel 注入 `VERCEL`、`VERCEL_ENV`、`VERCEL_GIT_COMMIT_SHA`，不要手动伪造。构建工具提供 `NODE_ENV`、`DEV`、`PROD`、`BASE_URL`、`SITE`。后台 Build Command 的 `NITRO_PRESET=vercel` 是构建选择。当前不读取 `SESSION_SECRET`、`JWT_SECRET` 或自定义 Workflow token。

四条数据库迁移、Fluid compute、DNS 和 Blob 访问属性是平台设置，不能由额外变量替代。部署步骤见 [deployment.md](./deployment.md)，管理模板见 [apps/admin/.env.example](../../apps/admin/.env.example)。
