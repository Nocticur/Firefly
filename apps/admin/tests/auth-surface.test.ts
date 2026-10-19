import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../server/index.js";
import { openApiDocument } from "../server/openapi.js";

test("every documented private API rejects anonymous and forged credentials before reading data", async (t) => {
	const variables = ["APP_ENV", "VERCEL_ENV", "ADMIN_ENTRY_PASSWORD", "ADMIN_DEV_ORIGIN"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV;
	process.env.ADMIN_ENTRY_PASSWORD = "testOnly42";
	process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
	let checked = 0;
	try {
		for (const [path, methods] of Object.entries(openApiDocument.paths)) for (const [method, operation] of Object.entries(methods)) {
			const security = (operation as { security?: Record<string, string[]>[] }).security;
			if (!security?.some((scheme) => Object.hasOwn(scheme, "session"))) continue;
			checked++;
			await t.test(`${method.toUpperCase()} ${path}`, async () => {
				const route = path.replace(/\{[^}]+\}/g, "00000000-0000-4000-8000-000000000001");
				for (const forged of [false, true]) {
					const headers: Record<string, string> = { Origin: "http://localhost:3000", "Content-Type": "application/json" };
					if (forged) Object.assign(headers, { Cookie: `__Host-admin-session=${"A".repeat(43)}; __Host-admin-entry=forged`, Authorization: "Bearer forged", "x-csrf-token": "forged", "x-admin-user": "password-admin" });
					const response = await app.request(`http://localhost:3000${route}`, { method: method.toUpperCase(), headers, ...(["get", "head", "options"].includes(method) ? {} : { body: "{}" }) });
					assert.equal(response.status, 401);
					assert.equal(response.headers.get("cache-control"), "no-store");
					const body = await response.json();
					assert.ok(body.error); assert.equal("data" in body, false);
				}
			});
		}
		assert.ok(checked >= 35, "The entire private surface must be exercised");
		await t.test("the session alias cannot bypass authentication", async () => {
			assert.equal((await app.request("http://localhost:3000/api/session")).status, 401);
		});
		await t.test("public metadata exposes neither a password nor its server-side verifier", async () => {
			const response = await app.request("http://localhost:3000/api/auth/entry");
			assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: { verified: false } });
			const spec = await (await app.request("http://localhost:3000/api/openapi.json")).text();
			assert.equal(spec.includes("testOnly42"), false); assert.equal(spec.includes("scrypt-v1$"), false);
		});
	} finally {
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});
