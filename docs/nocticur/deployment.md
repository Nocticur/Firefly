# Vercel 部署与回滚

本说明对应已选择的 Firefly 方案。先完成服务配置，在已确定的 Production 配置中按验收需要分别开启发布、邮件和维护；完成 [acceptance.md](./acceptance.md) 平台验收后再投入正式运行。实际秘密值填写在 Vercel / GitHub / Neon / Resend 的安全配置页面，不发送到聊天，不写入仓库、构建产物或日志。

## 两个 Vercel 项目

两个项目连接 `Nocticur/Firefly`，Production Branch 均为 `master`，使用同一根 `pnpm-lock.yaml`。

| 设置 | 博客项目 | 管理项目 |
| --- | --- | --- |
| Root Directory | 仓库根目录 `.` | `apps/admin` |
| 框架 | Astro，静态生成 | Other / 无框架预设，由 Nitro 构建 |
| Install Command | `pnpm install --frozen-lockfile` | `pnpm install --frozen-lockfile` |
| Build Command | `pnpm build` | `NITRO_PRESET=vercel pnpm build` |
| 产物 | `dist` | Nitro 生成的 `.vercel/output`，不要覆盖为 Vite 的 `public` |
| 生产域名 | `blog.mourn.top` | `admin.mourn.top` |
| Node | 满足 `>=22.23.0`；CI 使用 `24.19.0` | 同左 |

管理项目应允许访问 Root Directory 之外的 workspace 文件，使 pnpm 能使用根锁文件与 workspace 配置。React/Vite 先输出管理静态资源，Nitro 将 SPA 与 `/api/**` 一起打包；`nitro.config.ts` 注册 `workflow/nitro`。当前依赖为 Nitro `3.0.260903-beta`、Workflow `5.2.0`，升级须重新验证，不能仅替换为通用 Hono 打包。

