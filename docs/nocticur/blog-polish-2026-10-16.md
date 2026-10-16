# 页面优化与友链维护

本次按五篇参考文章改造现有 Firefly，保留 Nocticur 的站点资料与文章。友链申请界面参考用户补充截图，采用本站信息／三步申请双栏卡片；移动端改为单列。申请通过现有邮箱／QQ群联系，本站信息与申请模板都可复制，剪贴板权限受限时提供手动选择。

## 页面与配置

- `src/content/spec/about.mdx` 维护关于页正文与组件顺序；`src/data/about.ts` 维护本站技术、站点时间线、人物与联系方式。本站技术不代表个人熟练度。
- `src/config/sponsorConfig.ts` 的 `enable` 与 `siteConfig.pages.sponsor` 共同决定打赏是否开放；导航、文章按钮、站点地图与 `llms.txt` 使用同一判断。未提供真实收款信息，当前 `enable: false`，访问 `/sponsor/` 跳转到 `/404/`。填写本人收款信息并显式开启后才显示；不要使用主题作者的收款码，也不要编造打赏历史。
- 打赏方法以 `type: "qrcode"` 的 `image` 或 `type: "url"` 的 `url` 配置，条目还需 `enabled: true`。无效或不完整条目不渲染。二维码始终保留白底。
- `src/config/friendsConfig.ts` 维护现有友链、本站名片和 `kind: "featured"` 精选标识；后台已发布的公开友链仍可合并。`/friends.json` 输出兼容 check-flink 的 `{name, link, avatar, linkpage?}[]`，不输出申请邮箱或审核资料。
- `src/config/announcementConfig.ts` 的 `items` 支持标题、标签、日期、正文和详情链接，`enable: false` 或 `items: []` 隐藏公告弹窗入口。
- `src/config/musicConfig.ts` 的 `showFloatingPlayer` 控制悬浮音乐视图；关闭视图不暂停音乐，可从侧栏或右下角音乐按钮恢复。歌词只在配置启用、存在歌词且实际播放时出现。
- 保持评论配置为 `none`，已移除文章、友链、打赏、动态模板及浮动控制中的公开评论入口；动态评论地址退役到 404。未删除后台历史记录和其他管理能力。

## 友链检测与截图

唯一维护入口仍是博客侧已公开友链。监测脚本只读合并后的配置，不改 `managed-settings.json` 或后台发布快照。

```sh
pnpm check-friends --task status_only
pnpm check-friends --task both --target "Firefly Docs"
pnpm check-friends --task screenshots_only
pnpm check-friends --task both --due-only
pnpm check-friends --task both --dry-run
```

`target` 匹配站名或 URL 关键词；留空处理全部。指定目标时保留其他结果。`screenshots_only` 首次遇到新站点会先做可达性检测。状态检测每个站点最多尝试两次，每次运行只累计一次失败；反链缺失与截图失败不会累计不可达次数。反链只认可真正 `<a href>` 的匹配主机名；未配置 `linkpage` 时不把首页没反链视作异常。

公开输出为 `public/data/friends-health.json`，截图为 `public/assets/friends/*.webp`。浏览器先读取本地缓存再刷新；未检测或格式错误的条目保留可浏览状态。连续失败 1–6 次进入暂存区，7 次起进入失联档案，成功后回到正常列表。截图失败保留上次成功截图；新站没有截图时隐藏预览入口。截图来自检测时的页面，仅作为历史快照。

工作流 `.github/workflows/check-friends.yml` 在北京时间 **01:10、13:10** 检测，截图距上次成功满六天才更新。手动运行提供 `status_only`、`screenshots_only`、`both` 与 `target_link`。只有需要截图时才安装 Chromium。截图请求与 HTTP 检测都使用固定且已验证的公网地址，限制超时、重定向和响应大小；浏览器没有登录状态、站点凭据或 Actions 环境凭据。

检测任务只读，提交任务仅暂存公开报告和截图。监测期间分支变化时拒绝提交旧来源结果，产物保留七天供下载或重跑。分支保护禁止机器人提交时，下载 `friend-health` artifact 按仓库正常流程合入，不要放宽保护或添加个人 token。

工作流需随代码推送至 GitHub 后才生效；本次未推送、未触发远程 Actions、未发布生产环境。数据提交后会显式触发现有 `build.yml` 验证，生产上线仍由仓库现有 Git／部署平台集成处理，需在首次远程运行时核实实际部署结果。

## 验证与截图

```sh
pnpm test:site
pnpm check
pnpm type-check
pnpm build
pnpm exec playwright install chromium
pnpm preview --host 127.0.0.1 --port 4322
SITE_TEST_BASE_URL=http://127.0.0.1:4322 pnpm test:browser
```

Windows 可设置 `PLAYWRIGHT_CHROME_EXECUTABLE` 指向本机 Chrome；监测截图对应变量为 `FRIENDS_CHROME_PATH`。普通开发／构建不需要安装浏览器。浏览器测试使用网络拦截模拟暂存与失联状态，测试数据不会写进公开报告；实际检测截图另由脚本生成。

截图：

- [友链桌面](screenshots/blog-friends-desktop.png)
- [友链移动](screenshots/blog-friends-mobile.png)
- [关于桌面](screenshots/blog-about-desktop.png)
- [关于移动](screenshots/blog-about-mobile.png)

关键逻辑覆盖支付方式过滤、双重门控、URL 规范化、增量合并、反链解析、截图间隔、连续失败恢复、视频策略降级、背景图解码与音乐实际播放状态。完整构建的既有大包体提示不会阻止构建。

2026-10-16 本地验收结果：Astro 检查 298 个文件，0 错误／警告／提示；博客与后台类型检查通过；36 项站点逻辑测试、16 项发布清单与加密回归通过；完整生产构建通过，保持 15 篇公开文章和 33 个 Pagefind 产物。生产预览的 8 组友链／公告／音乐／关闭态检查通过，另已实测关于页四组件、键盘浮卡、手风琴、Swup 往返与 390px／1440px 布局。

三个现有友链已实际检测可达，并生成两个站点的主页截图。GitHub 仓库页本轮截图请求失败，链接状态保持可达；没有伪造截图，后续工作流可重试。截图与状态采集时间均保存在公开报告中。既有发布清单测试补充了 Windows 路径分隔符归一化，未改动文章内容或其发布身份。

## 参考文章

- [背景视频、公告与音乐打磨](https://blog.fqzlr.top/posts/tech/site-update-bg-video-and-polish/)
- [配置驱动的打赏页](https://blog.fqzlr.top/posts/tech/sponsor-page-from-scratch/)
- [关于页 MDX 四组件](https://blog.fqzlr.top/posts/tech/about-page-mdx-components/)
- [友链卡片、粒子与失联分区](https://blog.fqzlr.top/posts/tech/friends-page-design/)
- [友链检测与主页截图](https://blog.fqzlr.top/posts/tech/check-flink/)
