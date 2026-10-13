import {
	type NavBarConfig,
	type NavBarLink,
	type NavBarSearchConfig,
	NavBarSearchMethod,
} from "../types/navBarConfig";
import { applyManagedNavigation } from "../utils/managed-settings";

// ============================================================================
// 导航栏配置 - 根据顺序动态生成导航栏链接
// NavBar Configuration - Dynamically generate navigation bar links based on order
// ============================================================================
const getDynamicNavBarConfig = (): NavBarConfig => ({
	links: [
		LinkPresets.Home,
		LinkPresets.Archive,
		LinkPresets.Friends,
		LinkPresets.Dynamic,
		LinkPresets.Bilibili,
		LinkPresets.Booknav,
		LinkPresets.Gallery,
		{
			name: "更多",
			url: "#",
			icon: "material-symbols:more-horiz",
			children: [
				LinkPresets.Projects,
				LinkPresets.About,
				LinkPresets.Sponsor,
				LinkPresets.Bangumi,
				LinkPresets.VNDB,
				LinkPresets.MAL,
				{
					name: "GitHub",
					url: "https://github.com/CuteLeaf/Firefly",
					external: true,
					icon: "fa7-brands:github",
				},
				{
					name: "Gitee",
					url: "https://gitee.com/CuteLeaf/Firefly",
					external: true,
					icon: "fa7-brands:gitee",
				},
				{
					name: "Firefly文档",
					url: "https://docs-firefly.cuteleaf.cn",
					external: true,
					icon: "material-symbols:docs",
				},
				LinkPresets.Admin,
			],
		},
	],
});

// 导航搜索配置
export const navBarSearchConfig: NavBarSearchConfig = {
	method: NavBarSearchMethod.PageFind,
};

// ============================================================================
// 链接预设 - 可自由自定义导航栏链接的名称、图标和URL
// Link Presets - Allows free customization of the name, icon, and URL of navigation bar links
// ============================================================================
export const LinkPresets: Record<string, NavBarLink> = {
	Home: {
		name: "主页",
		url: "/",
		icon: "material-symbols:home",
	},
	Archive: {
		name: "归档",
		url: "/archive/",
		icon: "material-symbols:archive",
	},
	Friends: {
		name: "友链",
		url: "/friends/",
		icon: "material-symbols:link-2-rounded",
		pageKey: "friends",
	},
	Dynamic: {
		name: "动态",
		url: "/dynamic/",
		icon: "material-symbols:forum-rounded",
		pageKey: "dynamic",
	},
	Projects: {
		name: "项目",
		url: "/projects/",
		icon: "material-symbols:rocket-launch",
		pageKey: "projects",
	},
	Gallery: {
		name: "相册",
		url: "/gallery/",
		icon: "material-symbols:photo-library",
		pageKey: "gallery",
	},
	Booknav: {
		name: "网址导航",
		url: "/booknav/",
		icon: "material-symbols:bookmarks",
		pageKey: "booknav",
	},
	Bilibili: {
		name: "番剧",
		url: "/bilibili/",
		icon: "fa7-brands:bilibili",
		pageKey: "bilibili",
	},
	Bangumi: {
		name: "番组计划",
		url: "/bangumi/",
		icon: "material-symbols:movie",
		pageKey: "bangumi",
	},
	VNDB: {
		name: "VNDB",
		url: "/vndb/",
		icon: "material-symbols:chrome-reader-mode-rounded",
		pageKey: "vndb",
	},
	MAL: {
		name: "AnimeList",
		url: "/myanimelist/",
		icon: "material-symbols:menu-book",
		pageKey: "mal",
	},
	Sponsor: {
		name: "打赏",
		url: "/sponsor/",
		icon: "material-symbols:favorite",
		pageKey: "sponsor",
	},
	About: {
		name: "关于我",
		url: "/about/",
		icon: "material-symbols:person",
	},
	Admin: {
		name: "后台管理",
		url: "https://admin.mourn.top/",
		external: true,
		icon: "material-symbols:admin-panel-settings-outline",
	},
};

export const navBarConfig: NavBarConfig = applyManagedNavigation(
	getDynamicNavBarConfig(),
);
