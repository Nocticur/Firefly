# Nocticur 的 Firefly 博客与管理后台

本次选择 `Nocticur/Firefly` 与 Vercel 方案，发布分支为 `master`。博客保持 Astro 静态站点；管理界面、Hono API 与 Workflow 在独立 Vercel 项目运行。生产目标地址为 `https://blog.mourn.top/` 和 `https://admin.mourn.top/`。

本地验收已完成；Git 提交与推送状态以当前 Git 记录及本次推送回执为准。验证记录见 [acceptance.md](./acceptance.md)，平台配置与上线步骤见 [deployment.md](./deployment.md)。实际生产服务尚未接入，生产域名尚未切换。

本地完整数据库测试、发布清单测试、类型检查、博客与后台构建、编译后 API、主要页面和编辑器 8 项实际交互均已通过，详见验收记录。

交付文件为 [源码与验收包](/workspace/firefly-nocticur-review.tar.gz) 和 [SHA256 校验文件](/workspace/firefly-nocticur-review.tar.gz.sha256)。包为此前本地验收快照，本次推送准备仅调整本文件、`acceptance.md` 和 `resume-plan.md` 的状态措辞。包内包含完整工作区源码、`worktree.patch`、`deleted-paths.txt`、明确选取的环境辅助文件、验收日志、JSON 和截图；不包含会话文件、实际 `.env`、缓存或数据库。`deleted-paths.txt` 记录停用的旧 GitHub Pages workflow，恢复原代码仍使用前置备份。

## 改动清单

| 范围 | 已实现的改动 | 主要文件 |
| --- | --- | --- |
| 资料与主题 | 迁入身份、两行签名、原头像、两篇文章与固定中文地址；保留主题布局、功能开关、原文章和草稿 | `src/config/`、`src/content/posts/`、`src/content/spec/about.md`、`public/assets/images/logo-nocticur.png` |
| 管理界面 | 仪表盘、文章与历史、设置、导航与六个图标位、媒体、评论、友链、发布、维护；响应式页面与未保存提示 | `apps/admin/client/` |
| 写作 | TipTap 可视编辑、斜杠菜单、链接、代码、公式、Mermaid、表格；完整源码和未知片段保护 | `apps/admin/client/components/ArticleEditor.tsx`、`apps/admin/server/content.ts` |
| 登录与数据 | 固定 GitHub OAuth 回调、数字管理员 ID、持久会话和 CSRF；隔离 PostgreSQL 与顺序迁移 | `apps/admin/server/auth.ts`、`apps/admin/server/security.ts`、`apps/admin/migrations/` |
| 媒体 | 受限直传、签名完成回调、私有鉴权读取、外链导入；冻结媒体校验与公开不可变副本 | `apps/admin/server/media.ts` |
| 发布 | SQL 持久任务、冻结快照、租约 fencing、GitHub 原子提交、Workflow 等待、生产别名及清单核验；旧 slug 的永久重定向随配置提交 | `apps/admin/server/releases.ts`、`apps/admin/server/github.ts`、`apps/admin/workflows/`、`scripts/generate-release-manifest.ts` |
| 互动与通知 | 纯文本评论、Turnstile、限流、封禁、回复占位；友链审核、分组与生产上线通知；Resend 唯一通知及未知结果核查 | `apps/admin/server/interactions.ts`、`apps/admin/server/mail.ts` |
| 维护与部署 | 更新检查、私有备份、独立库恢复、每日 Cron；两个 Vercel 项目、完整构建 CI 和回滚说明 | `apps/admin/server/maintenance.ts`、`apps/admin/server/update-check.ts`、`vercel.json`、`apps/admin/vercel.json`、`.github/workflows/build.yml` |

