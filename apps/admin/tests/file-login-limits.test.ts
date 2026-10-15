import test from "node:test";
import assert from "node:assert/strict";
import { collection, createMemoryStore } from "../server/file-store.js";
import { consumeLoginAllowance } from "../server/login-rate.js";
import { ApiFailure } from "../server/security.js";

test("global file quota is checked before allocating clients and expired sessions are removed", async () => {
	const previous = {
		APP_ENV: process.env.APP_ENV,
		VERCEL_ENV: process.env.VERCEL_ENV,
		VERCEL: process.env.VERCEL,
	};
	process.env.APP_ENV = "development";
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	try {
		const site = "tests/global:development";
		const store = createMemoryStore(site);
		const window = Math.floor(Date.now() / 600_000) * 600_000;
		await store.update((state) => {
			collection(state, "interaction_rate_limits")[`entry:global:${window}`] = {
				subject: "entry:global",
				window_start: window,
				hits: 99,
			};
			collection(state, "sessions").expired = {
				expires_at: new Date(Date.now() - 1000).toISOString(),
			};
			collection(state, "sessions").live = {
				expires_at: new Date(Date.now() + 10_000).toISOString(),
			};
		});
		const attempt = (ip: string) =>
			consumeLoginAllowance(
				store,
				site,
				new Request("http://localhost", { headers: { "x-forwarded-for": ip } }),
				"secret",
				"entry",
			);
		const results = await Promise.allSettled([
			attempt("198.51.100.1"),
			attempt("198.51.100.2"),
		]);
		assert.equal(
			results.filter((result) => result.status === "fulfilled").length,
			1,
		);
		assert.equal(
			Object.keys(collection(await store.read(), "interaction_rate_limits"))
				.length,
			2,
		);
		assert.deepEqual(Object.keys(collection(await store.read(), "sessions")), [
			"live",
		]);
	} finally {
		for (const [key, value] of Object.entries(previous))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
});
test("production file login quotas accept only the trusted Vercel client address", async () => {
	const previous = {
		APP_ENV: process.env.APP_ENV,
		VERCEL_ENV: process.env.VERCEL_ENV,
		VERCEL: process.env.VERCEL,
	};
	Object.assign(process.env, {
		APP_ENV: "production",
		VERCEL_ENV: "production",
	});
	delete process.env.VERCEL;
	try {
		const site = "tests/proxy:production";
		const store = createMemoryStore(site);
		const request = (spoofed: string, trusted?: string) =>
			new Request("https://blog.mourn.top", {
				headers: {
					"x-forwarded-for": spoofed,
					...(trusted ? { "x-vercel-forwarded-for": trusted } : {}),
				},
			});
		await assert.rejects(
			consumeLoginAllowance(
				store,
				site,
				request("198.51.100.5"),
				"secret",
				"entry",
			),
			(error: unknown) =>
				error instanceof ApiFailure && error.code === "LOGIN_CLIENT_UNVERIFIED",
		);
		process.env.VERCEL = "1";
		for (let index = 0; index < 5; index++)
			await consumeLoginAllowance(
				store,
				site,
				request(`198.51.100.${index + 10}`, "192.0.2.2"),
				"secret",
				"entry",
			);
		await assert.rejects(
			consumeLoginAllowance(
				store,
				site,
				request("198.51.100.99", "192.0.2.2"),
				"secret",
				"entry",
			),
			(error: unknown) => error instanceof ApiFailure && error.status === 429,
		);
	} finally {
		for (const [key, value] of Object.entries(previous))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
});
