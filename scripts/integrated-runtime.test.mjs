import assert from "node:assert/strict";
import test from "node:test";

test("the deployed Node function serves the admin shell and retains API authentication", async () => {
	const keys = ["APP_ENV", "VERCEL_ENV", "ADMIN_ENTRY_PASSWORD", "ADMIN_DEV_ORIGIN"];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		APP_ENV: "development",
		VERCEL_ENV: "development",
		ADMIN_ENTRY_PASSWORD: "testOnly42",
		ADMIN_DEV_ORIGIN: "http://localhost:4321",
	});
	try {
		const { default: server } = await import("../.vercel/output/functions/__server.func/index.mjs");
		const request = (path, method = "GET") => server.fetch(new Request(`http://localhost:4321${path}`, { method }));
		for (const path of ["/admin", "/admin/", "/admin/posts/"]) {
			const response = await request(path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
			assert.match(await response.text(), /\/admin\/assets\/[^" ]+\.js/);
		}
		const head = await request("/admin/", "HEAD");
		assert.equal(head.status, 200);
		assert.equal(await head.text(), "");
		const health = await request("/api/health");
		assert.equal(health.status, 200);
		assert.equal((await health.json()).data.environment, "development");
		const entry = await request("/api/auth/entry");
		assert.equal(entry.status, 200);
		assert.deepEqual(await entry.json(), { data: { verified: false } });
		for (const path of ["/api/auth/session", "/api/posts", "/api/media"]) {
			const response = await request(path);
			assert.equal(response.status, 401, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.ok((await response.json()).error);
		}
		const missing = await request("/missing-blog-page/");
		assert.equal(missing.status, 404, "Unknown blog routes must not become the admin SPA");
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	}
});
