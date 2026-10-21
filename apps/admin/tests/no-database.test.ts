import test from "node:test";
import assert from "node:assert/strict";
import { storageConfig } from "../server/storage-config.js";
import { getStore } from "../server/file-store.js";
import { personalToken } from "../server/github.js";

// These cover the "no database" contract: Cloudflare KV is optional, and a personal
// access token replaces the GitHub App handshake for publishing.
const KV_KEYS = ["VERCEL_ENV", "APP_ENV", "GITHUB_REPOSITORY", "CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_KV_NAMESPACE_ID", "CLOUDFLARE_API_TOKEN",
	"ADMIN_DEV_CF_ACCOUNT_ID", "ADMIN_DEV_CF_KV_NAMESPACE_ID", "ADMIN_DEV_CF_API_TOKEN", "ADMIN_PREVIEW_CF_ACCOUNT_ID", "ADMIN_PREVIEW_CF_KV_NAMESPACE_ID", "ADMIN_PREVIEW_CF_API_TOKEN"];

function withEnvironment<T>(values: Record<string, string | undefined>, run: () => T): T {
	const saved = new Map(KV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of KV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		return run();
	} finally {
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
}

test("an unconfigured deployment needs no key-value store at all", () => {
	withEnvironment({ VERCEL_ENV: "production" }, () => {
		assert.equal(storageConfig({} as NodeJS.ProcessEnv), null);
		// A partially configured store is still rejected instead of silently changing backends.
		assert.throws(() => storageConfig({ CF_ACCOUNT_ID: "a".repeat(32) } as NodeJS.ProcessEnv), (error: unknown) => (error as { code?: string }).code === "KV_CONFIGURATION_REQUIRED");
	});
});

test("a personal access token authenticates publishing without GitHub App credentials", () => {
	withEnvironment({}, () => {
		assert.equal(personalToken({} as NodeJS.ProcessEnv), undefined);
		assert.equal(personalToken({ GITHUB_TOKEN: "  " } as NodeJS.ProcessEnv), undefined);
		assert.equal(personalToken({ GITHUB_TOKEN: "github_pat_example" } as NodeJS.ProcessEnv), "github_pat_example");
	});
});

test("the unconfigured store survives across calls instead of dropping every write", () => {
	withEnvironment({ VERCEL_ENV: "development", GITHUB_REPOSITORY: "Nocticur/blog" }, () => {
		const first = getStore();
		const second = getStore();
		// A fresh store per call would lose drafts the moment the request ended.
		assert.equal(first, second);
	});
});
