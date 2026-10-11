import test from "node:test";
import assert from "node:assert/strict";
import { fetchPublicCommentPage, mountTurnstile, submitPublicInteraction } from "../../../src/utils/public-interactions.ts";

const articleId = "12345678-1234-4234-9234-123456789abc";
const commentId = "87654321-1234-4234-9234-123456789abc";
const comment = { id: commentId, articleId, parentId: null, name: "<img onerror=alert(1)>", body: "<script>literal text</script>", status: "visible", createdAt: "2026-10-10T00:00:00.000Z", email: "private@example.com", visitorId: "private-visitor" };

test("comment pages keep pure text and private fields out, encode cursors, and enforce the page contract", async () => {
	const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
	Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
	let payload: unknown = { data: [comment], nextCursor: Buffer.from(JSON.stringify([articleId, "2026-10-10T00:00:00.000001Z", commentId])).toString("base64url") };
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input), "https://blog.mourn.top");
		assert.equal(url.pathname, "/api/public/comments"); assert.equal(url.searchParams.get("articleId"), articleId);
		assert.equal(url.searchParams.get("limit"), "50"); assert.equal(url.searchParams.get("cursor"), "cursor+/=literal");
		assert.equal(init?.credentials, "omit"); assert.equal(init?.cache, "no-store");
		return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
	};
	try {
		const page = await fetchPublicCommentPage(articleId, { cursor: "cursor+/=literal" });
		assert.equal(page.data[0].body, comment.body); assert.equal(page.data[0].name, comment.name);
		assert.equal("email" in page.data[0], false); assert.equal("visitorId" in page.data[0], false); assert.ok(page.nextCursor);
		payload = { data: [{ ...comment, status: "deleted" }], nextCursor: null };
		const removed = await fetchPublicCommentPage(articleId, { cursor: "cursor+/=literal" });
		assert.equal(removed.data[0].body, "此评论已删除。"); assert.equal(removed.data[0].name, "已删除的评论");
		for (const invalid of [{ data: Array.from({ length: 101 }, () => comment), nextCursor: null }, { data: [comment], nextCursor: "bad" }, { data: [{ ...comment, articleId: commentId }], nextCursor: null }]) {
			payload = invalid; await assert.rejects(() => fetchPublicCommentPage(articleId, { cursor: "cursor+/=literal" }));
		}
	} finally { Object.assign(globalThis, { window: originalWindow, fetch: originalFetch }); }
});

test("new comment responses can be added to the current page without returning private fields", async () => {
	const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
	Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
	globalThis.fetch = async (_input, init) => { assert.equal(init?.method, "POST"); return new Response(JSON.stringify({ data: comment }), { headers: { "Content-Type": "application/json" } }); };
	try {
		const result = await submitPublicInteraction("comments", { articleId, name: "name", body: "body", turnstileToken: "isolated-token" });
		assert.equal(result?.id, commentId); assert.equal(result?.body, comment.body); assert.equal("email" in (result ?? {}), false);
	} finally { Object.assign(globalThis, { window: originalWindow, fetch: originalFetch }); }
});

test("Turnstile mounts separate comment and friend actions and clears callbacks after abort", async () => {
	const originalWindow = globalThis.window;
	const actions: unknown[] = []; let removed = 0; let resets = 0; let callback: ((token: string) => void) | undefined;
	Object.assign(globalThis, { window: { turnstile: { ready: (fn: () => void) => fn(), render: (_element: HTMLElement, options: Record<string, unknown>) => { actions.push(options.action); callback = options.callback as (token: string) => void; return "isolated-widget"; }, reset: () => { resets++; }, remove: () => { removed++; } } } });
	try {
		for (const action of ["comments", "friend_request"] as const) {
			const controller = new AbortController(); const tokens: string[] = [];
			const widget = await mountTurnstile({} as HTMLElement, "public-site-key", action, (value) => tokens.push(value), controller.signal);
			callback?.("valid-token"); widget.reset(); controller.abort(); callback?.("expired-token"); widget.remove();
			assert.deepEqual(tokens, ["valid-token", ""]);
		}
		assert.deepEqual(actions, ["comments", "friend_request"]); assert.equal(removed, 2); assert.equal(resets, 2);
	} finally { Object.assign(globalThis, { window: originalWindow }); }
});
