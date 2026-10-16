# 博客页面与友链维护优化

用户已确认本方案，随后补充友链申请区截图。保留 Firefly 主题、Nocticur 资料与现有文章管理后台。

## 范围

- 背景视频在点击时加载，优先有声播放，失败时静音重试；失败恢复壁纸。图片准备完成才切换舞台，保留现有布局过渡与 Hero 模糊。
- 公告支持列表弹窗；播放器提供可恢复的悬浮视图，关闭悬浮视图不暂停音乐。
- 打赏采用二维码／外链联合类型、无效项过滤、白底收款码与静态名单。`pages.sponsor && sponsorConfig.enable` 统一控制路由、导航、文章按钮、站点地图和页面索引。未提供真实收款信息，默认关闭。
- 关于页保持单张 MDX 卡片，加入行内人物卡、本站技术栈手风琴、真实站点时间线与品牌色联系方式，不编造个人履历和技能水平。
- 友链支持普通、站长、推荐状态，后两者有尊重减少动画偏好的粒子。离屏、页面隐藏或组件卸载时停止动画。截图浮层挂到 body，支持键盘与触屏。
- 友链申请区按参考图采用左右卡片、可复制本站信息、三步流程、申请模板及注意事项；通过现有邮箱／QQ群联系。
- 不使用评论与留言，去除对应公开入口和无效浮动按钮，不清除历史私有资料。

## 友链检测契约

友链来源由现有 TS 配置和后台已发布的公开友链合并，并导出兼容 `check-flink` 的 `/friends.json`。定期任务只读这些来源，不改写后台发布快照。

健康输出独立存于 `public/data/friends-health.json`，格式为 `{schemaVersion: 1, checkedAt, results: []}`，每项包含 URL、检测时间、状态、延迟、HTTP 状态、连续失败次数和反链结果，可选最近成功时间与本地截图。截图存入 `public/assets/friends/`。未知或格式错误的数据不导致友链下线；连续失败 1–6 次进入暂存区，7 次以上进入失联区，恢复即回正常区。反链缺失与截图失败不累加站点不可达次数。

GitHub Actions 每天检测两次，截图距上次成功满六天时更新，支持仅检测、仅截图、两者和关键词指定友链。增量运行保留其他结果；截图失败保留旧截图。请求限制超时、重定向、响应大小和并发。提交仅包含公开检测文件与截图，不需要新图床或外部凭据。

## 验证

先验证关键逻辑的失败用例，再实现。执行节点测试、`pnpm check`、`pnpm type-check`、`pnpm build`，并以桌面／移动端浏览器验证关于页、友链搜索与分区、复制、浮层、关闭态及背景交互。保留现有未提交的邮件移除文档。本次不推送或部署。

## 参考

- https://blog.fqzlr.top/posts/tech/site-update-bg-video-and-polish/
- https://blog.fqzlr.top/posts/tech/sponsor-page-from-scratch/
- https://blog.fqzlr.top/posts/tech/about-page-mdx-components/
- https://blog.fqzlr.top/posts/tech/friends-page-design/
- https://blog.fqzlr.top/posts/tech/check-flink/
