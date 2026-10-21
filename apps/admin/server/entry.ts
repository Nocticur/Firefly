import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { AdminApp } from "./types.js";
import { getStore, getSiteId, type FileStore } from "./file-store.js";
import { consumeLoginAllowance } from "./login-rate.js";
import { ApiFailure, constantTimeEqual, managementOrigin, readJson } from "./security.js";
import { issueSession, SESSION_COOKIE, SESSION_SECONDS } from "./session.js";
import { isAdminPassword } from "../shared/password-policy.js";
import { createPasswordHash, PASSWORD_SCRYPT_OPTIONS, verifyPassword } from "./password.js";

export const ENTRY_COOKIE = "__Host-admin-entry";
export const ENTRY_SECONDS = 12 * 60 * 60;
const cookieOptions = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const };
const cachePepper = randomBytes(32);
let cached: { fingerprint: string; scope: string; key: Buffer; passwordHash: string } | undefined;

function configuration() {
	const password = process.env.ADMIN_ENTRY_PASSWORD;
	if (!isAdminPassword(password)) throw new ApiFailure(503, "ENTRY_CONFIGURATION_REQUIRED", "后台入口暂未启用，请联系站点管理员");
	const scope = `firefly-admin-entry:v1:${getSiteId()}:${managementOrigin()}`;
	const fingerprint = createHmac("sha256", cachePepper).update(`${scope}\0${password}`).digest("hex");
	if (!cached || cached.fingerprint !== fingerprint || cached.scope !== scope) {
		// A slow KDF also protects the signing key against offline guessing of a captured Cookie.
		// Keep only derived values in the cache; a random verifier salt must not change the cross-instance Cookie key.
		cached = { fingerprint, scope, key: scryptSync(password, scope, 32, PASSWORD_SCRYPT_OPTIONS), passwordHash: createPasswordHash(password) };
	}
	return cached;
}

function signature(payload: string, config: ReturnType<typeof configuration>): string {
	return createHmac("sha256", config.key).update(`${config.scope}\0${payload}`).digest("base64url");
}

/** Called only after server-side password verification; no public route exposes this token. */
export function issueEntryToken(now = Date.now()): string {
	const config = configuration();
	const payload = `v1.${Math.floor(now / 1000) + ENTRY_SECONDS}.${randomBytes(32).toString("base64url")}`;
	return `${payload}.${signature(payload, config)}`;
}

export function entryVerified(request: Request, now = Date.now()): boolean {
	const config = configuration();
	const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ENTRY_COOKIE}=`))?.slice(ENTRY_COOKIE.length + 1);
	if (!token || token.length > 160) return false;
	const match = /^(v1\.(\d{10})\.[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token);
	if (!match) return false;
	const expiresAt = Number(match[2]);
	const current = Math.floor(now / 1000);
	return expiresAt > current && expiresAt <= current + ENTRY_SECONDS + 60 && constantTimeEqual(match[3], signature(match[1], config));
}

export function requireEntry(request: Request): void {
	if (!entryVerified(request)) throw new ApiFailure(401, "ENTRY_PASSWORD_REQUIRED", "请先输入管理密码");
}

export function registerEntryRoutes(app: AdminApp, suppliedStore?: FileStore) {
	app.get("/api/auth/entry", (context) => {
		context.header("Cache-Control", "no-store");
		return context.json({ data: { verified: entryVerified(context.req.raw) } });
	});
	app.post("/api/auth/entry", async (context) => {
		context.header("Cache-Control", "no-store");
		const config = configuration();
		if (context.req.header("Origin") !== managementOrigin() || context.req.header("Sec-Fetch-Site") === "cross-site") throw new ApiFailure(403, "ENTRY_ORIGIN_REJECTED", "请从管理页面提交密码");
		const body = await readJson(context.req.raw, 1024);
		if (!isAdminPassword(body.password)) throw new ApiFailure(400, "ENTRY_PASSWORD_INVALID", "密码须为 3～10 个字符");
		const store = suppliedStore || getStore();
		await consumeLoginAllowance(store, getSiteId(), context.req.raw, config.key.toString("hex"), "entry");
		if (!await verifyPassword(body.password, config.passwordHash)) {
			throw new ApiFailure(401, "ENTRY_PASSWORD_INCORRECT", "密码不正确，请重新输入");
		}
		const entryToken = issueEntryToken();
		const session = issueSession();
		setCookie(context, ENTRY_COOKIE, entryToken, { ...cookieOptions, maxAge: ENTRY_SECONDS });
		setCookie(context, SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: SESSION_SECONDS });
		return context.json({ data: { verified: true } });
	});
}
