import test from "node:test";
import assert from "node:assert/strict";
import { ApiFailure, managementOrigin } from "../server/security.js";
import { openApiDocument } from "../server/openapi.js";

const invalidConfiguration = (error: unknown) => error instanceof ApiFailure && error.status === 503 && error.code === "CONFIGURATION_REQUIRED";

test("management stays on the blog origin while preview and development keep explicit isolation", async (t) => {
	const variables = ["APP_ENV", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "ADMIN_ORIGIN", "ADMIN_PREVIEW_ORIGIN", "ADMIN_DEV_ORIGIN"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.APP_ENV = "production";
	process.env.VERCEL_ENV = "production";
	delete process.env.ADMIN_ORIGIN;
	try {
		await t.test("production defaults to the same origin as the deployed blog", () => {
			assert.equal(managementOrigin(), "https://blog.mourn.top");
		});
		await t.test("production follows the current Vercel project origin when available", () => {
			process.env.VERCEL_PROJECT_PRODUCTION_URL = "firefly-five-smoky.vercel.app";
			assert.equal(managementOrigin(), "https://firefly-five-smoky.vercel.app");
			delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
			process.env.VERCEL_URL = "firefly-deployment.vercel.app";
			assert.equal(managementOrigin(), "https://firefly-deployment.vercel.app");
			delete process.env.VERCEL_URL;
		});
		await t.test("legacy ADMIN_ORIGIN no longer overrides the project origin", () => {
			process.env.ADMIN_ORIGIN = "https://admin.mourn.top";
			assert.equal(managementOrigin(), "https://blog.mourn.top");
			delete process.env.ADMIN_ORIGIN;
		});
		await t.test("preview requires one exact HTTPS deployment origin", () => {
			process.env.APP_ENV = "preview"; process.env.VERCEL_ENV = "preview";
			delete process.env.ADMIN_PREVIEW_ORIGIN;
			assert.throws(managementOrigin, invalidConfiguration);
			for (const origin of ["http://preview.example", "https://preview.example/", "https://preview.example/admin/"]) {
				process.env.ADMIN_PREVIEW_ORIGIN = origin;
				assert.throws(managementOrigin, invalidConfiguration);
			}
			process.env.ADMIN_PREVIEW_ORIGIN = "https://firefly-preview.vercel.app";
			assert.equal(managementOrigin(), process.env.ADMIN_PREVIEW_ORIGIN);
		});
		await t.test("development accepts loopback origins and rejects remote hosts or URL paths", () => {
			process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV;
			delete process.env.ADMIN_DEV_ORIGIN;
			assert.equal(managementOrigin(), "http://localhost:3000");
			for (const origin of ["http://localhost:3000", "http://127.0.0.1:4321", "http://[::1]:4321"]) {
				process.env.ADMIN_DEV_ORIGIN = origin;
				assert.equal(managementOrigin(), origin);
			}
			for (const origin of ["http://remote.example:3000", "http://localhost:3000/", "http://localhost:3000/admin/"]) {
				process.env.ADMIN_DEV_ORIGIN = origin;
				assert.throws(managementOrigin, invalidConfiguration);
			}
		});
	} finally {
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});

test("OpenAPI calls the API on the same origin in production and preview", () => {
	assert.deepEqual(openApiDocument.servers, [{ url: "/" }]);
});
