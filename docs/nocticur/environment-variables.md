# 无数据库环境变量

博客、`/admin/` 和 `/api/` 部署在同一个 Vercel `firefly` 项目。后台不需要数据库连接、建表或迁移。

## 基础后台：4 项

| 变量 | 填什么 | 用途 |
| --- | --- | --- |
| `ADMIN_ENTRY_PASSWORD` | 自己设置的 3～10 个字符密码，建议 10 位随机字符 | 后台登录；程序自动计算加盐哈希 |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | Vercel **Private Blob store** 的 Read/Write token | 保存私有 JSON 状态、草稿、历史、登录会话、限流、审核记录与备份；只用于私有后台数据 |
| `IMGBED_API_TOKEN` | CloudFlare-ImgBed API Token | 发布后台上传的图片到 `https://image.nocticur.eu.cc`；仅服务端使用 |
| `IMGBED_BASE_URL` | 可选，默认为 `https://image.nocticur.eu.cc` | 你的 CloudFlare-ImgBed 地址；只有图床地址改变时才需要填写 |

密码、Private Blob token 和 ImgBed API token 设为 Secret，仅勾选 Production；`IMGBED_BASE_URL` 是普通配置。首次使用时程序自动创建当前站点的状态文件，不需先初始化数据库。已有静态文章和图片照常从 GitHub 构建；不启用后台时无需这些凭据。

## 按功能添加

| 功能 | 变量 | 说明 |
| --- | --- | --- |
| 从仓库导入、核查和发布 | `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY` | GitHub App 只安装到 `Nocticur/Firefly`；Contents read/write，Metadata read；填写完整 PEM 私钥 |
| 核验生产发布 | `VERCEL_TOKEN` | 选择当前项目团队作用域，程序读取实际生产部署结果 |
| 接收友链申请或本站评论 | `PUBLIC_TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` | 同一个 Turnstile 小组件的公钥和私钥，允许博客域名 |
| Vercel 每日维护 Cron | `CRON_SECRET` | 已配置 Cron 的必需生产 Secret；使用独立随机值，接口以 Bearer 校验。维护业务开关仍默认关闭；每日维护同时执行 30 天历史清理 |

除 App ID 和 Turnstile Site key 外均设为 Secret。服务密钥不能填写到公开 JSON、文章、后台表单或 Git。后台只保存服务的开启状态，不接收服务密钥。

## 已自动完成

- 环境读取 `VERCEL_ENV`，本地默认 development。
- 仓库和发布分支沿用 `Nocticur/Firefly` 的 `master`。
- 生产地址读取 Vercel 项目的 `VERCEL_PROJECT_PRODUCTION_URL`，回退到当前部署的 `VERCEL_URL`；没有平台值时才回退到已发布站点地址。管理界面和公开交互因此跟随当前 Vercel 项目，不需要手填 `ADMIN_ORIGIN` 或 `PUBLIC_SITE_ORIGIN`。
- 预览 origin 读取平台 `VERCEL_URL`，继续精确校验来源。
- GitHub App 安装编号由目标仓库接口查询。
- Vercel 项目编号读取系统 `VERCEL_PROJECT_ID`。
- 图片导入白名单默认使用博客域名和已发布图片实际使用的 HTTPS 主机。后台发布图片使用 CloudFlare-ImgBed，不再使用 Public Blob。
- 语言、页面和主题沿用仓库现有设置。

Vercel 需开启 **Enable access to System Environment Variables**。通常不必添加 APP_ENV、各类 origin、GitHub installation ID、Vercel project ID 等高级覆盖变量。`ADMIN_ORIGIN`、`PUBLIC_SITE_ORIGIN`、所有数据库连接变量和 `BLOB_PUBLIC_READ_WRITE_TOKEN` 已不再使用，应从 Vercel 项目环境变量中删除。

## 服务开关和隔离

登录 `/admin/` 的“服务设置”，按需开启生产发布和生产维护。两项默认关闭；保存后立即生效，填入密钥不会自动开启服务。写入继续校验管理员、同源 Origin、CSRF 和修订号。Preview/Development 永远不能开启生产操作。

开发使用 `ADMIN_DEV_PRIVATE_BLOB_TOKEN`，预览使用 `ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN`，各自对应独立 Private store；公开图片统一发布到 ImgBed，不再添加开发或预览 Public Blob token。非生产不会回退到生产存储，且拒绝复用同一 store。每个环境还需自己的后台密码和所用第三方服务的隔离凭据。

## 个人邮箱与访客联系方式

个人联系邮箱为 `youjinmian@outlook.com`，通过博客中的邮箱链接联系，无需发信服务环境变量。评论和友链申请中的访客邮箱字段继续保留，用于必要时人工联系，不会公开展示；后台不自动发送回复、审核或上线邮件。第三方评论系统继续使用原有配置。

## 文件如何保存

后台状态保存在 private store 的 `admin-state/<站点摘要>/state.json`；不能直接公开访问。读操作绕过缓存，写操作校验 ETag，避免并发覆盖。状态文件最大 16 MiB；媒体字节、发布后的不可变图片和备份文件独立存放。每日维护自动清理超过 30 天的历史、已结束发布记录和备份对象；当前状态、未完成任务和恢复待核验记录保留。存储不可用或文件损坏时停止写入，不回退临时磁盘或内存。

已经彻底移除数据库驱动、SQL、迁移脚本和 CI 数据库服务。不要再添加任何数据库连接变量或执行旧迁移命令。旧文档和验收回执仅保留为历史记录，以本页为当前清单。

配置和代码修改需要重新部署才会在线上生效；完整统一构建命令为 `pnpm build:vercel`。本次不购买服务、不升级套餐，不以本地验证代替真实平台联调。
