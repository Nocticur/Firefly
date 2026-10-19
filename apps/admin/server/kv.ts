import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { ApiFailure } from "./security.js";
import type { DocumentBackend } from "./file-store.js";

export type KvConfig = { url: string; token: string };

/** Upstash rejects larger requests; keep the encoded document comfortably below that. */
export const MAX_KV_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_UPSTREAM_RESPONSE_BYTES = 12 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20_000;

type KvResponse = { result?: unknown; error?: unknown };

function normalizeUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new ApiFailure(503, "KV_CONFIGURATION_REQUIRED", "KV_REST_API_URL 无效");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
		throw new ApiFailure(503, "KV_CONFIGURATION_REQUIRED", "KV_REST_API_URL 必须是无路径的 HTTPS 地址");
	return url.origin;
}

export function normalizeKvConfig(url: string, token: string): KvConfig {
	if (!token || token.length > 4096) throw new ApiFailure(503, "KV_CONFIGURATION_REQUIRED", "KV_REST_API_TOKEN 无效");
	return { url: normalizeUrl(url), token };
}

/** Low-level Upstash REST command. Never log the token or full upstream body. */
export async function kvCommand<T>(config: KvConfig, command: unknown[]): Promise<T> {
	let response: Response;
	try {
		response = await fetch(config.url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${config.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(command),
			signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
		});
	} catch {
		throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储暂时不可用");
	}
	const text = await response.text().catch(() => "");
	if (Buffer.byteLength(text) > MAX_UPSTREAM_RESPONSE_BYTES)
		throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储返回内容过大");
	let payload: KvResponse;
	try {
		payload = JSON.parse(text) as KvResponse;
	} catch {
		throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储返回格式无效");
	}
	if (!response.ok || payload.error !== undefined) {
		// Provider error strings can contain key names but never credentials.
		throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储请求失败");
	}
	return payload.result as T;
}

export function stateKeys(site: string): { meta: string; data: string } {
	const digest = createHash("sha256").update(site).digest("hex");
	return {
		meta: `admin-state:${digest}:meta`,
		data: `admin-state:${digest}:data`,
	};
}

export function encodeState(json: string): string {
	return gzipSync(Buffer.from(json, "utf8"), { level: 9 }).toString("base64");
}

export function decodeState(value: string): string {
	let bytes: Buffer;
	try {
		bytes = gunzipSync(Buffer.from(value, "base64"));
	} catch {
		throw new ApiFailure(503, "FILE_STORE_INVALID", "后台状态文件损坏，已停止写入");
	}
	if (bytes.byteLength > 16 * 1024 * 1024)
		throw new ApiFailure(503, "FILE_STORE_TOO_LARGE", "后台状态文件超出大小限制");
	return bytes.toString("utf8");
}

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1
`;

export function createKvDocumentBackend(config: KvConfig, site: string): DocumentBackend {
	const keys = stateKeys(site);
	return {
		async read() {
			const result = await kvCommand<unknown[]>(config, ["MGET", keys.meta, keys.data]);
			if (!Array.isArray(result) || result.length !== 2)
				throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储返回无效的文档");
			const [etag, data] = result;
			if (data === null || data === undefined) return null;
			if (typeof data !== "string" || (etag !== null && etag !== undefined && typeof etag !== "string"))
				throw new ApiFailure(503, "KV_UNAVAILABLE", "KV 存储返回无效的文档");
			return { json: decodeState(data), etag: typeof etag === "string" ? etag : "" };
		},
		async write(json, expectedEtag) {
			const encoded = encodeState(json);
			if (Buffer.byteLength(encoded, "utf8") > MAX_KV_VALUE_BYTES)
				throw new ApiFailure(507, "FILE_STORE_TOO_LARGE", "后台状态文件压缩后仍超出存储限制");
			const nextEtag = randomUUID();
			const result = await kvCommand<number>(config, [
				"EVAL",
				CAS_SCRIPT,
				"2",
				keys.meta,
				keys.data,
				expectedEtag ?? "",
				nextEtag,
				encoded,
			]);
			return result === 1;
		},
	};
}

export type KvBackupProvider = {
	put(key: string, bytes: Buffer): Promise<void>;
	get(key: string): Promise<Buffer | null>;
	delete(key: string): Promise<void>;
};

function encodeBytes(bytes: Uint8Array): string {
	return gzipSync(bytes, { level: 9 }).toString("base64");
}

function decodeBytes(value: string): Buffer {
	return gunzipSync(Buffer.from(value, "base64"));
}

export function createKvBackupProvider(config: KvConfig): KvBackupProvider {
	function validateKey(key: string): void {
		if (!/^admin-backup:[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/.test(key))
			throw new Error("Invalid backup key");
	}
	async function get(key: string): Promise<Buffer | null> {
		validateKey(key);
		const value = await kvCommand<string | null>(config, ["GET", key]);
		if (value === null || value === undefined) return null;
		if (typeof value !== "string") throw new Error("Invalid backup value");
		try {
			return decodeBytes(value);
		} catch {
			throw new Error("Backup value is corrupt");
		}
	}
	return {
		async put(key, bytes) {
			validateKey(key);
			const encoded = encodeBytes(bytes);
			if (Buffer.byteLength(encoded, "utf8") > MAX_KV_VALUE_BYTES)
				throw new ApiFailure(507, "FILE_STORE_TOO_LARGE", "备份文件超出存储限制");
			const created = await kvCommand<string | null>(config, ["SET", key, encoded, "NX"]);
			if (created === "OK") return;
			const existing = await get(key);
			if (!existing || !existing.equals(bytes)) throw new Error("Immutable backup contains different bytes");
		},
		get,
		async delete(key) {
			validateKey(key);
			await kvCommand<number>(config, ["DEL", key]);
		},
	};
}
