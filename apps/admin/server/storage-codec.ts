import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { ApiFailure } from "./security.js";

export const MAX_KV_VALUE_BYTES = 8 * 1024 * 1024;

export function stateKey(site: string): string {
	const digest = createHash("sha256").update(site).digest("hex");
	return `admin-state:${digest}:data`;
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

export function encodeBackup(bytes: Uint8Array): string {
	return gzipSync(bytes, { level: 9 }).toString("base64");
}

export function decodeBackup(value: string): Buffer {
	try {
		return gunzipSync(Buffer.from(value, "base64"));
	} catch {
		throw new Error("Backup value is corrupt");
	}
}
