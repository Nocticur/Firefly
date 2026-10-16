import type { SponsorConfig } from "../types/sponsorConfig";

export const sponsorConfig: SponsorConfig = {
	// 没有核实的收款信息前保持关闭；页面、导航、文章按钮与 sitemap 共用此开关。
	enable: false,
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// 打赏用途说明
	usage:
		"您的打赏将用于服务器维护、内容创作和功能开发，帮助我持续提供优质内容。",

	// 是否显示打赏者列表
	showSponsorsList: true,

	// 是否在文章详情页底部显示打赏按钮
	showButtonInPost: true,

	// 打赏方式列表
	methods: [
		{
			type: "qrcode",
			name: "支付宝",
			icon: "fa7-brands:alipay",
			// 支持 / 开头的 public 路径、assets/ 源图片、HTTPS URL 或位图 data URI。
			image: "",
			description: "使用 支付宝 扫码打赏",
			enabled: false,
		},
		{
			type: "qrcode",
			name: "微信",
			icon: "fa7-brands:weixin",
			image: "",
			description: "使用 微信 扫码打赏",
			enabled: false,
		},
		{
			type: "url",
			name: "ko-fi",
			icon: "simple-icons:kofi",
			url: "",
			description: "Buy a Coffee for Firefly",
			enabled: false,
		},
		{
			type: "url",
			name: "爱发电",
			icon: "simple-icons:afdian",
			url: "",
			description: "通过 爱发电 进行打赏",
			enabled: false,
		},
	],

	// 仅在核实 Nocticur 的收款信息后显式启用，主题示例不作为本站收款与打赏历史。
	sponsors: [],
};
