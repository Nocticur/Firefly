import { ApiFailure, runtimeEnvironment } from "./security.js";
import { normalizeKvConfig, type KvConfig } from "./kv.js";

function readKv(prefix: string, env: NodeJS.ProcessEnv): KvConfig | undefined {
	const url = env[`${prefix}KV_REST_API_URL`] || env[`${prefix}UPSTASH_REDIS_REST_URL`];
	const token = env[`${prefix}KV_REST_API_TOKEN`] || env[`${prefix}UPSTASH_REDIS_REST_TOKEN`];
	if (!url && !token) return undefined;
	if (!url || !token)
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			`缺少 ${prefix}KV_REST_API_URL 或 ${prefix}KV_REST_API_TOKEN`,
		);
	return normalizeKvConfig(url, token);
}

/**
 * Production always needs KV. Development and preview use their own optional KV
 * and fall back to an in-memory store, which keeps them isolated and ephemeral.
 */
export function kvConfig(env: NodeJS.ProcessEnv = process.env): KvConfig | null {
	const environment = runtimeEnvironment();
	if (environment === "production") {
		const config = readKv("", env);
		if (!config)
			throw new ApiFailure(
				503,
				"KV_CONFIGURATION_REQUIRED",
				"缺少 KV_REST_API_URL/TOKEN，后台无法保存私有状态",
			);
		return config;
	}
	const prefix = environment === "preview" ? "ADMIN_PREVIEW_" : "ADMIN_DEV_";
	const scoped = readKv(prefix, env);
	if (!scoped) return null;
	const production = readKv("", env);
	if (
		production &&
		(production.url === scoped.url || production.token === scoped.token)
	)
		throw new ApiFailure(
			503,
			"KV_ENVIRONMENT_NOT_ISOLATED",
			"开发及预览 KV 必须与生产隔离",
		);
	return scoped;
}
