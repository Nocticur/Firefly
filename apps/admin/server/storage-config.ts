import { ApiFailure, runtimeEnvironment } from "./security.js";
import {
	normalizeCloudflareConfig,
	type CloudflareKvConfig,
} from "./cloudflare-kv.js";

export type StorageConfig = CloudflareKvConfig;

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
	return readCloudflare(prefix, env);
}

function sameStore(left: StorageConfig, right: StorageConfig): boolean {
	return left.accountId === right.accountId && left.namespaceId === right.namespaceId;
}

/**
 * Cloudflare KV stores private local-image drafts and optional admin state; a
 * partially configured environment is rejected rather than silently falling back.
 */
export function storageConfig(
	env: NodeJS.ProcessEnv = process.env,
): StorageConfig | null {
	const environment = runtimeEnvironment();
	if (environment === "production") return selectConfig("", env) ?? null;
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
