# Nocticur 的 Firefly 博客与管理后台

博客、`/admin/` 与 `/api/` 仍部署在同一个 Vercel 项目（`firefly`），根构建命令保持 `pnpm build:vercel`。正式文章、设置、导航和图标由后台直接读写你的 GitHub 仓库（细粒度 PAT，默认 `Nocticur/Firefly` 的 `master`）；本地图片先存 Cloudflare KV，显式发布后提交到 Git 项目的 `public/uploads/`；外链导入可转存到 CloudFlare-ImgBed。不使用数据库、Vercel Blob 或 Upstash Redis。

当前配置以 [环境变量填写清单](./environment-variables.md) 和 [统一部署说明](./deployment.md) 为准；服务额度见 [免费部署说明](./free-deployment.md)。

## 当前架构

| 部分 | 位置 / 服务 | 说明 |
| --- | --- | --- |
| 博客 | Vercel 项目 `firefly` | Astro 静态站点，`https://blog.mourn.top/`；与后台同源构建，无需第二个项目 |
| 管理界面、API、Workflow | 同一 Vercel 项目 | 入口 `/admin/` 与 `/api/`，Hono API 与 Vercel Workflow 部署在同一份 `.vercel/output` |
| 正式内容 | 本项目仓库 `Nocticur/Firefly` 的 `master` | 文章、公开设置、导航、图标及发布图片由后台提交；Git 提交是公开内容的唯一来源 |
| 后台草稿与运行时数据 | 后台内部状态 | 草稿、历史、评论/友链审核、发布任务与维护任务；未配置 Cloudflare KV 时保存在进程内存，重启即清空 |
| 图片资源 | GitHub 项目 + Cloudflare KV | 本地图片待发布时私有暂存于 KV，发布核验后进入 `public/uploads/` 并删除 KV 字节；外链导入可转存 ImgBed |
| 登录 | 服务端密码 + 无状态签名 Cookie | 只验证 `ADMIN_ENTRY_PASSWORD`，会话由 HMAC 签名，不需要会话表 |

`siteId` 为 `GITHUB_REPOSITORY`（默认 `Nocticur/Firefly`）加运行环境。**Git 是唯一持久数据源**：后台首次打开会自动导入仓库现有文章与设置，因此不会显示空白。可选配置 Cloudflare KV 时，后台状态写入 KV；未配置时用进程内存，并发写冲突返回 `409` 提示刷新后重新编辑；Production 与 Preview 的本地图片上传必须配置各自隔离的 KV。文章与设置的正式版本始终以 Git 提交为准。

## 登录方式

博客作者卡片和手机导航菜单提供“后台管理”入口。进入页只验证管理密码：

- 密码为 3～10 个字符，由 `ADMIN_ENTRY_PASSWORD` 提供，服务端使用 scrypt（随机加盐）计算并核对哈希，明文不写入日志或状态。
- 验证成功后签发 HMAC 签名的无状态会话，设置 `__Host-admin-session` Cookie（Secure、HttpOnly、SameSite=Lax）；会话保存令牌即包含身份与过期时间，服务端不存会话表，所以退出只清除 Cookie。轮换 `ADMIN_ENTRY_PASSWORD` 或设置 `ADMIN_SESSION_SECRET` 会让此前所有会话立即失效。管理写请求同时校验管理源与 `x-csrf-token`，并受限流保护。
- 不需要用户名、GitHub 登录或 OAuth。

## 功能清单

| 模块 | 功能 |
| --- | --- |
| 仪表盘 | 当前部署 SHA、文章/发布/审核计数、维护与发布状态、待处理事项 |
| 文章与历史 | 列表、源码与可视编辑、草稿、版本历史与恢复；支持完整 Markdown/MDX 源码和未知片段保护。发布核验后自动清理该文章的本地版本历史，控制存储体积 |
| 设置 | 站点资料、主题与功能开关等公开设置；可只存草稿，也可一键提交回仓库 |
| 导航与图标 | 导航链接与图标位编辑；校验层级、URL 与字段，随提交或发布写入 |
| 媒体 | 本地上传保存私有草稿，发布时提交到项目 `public/uploads/`；外链导入可转存 ImgBed；直接上传限制 4 MiB，外链导入最大 32 MiB |
| 评论 | 公开评论审核、删除占位、封禁与限流；Turnstile 校验，访客邮箱不公开 |
| 友链 | 申请审核、分组与排序、上线状态与健康检测结果展示 |
| 发布 | 创建发布任务、冻结快照、直接提交 Git、核验生产域名与发布清单；未配置 KV 时在同一请求内完成；失败或未知结果可核查 |
| 维护 | 更新检查、创建备份、恢复、每日 Cron 与 30 天历史清理；生产发布与维护开关默认关闭 |

