# 环境变量

博客、`/admin/` 和 `/api/` 部署在同一个 Vercel `firefly` 项目。**Git 仓库是唯一数据源**：文章与站点设置都从仓库读取并写回仓库，图片走 CloudFlare-ImgBed。不需要数据库、建表或 SQL 迁移，也不需要 Cloudflare KV、Vercel Blob 或 Upstash。

变量在 Vercel 项目 **Settings → Environment Variables** 中配置。生产 Secret 只勾选 **Production**；Vercel 需开启 **Enable access to System Environment Variables**，否则读不到平台注入的地址与项目编号。

## 生产基础必填

| 变量 | 填什么 | 用途 |
| --- | --- | --- |
| `ADMIN_ENTRY_PASSWORD` | 自己设置的 3～10 个字符密码，建议 10 位随机字符；设为 **Secret** | 后台登录；服务端自动加盐 scrypt 哈希后核对 |
| `GITHUB_TOKEN` | GitHub **细粒度个人访问令牌**（Fine-grained PAT）；设为 **Secret** | 读写仓库里的文章与设置 |
| `GITHUB_REPOSITORY` | 目标仓库；本项目为 `Nocticur/Firefly`，通常留空即用默认值 | 数据源仓库；不填时默认 `Nocticur/Firefly` |
| `GITHUB_BRANCH` | 目标分支，例如 `master` | 读写分支；不填时默认 `master` |
| `IMGBED_API_TOKEN` | CloudFlare-ImgBed API Token；使用媒体库时必填，设为 **Secret** | 服务端上传图片到图床 |
| `IMGBED_BASE_URL` | 可选，默认 `https://image.nocticur.eu.cc` | 图床地址；只有地址改变时才填 |

`GITHUB_TOKEN` 的权限：**Contents = Read and write**（提交文章与设置）、**Metadata = Read**（GitHub 强制要求）。令牌只授权目标仓库，不要授权全部仓库。

`ADMIN_SESSION_SECRET` 可选，至少 32 字符；不填时由 `ADMIN_ENTRY_PASSWORD` 派生。更换密码即让所有旧登录会话失效。

不需要初始化：后台首次打开会自动从仓库导入现有文章与设置，因此不会显示空白。仓库既没有 `src/data/managed-settings.json` 也没有 `src/config/siteConfig.ts` 时会明确报 `BASELINE_CONFIGURATION_REQUIRED`，不会用空配置覆盖主题。

> 后台按单人管理场景处理：保存时校验修订号，冲突返回 `409` 并提示刷新后重新编辑，不做分布式锁。Git 提交失败或并发冲突时不会覆盖远端内容。

## 发布与仓库

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 发布/导入时 | 见上表；读写目标仓库。生成地址 <https://github.com/settings/personal-access-tokens/new> |
| `GITHUB_REPOSITORY` | 可选 | 默认 `Nocticur/Firefly` |
| `GITHUB_BRANCH` | 可选 | 默认 `master` |
| `VERCEL_TOKEN` | 生产发布核验时必填 | Vercel Token，选择当前项目团队作用域；设为 **Secret** |
| `VERCEL_PROJECT_ID` | 可选 | Vercel 自动提供；也接受 `VERCEL_BLOG_PROJECT_ID` |
| `VERCEL_TEAM_ID` | 可选 | 团队作用域标识，仅有团队项目时需要 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 可选 | 生产域名启用 Deployment Protection 时，发布核验用它读取受保护清单 |

