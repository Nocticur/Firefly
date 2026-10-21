import test from "node:test";
import assert from "node:assert/strict";
import { deriveManagedSettings, MANAGED_SETTINGS_PATH } from "../server/managed-settings.js";

const siteConfig = `import type { SiteConfig } from "@/types/config";

export const siteConfig: SiteConfig = {
	title: "Nocticur的博客",
	subtitle: "Nocticur",
	site_url: "https://blog.mourn.top",
	description: "Nocticur的博客，记录个人学习、工作、AI相关的内容",
	navbar: {
		logo: { type: "image", value: "assets/images/logo-nocticur.png", alt: "logo" },
		title: "Nocticur的博客",
	},
	siteStartDate: "2026-07-26",
	timezone: "Asia/Shanghai",
	pages: {
		friends: true,
		sponsor: true,
		postList: true,
		archive: true,
		about: true,
		dynamic: true,
	},
};
`;

test("repositories without a managed settings file derive real values from siteConfig", () => {
	const derived = deriveManagedSettings([{ path: "src/config/siteConfig.ts", source: siteConfig }]);
	assert.equal(derived.source, "derived");
	assert.equal(derived.settings.title, "Nocticur的博客");
	assert.equal(derived.settings.subtitle, "Nocticur");
	assert.equal(derived.settings.siteUrl, "https://blog.mourn.top");
	assert.equal(derived.settings.timezone, "Asia/Shanghai");
	assert.equal(derived.settings.avatar, "/assets/images/logo-nocticur.png");
	const names = (derived.navigation.links as Array<{ name: string }>).map((link) => link.name);
	// Only pages the blog actually enables are exposed as navigation entries.
	assert.ok(names.includes("主页") && names.includes("归档") && names.includes("友链"));
	assert.equal(names.includes("关于我"), true);
});

test("a managed settings file wins over derived values", () => {
	const managed = JSON.stringify({ schemaVersion: 1, settings: { title: "已托管" }, navigation: { links: [{ name: "主页", url: "/" }] }, icons: { home: "x" } });
	const result = deriveManagedSettings([
		{ path: MANAGED_SETTINGS_PATH, source: managed },
		{ path: "src/config/siteConfig.ts", source: siteConfig },
	]);
	assert.equal(result.source, "managed");
	assert.equal(result.settings.title, "已托管");
	assert.deepEqual(result.icons, { home: "x" });
});

test("disabled pages are omitted and an unusable repository derives nothing", () => {
	const disabled = siteConfig.replace("archive: true", "archive: false");
	const derived = deriveManagedSettings([{ path: "src/config/siteConfig.ts", source: disabled }]);
	const names = (derived.navigation.links as Array<{ name: string }>).map((link) => link.name);
	assert.equal(names.includes("归档"), false);

	// No settings file and no config module: nothing is invented, so callers can reject it.
	const empty = deriveManagedSettings([{ path: "README.md", source: "# hi" }]);
	assert.deepEqual(empty.settings, {});
	assert.deepEqual(empty.navigation.links, []);
});
