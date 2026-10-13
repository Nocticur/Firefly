import assert from "node:assert/strict";
import test from "node:test";
import type { NavBarConfig } from "../types/navBarConfig";
import { organizeNavigation } from "./nav-config-utils";

const base: NavBarConfig = {
	links: [
		{ name: "主页", url: "/" },
		{ name: "归档", url: "/archive/" },
		{ name: "友链", url: "/friends/", pageKey: "friends" },
		{ name: "动态", url: "/dynamic/", pageKey: "dynamic" },
		{ name: "番剧", url: "/bilibili/", pageKey: "bilibili" },
		{ name: "网址导航", url: "/booknav/", pageKey: "booknav" },
		{ name: "相册", url: "/gallery/", pageKey: "gallery" },
		{
			name: "更多",
			url: "#",
			children: [
				{ name: "番组计划", url: "/bangumi/", pageKey: "bangumi" },
				{ name: "后台管理", url: "/admin/" },
			],
		},
	],
};

test("legacy published menus become direct links and preserve retained features under More", () => {
	const result = organizeNavigation(
		base,
		{
			links: [
				{
					name: "文章",
					url: "#",
					children: [
						{ name: "归档", url: "/archive/", icon: "fa7-solid:box-archive" },
						{ name: "分类", url: "/categories/" },
						{ name: "标签", url: "/tags/" },
						{ name: "系列", url: "/series/" },
					],
				},
				{
					name: "社交",
					url: "#",
					children: [
						{ name: "友链", url: "/friends/" },
						{ name: "留言", url: "/guestbook/", pageKey: "guestbook" },
					],
				},
				{
					name: "我的",
					url: "#",
					children: [
						{ name: "项目", url: "/projects/", pageKey: "projects" },
						{
							name: "GitHub",
							url: "https://github.com/Nocticur",
							external: true,
						},
					],
				},
			],
		},
		"https://blog.mourn.top/",
	);
	assert.deepEqual(
		result.links.map((link) => link.name),
		base.links.map((link) => link.name),
	);
	assert.ok(result.links.slice(0, -1).every((link) => !link.children));
	assert.equal(result.links[1].icon, "fa7-solid:box-archive");
	assert.equal(result.links[2].pageKey, "friends");
	assert.deepEqual(
		result.links.at(-1)?.children?.map((link) => link.url),
		["/projects/", "https://github.com/Nocticur", "/admin/"],
	);
});

test("retired local routes stay removed after republishing and external reference URLs remain usable", () => {
	const result = organizeNavigation(
		base,
		{
			links: [
				{ name: "旧分类", url: "/categories/Firefly/?sort=recent" },
				{ name: "旧标签", url: "https://blog.mourn.top/tags/?q=Astro" },
				{ name: "旧系列", url: "/series/example/#part-two" },
				{ name: "旧留言", url: "/%67uestbook/#comments" },
				{ name: "文档标签", url: "https://docs.example/tags/", external: true },
				{ name: "旧友链名称", url: "https://blog.mourn.top/friends/" },
				{ name: "后台管理", url: "/admin/" },
			],
		},
		"https://blog.mourn.top/",
	);
	assert.deepEqual(
		result.links.at(-1)?.children?.map((link) => link.url),
		["https://docs.example/tags/", "/admin/"],
	);
	assert.equal(result.links[2].url, "/friends/");
	assert.deepEqual(
		organizeNavigation(base, result, "https://blog.mourn.top/"),
		result,
	);
});

test("nested retained links flatten into More without losing known optional page switches", () => {
	const result = organizeNavigation(
		base,
		{
			links: [
				{
					name: "更多",
					url: "#",
					children: [
						{
							name: "收藏",
							url: "#",
							children: [
								{ name: "追番记录", url: "https://blog.mourn.top/bangumi/" },
								{ name: "工具", url: "https://tools.example/" },
							],
						},
					],
				},
			],
		},
		"https://blog.mourn.top/",
	);
	const additional = result.links.at(-1)?.children ?? [];
	assert.ok(additional.every((link) => !link.children));
	assert.equal(additional[0].pageKey, "bangumi");
	assert.deepEqual(
		additional.map((link) => link.url),
		[
			"https://blog.mourn.top/bangumi/",
			"https://tools.example/",
			"/admin/",
		],
	);
});

test("legacy and duplicate admin roots use the same-site admin entry without replacing the homepage", () => {
	const result = organizeNavigation(
		base,
		{
			links: [
				{ name: "首页", url: "/" },
				{ name: "旧后台", url: "/admin/" },
				{ name: "后台管理", url: "https://admin.mourn.top", external: true },
				{
					name: "另一后台入口",
					url: "https://admin.mourn.top/?from=blog",
					external: true,
				},
				{ name: "文档", url: "https://docs.example/", external: true },
				{
					name: "管理说明",
					url: "https://admin.mourn.top/docs",
					external: true,
				},
			],
		},
		"https://blog.mourn.top/",
	);
	const additional = result.links.at(-1)?.children ?? [];
	assert.equal(additional.filter((link) => link.name === "后台管理").length, 1);
	assert.deepEqual(additional[0], {
		name: "后台管理",
		url: "/admin/",
	});
	assert.equal(result.links[0].url, "/");
	assert.deepEqual(
		additional.slice(1).map((link) => link.url),
		["https://docs.example/", "https://admin.mourn.top/docs"],
	);
});
