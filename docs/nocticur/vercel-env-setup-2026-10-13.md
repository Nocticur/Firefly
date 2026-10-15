> 历史记录：2026-10-15 起后台改用无数据库文件存储。本文中的数据库架构、迁移步骤和旧测试结果不代表当前实现；当前配置见 [environment-variables.md](./environment-variables.md)。

> 历史回执：此处记录创建空占位项的操作。2026-10-14 已按用户要求精简，当前清单见 [环境变量说明](./environment-variables.md)，清理结果见 [精简回执](./vercel-env-simplification-2026-10-14.md)。

# 统一项目环境变量添加回执

日期：2026-10-13（Asia/Shanghai）。本回执只记录变量名称、范围和保存类型，不包含秘密值。

- 项目：`firefly`（`prj_lIQjUgfWVL6f8XUdyOK7wsttWJZG`），团队：`team_09F7sDf0p1hCd9apVLcHC2iU`。
- 新增 38 个变量名，拆为 46 条环境配置，共覆盖 52 个环境绑定。
- 所有新增值按用户要求提交为空字符串，未填写密码、连接串、令牌或固定配置值。
- 每条新增配置已添加“待填写”及用途说明；密码、连接串和令牌使用 Secret。
- 原有 15 条配置保留，校验没有发现缺项、类型错误或已有记录变化。
- 此次仅保存环境变量，没有触发重新部署，也没有删除旧项目。

填写入口：[Vercel firefly 环境变量](https://vercel.com/ymian3865-5221s-projects/firefly/settings/environment-variables)。具体取值参考 [环境变量填写清单](./environment-variables.md)。填写完成后再重新部署；空值不表示后台服务已经配置可用。

| 变量名 | 范围 | 类型 |
| --- | --- | --- |
| `ADMIN_DEVELOPMENT_DATABASE_URL` | development | Secret |
| `ADMIN_DEV_ORIGIN` | development | Config |
| `ADMIN_DEV_PRIVATE_BLOB_TOKEN` | development | Secret |
| `ADMIN_DEV_PUBLIC_BLOB_TOKEN` | development | Secret |
| `ADMIN_ENTRY_PASSWORD` | development | Secret |
| `ADMIN_ENTRY_PASSWORD` | preview | Secret |
| `ADMIN_ENTRY_PASSWORD` | production | Secret |
| `ADMIN_ORIGIN` | production | Config |
| `ADMIN_PREVIEW_DATABASE_URL` | preview | Secret |
| `ADMIN_PREVIEW_ORIGIN` | preview | Config |
| `ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN` | preview | Secret |
| `ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN` | preview | Secret |
| `ADMIN_PRODUCTION_DATABASE_URL` | production | Secret |
| `ADMIN_TEST_DATABASE_URL` | development | Secret |
| `APP_ENV` | development | Config |
| `APP_ENV` | preview | Config |
| `APP_ENV` | production | Config |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | production | Secret |
| `BLOB_PUBLIC_READ_WRITE_TOKEN` | production | Secret |
| `CRON_SECRET` | production | Secret |
| `ENABLE_PRODUCTION_EMAIL` | production | Config |
| `ENABLE_PRODUCTION_MAINTENANCE` | production | Config |
| `ENABLE_PRODUCTION_PUBLISH` | production | Config |
| `ENABLE_PUBLIC_COMMENTS` | production, preview, development | Config |
| `GITHUB_APP_ID` | production | Config |
| `GITHUB_APP_PRIVATE_KEY` | production | Secret |
| `GITHUB_INSTALLATION_ID` | production | Config |
| `GITHUB_REPOSITORY` | production, preview, development | Config |
| `INTERACTION_HASH_SECRET` | development | Secret |
| `INTERACTION_HASH_SECRET` | preview | Secret |
| `INTERACTION_HASH_SECRET` | production | Secret |
| `MEDIA_IMPORT_HOSTS` | production, preview, development | Config |
| `PUBLIC_DEV_ORIGIN` | development | Config |
| `PUBLIC_PREVIEW_ORIGIN` | preview | Config |
| `PUBLIC_SITE_ORIGIN` | production | Config |
| `RESEND_API_KEY` | production | Secret |
| `RESEND_FROM` | production | Config |
| `RESEND_WEBHOOK_SECRET` | production | Secret |
| `RESTORE_DATABASE_URL` | production | Secret |
| `TURNSTILE_SECRET_KEY` | development | Secret |
| `TURNSTILE_SECRET_KEY` | preview | Secret |
| `TURNSTILE_SECRET_KEY` | production | Secret |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | production | Secret |
| `VERCEL_BLOG_PROJECT_ID` | production | Config |
| `VERCEL_TEAM_ID` | production | Config |
| `VERCEL_TOKEN` | production | Secret |

