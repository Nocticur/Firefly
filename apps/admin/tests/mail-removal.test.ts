import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";
import { openApiDocument } from "../server/openapi.js";

test("retired mail endpoints return not found even for provider callbacks", async () => {
	const app = createApp();
	for (const [method, path] of [
		["GET", "/api/mail"],
		["POST", "/api/mail/00000000-0000-4000-8000-000000000001/reconcile"],
		["POST", "/api/webhooks/resend"],
	] as const) {
		const response = await app.request(`https://blog.mourn.top${path}`, {
			method,
			headers: { "Content-Type": "application/json", "svix-id": "retired-provider" },
			...(method === "POST" ? { body: JSON.stringify({ type: "email.delivered", data: {} }) } : {}),
		});
		assert.equal(response.status, 404, `${method} ${path}`);
		assert.equal(response.headers.get("cache-control"), "no-store");
	}
});

test("the current API contract advertises no mail service or provider callback", () => {
	for (const path of Object.keys(openApiDocument.paths))
		assert.equal(/^\/api\/(?:mail(?:\/|$)|webhooks\/resend(?:\/|$))/.test(path), false);
});
