> 历史记录：2026-10-15 起后台改用无数据库文件存储。本文中的数据库架构、迁移步骤和旧测试结果不代表当前实现；当前配置见 [environment-variables.md](./environment-variables.md)。

# Vercel 环境变量精简回执 · 2026-10-14

目标：`ymian3865-5221s-projects/firefly`（`prj_lIQjUgfWVL6f8XUdyOK7wsttWJZG`）。

用户已完成本机 Vercel CLI 登录。删除前通过 Vercel API 核实记录仍为空；通过 CLI 逐项删除，随后再次读取元数据确认 **61 条记录减少为 9 条，删除 52 条空占位**。其中最后三个开关在用户明确批准迁入后台并默认关闭后删除。没有填入真实凭据，没有修改生产秘密的值，没有部署代码，也没有删除其他 Vercel 项目。

| 保留变量 | 环境 | 类型 |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | production | Secret |
| `ADMIN_PRODUCTION_DATABASE_URL` | production | Secret |
| `GITHUB_APP_ID` | production | Config |
| `GITHUB_APP_PRIVATE_KEY` | production | Secret |
| `VERCEL_TOKEN` | production | Secret |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | production | Secret |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | production | Secret |
| `ADMIN_ENTRY_PASSWORD` | production | Secret |
| `PUBLIC_TURNSTILE_SITE_KEY` | production, preview, development | Config |

基础必填为 ADMIN_ENTRY_PASSWORD 和 ADMIN_PRODUCTION_DATABASE_URL；其余七项服务凭据按功能使用。保留的九项目前也均为空，等待用户填写真实凭据。

三个生产保护开关已在本地代码迁入后台“服务设置”，默认关闭，保留管理员认证、Origin/CSRF 校验、原子修订号和环境隔离。恢复旧备份不覆盖当前开关。其余无须人工填写的配置已接入自动获取，见 [当前清单](./environment-variables.md)。新界面须部署本次代码后才能在线使用。

本次删除的全是已核实的空占位。原有公开语言/页面开关为空，移除后沿用仓库已有配置；PUBLIC_PAGES_GUESTBOOK 属于已移除页面，也已清理。Preview/Development 未使用的后台空变量已移除，不会共享生产凭据。

验证：后台 166 项测试中 154 项通过、12 项因未配置隔离测试数据库而跳过；博客和后台类型检查通过；Astro 检查 272 个文件无错误、警告或提示；`pnpm build:vercel` 通过，统一产物及实际函数入口检查 4 项通过。浏览器使用临时本地模拟接口验证了开关默认关闭、修改保存和发布权限刷新；该验证不代表生产数据库已连接，测试夹具已删除。