实现的运行范围与故障覆盖以 [验收记录](./acceptance.md) 为准；生产参数、服务开通和回滚流程见 [部署说明](./deployment.md)。在线接口文档入口为管理项目的 [`/api/openapi.json`](https://admin.mourn.top/api/openapi.json)，需部署管理项目后访问；仓库中的定义见 [`apps/admin/server/openapi.ts`](../../apps/admin/server/openapi.ts)。

云环境发布故障已按用户要求暂缓。交接文件包括 [完整配置提案](/workspace/.firefly-environment/setup-transfer.json)、[安装脚本](/workspace/.firefly-environment/install-implementation.sh)、[启动与验证说明](/workspace/.firefly-environment/start-implementation.md) 和 [环境交接包](/workspace/firefly-setup-handoff.tar.gz)。最新配置保存仍受 `stale_base` 阻挡；这些磁盘文件不表示配置已保存或环境已发布。

## 迁移资料与保留规则

来源为只读仓库 `Nocticur/blog` 的 `master` 提交 `c075ac36c1313dc6ee47f7690c1a360aaa087da8`，作为 Windows `D:\blog` 资料的已解析来源。目标基线为 `Nocticur/Firefly` 提交 `6d82554bfe1cb3d4b43adb0969dad1d43ac6dee3`；仅迁入约定身份、头像与两篇文章。

| 项目 | 约定结果 |
| --- | --- |
| 标题 / 作者 | Nocticur的博客 / Nocticur |
| 描述 | Nocticur的博客，记录个人学习、工作、AI相关的内容 |
| 建站时间 / 时区 | `2026-07-26T00:00:00+08:00` / `Asia/Shanghai` |
| 联系方式 | GitHub Nocticur、B站 645892937、原约定 QQ 群、`nocticur@mourn.top` |
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
pnpm --filter @nocticur/admin db:migrate
pnpm check
pnpm type-check
pnpm --filter @nocticur/admin type-check
pnpm --filter @nocticur/admin test
pnpm build
NITRO_PRESET=vercel pnpm --filter @nocticur/admin build
```

迁移与数据库测试需要先安全注入隔离 PostgreSQL 连接；不会自动读取本模板中的空值。`ADMIN_TEST_DATABASE_URL` 未配置时，数据库测试会跳过，因此零失败不等于已覆盖数据库。维护恢复测试会建立并删除临时测试数据库，须使用专用测试实例与允许该操作的测试角色。

博客开发运行 `pnpm dev`。管理 API 运行 `pnpm --filter @nocticur/admin dev`，管理界面在另一个终端运行 `pnpm --filter @nocticur/admin dev:ui`；Vite 将 `/api` 代理到本地 Nitro。开发默认源为 `http://localhost:3000` 与 `http://localhost:4321`；通过 Vite 发起有会话的写请求时，将 `ADMIN_DEV_ORIGIN` 显式设为 `http://localhost:5173`。生产登录绑定固定 HTTPS 管理域名；本地或临时 Preview 域名不能完成这套生产 OAuth 登录。

## REST JSON 接口

服务运行后，`GET /api/openapi.json` 返回当前 OpenAPI 3.1 JSON。它描述真实路由、参数与鉴权边界，可用于接口查看和客户端生成；接口版本为 `0.1.0`。完整字段以该 JSON 与 `apps/admin/shared/contracts.ts` 为准。

| 模块 | 主要接口 |
| --- | --- |
| 认证 | `GET /api/auth/github`、`GET /api/auth/callback`、`GET /api/auth/session`、`POST /api/auth/logout` |
| 文章 | `GET/POST /api/posts`、`GET/PUT/PATCH /api/posts/{id}`、`GET /api/posts/{id}/history`、`POST /api/posts/{id}/restore`、`POST /api/import` |
| 设置 | `GET/PUT /api/settings`、`/api/navigation`、`/api/icons` |
| 媒体 | `GET /api/media`、`POST /api/media/intents`、`POST /api/media/upload`、`POST /api/media/import`、`GET /api/media/{id}/content`、`PATCH/DELETE /api/media/{id}` |
| 公开互动 | `GET/POST /api/public/comments`、`GET/POST /api/public/friends` |
| 审核 | `/api/comments/{id}/delete`、`/api/bans`、`/api/friends/{id}/approve`、`/api/friends/{id}/reject`、`PATCH /api/friends/{id}` |
| 发布 | `POST /api/releases`、`GET /api/tasks`、`GET /api/tasks/{id}`、`POST /api/tasks/{id}/reconcile` |
| 邮件 | `GET /api/mail`、`POST /api/mail/{id}/reconcile`、`POST /api/webhooks/resend` |
| 维护 | `/api/maintenance/backups`、`/api/maintenance/backup`、`/api/maintenance/restore`、`/api/maintenance/check`、`GET /api/maintenance/cron` |

管理接口需要 `__Host-admin-session` Cookie；Cookie 为 Secure、HttpOnly、SameSite=Lax。管理写请求同时校验管理源与 `x-csrf-token`，令牌从会话接口读取。文章、设置、导航和图标保存使用 `expectedRevision` 防止覆盖另一编辑，历史恢复创建新草稿版本并保留当前版本。成功响应通常为 `{ "data": ... }`，失败为 `{ "error": { "code": ..., "message": ... } }`；任务创建返回 HTTP 202。恢复后阻塞的发布任务手工核查还须传 `{ "reconcileRestored": true }`，表示只核查既有 Git 与生产结果。

公开评论按稳定文章 ID 查询，只返回公开字段及被删回复占位，不返回访客邮箱。访客写入要求 Turnstile、对应站点源和限流。Blob 上传接口的令牌请求仍须管理员认证，服务商完成回调须验证签名；它在 OpenAPI 中的公开回调描述不表示匿名可获取上传令牌。Resend Webhook 使用签名鉴权，Cron 使用独立 Bearer 密钥。`/api/health` 只表示进程运行，不能作为数据库或外部服务就绪证明。

## 维护与邮件状态

维护页读取 `CuteLeaf/Firefly` 最新 GitHub release，与当前主题包的稳定版本比较；无法取得或无法比较时显示未知。后台代码检查使用 GitHub App 只读查询 `master`，与 Vercel 注入的当前部署 SHA 比较；未配置 App 或未取得部署 SHA 时不显示“已是最新”。升级前额外建立私有备份，审阅代码与数据库兼容性，再分别部署博客和后台。搜索索引重建与公开静态缓存切换由完整发布完成。

友链拒绝通知在审核结果落库后发送，上线通知在冻结版本通过生产核验后发送。邮件记录的“已发送”表示服务商已接受或已确认发送，不保证收件箱送达；退信、投诉、发送失败和抑制会显示失败原因。发送结果未知时保留同一通知记录，核查签名回调或服务商记录；超过 Resend 的 24 小时幂等窗口不自动重发。