GitHub App（`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID`）只在没有 `GITHUB_TOKEN` 时作为回退，那条路径要求 App 已安装到 `GITHUB_REPOSITORY` 指定的仓库。**推荐只配 PAT 并删除 App 变量**，避免走错分支。出现「GitHub 仓库暂时无法读取」时先用 `node scripts/check-github-access.mjs` 自检，按状态码排查见 [统一部署](./deployment.md#排查github-仓库暂时无法读取)。服务密钥不能填写到公开 JSON、文章、后台表单或 Git；后台只保存服务开关状态，不接收密钥。

## 设置与导航的存放位置

- 站点设置、导航、图标统一写入 `src/data/managed-settings.json`，博客构建时由 `src/utils/managed-settings.ts` 读入并覆盖 `src/config` 的默认值。
- 仓库里还没有这个文件时，后台会从 `src/config/siteConfig.ts` 的 `title`、`subtitle`、`site_url`、`description`、`siteStartDate`、`timezone`、`navbar.logo.value` 以及 `pages.*` 开关推导出初始值，首次保存后即写入该文件。

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

开发/预览默认不需要任何存储配置：文章与设置照常从 Git 读取。若显式配置了独立 Cloudflare KV（`ADMIN_DEV_CF_*` / `ADMIN_PREVIEW_CF_*`），它必须与生产 KV 不同（比较账户 ID 与命名空间 ID），否则后台拒绝启动。每个非生产环境还需自己的后台密码与第三方服务凭据。本地默认 `development`，不需要 `APP_ENV`。

## Vercel 自动提供，不要手填

以下由平台注入，通常只在本地调试时手动导出：

`VERCEL_ENV`、`VERCEL_URL`、`VERCEL_PROJECT_PRODUCTION_URL`、`VERCEL_PROJECT_ID`、`VERCEL_GIT_COMMIT_SHA`、`VERCEL`。

`GITHUB_REPOSITORY` 与 `GITHUB_BRANCH` 决定读写哪个仓库的哪个分支；`GITHUB_REPOSITORY` 默认 `Nocticur/Firefly`，`GITHUB_BRANCH` 默认 `master`。

## 必须删除的旧变量

- `BLOB_PRIVATE_READ_WRITE_TOKEN`、`BLOB_PUBLIC_READ_WRITE_TOKEN`
- `ADMIN_DEV_PRIVATE_BLOB_TOKEN`、`ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN`
- `CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`、`CF_API_TOKEN`（已不再需要数据库）
- `KV_PROVIDER`、`KV_REST_API_URL`、`KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`、`ADMIN_DEV_KV_REST_API_*`、`ADMIN_PREVIEW_KV_REST_API_*`
- `ADMIN_ORIGIN`、`PUBLIC_SITE_ORIGIN`（已改为读取 Vercel 项目地址）
- 所有数据库变量（`DATABASE_URL`、`POSTGRES_*`、Neon 连接串等）

以上变量在运行时不再被读取，残留不会改变行为；保留它们只会掩盖配置错误，应尽快清理。

## 数据存放位置

**Git 仓库是唯一数据源**，没有数据库、键值存储或迁移命令：

- 文章：`src/content/posts/**/*.md|mdx`，由后台直接读写并提交。草稿只是"尚未发布的编辑版本"，发布时会自动清除该文件的 `draft` 标记并上线，内容不会丢失。
- 加密文章：编辑页勾选「保留为加密草稿」并填写密码，密码写入该文章 frontmatter 的 `password` 字段，随文章一起提交到仓库，不需要任何环境变量。
- 站点设置、导航、图标：`src/data/managed-settings.json`。
- 发布清单：`src/data/published-state.json`；重定向：`src/data/redirects.json`。
- 评论、友链、访客封禁等少量运行时写入保存在后台状态中；未配置 Cloudflare KV 时使用进程内存，重启即清空。

### AI 生成摘要（可选）

后台文章编辑页的「AI 生成摘要」按钮走 OpenAI `chat/completions` 兼容接口，只认三个变量，换服务商不用改代码：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `AI_API_KEY` | 是 | — | 缺失时按钮提示「未配置 AI_API_KEY」 |
| `AI_BASE_URL` | 否 | `https://api.deepseek.com` | 任何兼容端点，例如 `https://api.openai.com/v1` |
| `AI_MODEL` | 否 | `deepseek-chat` | 对应服务商的模型名 |

摘要只提交正文（自动去掉 front matter、代码块和图片语法），生成结果先填进摘要框，你可以改完再保存。

### 草稿与历史存在哪里

草稿不会推进 Git，所以要有个地方存：

| 配置 | 草稿 / 版本历史 / 评论 / 媒体记录 | 适合 |
| --- | --- | --- |
| 不配 KV | 进程内存，重启或多实例访问即丢 | 只用后台改文章并立即发布 |
| 配了 Cloudflare KV（`CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_API_TOKEN`） | 写入 KV，持久化 | 需要保留草稿与审核记录 |

**发布核验通过后会自动清理**：该次发布涉及的已入库文章，其本地版本历史（`post_version:*`）会被删除，避免每保存一次就在状态文档里多留一份全文副本；未发布文章的历史不受影响。已发布的正文本身仍在 Git 里，不会因为这次清理而丢失。发布快照由每日维护按 30 天保留期回收。

后台首次打开会自动导入仓库现有文章与设置，不需要手动初始化。保存设置或发布时后台以最新提交为基准生成一次提交；远端已被他人改动时返回冲突而不是覆盖。

保存设置有两种方式：`PUT /api/{settings,navigation,icons}` 只写入后台草稿，`POST /api/{settings,navigation,icons}/commit` 会立即把当前设置提交回仓库的 `src/data/managed-settings.json`（保留文件中后台不管理的其他字段，并同步推进基线，避免下次发布误判为外部改动）。

## 错误语义

| 情况 | 返回 | 后台表现 |
| --- | --- | --- |
| 仓库缺少设置基线 | `503 BASELINE_CONFIGURATION_REQUIRED` | 提示仓库需包含 `src/data/managed-settings.json` 或可解析的 `src/config/siteConfig.ts` |
| 仓库没有文章 | `422 REPOSITORY_POSTS_MISSING` | 提示仓库里没有可导入的文章源码 |
| 未配置 GitHub 凭据 | `503 GITHUB_APP_CONFIGURATION_REQUIRED` | 提示补充 `GITHUB_TOKEN` |
| 发布缺少 Vercel 凭据 | `503 PUBLISH_CONFIGURATION_REQUIRED` | 提示补充 `VERCEL_TOKEN` 或核对当前 Vercel 项目 |
| 仓库不可访问或无权限 | `503 GITHUB_REPOSITORY_UNAVAILABLE` | 错误信息带仓库、分支与 HTTP 状态码；按状态码排查（401 令牌、403 权限、404 仓库/分支、0 网络） |
| 修订号/摘要冲突 | `409 FILE_STORE_CONFLICT` | 提示刷新后重新编辑，不覆盖服务器版本 |
| 状态或备份过大 | `507 FILE_STORE_TOO_LARGE` | 提示清理历史或减少媒体记录 |
| 状态内容损坏 | `503 FILE_STORE_INVALID` | 停止写入，需从备份恢复 |

## 服务开关与隔离

登录 `/admin/` 的“服务设置”，按需开启生产发布和生产维护，两项默认关闭；保存后立即生效。写入继续校验管理员会话、同源 Origin、CSRF 和修订号。Preview/Development 永远不能开启生产操作，也不会读取生产 KV。

## 个人邮箱

个人联系邮箱 `youjinmian@outlook.com` 通过博客邮箱链接联系，无需发信服务变量。评论和友链申请中的访客邮箱用于必要时人工联系，不公开展示；后台不自动发送回复、审核或上线邮件。

配置和代码修改需要重新部署才会在线上生效；完整统一构建命令为 `pnpm build:vercel`。部署步骤见 [统一部署](./deployment.md)，额度见 [免费部署说明](./free-deployment.md)。
