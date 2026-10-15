# 部署服务与用量

博客和后台部署在一个 Vercel `firefly` 项目，不创建第二个后台项目，不购买服务或升级套餐。

| 功能 | 服务 | 配置方式 |
| --- | --- | --- |
| 博客和后台托管 | 现有 Vercel 项目 | 根目录 `pnpm build:vercel` |
| 草稿、历史、会话、限流、审核与备份 | Vercel Private Blob 文件 | 填私有 store 的 token，首次自动创建 JSON 状态文件 |
| 管理入口 | 服务端密码登录 | 填 ADMIN_ENTRY_PASSWORD，无需第三方登录 |
| 正式内容和发布历史 | GitHub App | 限定目标仓库，显式发布时提交 |
| 公开图片 | Vercel Public Blob | 按需填写独立 public store token |
| 评论和友链验证 | Turnstile | 按需填写小组件公钥和私钥 |
| 任务和定时维护 | Workflow 与每日 Cron | 使用时配置凭据并在后台明确开启 |

不再使用 Neon、PostgreSQL 或其他数据库服务。基础后台需要密码和私有文件存储凭据；静态博客无需这些后台配置。

后台服务开关仅保留生产发布和生产维护，默认关闭。个人联系邮箱 `youjinmian@outlook.com`、评论与友链申请中的访客邮箱继续保留，无需自建发信服务或发信凭据。第三方评论系统仍按原配置接入。

文件存储仍有请求次数、容量和流量用量。是否包含免费额度及额度大小以账户当前方案和官方说明为准；不能把“无数据库”等同于无限免费。若某项服务要求付费或升级，保持功能关闭并由用户决定。本次不购买、不自动扩容、不修改付费设置。

状态文件最大 16 MiB，适合个人博客；读写频繁或数据量很大时需重新评估文件方案。所有生产能力默认关闭，存储不可用时拒绝保存，不通过降低认证或使用临时磁盘来绕过配置。

- [Vercel Blob 官方说明](https://vercel.com/docs/vercel-blob)
- [Vercel Blob 用量](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Vercel Hobby](https://vercel.com/docs/plans/hobby)

当前填写清单见 [环境变量](./environment-variables.md)，部署步骤见 [统一部署](./deployment.md)。
