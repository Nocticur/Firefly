import { ApiFailure, runtimeEnvironment } from "./security.js";
import { normalizeKvConfig, type KvConfig } from "./kv.js";
import {
	normalizeCloudflareConfig,
	type CloudflareKvConfig,
} from "./cloudflare-kv.js";

export type StorageConfig =
	| ({ provider: "upstash" } & KvConfig)
	| CloudflareKvConfig;

function readUpstash(
	prefix: string,
	env: NodeJS.ProcessEnv,
): StorageConfig | undefined {
	const url =
		env[`${prefix}KV_REST_API_URL`] ||
		env[`${prefix}UPSTASH_REDIS_REST_URL`];
	const token =
		env[`${prefix}KV_REST_API_TOKEN`] ||
		env[`${prefix}UPSTASH_REDIS_REST_TOKEN`];
	if (!url && !token) return undefined;
	if (!url || !token)
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			`缺少 ${prefix}KV_REST_API_URL 或 ${prefix}KV_REST_API_TOKEN`,
		);
	return { provider: "upstash", ...normalizeKvConfig(url, token) };
}

function readCloudflare(
	prefix: string,
	env: NodeJS.ProcessEnv,
): StorageConfig | undefined {
	const accountId =
		env[`${prefix}CF_ACCOUNT_ID`] ||
		env[`${prefix}CLOUDFLARE_ACCOUNT_ID`];
	const namespaceId =
		env[`${prefix}CF_KV_NAMESPACE_ID`] ||
		env[`${prefix}CLOUDFLARE_KV_NAMESPACE_ID`];
	const token =
		env[`${prefix}CF_API_TOKEN`] ||
		env[`${prefix}CLOUDFLARE_API_TOKEN`];
	if (!accountId && !namespaceId && !token) return undefined;
	if (!accountId || !namespaceId || !token)
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			`缺少 ${prefix}CF_ACCOUNT_ID、${prefix}CF_KV_NAMESPACE_ID 或 ${prefix}CF_API_TOKEN`,
		);
	return normalizeCloudflareConfig(accountId, namespaceId, token);
}

function selectConfig(
	prefix: string,
	env: NodeJS.ProcessEnv,
): StorageConfig | undefined {
	const explicit = env.KV_PROVIDER?.trim().toLowerCase();
	if (explicit && explicit !== "cloudflare" && explicit !== "upstash")
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			"KV_PROVIDER 只能是 cloudflare 或 upstash",
		);
	if (explicit === "cloudflare") return readCloudflare(prefix, env);
	if (explicit === "upstash") return readUpstash(prefix, env);
	// Prefer Cloudflare when both are configured; KV_PROVIDER disambiguates.
	return readCloudflare(prefix, env) || readUpstash(prefix, env);
}

function sameStore(left: StorageConfig, right: StorageConfig): boolean {
	if (left.provider !== right.provider) return false;
	if (left.provider === "upstash" && right.provider === "upstash")
		return left.url === right.url || left.token === right.token;
	if (left.provider === "cloudflare" && right.provider === "cloudflare")
		return (
			(left.accountId === right.accountId &&
				left.namespaceId === right.namespaceId) ||
			left.token === right.token
		);
	return false;
}

/**
 * Production always needs KV. Development and preview use their own optional KV
 * and fall back to an in-memory store, which keeps them isolated and ephemeral.
 */
export function storageConfig(
	env: NodeJS.ProcessEnv = process.env,
): StorageConfig | null {
	const environment = runtimeEnvironment();
	if (environment === "production") {
		const config = selectConfig("", env);
		if (!config)
			throw new ApiFailure(
				503,
				"KV_CONFIGURATION_REQUIRED",
				"缺少 Cloudflare KV（CF_ACCOUNT_ID/CF_KV_NAMESPACE_ID/CF_API_TOKEN）或 Upstash（KV_REST_API_URL/TOKEN），后台无法保存私有状态",
			);
		return config;
	}
	const prefix = environment === "preview" ? "ADMIN_PREVIEW_" : "ADMIN_DEV_";
	const scoped = selectConfig(prefix, env);
	if (!scoped) return null;
	const production = selectConfig("", env);
	if (production && sameStore(production, scoped))
		throw new ApiFailure(
			503,
			"KV_ENVIRONMENT_NOT_ISOLATED",
			"开发及预览 KV 必须与生产隔离",
		);
	return scoped;
}
