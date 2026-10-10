import type { ApiResponse } from "../../shared/contracts";

let csrfToken = "";
export function configureSession(token: string) { csrfToken = token; }
export function sessionToken() { return csrfToken; }
export class RequestError extends Error {
	constructor(public code: string, message: string, public status: number, public details?: unknown) { super(message); }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
	const headers = new Headers(init.headers);
	if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
	if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) headers.set("X-CSRF-Token", csrfToken);
	const response = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin", cache: "no-store" });
	const body = await response.json().catch(() => null);
	if (!response.ok) throw new RequestError(body?.error?.code ?? "HTTP_ERROR", body?.error?.message ?? `请求失败 (${response.status})`, response.status, body?.error?.details);
	if (!body || !("data" in body)) throw new RequestError("INVALID_RESPONSE", "服务端未返回有效数据，请检查 API 部署。", response.status);
	return body as ApiResponse<T>;
}
export function write<T>(path: string, body: unknown = {}, method = "POST") { return request<T>(path, { method, body: JSON.stringify(body) }); }
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
export function stringify(value: unknown) { return JSON.stringify(value, null, 2); }
export function timestamp(value: string | null | undefined) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(date); }
