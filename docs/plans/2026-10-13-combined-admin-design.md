# 博客与后台同项目部署

用户要求后台与博客一起部署，并提供博客内的后台进入按钮。原来的独立 `firefly-admin` 项目与 `admin.mourn.top` 入口不再是目标部署结构。

## 路径与构建

- 现有 Vercel `firefly` 项目保持仓库根目录，生产分支为 `master`。
- 博客在 `https://blog.mourn.top/`，后台在 `/admin/`，后台资源在 `/admin/assets/`，所有 API 在同源 `/api/`。
- 根 `pnpm build:vercel` 执行完整静态博客流水线与后台 Vite/Nitro 构建，生成根 `.vercel/output`，同一次部署发布两部分。
- `pnpm build` 保持静态博客用途；Cloudflare 构建选择保留。独立后台开发服务和 Vite 服务仍用于本地开发，不要求新建托管项目。
- 后台入口与 API 使用 `no-store`；现有登录、数据库会话、Origin/CSRF 校验、限流和环境隔离继续适用。

## 变量与平台状态

Production 的 `ADMIN_ORIGIN` 和 `PUBLIC_SITE_ORIGIN` 都为 `https://blog.mourn.top`，不含 `/admin`。Preview 的两个 origin 指向同一个实际预览部署，使用隔离数据库与凭据。发布核验使用原 `firefly` 项目 ID `prj_lIQjUgfWVL6f8XUdyOK7wsttWJZG`，团队 ID 为 `team_09F7sDf0p1hCd9apVLcHC2iU`。

2026-10-13 平台核查发现 `firefly` 尚缺后台变量。旧 `firefly-admin` 的 Sensitive 值不能由读取工具恢复；用户须从原服务或密码管理器把所需凭据安全设置到 `firefly`。删除项目工具只返回需用户在控制台完成的已验证链接，不表示删除成功。数据库、Blob 与 GitHub App 保留为统一项目所需的外部服务。

## 验收边界

代码验收应覆盖统一构建产物、`/admin/` 入口、静态博客与 API 路由、缓存策略，以及浏览器中后台按钮和登录页。真实密码登录、数据库迁移、上传、发布和通知需要平台凭据与外部服务；本设计与本地构建不能代替生产验收。

现行操作说明：[部署](../nocticur/deployment.md)、[环境变量](../nocticur/environment-variables.md)、[免费服务](../nocticur/free-deployment.md)。2026-10-12 两项目回执保留为历史记录。

## 本地验证结果

- `pnpm check`：272 个文件，0 错误、0 警告、0 提示；博客与后台类型检查通过。
- `pnpm build:vercel` 完整构建通过，同一产物包含博客、后台、API 和 Workflow。
- 4 项实际产物与生成服务验收通过，覆盖静态文件、响应头、后台入口、匿名 API 拒绝及未知路径 404；导航迁移回归通过。
- 后台测试 142 项通过；11 项需要隔离测试数据库，本机未配置，已跳过。发布配置原子提交测试另行通过。
- 浏览器工具受到 Windows 沙箱目录权限错误阻断，未完成此次按钮的目视验证；不复用旧截图作为本次验证证据。
- 未推送或部署本次源码，未迁移平台秘密，也未删除旧 Vercel 项目。

用户随后要求先保存变量名。已在统一 `firefly` 项目添加 38 个后台变量名（46 条分环境配置），新增值全部留空，保留原有变量；这不表示运行所需数值已配置。详见 [环境变量添加回执](../nocticur/vercel-env-setup-2026-10-13.md)。
