import type { ProfileConfig } from "../types/profileConfig";
import { applyManagedProfileSettings } from "../utils/managed-settings";

export const profileConfig: ProfileConfig = applyManagedProfileSettings({
	// 头像
	// 图片路径支持三种格式：
	// 1. public 目录（以 "/" 开头，不优化）："/assets/images/avatar.webp"
	// 2. src 目录（不以 "/" 开头，自动优化但会增加构建时间，推荐）："assets/images/avatar.webp"
	// 3. 远程 URL："https://example.com/avatar.jpg"
	avatar: "/assets/images/logo-nocticur.png",

	// 名字
	name: "Nocticur",

	// 个人签名
	bio: "向 夜 驰 行 ， 不 问 喧 嚣\n身 沉 暮 色 ， 心 赴 归 途",

	// 链接配置
	// 已经预装的图标集：fa7-brands，fa7-regular，fa7-solid，material-symbols，simple-icons
	// 访问https://icones.js.org/ 获取图标代码，
	// 如果想使用尚未包含相应的图标集，则需要安装它
	// `pnpm add @iconify-json/<icon-set-name>`
	// showName: true 时显示图标和名称，false 时只显示图标
	links: [
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/Nocticur",
			showName: false,
		},
		{
			name: "属于夜幕之人",
			icon: "fa7-brands:bilibili",
			url: "https://space.bilibili.com/645892937",
			showName: false,
		},
		{
			name: "QQ群",
			icon: "fa7-brands:qq",
			url: "https://qm.qq.com/q/2R07cjGTZ0",
			showName: false,
		},
		{
			name: "Email",
			icon: "fa7-solid:envelope",
			url: "mailto:nocticur@mourn.top",
			showName: false,
		},
		{
			name: "RSS",
			icon: "fa7-solid:rss",
			url: "/rss/",
			showName: false,
		},
		{
			name: "Atom",
			icon: "fa7-solid:atom",
			url: "/atom/",
			showName: false,
		},
	],
});
