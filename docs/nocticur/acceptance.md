# 验收记录与待完成项

选择 `Nocticur/Firefly`、发布分支 `master`；时间口径为 `Asia/Shanghai`。此表分别记录本地执行结果、测试替身覆盖及真实平台未执行项，不能将本地测试通过视为已上线。

## 当前执行结果

| 检查 | 状态 | 证据与范围 |
| --- | --- | --- |
| 前置代码备份 | 已执行 | `/workspace/backups/firefly-before-nocticur/` 的 Git bundle 与 tracked tar，已完成校验；原 HEAD 为 `6d82554bfe1cb3d4b43adb0969dad1d43ac6dee3` |
| 只读来源与原图 | 已执行 | 来源提交 `c075ac36c1313dc6ee47f7690c1a360aaa087da8`；原图 SHA256 为 `3a7ed7bac3634bb05876966b415600c9f3862be08e1df09b10142cb0c622b01f`，见迁移 provenance |
| 内容迁移与基线 | 已执行 | 基线与 provenance 保存原 14 条、迁入两篇及正文哈希；本地管理导入 16 条、公开映射 15 篇，原草稿继续私有 |
| `pnpm check` | 已执行，通过 | [blog-check-final.log](/workspace/.firefly-environment/blog-check-final.log)：271 文件，0 errors、0 warnings、0 hints |
| 后台完整测试 | 已执行，通过 | [admin-tests-final.log](/workspace/.firefly-environment/admin-tests-final.log)：124 通过、0 失败、0 跳过；使用隔离真实 PostgreSQL，GitHub / Vercel / Blob / Resend / Turnstile 为受控替身 |
| 发布清单测试 | 已执行，通过 | [manifest-tests-final.log](/workspace/.firefly-environment/manifest-tests-final.log)：13 通过、0 失败、0 跳过；验证文章映射、草稿隔离、内容摘要、实际构建产物和永久重定向 |
| 根与后台最终类型检查 | 已执行，通过 | [blog-typecheck-final.log](/workspace/.firefly-environment/blog-typecheck-final.log) 与 [admin-typecheck-final.log](/workspace/.firefly-environment/admin-typecheck-final.log)：根 `pnpm type-check` 与后台 `type-check` 均成功 |
| 完整博客 `pnpm build` | 已执行，通过 | [blog-build-final.log](/workspace/.firefly-environment/blog-build-final.log)：42 个生成路由、15 篇公开文章、33 个 Pagefind 文件；保留资源后处理、字体处理及最终清单 |
| Nitro Vercel 构建 | 已执行，通过 | [admin-vercel-build-final.log](/workspace/.firefly-environment/admin-vercel-build-final.log)：`NITRO_PRESET=vercel pnpm --filter @nocticur/admin build` 成功；生成 Node 函数及 20 steps / 3 workflows，包含 Workflow 入口 |
| 编译后管理函数 | 已执行，通过 | [compiled-admin-acceptance.json](/workspace/.firefly-environment/compiled-admin-acceptance.json)：5 项通过；本地调用实际 Vercel Node 产物，核对真实 PostgreSQL 的 16/15 基线、匿名拒绝、OpenAPI、API no-store 和 SPA / CSP 回退 |
| 浏览器与移动端 | 已执行，通过 | [browser-acceptance.json](/workspace/.firefly-environment/browser-acceptance.json)：9 个管理页面、16 条管理记录、两篇中文 slug；管理与博客手机布局通过，无页面运行错误；截图位于 `screenshots/` |
| 编辑器实际交互 | 已执行，通过 | [browser-editor.json](/workspace/.firefly-environment/browser-editor.json)：8 项通过，涵盖源码字节往返、浮动菜单、Mermaid、双语斜杠菜单与代码语言搜索、Ctrl+K、实际 Markdown 剪贴板粘贴、行内/块 LaTeX 编辑与往返、高级表格行列增删、合并/拆分及多段落往返；无页面运行错误、无 API 写请求，未知 YAML 保留、原文章文件未改、没有保存试验编辑 |
| 订阅与搜索 | 已执行，通过 | [smoke-migration.log](/workspace/.firefly-environment/smoke-migration.log)：生产预览 12 项通过，无页面运行错误；RSS / Atom 各 15 项，Pagefind 实际搜索与搜索输入可用，目录、OG 图与重复文章请求正常 |
| 外部服务与生产切换 | 未执行 | 未配置实际 OAuth/App、Neon、Blob、Turnstile、Resend 与 Vercel 生产服务；未切换域名 |

