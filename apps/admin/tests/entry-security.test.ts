import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_COOKIE, ENTRY_SECONDS, entryVerified, issueEntryToken, requireEntry } from "../server/entry.js";
import { ApiFailure } from "../server/security.js";

test("entry credentials expire, reject forgery and bind password, site and environment", async (t) => {
	const variables = ["ADMIN_ENTRY_PASSWORD", "APP_ENV", "VERCEL_ENV", "GITHUB_REPOSITORY", "ADMIN_DEV_ORIGIN", "ADMIN_PREVIEW_ORIGIN"] as const;
	const previous = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
	process.env.ADMIN_ENTRY_PASSWORD = "synthetic-entry-password-only-for-tests";
	process.env.APP_ENV = "development"; delete process.env.VERCEL_ENV;
	process.env.GITHUB_REPOSITORY = "tests/entry-security";
	process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
	const now = 1_800_000_000_000;
	const token = issueEntryToken(now);
	const request = (value?: string) => new Request("http://localhost:3000/api/auth/session", { headers: value === undefined ? {} : { cookie: `${ENTRY_COOKIE}=${value}` } });
	try {
		await t.test("a valid opaque credential lasts 12 hours and never contains the password", () => {
			assert.equal(entryVerified(request(token), now), true);
			assert.equal(entryVerified(request(token), now + ENTRY_SECONDS * 1000 - 1000), true);
			assert.equal(entryVerified(request(token), now + ENTRY_SECONDS * 1000), false);
			assert.equal(token.includes(process.env.ADMIN_ENTRY_PASSWORD!), false);
			assert.notEqual(issueEntryToken(now), token);
		});
		await t.test("missing, truncated, malformed and modified signatures fail closed", () => {
			for (const value of [undefined, "", "%zz", "x".repeat(500), token.slice(0, -1), token.replace(/.$/, token.endsWith("a") ? "b" : "a"), token.replace("v1.", "v2.")]) assert.equal(entryVerified(request(value), now), false);
			assert.throws(() => requireEntry(request()), (error: unknown) => error instanceof ApiFailure && error.status === 401 && error.code === "ENTRY_PASSWORD_REQUIRED");
		});
		await t.test("an attacker cannot extend signed expiry and implausible future tokens are rejected", () => {
			const parts = token.split("."); parts[1] = String(Number(parts[1]) + 300);
			assert.equal(entryVerified(request(parts.join(".")), now), false);
			assert.equal(entryVerified(request(issueEntryToken(now + 90_000)), now), false);
			assert.equal(entryVerified(request(issueEntryToken(now + 1000)), now), true, "tolerate minor clock skew between platform instances");
		});
		await t.test("password rotation invalidates existing credentials", () => {
			const original = process.env.ADMIN_ENTRY_PASSWORD;
			process.env.ADMIN_ENTRY_PASSWORD = "different-test-only-password-after-rotation";
			assert.equal(entryVerified(request(token), now), false);
			assert.equal(entryVerified(request(issueEntryToken(now)), now), true);
			process.env.ADMIN_ENTRY_PASSWORD = original;
		});
		await t.test("site, origin and environment changes reject cross-environment reuse", () => {
			process.env.GITHUB_REPOSITORY = "tests/another-site";
			assert.equal(entryVerified(request(token), now), false);
			process.env.GITHUB_REPOSITORY = "tests/entry-security";
			process.env.ADMIN_DEV_ORIGIN = "http://localhost:5173";
			assert.equal(entryVerified(request(token), now), false);
			process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
			process.env.APP_ENV = "preview"; process.env.ADMIN_PREVIEW_ORIGIN = "https://preview.example";
			assert.equal(entryVerified(request(token), now), false);
			process.env.APP_ENV = "development";
		});
		await t.test("unconfigured and weak passwords keep the entry closed", () => {
			for (const value of [undefined, "", "too-short", " ".repeat(16), "界".repeat(86)]) {
				if (value === undefined) delete process.env.ADMIN_ENTRY_PASSWORD; else process.env.ADMIN_ENTRY_PASSWORD = value;
				assert.throws(() => issueEntryToken(now), (error: unknown) => error instanceof ApiFailure && error.status === 503 && error.code === "ENTRY_CONFIGURATION_REQUIRED");
			}
		});
	} finally {
		for (const key of variables) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
	}
});
