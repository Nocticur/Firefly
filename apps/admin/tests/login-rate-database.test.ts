import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import { registerAuthRoutes } from "../server/auth.js";
import { createDatabase, getDatabase, getSiteId, type Database } from "../server/db.js";
import { ApiFailure } from "../server/security.js";
import { consumeLoginAllowance } from "../server/login-rate.js";
import { entryCookie } from "./entry-fixture.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const secret = "isolated-test-only-rate-secret";
const consumePasswordLoginAllowance = (...args: [Database, string, Request, string]) => consumeLoginAllowance(...args, "entry");
const failure = (code: string, status: number) => (error: unknown) => error instanceof ApiFailure && error.code === code && error.status === status;
const loginRequest = (address: string) => new Request("https://blog.mourn.top/api/auth/entry", { headers: { "x-forwarded-for": address } });

test("Password login counters persist, serialize concurrent requests and clean expired authentication data", { skip: !databaseUrl }, async (t) => {
	const variables = ["APP_ENV", "VERCEL_ENV", "VERCEL", "ADMIN_DEVELOPMENT_DATABASE_URL", "ADMIN_ENTRY_PASSWORD", "GITHUB_REPOSITORY"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
	process.env.ADMIN_DEVELOPMENT_DATABASE_URL = databaseUrl;
	process.env.GITHUB_REPOSITORY = `tests/login-${randomUUID()}`;
	process.env.ADMIN_ENTRY_PASSWORD = "rateOnly42";
	const db = createDatabase(databaseUrl!); const second = createDatabase(databaseUrl!);
	const site = getSiteId(); const globalSite = `${site}-global`; const productionSite = `${site}-proxy`;
	const sites = [site, globalSite, productionSite];
	try {
		for (const name of ["001-core.sql", "003-interactions.sql"]) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
		await t.test("expired states/sessions and old password buckets are removed, preserving live and unrelated rows", async () => {
			await db.query("INSERT INTO oauth_states(site_id,state_hash,cookie_hash,expires_at) VALUES($1,'expired','nonce',now()-interval '1 second'),($1,'live','nonce',now()+interval '10 minutes')", [site]);
			await db.query("INSERT INTO sessions(site_id,token_hash,user_data,csrf_hash,expires_at) VALUES($1,'expired','{}','csrf',now()-interval '1 second'),($1,'live','{}','csrf',now()+interval '12 hours')", [site]);
			await db.query("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,'entry:old',now()-interval '1 hour',1),($1,'comments:retained',now()-interval '1 hour',1)", [site]);
			await consumePasswordLoginAllowance(db, site, loginRequest("198.51.100.1"), secret);
			assert.deepEqual((await db.query("SELECT state_hash FROM oauth_states WHERE site_id=$1 ORDER BY state_hash", [site])).map((row) => row.state_hash), ["live"]);
			assert.deepEqual((await db.query("SELECT token_hash FROM sessions WHERE site_id=$1 ORDER BY token_hash", [site])).map((row) => row.token_hash), ["live"]);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject='entry:old'", [site])).length, 0);
			assert.equal((await db.query("SELECT subject FROM interaction_rate_limits WHERE site_id=$1 AND subject='comments:retained'", [site])).length, 1);
		});
		await t.test("one IP cannot exceed five logins across concurrent independent connections", async () => {
			const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => consumePasswordLoginAllowance(index % 2 ? db : second, site, loginRequest("198.51.100.1"), secret)));
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
			for (const result of results) if (result.status === "rejected") assert.ok(failure("ENTRY_RATE_LIMITED", 429)(result.reason));
			const [global] = await db.query("SELECT hits FROM interaction_rate_limits WHERE site_id=$1 AND subject='entry:global'", [site]);
			assert.equal(Number(global.hits), 5);
			const [counter] = await db.query("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE 'entry:ip:%'", [site]);
			assert.equal(Number(counter.hits), 5);
			assert.equal(counter.subject, `entry:ip:${createHmac("sha256", secret).update(`${site}\0${"198.51.100.1"}`).digest("hex")}`);
		});
		await t.test("a global cap rejects new rotating addresses before allocating more IP rows", async () => {
			await db.query("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,'entry:global',to_timestamp(floor(extract(epoch FROM now())/600)*600),99)", [globalSite]);
			const results = await Promise.allSettled([consumePasswordLoginAllowance(db, globalSite, loginRequest("198.51.100.2"), secret), consumePasswordLoginAllowance(second, globalSite, loginRequest("198.51.100.3"), secret)]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			assert.ok(failure("ENTRY_RATE_LIMITED", 429)((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason));
			for (let index = 4; index < 9; index++) await assert.rejects(consumePasswordLoginAllowance(db, globalSite, loginRequest(`198.51.100.${index}`), secret), failure("ENTRY_RATE_LIMITED", 429));
			const counters = await db.query("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1", [globalSite]);
			assert.equal(counters.length, 2);
			assert.equal(Number(counters.find((row) => row.subject === "entry:global")?.hits), 100);
		});
		await t.test("production requires the Vercel proxy and ignores spoofed generic forwarding headers", async () => {
			process.env.APP_ENV = "production"; process.env.VERCEL_ENV = "production";
			await assert.rejects(consumePasswordLoginAllowance(db, productionSite, loginRequest("198.51.100.44"), secret), failure("LOGIN_CLIENT_UNVERIFIED", 503));
			process.env.VERCEL = "1";
			for (let index = 0; index < 5; index++) await consumePasswordLoginAllowance(db, productionSite, new Request("https://blog.mourn.top/api/auth/entry", { headers: { "x-vercel-forwarded-for": "198.51.100.44", "x-forwarded-for": `198.51.100.${100 + index}` } }), secret);
			await assert.rejects(consumePasswordLoginAllowance(second, productionSite, new Request("https://blog.mourn.top/api/auth/entry", { headers: { "x-vercel-forwarded-for": "198.51.100.44", "x-forwarded-for": "198.51.100.200" } }), secret), failure("ENTRY_RATE_LIMITED", 429));
			process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV; delete process.env.VERCEL;
		});
		await t.test("obsolete OAuth URLs never launch a provider or allocate login state", async () => {
			const app = new Hono<AppEnv>(); app.onError((error) => error instanceof ApiFailure ? error.getResponse() : new Response("Test error", { status: 500 })); registerAuthRoutes(app);
			const cookie = entryCookie();
			const countStates = async () => Number((await db.query("SELECT count(*)::int AS count FROM oauth_states WHERE site_id=$1", [site]))[0].count);
			const before = await countStates();
			for (const path of ["/api/auth/github", "/api/auth/callback?code=untrusted&state=untrusted"]) {
				const response = await app.request(`https://blog.mourn.top${path}`, { headers: { Cookie: cookie, Origin: "https://blog.mourn.top" } });
				assert.equal(response.status, 404); assert.equal(response.headers.has("location"), false); assert.equal(response.headers.has("set-cookie"), false);
			}
			assert.equal(await countStates(), before);
		});
	} finally {
		for (const current of sites) for (const table of ["oauth_states", "sessions", "interaction_rate_limits"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [current]);
		await db.close(); await second.close(); await getDatabase().close();
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});
