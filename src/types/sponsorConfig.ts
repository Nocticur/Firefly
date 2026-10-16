// 打赏方式类型
type SponsorMethodBase = {
	name: string; // 打赏方式名称，如 "支付宝"、"微信"、"PayPal"
	icon?: string; // 图标名称（Iconify 格式），如 "fa7-brands:alipay"
	description?: string; // 描述文本
	enabled: boolean; // 是否启用
};

// 一个方式只对应一种展示状态，避免空卡片或同卡同时展示两种收款入口。
export type SponsorMethod = SponsorMethodBase &
	(
		| { type: "qrcode"; image: string; url?: never }
		| { type: "url"; url: string; image?: never }
	);

// 打赏者列表项
export type SponsorItem = {
	name: string; // 打赏者名称，如果想显示匿名，可以直接设置为"匿名"或使用 i18n
	avatar?: string; // 打赏者头像图片路径(可选,相对于 public 目录 或者 网络图片)
	amount?: string; // 打赏金额（可选）
	date?: string; // 打赏日期（可选，ISO 格式）
};

// 打赏配置
export type SponsorConfig = {
	enable: boolean; // 功能总开关，与 siteConfig.pages.sponsor 同时开启才可访问
	title?: string; // 页面标题，默认使用 i18n
	description?: string; // 页面描述文本
	usage?: string; // 打赏用途说明
	methods: SponsorMethod[]; // 打赏方式列表
	sponsors?: SponsorItem[]; // 打赏者列表（可选）
	showSponsorsList?: boolean; // 是否显示打赏者列表，默认 true
	showButtonInPost?: boolean; // 是否在文章详情页底部显示打赏按钮，默认 true
};
