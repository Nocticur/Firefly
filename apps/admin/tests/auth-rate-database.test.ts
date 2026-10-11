import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import { consumeOAuthLoginAllowance, registerAuthRoutes } from "../server/auth.js";
import { createDatabase, getDatabase, getSiteId } from "../server/db.js";
import { ApiFailure } from "../server/security.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const secret = "isolated-test-only-oauth-secret";
const failure = (code: string, status: number) => (error: unknown) => error instanceof ApiFailure && error.code === code && error.status === status;
const loginRequest = (address: string) => new Request("https://admin.mourn.top/api/auth/github", { headers: { "x-forwarded-for": address } });

test("OAuth launch counters persist, serialize concurrent requests and clean expired authentication data", { skip: !databaseUrl }, async (t) => {
	const variables = ["APP_ENV", "VERCEL_ENV", "VERCEL", "ADMIN_DEVELOPMENT_DATABASE_URL", "ADMIN_GITHUB_USER_ID", "GITHUB_REPOSITORY", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
	process.env.ADMIN_DEVELOPMENT_DATABASE_URL = databaseUrl;
	process.env.ADMIN_GITHUB_USER_ID = "285582250";
	process.env.GITHUB_REPOSITORY = `tests/oauth-${randomUUID()}`;
	process.env.GITHUB_OAUTH_CLIENT_ID = "isolated-test-only-client";
	process.env.GITHUB_OAUTH_CLIENT_SECRET = secret;
	const db = createDatabase(databaseUrl!); const second = createDatabase(databaseUrl!);
	const site = getSiteId(); const globalSite = `${site}-global`; const productionSite = `${site}-proxy`;
	const sites = [site, globalSite, productionSite];
	try {
		for (const name of ["001-core.sql", "003-interactions.sql"]) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
		await t.test("expired states/sessions and old OAuth buckets are removed, preserving live and unrelated rows", async () => {
			await db.query("INSERT INTO oauth_states(site_id,state_hash,cookie_hash,expires_at) VALUES($1,'expired','nonce',now()-interval '1 second'),($1,'live','nonce',now()+interval '10 minutes')", [site]);
			await db.query("INSERT INTO sessions(site_id,token_hash,user_data,csrf_hash,expires_at) VALUES($1,'expired','{}','csrf',now()-interval '1 second'),($1,'live','{}','csrf',now()+interval '12 hours')", [site]);
			await db.query("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,'oauth:old',now()-interval '1 hour',1),($1,'comments:retained',now()-interval '1 hour',1)", [site]);
			await consumeOAuthLoginAllowance(db, site, loginRequest("198.51.100.1"), secret);
			assert.deepEqual((await db.query("SELECT state_hash FROM oauth_states WHERE site_id=$1 ORDER BY state_hash", [site])).map((row) => row.state_hash), ["live"]);
			assert.deepEqual((await db.query("SELECT token_hash FROM sessions WHERE site_id=$1 ORDER BY token_hash", [site])).map((row) => row.token_hash), ["live"]);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject='oauth:old'", [site])).length, 0);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject='comments:retained'", [site])).length, 1);
		});
		await t.test("one IP cannot exceed five launches across concurrent independent connections", async () => {
			const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => consumeOAuthLoginAllowance(index % 2 ? db : second, site, loginRequest("198.51.100.1"), secret)));
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
			for (const result of results) if (result.status === "rejected") assert.ok(failure("OAUTH_RATE_LIMITED", 429)(result.reason));
			const [global] = await db.query("SELECT hits FROM interaction_rate_limits WHERE site_id=$1 AND subject='oauth:global'", [site]);
			assert.equal(Number(global.hits), 5);
			const [counter] = await db.query("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'oauth:ip:%'", [site]);
			assert.equal(Number(counter.hits), 5);
			assert.equal(counter.subject, `oauth:ip:${createHmac("sha256", secret).update(`${site}\0${"198.51.100.1"}`).digest("hex")}`);
		});
		await t.test("a global cap rejects new rotating addresses before allocating more IP rows", async () => {
			await db.query("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,'oauth:global',to_timestamp(floor(extract(epoch FROM now())/600)*600),99)", [globalSite]);
			const results = await Promise.allSettled([consumeOAuthLoginAllowance(db, globalSite, loginRequest("198.51.100.2"), secret), consumeOAuthLoginAllowance(second, globalSite, loginRequest("198.51.100.3"), secret)]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			assert.ok(failure("OAUTH_RATE_LIMITED", 429)((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason));
			for (let index = 4; index < 9; index++) await assert.rejects(consumeOAuthLoginAllowance(db, globalSite, loginRequest(`198.51.100.${index}`), secret), failure("OAUTH_RATE_LIMITED", 429));
			const counters = await db.query("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1", [globalSite]);
			assert.equal(counters.length, 2);
			assert.equal(Number(counters.find((row) => row.subject === "oauth:global")?.hits), 100);
		});
		await t.test("production requires the Vercel proxy and ignores spoofed generic forwarding headers", async () => {
			process.env.APP_ENV = "production"; process.env.VERCEL_ENV = "production";
			await assert.rejects(consumeOAuthLoginAllowance(db, productionSite, loginRequest("198.51.100.44"), secret), failure("OAUTH_CLIENT_UNVERIFIED", 503));
			process.env.VERCEL = "1";
			for (let index = 0; index < 5; index++) await consumeOAuthLoginAllowance(db, productionSite, new Request("https://admin.mourn.top/api/auth/github", { headers: { "x-vercel-forwarded-for": "198.51.100.44", "x-forwarded-for": `198.51.100.${100 + index}` } }), secret);
			await assert.rejects(consumeOAuthLoginAllowance(second, productionSite, new Request("https://admin.mourn.top/api/auth/github", { headers: { "x-vercel-forwarded-for": "198.51.100.44", "x-forwarded-for": "198.51.100.200" } }), secret), failure("OAUTH_RATE_LIMITED", 429));
			process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
		});
		await t.test("OAuth HTTP starts reject foreign Origin/fetch/frame and preserve ordinary top-level navigation", async () => {
			const app = new Hono<AppEnv>(); app.onError((error) => error instanceof ApiFailure ? error.getResponse() : new Response("Test error", { status: 500 })); registerAuthRoutes(app);
			const countStates = async () => Number((await db.query("SELECT count(*)::int AS count FROM oauth_states WHERE site_id=$1", [site]))[0].count);
			const before = await countStates();
			const foreignRequests: Record<string, string>[] = [{ Origin: "https://untrusted.invalid" }, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }];
			for (const headers of foreignRequests) {
				const response = await app.request("https://admin.mourn.top/api/auth/github", { headers }); assert.equal(response.status, 403);
			}
			assert.equal(await countStates(), before);
			const navigation = await app.request("https://admin.mourn.top/api/auth/github", { headers: { "x-forwarded-for": "198.51.100.23", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
			assert.equal(navigation.status, 302);
			const location = new URL(navigation.headers.get("location")!);
			assert.equal(location.origin, "https://github.com"); assert.equal(location.searchParams.get("redirect_uri"), "https://admin.mourn.top/api/auth/callback");
			assert.match(navigation.headers.get("set-cookie")!, /__Host-admin-oauth=.*HttpOnly/);
			assert.equal(navigation.headers.get("cache-control"), "no-store");
			assert.equal(await countStates(), before + 1);
			assert.equal((await app.request("https://admin.mourn.top/api/auth/github", { headers: { Origin: "https://admin.mourn.top", "x-forwarded-for": "198.51.100.23" } })).status, 302);
			assert.equal(await countStates(), before + 2);
		});
	} finally {
		for (const current of sites) for (const table of ["oauth_states", "sessions", "interaction_rate_limits"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [current]);
		await db.close(); await second.close(); await getDatabase().close();
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});
