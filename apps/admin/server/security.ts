import { timingSafeEqual, createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RuntimeEnvironment } from "../shared/contracts.js";

export class ApiFailure extends HTTPException {
	readonly code: string;
	readonly details?: unknown;
	constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
		super(status, { message, res: new Response(JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) });
		this.code = code;
		this.details = details;
	}
}

export function runtimeEnvironment(): RuntimeEnvironment {
	const value = process.env.APP_ENV || process.env.VERCEL_ENV || "development";
	if (value !== "production" && value !== "preview" && value !== "development") throw new ApiFailure(503, "CONFIGURATION_REQUIRED", "APP_ENV 必须明确为 development、preview 或 production");
	if (process.env.VERCEL_ENV && value !== process.env.VERCEL_ENV) throw new ApiFailure(503, "ENVIRONMENT_MISMATCH", "APP_ENV 与 Vercel 环境不一致");
	return value;
}
export function productionEnvironment(): boolean { return runtimeEnvironment() === "production" && process.env.APP_ENV === "production" && process.env.VERCEL_ENV === "production" && process.env.ENABLE_PRODUCTION_PUBLISH === "true"; }
export function requireProduction(): void {
	if (!productionEnvironment()) throw new ApiFailure(403, "PRODUCTION_PERMISSION_REQUIRED", "开发及预览环境没有生产发布权限");
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function constantTimeEqual(left: string, right: string): boolean {
	return timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));
}
export function managementOrigin(): string {
	const environment = runtimeEnvironment();
	if (environment === "production") {
		if (process.env.ADMIN_ORIGIN && process.env.ADMIN_ORIGIN !== "https://admin.mourn.top") throw new ApiFailure(503, "CONFIGURATION_REQUIRED", "生产 ADMIN_ORIGIN 必须是 https://admin.mourn.top");
		return "https://admin.mourn.top";
	}
	const origin = environment === "preview" ? process.env.ADMIN_PREVIEW_ORIGIN : process.env.ADMIN_DEV_ORIGIN || "http://localhost:3000";
	if (!origin) throw new ApiFailure(503, "CONFIGURATION_REQUIRED", "缺少 ADMIN_PREVIEW_ORIGIN");
	const parsed = new URL(origin);
	if (parsed.origin !== origin || (environment === "preview" && parsed.protocol !== "https:") || (environment === "development" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new ApiFailure(503, "CONFIGURATION_REQUIRED", "管理域名配置不合法");
	return origin;
}
export async function readJson(request: Request, limit = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
	if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiFailure(415, "JSON_REQUIRED", "请求必须使用 application/json");
	const declared = Number(request.headers.get("content-length") || 0);
	if (declared > limit) throw new ApiFailure(413, "REQUEST_TOO_LARGE", "请求过大");
	const text = await request.text();
	if (Buffer.byteLength(text, "utf8") > limit) throw new ApiFailure(413, "REQUEST_TOO_LARGE", "请求过大");
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new ApiFailure(400, "INVALID_JSON", "JSON 格式不合法"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure(400, "INVALID_BODY", "请求体必须为对象");
	return value as Record<string, unknown>;
}
export function expectedRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ApiFailure(400, "REVISION_REQUIRED", "必须提供有效的 expectedRevision");
	return value;
}
