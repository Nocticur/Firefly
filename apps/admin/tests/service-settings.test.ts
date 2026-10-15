import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createMemoryStore, collection } from "../server/file-store.js";
import { ApiFailure } from "../server/security.js";
import { registerSettingsRoutes } from "../server/settings.js";
import type { AppEnv } from "../server/types.js";
import { readServiceSettings, saveServiceSettings, serviceEnabled, validateServiceSettings } from "../server/service-settings.js";

const off = { publish: false, maintenance: false };
const failure = (code: string) => (error: unknown) => error instanceof ApiFailure && error.code === code;

test("new private files default services off even when legacy environment flags exist", async () => {
	const previous = process.env.ENABLE_PRODUCTION_PUBLISH;
	process.env.ENABLE_PRODUCTION_PUBLISH = "true";
	try { assert.deepEqual(await readServiceSettings(createMemoryStore("tests/new:production"), "tests/new:production"), { data: off, revision: 0 }); }
	finally { if (previous === undefined) delete process.env.ENABLE_PRODUCTION_PUBLISH; else process.env.ENABLE_PRODUCTION_PUBLISH = previous; }
});

test("service settings accept only explicit booleans and cannot store secrets", () => {
	assert.deepEqual(validateServiceSettings(off), off);
	for (const value of [null, [], {}, { ...off, publish: "true" }, { ...off, email: true }, { ...off, VERCEL_TOKEN: "secret" }]) assert.throws(() => validateServiceSettings(value), ApiFailure);
});

test("legacy email switches are ignored without rewriting existing private state", async () => {
	const site = "tests/legacy-services:production";
	const store = createMemoryStore(site);
	const legacy = { ...off, email: true };
	await store.update(state => { collection(state, "entities")["service_settings:default"] = { id: "default", kind: "service_settings", data: legacy, revision: 4 }; });
	assert.deepEqual(await readServiceSettings(store, site), { data: off, revision: 4 });
	assert.deepEqual(collection(await store.read(), "entities")["service_settings:default"].data, legacy);
});

test("service updates are atomic, reject stale revisions, and isolate sites", async () => {
	const site = "tests/services:development"; const store = createMemoryStore(site);
	const results = await Promise.allSettled([saveServiceSettings(store, site, off, 0), saveServiceSettings(store, site, off, 0)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.ok(results.some(result => result.status === "rejected" && failure("REVISION_CONFLICT")(result.reason)));
	assert.deepEqual(await readServiceSettings(store, site), { data: off, revision: 1 });
	await assert.rejects(saveServiceSettings(store, site, off, 0), failure("REVISION_CONFLICT"));
	await assert.rejects(readServiceSettings(store, "tests/other:development"), failure("STORE_SITE_MISMATCH"));
	assert.deepEqual(await saveServiceSettings(store, site, off, 1), { data: off, revision: 2 });
});

test("preview and development reject production enablement before touching storage", async () => {
	const previous = { APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
	let reads = 0; const site = "tests/services:production"; const memory = createMemoryStore(site);
	await memory.update(state => { collection(state, "entities")["service_settings:default"] = { id: "default", kind: "service_settings", data: { ...off, publish: true }, revision: 1 }; });
	const store = { ...memory, async read() { reads++; return memory.read(); } };
	try {
		delete process.env.APP_ENV;
		for (const env of ["preview", "development"]) {
			process.env.VERCEL_ENV = env;
			assert.equal(await serviceEnabled("publish", store, site), false);
			await assert.rejects(saveServiceSettings(store, site, { ...off, publish: true }, 1), failure("PRODUCTION_PERMISSION_REQUIRED"));
		}
		assert.equal(reads, 0);
		process.env.VERCEL_ENV = "production";
		assert.equal(await serviceEnabled("publish", store, site), true);
		assert.equal(await serviceEnabled("maintenance", store, site), false);
		assert.equal(reads, 2);
	} finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("service settings HTTP reads and writes require an authenticated administrator", async () => {
	const app = new Hono<AppEnv>(); registerSettingsRoutes(app);
	app.onError(error => error instanceof ApiFailure ? error.getResponse() : new Response(null, { status: 500 }));
	for (const method of ["GET", "PUT"]) assert.equal((await app.request("https://blog.mourn.top/api/service-settings", { method })).status, 401);
});
