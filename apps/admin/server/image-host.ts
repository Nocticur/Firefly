import { ApiFailure } from "./security.js";

export const DEFAULT_IMAGE_BED_URL = "https://image.nocticur.eu.cc";
const MAX_RESPONSE_BYTES = 64 * 1024;

type ImageBedFetch = typeof fetch;
export type ImageBedUploadOptions = {
	baseUrl?: string;
	token?: string;
	fetcher?: ImageBedFetch;
};

function imageBedUrl(baseUrl: string): URL {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.port || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid origin");
		return url;
	} catch {
		throw new ApiFailure(503, "IMG_BED_CONFIGURATION_REQUIRED", "图床地址配置无效");
	}
}

function publicUrl(value: unknown, baseUrl: URL): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value, baseUrl);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

export async function uploadToImageBed(
	bytes: Uint8Array,
	filename: string,
	contentType: string,
	options: ImageBedUploadOptions = {},
): Promise<string> {
	const baseUrl = imageBedUrl(options.baseUrl || process.env.IMGBED_BASE_URL || DEFAULT_IMAGE_BED_URL);
	const token = options.token || process.env.IMGBED_API_TOKEN;
	if (!token) throw new ApiFailure(503, "IMG_BED_CONFIGURATION_REQUIRED", "缺少图床 API Token：IMGBED_API_TOKEN");
	const endpoint = new URL("/upload", baseUrl);
	endpoint.searchParams.set("returnFormat", "full");
	endpoint.searchParams.set("autoRetry", "false");
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
	let response: Response;
	try {
		response = await (options.fetcher || fetch)(endpoint, {
			method: "POST",
			headers: { Authorization: "Bearer " + token },
			body: form,
			signal: AbortSignal.timeout(60_000),
		});
	} catch {
		throw new ApiFailure(502, "IMG_BED_UNAVAILABLE", "图床上传服务暂时不可用");
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new ApiFailure(502, "IMG_BED_UPLOAD_FAILED", "图床上传失败（HTTP " + response.status + "）");
	}
	const text = await response.text();
	if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new ApiFailure(502, "IMG_BED_RESPONSE_INVALID", "图床返回内容过大");
	let payload: unknown;
	try { payload = JSON.parse(text); } catch { throw new ApiFailure(502, "IMG_BED_RESPONSE_INVALID", "图床返回格式无效"); }
	const item = Array.isArray(payload) ? payload[0] : payload;
	const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
	const resolved = publicUrl(record?.publicUrl, baseUrl) || publicUrl(record?.url, baseUrl) || publicUrl(record?.src, baseUrl);
	if (!resolved) throw new ApiFailure(502, "IMG_BED_RESPONSE_INVALID", "图床未返回可访问的图片地址");
	return resolved;
}
