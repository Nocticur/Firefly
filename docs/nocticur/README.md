# Nocticur 的 Firefly 博客与管理后台

当前配置以 [环境变量填写清单](./environment-variables.md) 和 [统一部署说明](./deployment.md) 为准。此前安全复审与验收回执保留为历史资料；本页描述删除数据库和定制邮件功能后的运行方式。

后台部署到 Vercel Hobby，配套服务只选择免费方案，具体约束见 [免费部署说明](./free-deployment.md)。博客作者卡片和手机导航菜单提供“后台管理”入口；只验证管理项目的 `ADMIN_ENTRY_PASSWORD`（3～10 个字符，服务端自动加盐 scrypt 哈希），正确后直接进入，无需用户名或 GitHub 登录。进入页提供与博客一致的头像、签名、淡青柔粉配色和深浅主题。

源码仓库为 `Nocticur/Firefly`，发布分支为 `master`。博客保持 Astro 静态站点；管理界面、Hono API 与 Workflow 和博客一起部署在现有 Vercel `firefly` 项目，入口分别为 `https://blog.mourn.top/`、`/admin/` 和 `/api/`。

正式文章与公开设置由 GitHub 构建；草稿、历史、会话、限流、审核及任务状态保存在 Private Blob 的私有 JSON 文件。每日维护自动清理超过 30 天的历史、已结束发布记录和备份对象，当前状态及未完成任务保留。无需数据库连接、建表或迁移。基础后台只需要登录密码和私有 Blob 存储令牌，其他功能按需配置。

## 改动清单

| 范围 | 已实现的改动 | 主要文件 |
| --- | --- | --- |
| 资料与主题 | 迁入身份、两行签名、原头像、两篇文章与固定中文地址；保留主题布局、功能开关、原文章和草稿 | `src/config/`、`src/content/posts/`、`src/content/spec/about.md`、`public/assets/images/logo-nocticur.png` |
| 管理界面 | 仪表盘、文章与历史、设置、导航与六个图标位、媒体、评论、友链、发布、维护；响应式页面与未保存提示 | `apps/admin/client/` |
| 写作 | TipTap 可视编辑、斜杠菜单、链接、代码、公式、Mermaid、表格；完整源码和未知片段保护 | `apps/admin/client/components/ArticleEditor.tsx`、`apps/admin/server/content.ts` |
| 登录与数据 | 服务端自动加盐哈希验证密码后建立会话；安全 Cookie、持久限流、会话轮换和 CSRF；私有文件条件写入及环境隔离 | `apps/admin/server/entry.ts`、`apps/admin/server/password.ts`、`apps/admin/server/session.ts`、`apps/admin/server/auth.ts`、`apps/admin/server/file-store.ts` |
| 媒体 | 受限直传、签名完成回调、私有鉴权读取、外链导入；冻结媒体校验与公开不可变副本 | `apps/admin/server/media.ts` |
| 发布 | 私有文件持久任务、冻结快照、租约 fencing、GitHub 原子提交、Workflow 等待、生产别名及清单核验；旧 slug 的永久重定向随配置提交 | `apps/admin/server/releases.ts`、`apps/admin/server/github.ts`、`apps/admin/workflows/`、`scripts/generate-release-manifest.ts` |
| 互动与审核 | 纯文本评论、Turnstile、限流、封禁、回复占位；友链审核、分组与经过生产核验的上线状态 | `apps/admin/server/interactions.ts` |
| 维护与部署 | 更新检查、私有文件备份与恢复、每日 Cron；一个 Vercel 项目、完整构建 CI 和回滚说明 | `apps/admin/server/maintenance.ts`、`apps/admin/server/update-check.ts`、`vercel.json`、`.github/workflows/build.yml` |