公开互动（评论、友链申请）可在“服务设置”中按需开启；生产发布与生产维护同样需要管理员显式开启，填入密钥不会自动开启。

## 构建与验证

要求 Node.js `>=22.23.0`、`pnpm@11.22.0`。从仓库根目录安装，博客与后台共用根锁文件：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm type-check
pnpm test:site
pnpm --filter @nocticur/admin type-check
pnpm --filter @nocticur/admin test
pnpm build:vercel
```

`pnpm build:vercel` 生成一份 `.vercel/output`，包含静态博客、管理资源、API 与 Workflow，并核验产物结构。本地管理 API 用 `pnpm --filter @nocticur/admin dev`（端口 3000），管理界面用 `pnpm --filter @nocticur/admin dev:ui`（Vite 5173，代理 `/api`）。本地与 Preview 使用各自的密码；本地要读写真实仓库时，在 `.env` 里配置 `GITHUB_TOKEN`、`GITHUB_REPOSITORY`、`GITHUB_BRANCH`。浏览器回归可用 `pnpm test:browser`（截图写入 `cache/verify-screenshots/`）。

## REST API 简表

服务运行后 `GET /api/openapi.json` 返回 OpenAPI 3.1 JSON，描述真实路由、参数与鉴权边界；完整字段以该 JSON 与 `apps/admin/shared/contracts.ts` 为准。

| 模块 | 主要接口 |
| --- | --- |
| 认证 | `GET/POST /api/auth/entry`、`GET /api/auth/session`、`POST /api/auth/logout` |
| 文章 | `GET/POST /api/posts`、`GET/PUT/PATCH /api/posts/{id}`、`GET /api/posts/{id}/history`、`POST /api/posts/{id}/restore`、`POST /api/import` |
| 设置 | `GET/PUT /api/settings`、`POST /api/settings/commit`、`/api/navigation`、`/api/icons`、`/api/service-settings` |
| 媒体 | `GET /api/media`、`POST /api/media/upload`（multipart，≤4 MiB，写入私有草稿）、`GET /api/media/{id}/content`（受保护预览或公开地址跳转）、`POST /api/media/import`、`PATCH/DELETE /api/media/{id}` |
| 公开互动 | `GET/POST /api/public/comments`、`GET/POST /api/public/friends` |
| 审核 | `/api/comments/{id}/delete`、`/api/bans`、`/api/friends/{id}/approve`、`/api/friends/{id}/reject`、`PATCH /api/friends/{id}` |
| 发布 | `POST /api/releases`、`GET /api/tasks`、`GET /api/tasks/{id}`、`POST /api/tasks/{id}/reconcile` |
| 维护 | `/api/maintenance/backups`、`/api/maintenance/backup`、`/api/maintenance/restore`、`/api/maintenance/check`、`GET /api/maintenance/cron` |

成功响应通常为 `{ "data": ... }`，失败为 `{ "error": { "code": ..., "message": ... } }`；任务创建返回 HTTP 202。文章、设置、导航、图标保存使用 `expectedRevision` 防止覆盖他人编辑；历史恢复创建新草稿。公开评论按稳定文章 ID 查询，只返回公开字段与已删回复占位，不返回访客邮箱。Cron 使用独立 Bearer 密钥；`/api/health` 只表示进程运行，不能证明 KV 或外部服务就绪。

## 迁移记录

来源为只读仓库 `Nocticur/blog` 的 `master` 提交 `c075ac36c1313dc6ee47f7690c1a360aaa087da8`；目标为 `Nocticur/Firefly` 提交 `6d82554bfe1cb3d4b43adb0969dad1d43ac6dee3`。仅迁入约定身份、头像与两篇文章。

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

[content-baseline.json](./content-baseline.json) 记录原 14 篇的路径、网址、草稿状态及哈希；[migration-provenance.json](./migration-provenance.json) 记录来源提交、文章正文哈希与原图 SHA256。迁入文章只新增显式中文 `slug`，保留原字段、正文、封面外链及空摘要；改网址须通过发布生成旧址重定向。

后台功能清单、构建命令和接口以本页为准；部署与变量分别见 [统一部署](./deployment.md)、[环境变量](./environment-variables.md) 与 [免费部署](./free-deployment.md)。此前关于 Blob、数据库与历史验收回执的文档已删除，不再作为当前配置依据。
