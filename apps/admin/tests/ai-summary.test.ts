import test from "node:test";
import assert from "node:assert/strict";
import { aiConfig, summarize, summaryInput } from "../server/ai.js";
import { ApiFailure } from "../server/security.js";

test("AI configuration is optional and fully env driven", () => {
	assert.equal(aiConfig({}), null);
	assert.deepEqual(aiConfig({ AI_API_KEY: "k", AI_BASE_URL: "https://example.com/v1/", AI_MODEL: "m" }), { apiKey: "k", baseUrl: "https://example.com/v1", model: "m" });
	assert.deepEqual(aiConfig({ AI_API_KEY: "k" }), { apiKey: "k", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
});

test("summary input keeps prose and drops front matter, images and code", () => {
	const source = '---\ntitle: "标题"\npassword: "x"\n---\n# 小标题\n\n![图](https://a/b.png)\n\n[链接文字](https://c)\n\n```js\nconst a = 1;\n```\n';
	const input = summaryInput(source);
	assert.doesNotMatch(input, /title:/);
	assert.doesNotMatch(input, /password:/);
	assert.doesNotMatch(input, /```/);
	assert.doesNotMatch(input, /b\.png/);
	assert.match(input, /# 小标题/);
	assert.match(input, /链接文字/);
});

test("summary posts to an OpenAI-compatible endpoint and trims quoting", async () => {
	let captured: { url: string; init: RequestInit } | null = null;
	const fetcher = (async (url: unknown, init?: unknown) => {
		captured = { url: String(url), init: (init ?? {}) as RequestInit };
		return new Response(JSON.stringify({ choices: [{ message: { content: "「一段摘要」" } }] }), { status: 200 });
	}) as unknown as typeof fetch;
	assert.equal(await summarize("正文", { apiKey: "k", baseUrl: "https://api.example.com", model: "m" }, fetcher), "一段摘要");
	assert.equal(captured!.url, "https://api.example.com/chat/completions");
	const body = JSON.parse(String(captured!.init.body)) as { model: string; messages: Array<{ content: string }> };
	assert.equal(body.model, "m");
	assert.equal(body.messages[1]!.content, "正文");
	assert.match(String((captured!.init.headers as Record<string, string>).Authorization), /^Bearer k$/);
});

test("summary failures stay actionable and never echo the provider body", async () => {
	const failing = (async () => new Response("secret upstream detail", { status: 401 })) as unknown as typeof fetch;
	await assert.rejects(summarize("x", { apiKey: "k", baseUrl: "https://a", model: "m" }, failing), (error: unknown) => error instanceof ApiFailure && error.code === "AI_UPSTREAM_FAILED" && !error.message.includes("secret"));
	const empty = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
	await assert.rejects(summarize("x", { apiKey: "k", baseUrl: "https://a", model: "m" }, empty), (error: unknown) => error instanceof ApiFailure && error.code === "AI_EMPTY_RESPONSE");
});
