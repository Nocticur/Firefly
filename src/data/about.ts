import { profileConfig } from "../config/profileConfig";
import { siteConfig } from "../config/siteConfig";

export type SiteTechnology = {
	name: string;
	icon: string;
	color: string;
	description: string;
	url: string;
};
export type AboutMilestone = {
	date?: string;
	label: string;
	title: string;
	description: string;
};
export type AboutSocial = {
	name: string;
	handle: string;
	icon: string;
	color: string;
	url: string;
};
export type AboutProfile = {
	name: string;
	avatar: string;
	description: string;
	bio?: string;
};

// 只记录本站已经使用的技术，不代表站长的个人熟练度或工作经历。
export const siteTechnologies: SiteTechnology[] = [
	{
		name: "Astro",
		icon: "simple-icons:astro",
		color: "#e2531b",
		description: "页面与内容集合的基础。以静态内容为主，按需添加交互。",
		url: "https://astro.build/",
	},
	{
		name: "Svelte",
		icon: "simple-icons:svelte",
		color: "#d9431f",
		description: "为搜索、动态等需要交互的区域提供组件。",
		url: "https://svelte.dev/",
	},
	{
		name: "TypeScript",
		icon: "simple-icons:typescript",
		color: "#3178c6",
		description: "为站点配置、数据和脚本提供类型约束。",
		url: "https://www.typescriptlang.org/",
	},
	{
		name: "Tailwind CSS",
		icon: "simple-icons:tailwindcss",
		color: "#087e98",
		description: "结合主题变量组织布局、响应式样式与亮暗色外观。",
		url: "https://tailwindcss.com/",
	},
	{
		name: "MDX",
		icon: "simple-icons:mdx",
		color: "#8c6410",
		description: "将 Markdown 内容与 Astro 组件组合在同一张关于卡片中。",
		url: "https://mdxjs.com/",
	},
];

export const aboutProfile: AboutProfile = {
	name: profileConfig.name,
	avatar: "/assets/images/logo-nocticur.png",
	description: "记录个人学习、工作与 AI 相关的内容。",
	bio: profileConfig.bio,
};

export const aboutMilestones: AboutMilestone[] = [
	{
		date: siteConfig.siteStartDate,
		label:
			siteConfig.siteStartDate?.slice(0, 10).replaceAll("-", ".") || "起点",
		title: "本站的起始记录",
		description: "这个博客的时间起点，也是这份个人记录的开始。",
	},
	{
		label: "持续记录",
		title: "学习、工作与 AI",
		description: "把学习与实践整理成文字，在这里慢慢积累。",
	},
];

export const aboutSocials: AboutSocial[] = [
	{
		name: "GitHub",
		handle: "Nocticur",
		icon: "fa7-brands:github",
		color: "#596575",
		url: "https://github.com/Nocticur",
	},
	{
		name: "哔哩哔哩",
		handle: "属于夜幕之人",
		icon: "fa7-brands:bilibili",
		color: "#bd4073",
		url: "https://space.bilibili.com/645892937",
	},
	{
		name: "QQ 群",
		handle: "源站群聊入口",
		icon: "fa7-brands:qq",
		color: "#2476b8",
		url: "https://qm.qq.com/q/2R07cjGTZ0",
	},
	{
		name: "邮箱",
		handle: "youjinmian@outlook.com",
		icon: "fa7-solid:envelope",
		color: "#267b63",
		url: "mailto:youjinmian@outlook.com",
	},
];
