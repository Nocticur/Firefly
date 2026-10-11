import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import { registerAuthRoutes, csrfForSession } from "../server/auth.js";
import { ENTRY_COOKIE } from "../server/entry.js";
import { getDatabase, getSiteId } from "../server/db.js";
import { consumeLoginAllowance } from "../server/login-rate.js";
import { ApiFailure, digest } from "../server/security.js";
import { PASSWORD_ADMIN_ID } from "../server/session.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const password = "DbTest_42";
function responseCookie(response: Response, name: string): string {
	const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
	assert.ok(cookie, `Expected ${name} Cookie`);
	return cookie.split(";")[0];
}

test("password alone creates a durable administrator session with CSRF, expiry and persistent quotas", { skip: !databaseUrl }, async (t) => {
	const variables = ["APP_ENV", "VERCEL_ENV", "VERCEL", "ADMIN_DEVELOPMENT_DATABASE_URL", "ADMIN_GITHUB_USER_ID", "ADMIN_ENTRY_PASSWORD", "ADMIN_DEV_ORIGIN", "GITHUB_REPOSITORY", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
	process.env.ADMIN_DEVELOPMENT_DATABASE_URL = databaseUrl;
	process.env.ADMIN_DEV_ORIGIN = origin;
	delete process.env.ADMIN_GITHUB_USER_ID;
	process.env.ADMIN_ENTRY_PASSWORD = password;
	process.env.GITHUB_REPOSITORY = `tests/entry-${randomUUID()}`;
	delete process.env.GITHUB_OAUTH_CLIENT_ID;
	delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
	const db = getDatabase(); const site = getSiteId();
	const app = new Hono<AppEnv>();
	app.onError((error) => error instanceof ApiFailure ? error.getResponse() : new Response("Isolated test failed", { status: 500 }));
	registerAuthRoutes(app);
	const post = (value: unknown, ip = "192.0.2.1", extraHeaders: Record<string, string> = {}) => app.request(`${origin}/api/auth/entry`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "x-forwarded-for": ip, ...extraHeaders }, body: JSON.stringify({ password: value }) });
	let verifiedCookie = "";
	let sessionCookie = "";
	const originalFetch = globalThis.fetch;
	let networkCalls = 0;
	globalThis.fetch = async () => { networkCalls++; throw new Error("Password login must not call external authentication providers"); };
	try {
		for (const name of ["001-core.sql", "003-interactions.sql"]) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
		await t.test("entry status fails closed until configured, without exposing secrets", async () => {
			for (const value of [undefined, "", "ab", "x".repeat(11), " ".repeat(3)]) {
				if (value === undefined) delete process.env.ADMIN_ENTRY_PASSWORD; else process.env.ADMIN_ENTRY_PASSWORD = value;
				assert.equal((await app.request(`${origin}/api/auth/entry`)).status, 503);
				assert.equal((await post(password)).status, 503);
			}
			process.env.ADMIN_ENTRY_PASSWORD = password;
			const status = await app.request(`${origin}/api/auth/entry`);
			assert.deepEqual(await status.json(), { data: { verified: false } });
			assert.equal(status.headers.get("cache-control"), "no-store");
		});
		await t.test("foreign/missing Origin, cross-site fetches, invalid bodies and oversized bytes are rejected", async () => {
			assert.equal((await post(password, "192.0.2.1", { Origin: "https://evil.example" })).status, 403);
			assert.equal((await post(password, "192.0.2.1", { Origin: "" })).status, 403);
			assert.equal((await post(password, "192.0.2.1", { "Sec-Fetch-Site": "cross-site" })).status, 403);
			for (const value of [null, 1, [], {}, "", "ab", "x".repeat(11), "界".repeat(11), "\ud800ab", " ".repeat(3)]) assert.equal((await post(value)).status, 400);
			assert.equal((await post("x".repeat(2000))).status, 413);
			assert.equal((await post(password, "192.0.2.1", { "Content-Type": "text/plain" })).status, 415);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'entry:%'", [site])).length, 0);
		});
		await t.test("real 3- and 10-character passwords including Unicode create sessions and rotation invalidates prior proof", async () => {
			let previousCookie = "";
			try {
				for (const [index, value] of ["a1!", "testOnly42", "暮夜途", "🚀".repeat(10)].entries()) {
					process.env.ADMIN_ENTRY_PASSWORD = value;
					if (previousCookie) assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: previousCookie } })).status, 401);
					const response = await post(value, `192.0.2.${60 + index}`);
					assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: { verified: true } });
					const both = `${responseCookie(response, ENTRY_COOKIE)}; ${responseCookie(response, "__Host-admin-session")}`;
					const current = await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } });
					assert.equal(current.status, 200);
					const session = (await current.json()).data;
					assert.equal(session.user.id, PASSWORD_ADMIN_ID);
					previousCookie = both;
				}
			} finally {
				process.env.ADMIN_ENTRY_PASSWORD = password;
				await db.query("DELETE FROM sessions WHERE site_id=$1", [site]);
			}
		});
		await t.test("wrong passwords do not issue an entry or administrator session", async () => {
			const response = await post("wrongGuess");
			assert.equal(response.status, 401);
			assert.equal((await response.json()).error.code, "ENTRY_PASSWORD_INCORRECT");
			assert.equal(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${ENTRY_COOKIE}=v1.`)), false);
			assert.equal((await db.query("SELECT token_hash FROM sessions WHERE site_id=$1", [site])).length, 0);
		});
		await t.test("correct password creates secure credentials and enters directly without GitHub configuration", async () => {
			const response = await post(password);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { data: { verified: true } });
			const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${ENTRY_COOKIE}=`))!;
			for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) assert.ok(cookie.includes(attribute));
			assert.equal(cookie.includes(password), false); assert.equal(cookie.includes("Domain="), false);
			verifiedCookie = responseCookie(response, ENTRY_COOKIE);
			sessionCookie = responseCookie(response, "__Host-admin-session");
			const sessionHeader = response.headers.getSetCookie().find((value) => value.startsWith("__Host-admin-session="))!;
			for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) assert.ok(sessionHeader.includes(attribute));
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: verifiedCookie } })).status, 401);
			assert.deepEqual(await (await app.request(`${origin}/api/auth/entry`, { headers: { Cookie: verifiedCookie } })).json(), { data: { verified: true } });
			const current = await app.request(`${origin}/api/auth/session`, { headers: { Cookie: `${verifiedCookie}; ${sessionCookie}` } });
			assert.equal(current.status, 200);
			const session = (await current.json()).data;
			assert.equal(session.user.id, PASSWORD_ADMIN_ID); assert.equal(session.user.name, "Nocticur");
			assert.equal(session.csrfToken, csrfForSession(sessionCookie.split("=")[1]));
			assert.equal(networkCalls, 0);
		});
		await t.test("session proof and same-origin CSRF remain mandatory for writes and logout clears both credentials", async () => {
			const denied = await app.request(`${origin}/api/auth/session`, { headers: { Cookie: sessionCookie } });
			assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, "ENTRY_PASSWORD_REQUIRED");
			const both = `${sessionCookie}; ${verifiedCookie}`;
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } })).status, 200);
			const csrf = csrfForSession(sessionCookie.split("=")[1]);
			const rejectedHeaders: Record<string, string>[] = [{ Cookie: both, Origin: origin }, { Cookie: both, Origin: "https://evil.example", "x-csrf-token": csrf }];
			for (const headers of rejectedHeaders) assert.equal((await app.request(`${origin}/api/auth/logout`, { method: "POST", headers })).status, 403);
			const logout = await app.request(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: both, Origin: origin, "x-csrf-token": csrf } });
			assert.equal(logout.status, 200);
			for (const name of [ENTRY_COOKIE, "__Host-admin-session"]) assert.ok(logout.headers.getSetCookie().some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0")));
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } })).status, 401);
		});
		await t.test("removed OAuth launch and callback cannot create a session or call GitHub", async () => {
			for (const path of ["/api/auth/github", "/api/auth/callback?state=invalid&code=invalid"]) {
				const response = await app.request(`https://admin.mourn.top${path}`);
				assert.equal(response.status, 404);
			}
			assert.equal((await db.query("SELECT state_hash FROM oauth_states WHERE site_id=$1", [site])).length, 0);
			assert.equal(networkCalls, 0);
		});
		await t.test("repeated password login rotates the session, ignores supplied identity and revokes the previous token", async () => {
			const first = await post(password, "192.0.2.12");
			assert.equal(first.status, 200);
			const firstCookie = responseCookie(first, "__Host-admin-session");
			const firstProof = responseCookie(first, ENTRY_COOKIE);
			const second = await app.request(`${origin}/api/auth/entry`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "x-forwarded-for": "192.0.2.12", Cookie: `${firstCookie}; ${firstProof}` }, body: JSON.stringify({ password, user: { id: "1", name: "Impersonated" }, token: firstCookie.split("=")[1] }) });
			assert.equal(second.status, 200);
			sessionCookie = responseCookie(second, "__Host-admin-session");
			verifiedCookie = responseCookie(second, ENTRY_COOKIE);
			assert.notEqual(sessionCookie, firstCookie);
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: `${firstCookie}; ${firstProof}` } })).status, 401);
			const current = await app.request(`${origin}/api/auth/session`, { headers: { Cookie: `${sessionCookie}; ${verifiedCookie}` } });
			assert.equal(current.status, 200); assert.equal((await current.json()).data.user.id, PASSWORD_ADMIN_ID);
			assert.equal((await db.query("SELECT token_hash FROM sessions WHERE site_id=$1 AND token_hash=$2", [site, digest(firstCookie.split("=")[1])])).length, 0);
			assert.equal(networkCalls, 0);
		});
		await t.test("legacy GitHub sessions, expired sessions and corrupted CSRF hashes are rejected", async () => {
			const hash = digest(sessionCookie.split("=")[1]);
			const both = `${sessionCookie}; ${verifiedCookie}`;
			await db.query("UPDATE sessions SET user_data=jsonb_set(user_data,'{id}','\"285582250\"') WHERE site_id=$1 AND token_hash=$2", [site, hash]);
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } })).status, 401);
			await db.query("UPDATE sessions SET user_data=jsonb_set(user_data,'{id}',to_jsonb($3::text)),csrf_hash='invalid' WHERE site_id=$1 AND token_hash=$2", [site, hash, PASSWORD_ADMIN_ID]);
			const corrupted = await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } });
			assert.equal(corrupted.status, 401); assert.equal((await corrupted.json()).error.code, "SESSION_INVALID");
			await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE site_id=$1 AND token_hash=$2", [site, hash]);
			assert.equal((await app.request(`${origin}/api/auth/session`, { headers: { Cookie: both } })).status, 401);
		});
		await t.test("concurrent password attempts share a persistent five-per-IP quota", async () => {
			const responses = await Promise.all(Array.from({ length: 8 }, () => post("badGuess9", "192.0.2.22")));
			assert.equal(responses.filter((response) => response.status === 401).length, 5);
			assert.equal(responses.filter((response) => response.status === 429).length, 3);
			assert.equal((await post(password, "192.0.2.22")).status, 429);
			const rows = await db.query("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'entry:%'", [site]);
			assert.equal(rows.some((row) => String(row.subject).includes("192.0.2.22")), false);
			assert.ok(rows.some((row) => Number(row.hits) === 5));
		});
		await t.test("rotating addresses cannot bypass the global password quota", async () => {
			await db.query("UPDATE interaction_rate_limits SET hits=100 WHERE site_id=$1 AND subject='entry:global'", [site]);
			const before = (await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'entry:%'", [site])).length;
			for (const ip of ["192.0.2.30", "192.0.2.31"]) assert.equal((await post(password, ip)).status, 429);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'entry:%'", [site])).length, before);
		});
		await t.test("production password quotas require trusted Vercel forwarding and ignore spoofed generic IP headers", async () => {
			const proxySite = `${site}-proxy`;
			process.env.APP_ENV = "production"; process.env.VERCEL_ENV = "production";
			const proxyRequest = (headers: Record<string, string>) => new Request("https://admin.mourn.top/api/auth/entry", { headers });
			try {
				await assert.rejects(() => consumeLoginAllowance(db, proxySite, proxyRequest({ "x-forwarded-for": "192.0.2.44" }), "synthetic-rate-secret", "entry"), (error: unknown) => error instanceof ApiFailure && error.status === 503);
				process.env.VERCEL = "1";
				for (let i = 0; i < 5; i++) await consumeLoginAllowance(db, proxySite, proxyRequest({ "x-vercel-forwarded-for": "192.0.2.44", "x-forwarded-for": `192.0.2.${100 + i}` }), "synthetic-rate-secret", "entry");
				await assert.rejects(() => consumeLoginAllowance(db, proxySite, proxyRequest({ "x-vercel-forwarded-for": "192.0.2.44", "x-forwarded-for": "192.0.2.200" }), "synthetic-rate-secret", "entry"), (error: unknown) => error instanceof ApiFailure && error.code === "ENTRY_RATE_LIMITED");
			} finally { await db.query("DELETE FROM interaction_rate_limits WHERE site_id=$1", [proxySite]); }
		});
	} finally {
		globalThis.fetch = originalFetch;
		for (const table of ["sessions", "oauth_states", "interaction_rate_limits"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [site]);
		await db.close();
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});
