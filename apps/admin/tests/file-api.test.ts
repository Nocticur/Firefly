import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";
import {
	collection,
	createMemoryStore,
	getSiteId,
} from "../server/file-store.js";

test("authenticated HTTP editing persists in files with history, revision conflicts and CSRF", async () => {
	const keys = [
		"APP_ENV",
		"VERCEL_ENV",
		"VERCEL",
		"ADMIN_ENTRY_PASSWORD",
		"GITHUB_REPOSITORY",
		"ADMIN_DEV_ORIGIN",
	] as const;
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, {
		APP_ENV: "development",
		ADMIN_ENTRY_PASSWORD: "testOnly42",
		GITHUB_REPOSITORY: "tests/file-api",
		ADMIN_DEV_ORIGIN: "http://localhost:3000",
	});
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	try {
		const store = createMemoryStore(getSiteId());
		const app = createApp(store);
		const origin = "http://localhost:3000";
		const login = await app.request(`${origin}/api/auth/entry`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ password: "testOnly42" }),
		});
		assert.equal(login.status, 200);
		const cookie = login.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const session = (
			await (
				await app.request(`${origin}/api/auth/session`, { headers: { cookie } })
			).json()
		).data;
		const headers = {
			cookie,
			Origin: origin,
			"Content-Type": "application/json",
			"x-csrf-token": session.csrfToken,
		};
		const write = (
			path: string,
			body: unknown,
			method = "POST",
			overrides = {},
		) =>
			app.request(`${origin}/api${path}`, {
				method,
				headers: { ...headers, ...overrides },
				body: JSON.stringify(body),
			});
		const source =
			'---\r\ntitle: "文件草稿" # keep\r\npublished: 2026-10-15\r\ndraft: true\r\nslug: "文件测试"\r\nunknown: { keep: [1, 2] }\r\n---\r\n\r\nOriginal body\r\n';
		assert.equal(
			(
				await write("/posts", { source, slug: "文件测试" }, "POST", {
					"x-csrf-token": "",
				})
			).status,
			403,
		);
		const created = await write("/posts", { source, slug: "文件测试" });
		assert.equal(created.status, 201);
		const post = (await created.json()).data;
		const edited = source.replace("Original body", "Edited body");
		assert.equal(
			(
				await write(
					`/posts/${post.id}`,
					{ source: edited, expectedRevision: 1 },
					"PUT",
				)
			).status,
			200,
		);
		assert.equal(
			(await write(`/posts/${post.id}`, { source, expectedRevision: 1 }, "PUT"))
				.status,
			409,
		);
		const history = await app.request(
			`${origin}/api/posts/${post.id}/history`,
			{ headers },
		);
		assert.equal(history.status, 200);
		const versions = (await history.json()).data;
		assert.equal(versions[0].source, source);
		assert.equal(
			(
				await write(`/posts/${post.id}/restore`, {
					versionId: versions[0].id,
					expectedRevision: 2,
				})
			).status,
			200,
		);
		const refreshed = await app.request(`${origin}/api/posts/${post.id}`, {
			headers,
		});
		assert.equal((await refreshed.json()).data.source, source);
		assert.equal(
			(
				await write(
					"/service-settings",
					{
						data: { publish: false, maintenance: false },
						expectedRevision: 0,
					},
					"PUT",
				)
			).status,
			200,
		);
		assert.equal(
			(
				await write(
					"/service-settings",
					{
						data: { publish: true, maintenance: false },
						expectedRevision: 1,
					},
					"PUT",
				)
			).status,
			403,
		);
		assert.equal(
			Object.values(collection(await store.read(), "entities")).filter(
				(row) => row.kind === "post",
			).length,
			1,
		);
		assert.equal(refreshed.headers.get("cache-control"), "no-store");
	} finally {
		for (const key of keys)
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
	}
});
