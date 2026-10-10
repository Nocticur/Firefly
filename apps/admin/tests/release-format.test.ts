import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, compareCodePoints, publicContentDigest, publishedSource, publicSettings } from "../server/release-format.js";

test("public digest uses Unicode code point ordering across nested keys and public entries", () => {
	assert.equal(canonicalJson({ "😀": { b: 2, a: 1 }, "\ue000": 3, z: [null, false] }), '{"z":[null,false],"":3,"😀":{"a":1,"b":2}}');
	assert.equal(compareCodePoints("a", "aa") < 0, true);
	const posts = [{ id: "z", filePath: "src/content/posts/z.md", slug: "z", sourceSha256: "2" }, { id: "A", filePath: "src/content/posts/A.md", slug: "A", sourceSha256: "1" }];
	const settings = { schemaVersion: 1, settings: { title: "博客" }, navigation: null, icons: {} };
	const redirects = [{ from: "/z/", to: "/new/", permanent: true as const }, { from: "/A/", to: "/new/", permanent: true as const }];
	const canonical = '{"posts":[{"filePath":"src/content/posts/A.md","id":"A","slug":"A","sourceSha256":"1"},{"filePath":"src/content/posts/z.md","id":"z","slug":"z","sourceSha256":"2"}],"redirects":[{"from":"/A/","permanent":true,"to":"/new/"},{"from":"/z/","permanent":true,"to":"/new/"}],"settings":{"icons":{},"navigation":null,"schemaVersion":1,"settings":{"title":"博客"}}}';
	const expected = createHash("sha256").update(canonical).digest("hex");
	assert.equal(publicContentDigest(posts, settings, redirects), expected);
	assert.equal(publicContentDigest([...posts].reverse(), settings, [...redirects].reverse()), expected);
	assert.notEqual(publicContentDigest(posts, { ...settings, settings: { title: "Changed" } }, redirects), expected);
});

test("publication preserves saved YAML comments and MDX and never clears draft markers", () => {
	const raw = '---\r\n# Original YAML comment\r\ntitle: "Unknown"\r\ndraft: false\r\ncustom: [a, b]\r\n---\r\nimport Widget from "./Widget.astro";\r\n<Widget value={{ nested: true }} />\r\n';
	assert.equal(publishedSource(raw, "fixed-slug"), raw);
	assert.throws(() => publishedSource(raw.replace("draft: false", "draft: true")), /草稿/);
	assert.throws(() => publishedSource(raw.replace("draft: false", 'draft: true\r\ndraft: false')), /Invalid YAML/);
	assert.throws(() => publishedSource("body without front matter"), /front matter/);
	assert.deepEqual(publicSettings({ title: "Public", avatar: "media:one", retainedUnknown: "private", token: "secret", schemaVersion: 999 }), { title: "Public", avatar: "media:one" });
});
