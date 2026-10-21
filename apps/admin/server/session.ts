import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminUser } from "../shared/contracts.js";
import { digest, ApiFailure } from "./security.js";

export const SESSION_COOKIE = "__Host-admin-session";
export const SESSION_SECONDS = 12 * 60 * 60;
export const PASSWORD_ADMIN_ID = "password-admin";
const administrator: AdminUser = { id: PASSWORD_ADMIN_ID, login: "Nocticur", name: "Nocticur", avatarUrl: "" };

/**
 * Stateless sessions: no session table, so no database is required to stay logged in.
 * The key is resolved once per process; re-reading the environment on every call would
 * let a mid-process configuration change invalidate tokens signed moments earlier.
 */
let cachedKey: string | undefined;
function signingKey(): string {
	if (cachedKey) return cachedKey;
	const secret = process.env.ADMIN_SESSION_SECRET?.trim();
	if (secret && secret.length >= 32) return (cachedKey = secret);
	const password = process.env.ADMIN_ENTRY_PASSWORD?.trim();
	if (password) return (cachedKey = digest(`firefly-admin-session:${password}`));
	// No configuration: stay stable per process so tokens survive within one deployment.
	return (cachedKey = digest(`firefly-admin-session:ephemeral:${process.pid}`));
}

function sign(token: string): string {
	return createHmac("sha256", signingKey()).update(token).digest("base64url");
}

export function csrfForSession(token: string): string {
	return digest(`firefly-admin-csrf:${token}`);
}

export type VerifiedSession = { user: AdminUser; csrfToken: string; expiresAt: number };

/** Internal only: the login route calls this after verifying ADMIN_ENTRY_PASSWORD. */
export function issueSession(): { token: string; csrfToken: string } {
	const expiresAt = Date.now() + SESSION_SECONDS * 1000;
	const payload = Buffer.from(JSON.stringify({ exp: expiresAt, nonce: randomBytes(9).toString("base64url") }), "utf8").toString("base64url");
	const token = `${payload}.${sign(payload)}`;
	return { token, csrfToken: csrfForSession(token) };
}

export function verifySessionToken(token: string): VerifiedSession {
	const parts = token.split(".");
	if (parts.length !== 2) throw new ApiFailure(401, "SESSION_INVALID", "会话校验失败");
	const [payload, signature] = parts;
	const expected = sign(payload);
	const a = Buffer.from(signature, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiFailure(401, "SESSION_INVALID", "会话校验失败");
	let claims: { exp?: unknown };
	try {
		claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
	} catch {
		throw new ApiFailure(401, "SESSION_INVALID", "会话校验失败");
	}
	const expiresAt = Number(claims?.exp);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new ApiFailure(401, "SESSION_EXPIRED", "登录已失效，请重新输入密码");
	return { user: administrator, csrfToken: csrfForSession(token), expiresAt };
}
