# Vercel 免费部署

用户要求整个后台不产生服务费用。博客与管理后台均部署到个人 Vercel **Hobby** 项目；不升级 Pro、不购买付费附加项，也不调用任何套餐升级或购买 API。代码中的密码校验、React 界面和编辑器没有付费授权依赖；本次新增入口没有新增软件依赖。

## 服务选择

| 功能 | 选择 | 免费部署设置 |
| --- | --- | --- |
| 博客和后台托管 | Vercel Hobby | 两个个人项目，均连接 `Nocticur/Firefly` 的 `master`；个人非商业博客须符合 Hobby 用途条款 |
| 草稿、历史、登录会话和限流 | Neon Free PostgreSQL | 创建 Free 项目，不选付费计划或自动扩容付费项；只给对应环境填写数据库连接串 |
| 管理入口 | 服务端密码直接登录 | 仅验证 `ADMIN_ENTRY_PASSWORD`，无需第三方登录服务或付费认证套餐 |
| 内容读取、发布 | GitHub App + Vercel 部署 | GitHub App 限定此仓库；在免费额度内使用，显式发布，不按每次保存触发部署 |
| 图片、备份 | Vercel Blob | 只创建账户中明确支持 Hobby 免费额度的 public / private store；默认不填写令牌，超额度停用相应功能，不升级套餐 |
| 评论、友链校验 | Cloudflare Turnstile Free | 可选；公开评论默认关闭，关闭时不必配置评论服务 |
| 邮件通知 | Resend Free | 可选；仅使用 Free，`ENABLE_PRODUCTION_EMAIL` 默认关闭，无需邮件时不配置 |
| 发布任务 | Vercel Workflow + Fluid compute | 使用 Hobby 的包含额度，不申请付费额度；先在账户中核对产品是否提供免费使用及用量上限 |
| 定时维护 | Vercel Hobby 每日 Cron | 已配置每天一次；`ENABLE_PRODUCTION_MAINTENANCE` 默认关闭，启用前准备免费私有存储和恢复数据库 |

Blob 令牌为空时，图片上传及云备份不会执行；已有文章与仓库中的图片继续由博客静态资源提供。关闭邮件不影响编辑和发布，友链通过审核仍可进入显式发布。Neon 数据库是登录与编辑的必要条件，不可用内存或 Vercel 临时文件系统代替持久存储。

`ENABLE_PRODUCTION_PUBLISH`、`ENABLE_PRODUCTION_EMAIL`、`ENABLE_PRODUCTION_MAINTENANCE` 均默认关闭。基础配置和验收完成后可只开启发布，邮件与每日备份保持关闭；不要用删除认证、限流、私有存储访问控制的方式节省服务额度。后台有校验请求和数据库消耗，免费额度不是无限容量；超过免费额度时停止相关功能或等待额度恢复，不能购买或自动转入付费计划。

## 平台核对

使用用户已有的域名，不通过 Vercel 购买新域名。已有域名的注册/续费由原注册商决定，代码不能将其变成免费。个人 Vercel 项目保持 Hobby；在 Neon / Resend 等服务控制台确认 Free 且未绑定付费服务。若某项服务在当前账户要求升级或付款，保持该项关闭，不能为部署自动购买服务。

仓库为私有仓库时，GitHub Actions 也有免费分钟数和产物存储额度。账户的 Actions 付费用量预算设为 0 并阻止超预算使用；仓库构建产物已改为仅保留 1 天并提高压缩率，减少重复构建积累的存储。代码无法替用户修改个人账户的计费设置。

本次云环境没有这些平台的生产凭据，未创建套餐、存储或部署。官方定价网站被当前环境出站策略拦截，未能实时核实 2026 年的具体免费额度；因此本说明不填写未经核实的额度数字。上线前以以下官方页面和实际账户中的 Free/Hobby 标记为准，不将本地构建通过描述为已经完成免费线上部署：

- [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Vercel Blob 用量和定价](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Vercel Workflow](https://vercel.com/docs/workflow)
- [Neon 定价](https://neon.com/pricing)
- [Resend 定价](https://resend.com/pricing)
- [Turnstile 方案](https://developers.cloudflare.com/turnstile/plans/)

完整项目、迁移和变量步骤见 [deployment.md](./deployment.md) 与 [environment-variables.md](./environment-variables.md)。
