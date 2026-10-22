import test from "node:test";
import assert from "node:assert/strict";
import { storageConfig } from "../server/storage-config.js";
import { createMemoryStore, getStore } from "../server/file-store.js";
import { GitHubError, personalToken } from "../server/github.js";
import { importRepository } from "../server/repository.js";

// These cover the "no database" contract: Cloudflare KV is optional, and a personal
// access token replaces the GitHub App handshake for publishing.
const KV_KEYS = ["VERCEL_ENV", "APP_ENV", "GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_TOKEN", "CF_ACCOUNT_ID", "CF_KV_NAMESPACE_ID", "CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_KV_NAMESPACE_ID", "CLOUDFLARE_API_TOKEN",
	"ADMIN_DEV_CF_ACCOUNT_ID", "ADMIN_DEV_CF_KV_NAMESPACE_ID", "ADMIN_DEV_CF_API_TOKEN", "ADMIN_PREVIEW_CF_ACCOUNT_ID", "ADMIN_PREVIEW_CF_KV_NAMESPACE_ID", "ADMIN_PREVIEW_CF_API_TOKEN"];

async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved = new Map(KV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const key of KV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		return await run();
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

const readFailures: Array<[number, string]> = [
	[401, "令牌无效或已过期"],
	[403, "令牌权限不足"],
	[404, "仓库或分支不存在"],
	[0, "无法连接 api.github.com"],
];

for (const [status, expected] of readFailures) {
	test(`a repository read failure (${status}) explains the actual remedy`, async () => {
		await withEnvironment({ VERCEL_ENV: "development", GITHUB_REPOSITORY: "Nocticur/blog", GITHUB_BRANCH: "master" }, async () => {
			const store = createMemoryStore("Nocticur/blog:development");
			await assert.rejects(
				() => importRepository(store, "Nocticur/blog:development", async () => { throw new GitHubError(status, "failure"); }),
				(error: unknown) => {
					const failure = error as { status?: number; code?: string; message?: string };
					assert.equal(failure.status, 503);
					assert.equal(failure.code, "GITHUB_REPOSITORY_UNAVAILABLE");
					// The message must name the target coordinates and the remedy, not just "failed".
					assert.match(String(failure.message), /Nocticur\/blog@master/);
					assert.match(String(failure.message), new RegExp(expected));
					return true;
				},
			);
		});
	});
}