当前证据目录为 `/workspace/.firefly-environment/`，其中日志、JSON 和截图不会自动随 Git 保存或进入新云实例；会话文件不用于交付。最终结果与新增验证由实际运行者更新，未记录结果仍视为未完成。

编译函数和浏览器使用本地隔离数据库及测试会话，不调用真实 OAuth、不发送正式邮件、不写入 Git、不验证外部平台送达。页面截图与受控提供者测试不代替以下生产专项。

本地验收已完成，Git 提交与推送状态以当前 Git 记录及本次推送回执为准。本地发布清单的 Git SHA 取自构建时的 checkout；它不是新代码已经部署的证据。生产验收须从已提交的目标 SHA 完整构建，再核对实际生产清单和别名。

源码与本地验收交付见 [firefly-nocticur-review.tar.gz](/workspace/firefly-nocticur-review.tar.gz) 及 [SHA256 校验文件](/workspace/firefly-nocticur-review.tar.gz.sha256)。包为此前本地验收快照，本次推送准备仅调整 `README.md`、本文件和 `resume-plan.md` 的状态措辞。源码、完整工作区补丁与删除路径清单可用于审阅和恢复本次改动；实际会话、`.env`、缓存和数据库不在包内。

## 已覆盖的故障与数据边界

数据库测试使用真实 PostgreSQL，覆盖乐观版本冲突、历史保存/恢复、会话、一次性导入、环境站点 ID、评论审核、封禁与解除、回复占位、友链事务通知和唯一键。源码测试覆盖未知 Front-matter、YAML 注释、HTML / MDX 原始块与安全可视编辑边界。

发布专项使用可控 GitHub/Vercel 提供者测试连续发布、冻结后继续编辑、原子提交冲突、写响应丢失/未知、任务幂等与恢复后的只读核对。Vercel 核验要求正确项目、目标 SHA、实际生产别名与两个地址的发布清单同时一致；READY、旧别名、Preview 部署、不同摘要或别名中途切换都不能单独判定成功。

永久重定向测试核对旧 slug 映射与根 `vercel.json` 一同原子提交，保留原安全 headers、非管理规则和其他冻结配置。精确管理规则须优先，映射缺失、宽泛规则遮蔽、重复旧址或新文章占用旧址时拒绝；完整构建再次校验映射。真实平台的 HTTP 永久跳转仍待线上验收。

维护专项验证并发备份只冻结一份数据、过期 worker 不能覆盖新的 fencing token、同尺寸损坏对象无法通过校验、恢复阻挡所有普通写入、恢复前保护备份、独立库别名拒绝、媒体损坏拒绝，以及旧发布/邮件/Workflow 不重放。它验证的是程序与数据库行为，真实 Blob 权限、Workflow 平台重启与 Resend 幂等结果仍需下表验收。

## 真实平台验收清单

