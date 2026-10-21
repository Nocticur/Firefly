# 部署服务与用量

博客和后台部署在一个 Vercel `firefly` 项目，不创建第二个后台项目，不购买服务或升级套餐。文章与站点设置以 Git 仓库为唯一数据源，图片使用自建 CloudFlare-ImgBed，不使用 Cloudflare KV、Vercel Blob、Upstash Redis，也不使用数据库。

| 功能 | 服务 | 配置方式 |
| --- | --- | --- |
| 博客、后台、API、Workflow | Vercel Hobby（现有 `firefly` 项目） | 根目录 `pnpm build:vercel` |
| 文章与设置读写 | GitHub 仓库（免费） | 填 `GITHUB_TOKEN`（细粒度 PAT，Contents 读写），可选 `GITHUB_REPOSITORY` / `GITHUB_BRANCH` |
| 管理入口 | 服务端密码登录 | 填 `ADMIN_ENTRY_PASSWORD`，无需第三方登录 |
| 图片上传与外链导入 | CloudFlare-ImgBed（自建） | 填 `IMGBED_API_TOKEN`，可选 `IMGBED_BASE_URL` |
| 正式内容与发布 | GitHub 仓库分支 | 显式发布时提交到 `GITHUB_BRANCH`（默认 `master`） |
| 评论与友链验证 | Turnstile | 填 `PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` |
| 任务与每日维护 | Vercel Workflow 与 Cron | 填 `CRON_SECRET`，使用时在后台明确开启 |

## 额度与限制

| 服务 | 免费额度（以官方当前说明为准） | 对本项目的影响 |
| --- | --- | --- |
| Vercel Hobby | 免费，含静态托管、函数与 Cron；函数请求体约 **4.5 MiB** | 直接上传图片限制 4 MiB；外链导入最大 32 MiB（由服务端拉取，不进请求体）；每日 Cron 一次 |
| Upstash Redis 免费 | 已不再使用 | 历史方案已删除，运行时不会再读取 Upstash 变量 |
| GitHub 仓库 | 免费 | 文章与设置的读写都走 Git 提交，受仓库权限与 API 速率限制 |
| CloudFlare-ImgBed | 自建在 Cloudflare 上，受 Cloudflare 免费套餐与图床自身配置限制 | 图片由 ImgBed 直接提供，不占 Vercel 带宽；单张导入 32 MiB 上限 |
| Turnstile | 免费 | 公开评论与友链申请校验 |

额度是上限而不是承诺：不能把“无数据库”等同于无限免费。个人博客的少量写入通常远低于免费额度，但以下使用会更费空间或 API 调用次数：

- 每次保存设置或发布都会产生一次 Git 提交，频繁保存会累积提交历史；GitHub API 对个人令牌有每小时的请求上限。
- 评论、友链、访客封禁等少量运行时写入保存在后台状态中；未配置 Cloudflare KV 时使用进程内存，重启即清空，因此不适合作为长期审核记录。
- 状态文档过大时写入会返回 `507`，应先清理历史或减少媒体记录，而不是升级套餐。

所有生产能力默认关闭；GitHub 或外部服务不可用时拒绝写入，不通过降低认证、改用临时磁盘或内存存储绕过配置。若某项服务要求付费或升级，保持功能关闭并由用户决定；本项目不购买、不自动扩容、不修改付费设置。

## 相关文档

- [Vercel 套餐与价格](https://vercel.com/pricing)
- [GitHub 细粒度令牌权限说明](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed)
- [Cloudflare 免费套餐](https://www.cloudflare.com/plans/free/)
- [环境变量](./environment-variables.md)、[统一部署](./deployment.md)
