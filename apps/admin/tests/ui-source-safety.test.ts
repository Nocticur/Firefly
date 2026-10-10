import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSource, combineEditedBody, imageDisplaySource, isSafeImageSource, isSafeLink, isSafeTableHTML, preserveSourceLineEndings, serializeSafeTable } from "../client/lib/source-safety.ts";

test("frontmatter bytes, comments, BOM and CRLF are kept outside the editor", () => {
	const prefix = "\uFEFF---\r\ntitle: '标题' # keep this comment\r\ncustom:\r\n  - one\r\n  - two\r\n---\r\n";
	const source = `${prefix}# 正文\r\n\r\n**text**\r\n`;
	const result = analyzeSource(source);
	assert.equal(result.safe, true);
	assert.equal(result.prefix, prefix);
	assert.equal(result.body, "# 正文\r\n\r\n**text**\r\n");
	assert.equal(combineEditedBody(result, result.body), source);
});

test("unsupported HTML, MDX, YAML and Markdown stay in source mode", () => {
	for (const source of ["<iframe src='https://example.com'></iframe>", "export const a = 1\n\n# title", "Hello {title}", ":::note\nhello\n:::", "- [x] checked", "[[wiki]]", "[^note]: a footnote", "---\ntitle: !custom x\n---\nhello", "---\ntitle: [broken\n---\nhello", "```js title=custom\nalert(1)\n```", "```js\nunclosed"]) {
		assert.equal(analyzeSource(source).safe, false, source);
	}
});

test("code, math, escapes and regular Markdown remain editable", () => {
	for (const source of ["# Hi\n\n**bold** and *italic*\n\n> quote", "```mdx\n<Component value={a}/>\n```", "~~~html\n<script>example</script>\n~~~", "`<span>{code}</span>` and \\{literal\\}", "$$\n\\frac{a}{b}\n$$\n\nInline $x^{2}$.", "| A | B |\n| --- | --- |\n| one | two |", "![alt](https://example.com/a.png)", "<https://example.com>"]) {
		assert.equal(analyzeSource(source).safe, true, source);
	}
});

test("link dialog accepts only public web, mail and local destinations", () => {
	for (const value of ["https://example.com", "http://example.com", "mailto:test@example.com", "/posts/one", "#title"]) assert.equal(isSafeLink(value), true);
	for (const value of ["javascript:alert(1)", "data:text/html,a", "file:///etc/passwd", "//example.com", "https://exa\nmple.com", ""]) assert.equal(isSafeLink(value), false);
	assert.equal(analyzeSource("[click](javascript:alert(1))").safe, false);
});

test("unknown YAML, MDX and HTML documents round-trip as exact source bytes", () => {
	const sources = [
		"\uFEFF---\r\ntitle: '未知组件' # 注释必须保留\r\ncustom: &custom\r\n  nested: [一, 二]\r\ncopy: *custom\r\n---\r\nimport Card from './Card.astro'\r\n\r\n<Card {...props}>\r\n  <span data-unknown='keep'>{value}</span>\r\n</Card>\r\n",
		"---\ntitle: HTML\nplugin: !UnknownTag original # untouched\n---\n\n<!-- unknown HTML comment -->\n<div class='custom' data-foo=\"bar\">\n  原始  空格<br/>\n</div>\n",
		"---\ntitle: 扩展语法\nunknown: { keep: [all, values] }\n---\n\n:::warning{custom='value'}\n[[未知链接]]\n::: \n\nexport const 配置 = {unknown: true}\n",
	];
	for (const original of sources) {
		const analysis = analyzeSource(original);
		assert.equal(analysis.safe, false);
		assert.equal(combineEditedBody(analysis, analysis.body), original);
		assert.deepEqual(Buffer.from(combineEditedBody(analysis, analysis.body)), Buffer.from(original));
	}
});

test("private media keeps stable source references and relative source images", () => {
	const reference = "media:12345678-1234-1234-1234-123456789abc";
	assert.equal(isSafeImageSource(reference), true);
	assert.equal(imageDisplaySource(reference), "/api/media/12345678-1234-1234-1234-123456789abc/content");
	for (const image of ["./images/原图.png", "../images/source.png", "images/source.png"]) assert.equal(isSafeImageSource(image), true);
	for (const image of ["media:untrusted", "javascript:alert(1)", "data:image/svg+xml,evil", "//evil.test/a.png", "images/evil\\file.png"]) assert.equal(isSafeImageSource(image), false);
});

test("source textarea edits preserve CRLF in unchanged unknown fragments", () => {
	const original = "---\r\ntitle: 原文 # 保留\r\n---\r\n<UnknownBlock attr='原样'/>\r\n\r\n旧正文\r\n";
	const browserValue = original.replaceAll("\r\n", "\n").replace("旧正文", "新正文");
	assert.equal(preserveSourceLineEndings(original, browserValue), original.replace("旧正文", "新正文"));
});

test("advanced table schema retains spans and rejects unknown active HTML", () => {
	const html = serializeSafeTable({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2, rowspan: 2, colwidth: [120, 180] }, content: [{ type: "paragraph", content: [{ type: "text", text: "合并单元格 & 原文" }] }, { type: "paragraph", content: [{ type: "text", text: "第二段" }] }] }] }] });
	assert.match(html, /colspan="2"/);
	assert.match(html, /rowspan="2"/);
	assert.match(html, /colwidth="120,180"/);
	assert.equal(isSafeTableHTML(html), true);
	assert.equal(analyzeSource(html).safe, true);
	for (const original of ["<table><tbody><tr><td onclick=\"evil()\"><p>原文</p></td></tr></tbody></table>", "<table><tbody><tr><td><CustomBlock unknown=\"keep\" /></td></tr></tbody></table>"]) {
		const analysis = analyzeSource(original);
		assert.equal(analysis.safe, false);
		assert.equal(combineEditedBody(analysis, analysis.body), original);
	}
});
