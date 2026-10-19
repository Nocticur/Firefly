# 部署服务与用量

博客和后台部署在一个 Vercel `firefly` 项目，不创建第二个后台项目，不购买服务或升级套餐。后台私有状态与备份使用 Upstash Redis 免费额度，图片使用自建 CloudFlare-ImgBed，不使用 Vercel Blob，也不使用数据库。

| 功能 | 服务 | 配置方式 |
| --- | --- | --- |
| 博客、后台、API、Workflow | Vercel Hobby（现有 `firefly` 项目） | 根目录 `pnpm build:vercel` |
| 草稿、历史、会话、限流、审核、任务索引与备份 | Upstash Redis 免费（Marketplace 集成） | 填 `KV_REST_API_URL` / `KV_REST_API_TOKEN` |
| 管理入口 | 服务端密码登录 | 填 `ADMIN_ENTRY_PASSWORD`，无需第三方登录 |
| 图片上传与外链导入 | CloudFlare-ImgBed（自建） | 填 `IMGBED_API_TOKEN`，可选 `IMGBED_BASE_URL` |
| 正式内容与发布 | GitHub App | 限定目标仓库，显式发布时提交 `master` |
| 评论与友链验证 | Turnstile | 填 `PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` |
| 任务与每日维护 | Vercel Workflow 与 Cron | 填 `CRON_SECRET`，使用时在后台明确开启 |

## 额度与限制

| 服务 | 免费额度（以官方当前说明为准） | 对本项目的影响 |
| --- | --- | --- |
| Vercel Hobby | 免费，含静态托管、函数与 Cron；函数请求体约 **4.5 MiB** | 直接上传图片限制 4 MiB；外链导入最大 32 MiB（由服务端拉取，不进请求体）；每日 Cron 一次 |
| Upstash Redis 免费 | **250 MB** 存储、**50 万命令/月**、单次请求 **10 MiB** | 状态文档解码后上限 16 MiB、压缩编码后上限 8 MiB；单个备份对象上限 8 MiB；每次读写都计命令 |
| CloudFlare-ImgBed | 自建在 Cloudflare 上，受 Cloudflare 免费套餐与图床自身配置限制 | 图片由 ImgBed 直接提供，不占 Vercel 带宽；单张导入 32 MiB 上限 |
| GitHub App | 免费 | 读取基线与发布提交，受仓库权限限制 |
| Turnstile | 免费 | 公开评论与友链申请校验 |

额度是上限而不是承诺：不能把“无数据库”“无 Blob”等同于无限免费。个人博客的少量写入通常远低于 Upstash 免费额度，但以下使用会更费命令或空间：

- 每次状态读取与保存都是一次或多次 Redis 命令；发布、恢复与备份会连续读写，请避免在维护期间反复重试。
- 备份对象不可变，创建后不会原地覆盖；每日维护清理超过 30 天的已结束历史、发布任务与备份，以控制 250 MB 存储占用。
- 状态文档过大时写入会返回 `507`，应先清理历史或减少媒体记录，而不是升级套餐。
- 图片存储与流量由 ImgBed / Cloudflare 承担；图床不可用时上传失败，不会回退到 Blob 或临时磁盘。

所有生产能力默认关闭；KV 或外部服务不可用时拒绝写入，不通过降低认证、改用临时磁盘或内存存储绕过配置。若某项服务要求付费或升级，保持功能关闭并由用户决定；本项目不购买、不自动扩容、不修改付费设置。

## 相关文档

- [Vercel 套餐与价格](https://vercel.com/pricing)
- [Upstash Redis 定价与限制](https://upstash.com/pricing/redis)
- [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed)
- [Cloudflare 免费套餐](https://www.cloudflare.com/plans/free/)
- [环境变量](./environment-variables.md)、[统一部署](./deployment.md)
