import { createHash } from "node:crypto";
import { ApiFailure } from "./security.js";
import {
	MAX_KV_VALUE_BYTES,
	coldStateKey,
	mediaBlobKey,
	decodeBackup,
	decodeState,
	encodeBackup,
	encodeState,
	stateKey,
} from "./storage-codec.js";
import type { DocumentBackend } from "./file-store.js";

export type CloudflareKvConfig = {
	provider: "cloudflare";
	accountId: string;
	namespaceId: string;
	token: string;
};

const MAX_CF_RESPONSE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 4;

type CfResponse = {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: unknown;
	result?: unknown;
};

const accountPattern = /^[a-f0-9]{32}$/i;
const namespacePattern = /^[a-f0-9]{32}$/i;

export function normalizeCloudflareConfig(
	accountId: string,
	namespaceId: string,
	token: string,
): CloudflareKvConfig {
	const account = accountId.trim();
	const namespace = namespaceId.trim();
	if (!accountPattern.test(account))
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			"CF_ACCOUNT_ID 必须是 Cloudflare 账户 ID（32 位十六进制）",
		);
	if (!namespacePattern.test(namespace))
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			"CF_KV_NAMESPACE_ID 必须是 Cloudflare KV 命名空间 ID（32 位十六进制）",
		);
	const apiToken = token.trim();
	if (!apiToken || apiToken.length > 4096)
		throw new ApiFailure(503, "KV_CONFIGURATION_REQUIRED", "CF_API_TOKEN 无效");
	return { provider: "cloudflare", accountId: account, namespaceId: namespace, token: apiToken };
}

function valueUrl(config: CloudflareKvConfig, key: string): string {
	return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/storage/kv/namespaces/${encodeURIComponent(config.namespaceId)}/values/${encodeURIComponent(key)}`;
}

function replayableError(status: number): boolean {
	return status === 429 || status >= 500;
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(
	config: CloudflareKvConfig,
	key: string,
	init: RequestInit,
	allowMissing = false,
): Promise<{ response: Response; text: string; missing: boolean }> {
	let lastStatus = 0;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		let response: Response;
		try {
			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${config.token}`);
			response = await fetch(valueUrl(config, key), {
				...init,
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new ApiFailure(503, "KV_UNAVAILABLE", "Cloudflare KV 暂时不可用");
		}
		lastStatus = response.status;
		if (allowMissing && response.status === 404) {
			await response.body?.cancel().catch(() => {});
			return { response, text: "", missing: true };
		}
		if (response.ok) {
			const text = await response.text().catch(() => "");
			if (Buffer.byteLength(text) > MAX_CF_RESPONSE_BYTES) {
				await response.body?.cancel().catch(() => {});
				throw new ApiFailure(503, "KV_UNAVAILABLE", "Cloudflare KV 返回内容过大");
			}
			if (text) {
				try {
					const payload = JSON.parse(text) as CfResponse;
					if (payload.success === false) {
						const message = payload.errors?.[0]?.message || "请求被拒绝";
						throw new ApiFailure(
							503,
							"KV_UNAVAILABLE",
							`Cloudflare KV 请求失败：${message}`,
						);
					}
				} catch (error) {
					if (error instanceof ApiFailure) throw error;
					// GET returns the raw value, not an API envelope.
				}
			}
			return { response, text, missing: false };
		}
		await response.body?.cancel().catch(() => {});
		if (!replayableError(response.status) || attempt === MAX_RETRIES) break;
		// Cloudflare KV allows one write per key per second; 429 is expected
		// during login when rate-limit and session writes happen together.
		const retryAfter = Number(response.headers.get("retry-after"));
		const delay = Number.isFinite(retryAfter) && retryAfter > 0
			? Math.min(5_000, retryAfter * 1_000)
			: 1_200 * (attempt + 1);
		await wait(delay);
	}
	throw new ApiFailure(
		503,
		"KV_UNAVAILABLE",
		`Cloudflare KV 请求失败（HTTP ${lastStatus}）；请检查 CF_API_TOKEN 是否具有 Workers KV Storage:Edit 权限`,
	);
}

async function readValue(config: CloudflareKvConfig, key: string): Promise<string | null> {
	const { text, missing } = await request(config, key, { method: "GET" }, true);
	return missing ? null : text;
}

async function writeValue(
	config: CloudflareKvConfig,
	key: string,
	value: string,
): Promise<void> {
	if (Buffer.byteLength(value, "utf8") > MAX_KV_VALUE_BYTES)
		throw new ApiFailure(507, "FILE_STORE_TOO_LARGE", "Cloudflare KV 值超出存储限制");
	await request(config, key, {
		method: "PUT",
		headers: { "Content-Type": "text/plain; charset=utf-8" },
		body: value,
	});
}

async function deleteValue(config: CloudflareKvConfig, key: string): Promise<void> {
	await request(config, key, { method: "DELETE" }, true);
}

export function createCloudflareKvDocumentBackend(
	config: CloudflareKvConfig,
	site: string,
): DocumentBackend {
	const key = stateKey(site);
	const coldKey = coldStateKey(site);
	async function readDocument(at: string) {
		const raw = await readValue(config, at);
		if (raw === null) return null;
		return { json: decodeState(raw), etag: createHash("sha256").update(raw).digest("hex") };
	}
	async function writeDocument(at: string, json: string, expectedEtag: string | null): Promise<boolean> {
		const current = await readValue(config, at);
		const currentEtag = current === null
			? ""
			: createHash("sha256").update(current).digest("hex");
		if (currentEtag !== (expectedEtag ?? "")) return false;
		await writeValue(config, at, encodeState(json));
		return true;
	}
	return {
		async readMediaBlob(id) {
			const value = await readValue(config, mediaBlobKey(site, id));
			if (value === null) return null;
			try { return Buffer.from(value, "base64"); }
			catch { throw new ApiFailure(503, "FILE_STORE_INVALID", "私有图片草稿损坏，已停止读取"); }
		},
		async writeMediaBlob(id, bytes) {
			await writeValue(config, mediaBlobKey(site, id), Buffer.from(bytes).toString("base64"));
		},
		async deleteMediaBlob(id) { await deleteValue(config, mediaBlobKey(site, id)); },
		read: () => readDocument(key),
		write: (json, expectedEtag) => writeDocument(key, json, expectedEtag),
		readCold: () => readDocument(coldKey),
		writeCold: (json, expectedEtag) => writeDocument(coldKey, json, expectedEtag),
	};
}

export type CloudflareKvBackupProvider = {
	put(key: string, bytes: Buffer): Promise<void>;
	get(key: string): Promise<Buffer | null>;
	delete(key: string): Promise<void>;
};

export function createCloudflareKvBackupProvider(
	config: CloudflareKvConfig,
): CloudflareKvBackupProvider {
	function validateKey(key: string): void {
		if (!/^admin-backup:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/.test(key))
			throw new Error("Invalid backup key");
	}
	async function get(key: string): Promise<Buffer | null> {
		validateKey(key);
		const value = await readValue(config, key);
		if (value === null) return null;
		try {
			return decodeBackup(value);
		} catch {
			throw new Error("Backup value is corrupt");
		}
	}
	return {
		async put(key, bytes) {
			validateKey(key);
			const existing = await get(key);
			if (existing) {
				if (!existing.equals(bytes)) throw new Error("Immutable backup contains different bytes");
				return;
			}
			await writeValue(config, key, encodeBackup(bytes));
		},
		get,
		async delete(key) {
			validateKey(key);
			await deleteValue(config, key);
		},
	};
}
