export type AnnouncementConfig = {
	// false disables both the sidebar announcement and the details dialog.
	enable?: boolean;
	title?: string; // 公告栏标题
	content: string; // 公告栏内容
	icon?: string; // 公告栏图标
	type?: "info" | "warning" | "success" | "error"; // 公告类型
	closable?: boolean; // 是否可关闭
	items?: {
		id: string;
		title: string;
		content: string;
		label?: string;
		date?: string;
		enabled?: boolean;
		link?: { text: string; url: string; external?: boolean };
	}[];
	link?: {
		enable: boolean; // 是否启用链接
		text: string; // 链接文字
		url: string; // 链接地址
		external?: boolean; // 是否外部链接
	};
};