在管理项目的 Vercel 设置中**启用 Fluid compute**；这是 Workflow 的平台前提，仓库构建配置不能代替控制台设置。检查部署产物中包含 Workflow 自动生成的入口，再通过真实平台验收耐久等待与函数重启。官方参考：[Workflow Hono 集成](https://workflow-sdk.dev/docs/getting-started/hono)、[Vercel Fluid compute](https://vercel.com/docs/fluid-compute)。

博客构建必须执行完整 `pnpm build`，包含资源后处理、Pagefind 与最终发布清单生成；不能简化为 `astro build`。`vercel.json` 只将博客 `/api/public/*` 转发到管理项目，管理接口从管理同源访问。两种发布清单与动态 API 配置 `no-store`，前台不新增 Service Worker。

博客保持静态构建；**删除 `CF_WORKERS` 变量，包含删除字符串 `false`**，因为现有 adapter 开关按变量存在与否判断。GitHub Actions 只验证和上传构建产物，GitHub Pages 生产部署已停用；同时在 GitHub Pages 设置和 Vercel 项目中检查是否有旧部署入口或重复的生产连接。

## 环境隔离与变量

[apps/admin/.env.example](../../apps/admin/.env.example) 只提供变量名及已知公开身份，秘密值为空。开发时可复制为被忽略的 `apps/admin/.env` 并由受支持的环境加载方式注入；迁移与 `tsx` 测试应使用已注入的进程环境，不能假定它们自动读取 `.env`。

`APP_ENV` 在每个环境显式设为 `production`、`preview` 或 `development`，必须与 Vercel 自行提供的 `VERCEL_ENV` 一致。部署平台的 `VERCEL`、`VERCEL_ENV` 与 `VERCEL_GIT_COMMIT_SHA` 保持平台提供值。生产写能力要求两个环境标识同时为 production，并显式打开对应开关；仅在平台 Production 范围配置开关与生产秘密。

| 变量 | 用途与范围 |
| --- | --- |
| `GITHUB_REPOSITORY` | 固定 `Nocticur/Firefly`，用于站点环境 ID；发布提供者绑定此仓库和 `master` |
| `ADMIN_GITHUB_USER_ID` | 管理员数字 ID `285582250`；登录名不是权限凭据 |
| `ADMIN_ORIGIN` / `PUBLIC_SITE_ORIGIN` | 固定 `https://admin.mourn.top` / `https://blog.mourn.top`，不含末尾 `/` |
| `ADMIN_PREVIEW_ORIGIN` / `PUBLIC_PREVIEW_ORIGIN` | 当前隔离 Preview 的精确 HTTPS origin |
| `ADMIN_DEV_ORIGIN` / `PUBLIC_DEV_ORIGIN` | 本地开发 origin；默认 `http://localhost:3000` / `http://localhost:4321` |
| `ADMIN_PRODUCTION_DATABASE_URL` | 管理 Production 的 Neon 连接；代码也接受 Marketplace 的 `DATABASE_URL` |
| `ADMIN_PREVIEW_DATABASE_URL` | 隔离 Preview 连接；可接受专属 `PREVIEW_DATABASE_URL`，不会回退生产 `DATABASE_URL` |
| `ADMIN_DEVELOPMENT_DATABASE_URL` | 隔离开发连接；兼容 `ADMIN_DATABASE_URL` |
| `RESTORE_DATABASE_URL` | 独立恢复验证库，数据库名必须与生产不同，并已完成迁移 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | GitHub 登录配置 |
| `GITHUB_APP_ID` / `GITHUB_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` | 仅安装于目标仓库的 GitHub App 身份，读基线及原子提交 |
| `VERCEL_TOKEN` / `VERCEL_BLOG_PROJECT_ID` | 管理 Production 核验博客部署；项目 ID 必须是博客项目 |
| `VERCEL_TEAM_ID` | 项目属于团队时填写对应团队 ID |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 若博客部署保护阻挡清单请求，使用专门的自动化绕过秘密 |
| `MEDIA_IMPORT_HOSTS` | 外链导入精确 HTTPS 主机白名单，逗号分隔；空值关闭外链导入 |
| `TURNSTILE_SECRET_KEY` / `INTERACTION_HASH_SECRET` | 当前环境的人机验证与访客标识摘要密钥；建议分别生成，摘要密钥变更会影响既有访客封禁标识 |
| `RESEND_API_KEY` / `RESEND_FROM` / `RESEND_WEBHOOK_SECRET` | Production 正式发信、已验证发件人及签名回调 |
| `CRON_SECRET` | 管理 Production 的每日维护鉴权密钥 |
| `ENABLE_PRODUCTION_PUBLISH` / `ENABLE_PRODUCTION_EMAIL` / `ENABLE_PRODUCTION_MAINTENANCE` | 空值关闭；只在 Production 按受控验收与正式运行需求设置为 `true` |

博客项目另设公开构建变量 `PUBLIC_TURNSTILE_SITE_KEY`，为当前前台对应站点的 Turnstile 公钥。它可进入公开静态产物；`TURNSTILE_SECRET_KEY` 只在管理项目。注册允许 `blog.mourn.top` 的小组件，隔离环境使用各自的小组件与密钥。缺少公钥时页面保留评论和申请结构，明确显示暂不能提交。

评论引擎保留原来的关闭状态：`src/config/commentConfig.ts` 的 `type` 当前为 `none`。准备验收本站评论时，显式选择 `nocticur` 并完整构建，同时检查具体文章的评论开关；仅填写 Turnstile 变量不会启用评论引擎。友链申请使用同一套公开互动校验，不依赖评论引擎开关。

当前根 `vercel.json` 的转发目标固定为生产管理域名。临时博客 Preview 的写入来源会被生产 API 拒绝，**不能将这种 Preview 宣称为可写隔离联调环境**。需要互动联调时，先为隔离部署配置指向隔离管理项目的转发与精确 origins；否则 Preview 仅用于静态内容检查，并保持互动提交关闭。OAuth 同样只接受 `https://admin.mourn.top`，临时 Preview 管理域名不能进行生产登录；不要复制生产 Cookie 或会话数据库到 Preview。

## Neon 与数据库迁移

通过 [Vercel Marketplace Neon 集成](https://vercel.com/marketplace/neon) 为管理项目建立生产、预览与开发各自的数据库 / 分支及连接权限。检查集成变量的环境范围：Preview 与 Development 不得持有生产连接。使用服务提供的 TLS 连接，不关闭 TLS 验证。生产可将注入的 `DATABASE_URL` 映射为 `ADMIN_PRODUCTION_DATABASE_URL`，预览必须配置专用连接名。

在安全注入对应环境变量的一次性终端，从仓库根执行：

```bash
pnpm --filter @nocticur/admin db:migrate
```

迁移脚本按序应用 `001-core.sql`、`002-release.sql`、`003-interactions.sql`、`004-maintenance-guards.sql`，每次在事务中记录 `schema_migrations`，可重复执行。分别检查各环境数据库的四条迁移记录。迁移角色需要创建表、函数和触发器；日常业务连接保持在对应环境范围。

恢复库必须使用**不同数据库名**；仅另建同名 `neondb` 分支不满足当前保护规则。该库同样应用 001–004 迁移。可在独立本地迁移终端将它临时作为 development 数据源执行迁移，随后移除临时绑定；不要修改管理 Production 的业务连接指向恢复库。恢复流程同时检查数据库名称及实际服务器/数据库身份，并使用临时表验证备份的约束和条数。

本地开发可使用专用 PostgreSQL，例如只绑定 loopback 的测试实例；CI 的无密码 trust 连接只用于临时测试服务，不能照抄为公网或生产数据库配置。

## GitHub 登录与原子提交

创建 GitHub OAuth 登录配置，回调精确填写：

```text
https://admin.mourn.top/api/auth/callback
```

应用只申请 `read:user`，随后调用 GitHub 用户接口校验数字 ID `285582250`。OAuth state 一次性使用，管理员会话有效期 12 小时。管理域名必须已有有效 HTTPS；不同大小写、协议、路径或临时 Preview 域名不能替代固定回调。

另建 GitHub App，安装范围只选 `Nocticur/Firefly`，Repository permissions 的 Contents 允许 read/write，Metadata 使用 GitHub 所需读取权限。读基线请求申请只读 Contents 令牌；生产发布临时申请写令牌，以 `expectedHeadOid` 的 GraphQL 原子提交更新 `master`。不要用用户 PAT 代替仓库写入身份。

将 App ID、installation ID 和 PEM 私钥安全配置到管理项目；代码支持多行 PEM 与字面量 `\n`。分支保护应允许该 App 执行已经授权的内容提交；若强制 PR 使原子提交被拒绝，须调整为明确允许此 App 的目标规则或保留发布关闭状态。GitHub 的读取代理或 `git ls-remote` 成功只证明读取，不能证明 App 或写权限可用。

代码首次推送到目标 `master` 后，登录管理后台执行一次“导入仓库基线”；核对 16 条管理记录、15 篇公开文章、草稿状态与真实设置。导入不触发发布，并且第二次导入不会覆盖已有草稿。此步骤需要 GitHub App 能读到新加入的 `src/data` 基线文件，不能针对改动尚未推送的旧远端验证迁移结果。

基线同时读取根 `vercel.json`。改 slug 后显式发布会将旧址映射写入 `src/data/redirects.json`，并在同一原子提交中更新根 Vercel `redirects` 为对应的 `permanent: true` 规则，保留其他配置、原安全 headers 和非管理重定向。冻结快照缺少部署配置、已有相同旧址规则冲突或映射不一致时拒绝发布；最终构建也会核对两份映射。上线验收仍须请求真实旧址，确认平台返回永久跳转且目标页面正确。

管理的精确旧址规则排在保留的其他规则之前，避免被宽泛匹配遮住。新公开文章若占用仍用于旧址跳转的路径，发布返回冲突，不能把已有文章入口改为跳转入口。

## Blob 媒体与上传

每个环境分别创建一个 private 与一个 public store，至少三组环境共六个 store。配置令牌：

| 环境 | 私有 | 公开 |
| --- | --- | --- |
| Production | `BLOB_PRIVATE_READ_WRITE_TOKEN` | `BLOB_PUBLIC_READ_WRITE_TOKEN` |
| Preview | `ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN` | `ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN` |
| Development | `ADMIN_DEV_PRIVATE_BLOB_TOKEN` | `ADMIN_DEV_PUBLIC_BLOB_TOKEN` |

Marketplace 自动注入的单个 `BLOB_READ_WRITE_TOKEN` 不能替代这两种访问级别的令牌。核对 store 的访问属性及环境范围，避免只给同一个 store 改变量名。代码会按令牌对应的 store ID 检查隔离：轮换同一生产 store 的令牌仍然不能用作开发或预览 store。私有与公开资源也须来自不同 store，不应将生产令牌绑定到隔离部署。

浏览器先请求受限上传意图，再使用 Blob SDK 直传；当前单文件上限为 32 MiB。后台完成回调核验归属、路径、类型和大小，并计算保存内容摘要。真实部署要确认 Blob 完成回调能到达管理项目 `/api/media/upload`，平台保护不能阻断服务商回调。匿名令牌获取与匿名私有资源读取必须失败。

私有资源仅经鉴权内容接口读取，不写临时 URL 到公开文章。显式发布读取快照中冻结的资源路径、版本、类型、大小与摘要，校验实际字节，再复制为公开不可变版本；重试也会核验已存在的公开对象。发布过程中修改或删除当前媒体记录不改变冻结版本，历史资源仍须保留。外链导入限定精确 HTTPS 主机、公网解析地址与直接图片响应，不接受重定向；先按实际来源填写 `MEDIA_IMPORT_HOSTS`，不预设通配符。

## Resend、Webhook 与每日维护

在 Resend 验证发件域与发件人，再配置 `RESEND_FROM` 和 API key。Webhook 地址为：

```text
https://admin.mourn.top/api/webhooks/resend
```

复制该 Webhook 的签名秘密至 `RESEND_WEBHOOK_SECRET`，确认部署保护允许签名回调到达。审核拒绝与邮件入队在同一个 PostgreSQL 事务完成，并在事务提交后调度发送；通过审核的友链先参加显式发布，仅当生产清单核验成功后入队上线通知。上线通知收件人取自被冻结的私有快照，不写入 Git 或公开清单。通知使用唯一键、发送记录与 Resend 幂等键；调度失败保留持久待发记录，重复触发使用同一通知 ID。

邮件“已发送”表示服务商已接受或已确认发送，不保证收件箱送达。签名回调中的退信、投诉、失败或抑制会落为失败并记录原因；入站、计划发送或延迟事件不作为发送成功证据。发送响应丢失、函数中断或结果未知时先查签名回调和服务商记录。超过 24 小时幂等窗口会阻止自动重发；`POST /api/mail/{id}/reconcile` 可附已核实的 `providerId` 只读核查服务商证据，不能把查询不到记录当作未发送证明。

管理项目 `vercel.json` 配置一次每日 Cron：`0 19 * * *`，即 UTC 19:00、北京时间次日 03:00，入口 `/api/maintenance/cron`。Vercel 自动发送 `Authorization: Bearer <CRON_SECRET>`。该安排适配 Hobby 每日 Cron，实际触发不承诺精确分钟；发布中的每分钟核验来自 Workflow 耐久等待，不来自每分钟 Cron。每日任务按日期幂等创建，备份、空闲发布核验与待发邮件共用触发；发布/邮件开关关闭时分别跳过对应外部操作。

正式发信、生产发布与维护都保持关闭，直到对应真实验收完成；验收时在已确定的目标生产配置中分别开启必需开关。隔离环境即使误填 `true`，也会被环境校验拒绝，但仍须从平台环境范围移除生产秘密。

## 更新检查与升级

维护页的主题检查读取 `https://api.github.com/repos/CuteLeaf/Firefly/releases/latest`，将 release tag 与根 `package.json` 的版本比较；预发行或不可比较版本显示待比对。后台检查用 GitHub App 只读取得目标仓库 `master`，与 `VERCEL_GIT_COMMIT_SHA` 比较，代码不同只表示存在需要审阅的变更。App、部署 SHA 或上游请求不可用时显示配置缺失或未知。

检查不会修改仓库、安装升级或部署。升级前先创建并验证额外的私有备份，记录现有 Git SHA、Vercel deployment ID 和 schema 版本，审阅升级与迁移兼容性，再分别构建部署后台和博客。搜索重建和公开静态缓存更新通过完整发布切换，无独立在线索引删除或离线缓存清除动作。

## 上线检查

1. 在新项目临时地址检查构建与 API `no-store`，核对 Fluid compute、四条迁移及隔离配置；确认旧后台和 GitHub Pages 不再拥有目标站点生产写入口。
2. 配置固定管理域名与 HTTPS，完成真实 OAuth 管理员登录、错误身份拒绝、CSRF、基线导入、媒体直传和私有读取验收。域名首次绑定前记录现有 DNS 与部署状态。
3. 在博客项目完成完整生产构建，检查 15 篇、中文固定地址、MDX、相对图片、RSS 与 Pagefind；确认草稿不在任何公开索引。
4. 按 [acceptance.md](./acceptance.md) 验证发布冲突、Workflow 重试、生产别名与清单一致、Turnstile 互动、友链邮件、备份与恢复，再确认生产开关和每日 Cron。
5. 将博客域名指向验收过的博客项目，记录目标 Git SHA、Vercel deployment ID 与清单摘要。域名切换后再次读取固定生产域名清单与代表性页面。

本仓库未执行上述外部上线操作。平台变量不全时，静态博客可以构建，后台相关功能会返回明确的配置缺失错误；不能据此声称生产闭环已经完成。

## 备份与回滚

改动前的本地备份位于 `/workspace/backups/firefly-before-nocticur/`：`repository.bundle`、`tracked-files.tar.gz`、`SHA256SUMS`、原 HEAD、状态与文件清单。它用于恢复原代码与受跟踪文件；不包含未来的生产数据库、媒体、DNS 或平台设置，也不会随 Git 推送保存在远端。

日常内容回滚使用 Git revert 在 `master` 建立新提交，保持历史可追溯，随后重新运行完整构建并重新核验生产版本。选择具体提交前先核查当前远端 HEAD、发布任务和差异；不得用 reset/force push 回退正在发布的分支。未推送的本地代码可先在已有隔离 checkout 审查恢复；需要恢复整个前置基线时，从上述备份提取到独立检查目录，验证哈希后有选择地恢复，保留当前用户改动。

Vercel 平台代码回滚仅改变活动部署，不自动回滚 Git、数据库或 Blob。回滚后台前检查旧版本与已应用 schema 是否兼容。博客生产回滚后任务可能显示目标与生产不一致，应保留真实状态，不能手动标记成功。Pagefind 随完整静态版本切换，无独立在线索引删除动作。

每日私有备份包含私有数据与媒体清单，并读回校验 SHA256；不导出会话与 OAuth state。媒体清单不是媒体字节副本：必须保留对应 private/public Blob 对象及历史版本，另行执行所需的对象备份/保留策略，并定期核查清单引用可读。

恢复先核验备份、稳定文章 ID、媒体摘要与独立恢复库，再建立当前状态的保护备份。生产写保护和维护租约在恢复期间阻挡并发写入；结束后会话清除，须重新登录。正在发送的邮件或尚未确认的当前 Git 操作会阻止恢复，需先核查外部结果。

恢复不会重放旧 Workflow、旧 Git 提交或历史邮件。恢复的未完成发布和未发送邮件置为阻塞；后台“核查当前发布”显式发送 `{ "reconcileRestored": true }`，只核对既有 Git 与生产结果，未传该确认字段的普通恢复核查请求被拒绝。邮件根据签名回调/服务商记录核对。核查完成后再建立新的显式发布，不将旧任务重新提交。Git、数据库和媒体恢复分别记录，最后核对稳定文章 ID、媒体引用、目标 SHA、生产域名、搜索、RSS 与通知账本。

## 云开发环境交接

当前云实例已安装依赖并提供隔离本地 PostgreSQL，用于开发和本地验收。[setup-transfer.json](/workspace/.firefly-environment/setup-transfer.json) 保存完整的 `install_script`、`start_skill`、必要的追加网络域名与变量/秘密名称要求；[交接说明](/workspace/.firefly-environment/setup-transfer-readme.md) 解释各字段与合并方式，[firefly-setup-handoff.tar.gz](/workspace/firefly-setup-handoff.tar.gz) 包含可转移文件。脚本在当前实例执行过，安装保持 frozen lockfile 和签名、校验和、TLS 验证。

最新草稿保存被配置工具拒绝为 `stale_base`：环境设置在当前会话之外已经改变。用户已将这项故障暂缓，继续本实例的项目验收与交付；不根据旧基线重试覆盖。后续重新保存时，需要从**当前环境设置**启动有效的 setup 会话，以交接文件合并待保存内容并保留已有设置；网络要求以追加方式合并，秘密值仍通过安全设置注入。当前实例验证、提案文件、配置保存与新任务复现是不同状态；本次没有完成最新草稿保存或在新任务中复现，也没有因此配置生产平台服务。