| 项目 | 必须验证的行为 | 当前状态 |
| --- | --- | --- |
| 两个 Vercel 项目 | 根博客 / `apps/admin` 独立构建；管理 Fluid compute；Workflow 入口与同源 SPA/API 路由 | 未执行，待平台配置 |
| OAuth 与管理员 | 固定回调成功、数字 ID `285582250` 允许、其他账号拒绝、state 重用拒绝、Secure Cookie / CSRF 生效 | 未执行，待 OAuth 与固定 HTTPS 域名 |
| Neon | 三环境连接隔离，全部 001–004 迁移生效，Preview/Development 不接触生产数据 | 未执行，待 Marketplace 数据库 |
| 基线导入 | 16 条管理记录、15 公开文章、原草稿/MDX/未知字段完整，重复导入不覆盖私有草稿 | 未执行真实远端导入，须配置 App 并确认可读取本次完整改动 |
| 私有媒体 | 匿名上传令牌和读取拒绝；32 MiB 上限、类型/归属核验、真实 Blob 完成回调 | 未执行，待 private/public stores |
| 媒体发布 | 冻结引用复制为 public 不可变版本，文章无临时 private URL；历史媒体保留 | 未执行，待真实发布 |
| 写作与历史 | 斜杠菜单、浮动菜单、Ctrl+K、Markdown 粘贴、语言搜索、公式、Mermaid、表格与源码往返 | 本地 8 项实际交互及源码/历史测试通过；生产未执行 |
| 设置、导航、图标 | 保存仍私有；发布后仅约定字段改变；六个图标位、菜单结构及未知配置保留 | 本地编译/源码测试通过，生产未执行 |
| Turnstile 评论 | 合法提交、错误/重放验证拒绝、限流、邮箱不公开、封禁/解禁、删除保留回复关系 | 未执行，待公钥/私钥 |
| 友链与邮件 | 通过等待生产核验后通知；拒绝理由持久保存；重试/中断不重复发信，签名 Webhook 生效 | 替身测试通过，真实 Resend 未执行 |
| 发布闭环 | API 202 任务 ID；双次发布、外部冲突、提交超时、构建失败、别名切换与三方版本一致 | 替身测试通过，真实 App/Vercel 未执行 |
| Workflow 重启 | 函数重启、重复触发与耐久等待恢复后不丢任务、不重复提交或发信 | 未执行真实平台故障验收 |
| Preview 边界 | 不写生产数据库、不发送正式邮件、不发布 master；实际隔离联调须配置独立公开接口转发 | 程序权限拒绝已有覆盖，真实环境未执行 |
| 完整静态站点 | 15 篇、两中文 slug、原 14 篇正文哈希、原头像、签名、计时、RSS、目录、搜索与移动端 | 本地构建、清单测试和浏览器通过；真实 Vercel 域名未执行 |
| 每日 Cron | 19:00 UTC 每日触发、Bearer 校验、同日幂等、空闲核验及私有备份可读回 | 替身/数据库测试通过，Vercel Cron 未执行 |
| 真实恢复演练 | 独立不同名恢复库、保留 Blob 对象、保护备份、稳定文章 ID/媒体引用一致、会话清除 | PostgreSQL/替身测试通过，Neon/Blob 真实演练未执行 |
| 回滚与旧服务隔离 | Git revert 完整重建；平台回滚独立处理；旧后台、Pages 与重复部署无法写生产站点 | 代码流程与说明已交付，真实演练未执行 |
| DNS 与正式上线 | 最终目标 SHA、Vercel deployment ID、生产清单和代表页面一致 | 未执行，尚未生产切换 |

## 配置与交付限制

真实平台配置须在安全设置中填写值，见 [deployment.md](./deployment.md)。当前迁移 provenance 与原内容基线可以审阅；执行真实管理基线导入前，须确认 GitHub App 能从目标 `master` 读取本次完整改动。

临时 Preview 管理域名不能使用固定生产 OAuth 回调；博客根转发默认指向生产公开 API，Preview 写来源被拒绝。若要完整 Preview 联调，必须先补充隔离转发与测试登录方案，不能复制生产会话。静态构建发布与正式邮件不会因保存草稿而自动执行。

维护页检查主题最新 release 与当前稳定包版本，后台检查比较只读 `master` HEAD 与实际部署 SHA；缺少配置或请求失败时保留未知状态。升级依靠经过审阅的 Git 变更，并在升级前额外备份；当前不提供无人值守的自动主题/后台升级。搜索重建及公开静态缓存切换由完整部署完成。私有备份含媒体清单，媒体字节需保留 Blob 历史对象与独立保留策略。

云环境当前实例准备与后续环境配置保存不同。最新重现说明的草稿保存此前遇到 `stale_base`：当前设置已发生变化，不能使用旧基线继续覆盖，也不能把磁盘说明或早期草稿称为最新配置已保存。用户已将云环境发布修复暂缓，继续原项目任务；全部定时恢复和定时检查安排已取消。

已交付 [完整配置提案](/workspace/.firefly-environment/setup-transfer.json)、[可重复安装脚本](/workspace/.firefly-environment/install-implementation.sh)、[启动与验证说明](/workspace/.firefly-environment/start-implementation.md) 及 [环境交接包](/workspace/firefly-setup-handoff.tar.gz)。后续重建环境时按提案与有效的当前设置合并安装、启动说明和追加网络要求，秘密值在安全设置中注入。最新配置保存与新任务复现仍待完成；这项交接不替代生产平台验收，也不表示环境或站点已发布。
