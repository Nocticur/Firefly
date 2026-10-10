import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSourceDocument, patchMetadata, validatePostSource } from "../server/source-document.js";
import { validateSettingsPatch, validateNavigation } from "../server/settings.js";
import { productionEnvironment, runtimeEnvironment } from "../server/security.js";
import { normalizeSlug } from "../server/content.js";

test("fixed Chinese slugs stay literal when used as permanent redirect routes", () => {
	assert.equal(normalizeSlug("分类/旧中文-文章"), "分类/旧中文-文章");
	for (const unsafe of ["old/:wildcard", "old*", "old+", "old(test)", "old{test}", "old[test]", "old%2Fpath", "../old", "old//new"]) {
		assert.throws(() => normalizeSlug(unsafe), (error: unknown) => error instanceof Error && "code" in error && error.code === "SLUG_INVALID");
	}
});

const complex = `---\r\n# keep this comment\r\ntitle: "old title" # inline title comment\r\npublished: 2026-09-10\r\nunknown-field:\r\n  nested: [one, two] # do not reserialize\r\n  scalar: |\r\n    first line\r\n    second line\r\ntags: [旧标签, 技术]\r\n# final comment\r\n---\r\nimport Chart from "./Chart.astro";\r\n\r\n<div data-extra="keep raw">\r\n  <Chart values={[1, 2, 3]} />\r\n</div>\r\n\r\n\`\`\`mermaid\r\ngraph TD\r\n A --> B\r\n\`\`\`\r\n`;

test("source mode preserves complete original Markdown/MDX bytes and no-op metadata patches", () => {
	const source = parseSourceDocument(complex);
	assert.equal(source.source, complex);
	assert.equal(patchMetadata(complex, {}), complex);
	assert.deepEqual(source.metadata["unknown-field"], { nested: ["one", "two"], scalar: "first line\nsecond line\n" });
});

test("targeted YAML patch preserves unknown fields, comments, CRLF and raw MDX body", () => {
	const updated = patchMetadata(complex, { title: "新标题", tags: ["新标签"], pinned: true });
	assert.equal(parseSourceDocument(updated).body, parseSourceDocument(complex).body);
	assert.ok(updated.includes('title: "新标题" # inline title comment\r\n'));
	assert.ok(updated.includes('unknown-field:\r\n  nested: [one, two] # do not reserialize\r\n  scalar: |\r\n    first line\r\n    second line\r\n'));
	assert.ok(updated.includes("# final comment\r\n"));
	assert.equal(parseSourceDocument(updated).metadata.pinned, true);
	assert.equal(validatePostSource(updated).title, "新标题");
});

test("unsafe YAML anchors, duplicate keys, unsupported edits and invalid source require correction", () => {
	assert.throws(() => patchMetadata('---\ntitle: &title old\npublished: 2026-09-10\nother: *title\n---\nbody', { title: "new" }), /源码模式/);
	assert.throws(() => parseSourceDocument('---\ntitle: first\ntitle: duplicate\n---\n'), /不合法/);
	assert.throws(() => patchMetadata(complex, { "unknown-field": "replacement" }), /源码模式/);
	assert.throws(() => validatePostSource('---\ntitle: hi\npublished: invalid\n---\n'), /不合法/);
});

test("all real theme posts roundtrip source exactly, retaining nested paths and MDX", async () => {
	const base = fileURLToPath(new URL("../../../src/content/posts/", import.meta.url));
	const files = await readdir(base, { recursive: true });
	let count = 0;
	for (const file of files.filter((entry) => /\.mdx?$/.test(entry))) {
		const source = await readFile(`${base}/${file}`, "utf8");
		assert.equal(parseSourceDocument(source).source, source, file);
		assert.equal(patchMetadata(source, {}), source, file);
		validatePostSource(source);
		count++;
	}
	assert.ok(count >= 14);
});

test("settings preserve intended assets and nav schemas while rejecting dangerous URLs and unmanaged fields", () => {
	validateSettingsPatch({ avatar: "assets/images/avatar.avif", contactLinks: [{ name: "RSS", url: "/rss/", showName: false }], homeCover: { desktop: ["/a.avif"], mobile: [] }, timezone: "Asia/Shanghai", siteStartDate: "2026-07-26T00:00:00+08:00" });
	validateNavigation({ links: [{ name: "分组", url: "#", children: [{ name: "文章", url: "/archive/", pageKey: "archive" }] }] });
	assert.throws(() => validateSettingsPatch({ avatar: "javascript:alert(1)" }), /HTTPS/);
	assert.throws(() => validateSettingsPatch({ music: { enable: false } }), /不支持/);
	assert.throws(() => validateNavigation({ links: [{ name: "unsafe", url: "//evil.example" }] }), /不合法/);
});

test("production publication needs both platform environment and explicit server switch", () => {
	const saved = { APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV, ENABLE_PRODUCTION_PUBLISH: process.env.ENABLE_PRODUCTION_PUBLISH };
	try {
		process.env.APP_ENV = "preview"; process.env.VERCEL_ENV = "preview"; process.env.ENABLE_PRODUCTION_PUBLISH = "true";
		assert.equal(productionEnvironment(), false);
		process.env.APP_ENV = "production"; process.env.VERCEL_ENV = "production"; process.env.ENABLE_PRODUCTION_PUBLISH = "false";
		assert.equal(productionEnvironment(), false);
		process.env.ENABLE_PRODUCTION_PUBLISH = "true";
		assert.equal(productionEnvironment(), true);
		process.env.APP_ENV = "development";
		assert.throws(() => runtimeEnvironment(), /不一致/);
	} finally {
		for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});