在线接口文档入口为同一博客的 [`/api/openapi.json`](https://blog.mourn.top/api/openapi.json)，仓库定义见 [`apps/admin/server/openapi.ts`](../../apps/admin/server/openapi.ts)。生产发布和维护默认关闭，管理员在“服务设置”中保存开关后立即生效；开启发布仍需单独创建发布任务。

个人联系邮箱为 `youjinmian@outlook.com`，首页、侧栏、关于页和友链人工联系说明保留。评论和友链的访客邮箱仅用于联系资料，不公开展示，也不触发本项目自动发信。第三方评论配置保留；定制后台不再提供邮件开关、发信服务、邮件记录或补发接口。

## 迁移资料与保留规则

来源为只读仓库 `Nocticur/blog` 的 `master` 提交 `c075ac36c1313dc6ee47f7690c1a360aaa087da8`，作为 Windows `D:\blog` 资料的已解析来源。目标基线为 `Nocticur/Firefly` 提交 `6d82554bfe1cb3d4b43adb0969dad1d43ac6dee3`；仅迁入约定身份、头像与两篇文章。

| 项目 | 约定结果 |
| --- | --- |
| 标题 / 作者 | Nocticur的博客 / Nocticur |
| 描述 | Nocticur的博客，记录个人学习、工作、AI相关的内容 |
| 建站时间 / 时区 | `2026-07-26T00:00:00+08:00` / `Asia/Shanghai` |
| 联系方式 | GitHub Nocticur、B站 645892937、原约定 QQ 群、`youjinmian@outlook.com` |
| 两篇文章 | `/posts/cloudflare优选/`、`/posts/软件分享/` |
| 管理 / 公开基线 | 原有 14 条记录保留；迁移后 16 条记录、15 篇公开文章 |
| 原草稿 | `draft.md` 继续为草稿，不进入前台、RSS 与 Pagefind |
| 原头像与默认图标 | `public/assets/images/logo-nocticur.png`，保持 PNG 原始字节 |

作者卡与首页签名保留空格及换行：

```text
向 夜 驰 行 ， 不 问 喧 嚣
身 沉 暮 色 ， 心 赴 归 途
```

[content-baseline.json](./content-baseline.json) 记录原 14 篇的路径、网址、草稿状态及哈希；[migration-provenance.json](./migration-provenance.json) 记录来源提交、文章正文哈希与原图 SHA256。迁入文章只新增显式中文 `slug`，保留原字段、正文、封面外链及空摘要。标题更改与固定网址独立；改网址须通过发布生成旧址重定向。

主题布局、导航结构、背景、音乐及功能开关沿用 Firefly；关于页保留技术说明与主题署名。新站公开互动替换个人服务连接，未把原作者的评论、说说或笔记导入为 Nocticur 历史。

## 内容与发布流程

首次“导入仓库基线”只建立管理记录，不重写文章、不提交 Git、不自动部署。文章采用独立 UUID，历史与评论按该 ID 关联。新文章先保存为私有草稿，明确取消草稿标记并保存后才可发布。

文章、设置、导航、图标和友链的公开修改遵循：

```text
保存私有草稿 → 冻结所选版本 → 原子提交 master
→ Vercel 完整构建 → 核验生产域名、Git SHA 与发布清单
```

发布时可以继续编辑，新的编辑不会改变已冻结快照。任务创建立即返回持久任务 ID；发布期间 Workflow 每分钟核验，发布页首次读取未完成任务时发起核查，也可手工点击“核查当前发布”。出现外部冲突或结果未知时，先查任务证据与差异，不直接重复提交。

源码模式保留完整 Markdown / MDX。可视模式用于能够安全解析的普通 Markdown；未知 YAML、HTML、MDX 或复杂块自动保留在源码模式。未修改的文档不因切换编辑器而重新序列化。媒体的 `alt` 与图注分别保存；草稿资源引用为 `media:<UUID>`，发布步骤将其替换为公开不可变资源地址。

## 开发与验证

使用 `package.json` 的 Node 要求与 `pnpm@11.22.0`；本次 CI 固定 Node `24.19.0`。从仓库根目录安装，管理项目与博客共用根锁文件：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm type-check
pnpm --filter @nocticur/admin type-check
pnpm --filter @nocticur/admin test
pnpm build:vercel
```

测试使用隔离的文件存储适配器，不需要外部数据库。统一构建生成一份 `.vercel/output`，并检查博客、后台、API 与 Workflow 的部署产物。本地测试不代替真实平台凭据与权限联调。

博客开发运行 `pnpm dev`。管理 API 运行 `pnpm --filter @nocticur/admin dev`，管理界面在另一个终端运行 `pnpm --filter @nocticur/admin dev:ui`；Vite 将 `/api` 代理到本地 Nitro。开发默认源为 `http://localhost:3000` 与 `http://localhost:4321`；通过 Vite 发起有会话的写请求时，将 `ADMIN_DEV_ORIGIN` 显式设为 `http://localhost:5173`。本地和 Preview 使用隔离密码、私有文件存储和各自的管理 origin；非生产不能使用生产存储或开启生产操作。

## REST JSON 接口

服务运行后，`GET /api/openapi.json` 返回当前 OpenAPI 3.1 JSON。它描述真实路由、参数与鉴权边界，可用于接口查看和客户端生成；接口版本为 `0.1.0`。完整字段以该 JSON 与 `apps/admin/shared/contracts.ts` 为准。

| 模块 | 主要接口 |
| --- | --- |
| 认证 | `GET/POST /api/auth/entry`、`GET /api/auth/session`、`POST /api/auth/logout` |
| 文章 | `GET/POST /api/posts`、`GET/PUT/PATCH /api/posts/{id}`、`GET /api/posts/{id}/history`、`POST /api/posts/{id}/restore`、`POST /api/import` |
| 设置 | `GET/PUT /api/settings`、`/api/navigation`、`/api/icons`、`/api/service-settings` |
| 媒体 | `GET /api/media`、`POST /api/media/intents`、`POST /api/media/upload`、`POST /api/media/import`、`GET /api/media/{id}/content`、`PATCH/DELETE /api/media/{id}` |
| 公开互动 | `GET/POST /api/public/comments`、`GET/POST /api/public/friends` |
| 审核 | `/api/comments/{id}/delete`、`/api/bans`、`/api/friends/{id}/approve`、`/api/friends/{id}/reject`、`PATCH /api/friends/{id}` |
| 发布 | `POST /api/releases`、`GET /api/tasks`、`GET /api/tasks/{id}`、`POST /api/tasks/{id}/reconcile` |
| 维护 | `/api/maintenance/backups`、`/api/maintenance/backup`、`/api/maintenance/restore`、`/api/maintenance/check`、`GET /api/maintenance/cron` |

一次密码登录自动设置 `__Host-admin-session` 和 `__Host-admin-entry` Cookie；管理接口同时需要两者，Cookie 为 Secure、HttpOnly、SameSite=Lax。管理写请求同时校验管理源与 `x-csrf-token`，令牌从会话接口读取。文章、设置、导航和图标保存使用 `expectedRevision` 防止覆盖另一编辑，历史恢复创建新草稿版本并保留当前版本。成功响应通常为 `{ "data": ... }`，失败为 `{ "error": { "code": ..., "message": ... } }`；任务创建返回 HTTP 202。恢复后阻塞的发布任务手工核查还须传 `{ "reconcileRestored": true }`，表示只核查既有 Git 与生产结果。

公开评论按稳定文章 ID 查询，只返回公开字段及被删回复占位，不返回访客邮箱。访客写入要求 Turnstile、对应站点源和限流。Blob 上传接口的令牌请求仍须管理员认证，服务商完成回调须验证签名；它在 OpenAPI 中的公开回调描述不表示匿名可获取上传令牌。Cron 使用独立 Bearer 密钥。`/api/health` 只表示进程运行，不能作为私有存储或外部服务就绪证明。

## 维护与备份兼容

维护页读取 `CuteLeaf/Firefly` 最新 GitHub release，与当前主题包的稳定版本比较；无法取得或无法比较时显示未知。后台代码检查使用 GitHub App 只读查询 `master`，与 Vercel 注入的当前部署 SHA 比较；未配置 App 或未取得部署 SHA 时不显示“已是最新”。升级前额外建立私有备份，审阅代码与文件格式兼容性，再统一部署博客和后台。搜索索引重建与公开静态缓存切换由完整发布完成。

新备份采用 schema 3，不包含旧邮件集合。schema 2 备份仍可恢复其余有效数据，其中的邮件集合被忽略。恢复保留当前服务开关，清除登录会话并阻止旧发布任务直接重放；当前私有状态中的旧邮件历史保持原样，旧备份文件也不会被重写。友链上线状态的中断修复继续执行，不涉及发信。
