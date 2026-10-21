import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
	collection,
	createMemoryStore,
	getSiteId,
} from "../server/file-store.js";
import { registerAuthRoutes } from "../server/auth.js";
import { consumeLoginAllowance } from "../server/login-rate.js";
import { issueSession, PASSWORD_ADMIN_ID, verifySessionToken } from "../server/session.js";
import { ApiFailure } from "../server/security.js";
import type { AppEnv } from "../server/types.js";

test("file-backed login checks password, restores session and revokes logout with same-origin CSRF", async () => {
	const keys = [
		"APP_ENV",
		"VERCEL_ENV",
		"VERCEL",
		"GITHUB_REPOSITORY",
		"ADMIN_ENTRY_PASSWORD",
		"ADMIN_DEV_ORIGIN",
	] as const;
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, {
		APP_ENV: "development",
		GITHUB_REPOSITORY: "tests/file-auth",
		ADMIN_ENTRY_PASSWORD: "testOnly42",
		ADMIN_DEV_ORIGIN: "http://localhost:3000",
	});
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	try {
		const store = createMemoryStore(getSiteId());
		const app = new Hono<AppEnv>();
		registerAuthRoutes(app, store);
		app.onError((error) =>
			error instanceof ApiFailure
				? error.getResponse()
				: new Response(null, { status: 500 }),
		);
		const origin = "http://localhost:3000";
		const login = (password: string) =>
			app.request(`${origin}/api/auth/entry`, {
				method: "POST",
				headers: { Origin: origin, "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
		for (const password of ["", "ab", "x".repeat(11), " ".repeat(3)])
			assert.equal((await login(password)).status, 400);
		assert.equal(
			Object.keys(collection(await store.read(), "interaction_rate_limits"))
				.length,
			0,
		);
		assert.equal((await login("wrongGuess")).status, 401);
		const response = await login("testOnly42");
		assert.equal(response.status, 200);
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		assert.match(cookie, /__Host-admin-session=/);
		const current = await app.request(`${origin}/api/auth/session`, {
			headers: { cookie },
		});
		assert.equal(current.status, 200);
		const session = (await current.json()).data;
		assert.equal(session.productionPublish, false);
		const rejectedHeaders: Record<string, string>[] = [
			{ cookie, Origin: origin },
			{
				cookie,
				Origin: "https://foreign.example",
				"x-csrf-token": session.csrfToken,
			},
		];
		for (const headers of rejectedHeaders)
			assert.equal(
				(
					await app.request(`${origin}/api/auth/logout`, {
						method: "POST",
						headers,
					})
				).status,
				403,
			);
		// Stateless sessions cannot be revoked server-side, so logout clears the cookie.
		assert.match(
			(
				await app.request(`${origin}/api/auth/logout`, {
					method: "POST",
					headers: {
						cookie,
						Origin: origin,
						"x-csrf-token": session.csrfToken,
					},
				})
			).headers.get("set-cookie") || "",
			/__Host-admin-session=;.*Max-Age=0/i,
		);
		// The signed token stays cryptographically valid, but logout removes it from
		// the browser; rotating ADMIN_ENTRY_PASSWORD invalidates every prior session.
		assert.equal(
			Object.keys(collection(await store.read(), "sessions")).length,
			0,
		);
	} finally {
		for (const key of keys)
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
	}
});
test("stateless sessions are signed, self-describing, and reject tampering", () => {
	const first = issueSession();
	assert.ok(first.token.includes("."));
	const verified = verifySessionToken(first.token);
	assert.equal(verified.user.id, PASSWORD_ADMIN_ID);
	assert.ok(verified.expiresAt > Date.now());
	// No session table is involved, so a stateless deployment needs no database.
	assert.throws(() => verifySessionToken(`${first.token}x`), /SESSION_INVALID|会话/);
});
test("concurrent file login attempts preserve per-client quotas", async () => {
	const previous = {
		APP_ENV: process.env.APP_ENV,
		VERCEL_ENV: process.env.VERCEL_ENV,
		VERCEL: process.env.VERCEL,
	};
	process.env.APP_ENV = "development";
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	try {
		const site = "tests/limits:development";
		const store = createMemoryStore(site);
		const request = new Request("http://localhost:3000", {
			headers: { "x-forwarded-for": "192.0.2.1" },
		});
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, () =>
				consumeLoginAllowance(
					store,
					site,
					request,
					"test-hash-secret",
					"entry",
				),
			),
		);
		assert.equal(
			results.filter((result) => result.status === "fulfilled").length,
			5,
		);
		assert.equal(
			results.filter(
				(result) =>
					result.status === "rejected" && result.reason.status === 429,
			).length,
			5,
		);
		assert.equal(
			JSON.stringify(await store.read()).includes("192.0.2.1"),
			false,
		);
	} finally {
		for (const [key, value] of Object.entries(previous))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
});
