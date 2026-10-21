import { deleteCookie, getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { AdminApp, AppEnv } from "./types.js";
import type { AdminSession, AdminUser } from "../shared/contracts.js";
import { assertSite, collection, getStore, getSiteId, type FileStore } from "./file-store.js";
import { ApiFailure, constantTimeEqual, digest, managementOrigin, runtimeEnvironment } from "./security.js";
import { serviceEnabled } from "./service-settings.js";
import { ENTRY_COOKIE, registerEntryRoutes, requireEntry } from "./entry.js";
import { csrfForSession, PASSWORD_ADMIN_ID, SESSION_COOKIE, verifySessionToken } from "./session.js";

export { issueSession, csrfForSession } from "./session.js";

type SessionRow = Record<string, unknown> & { user_data: AdminUser; csrf_hash: string };

export async function authenticateRequest(request: Request, csrfTokenOverride?: string, suppliedStore?: FileStore): Promise<AdminSession> {
	const rawCookie = request.headers.get("cookie") || "";
	const encodedToken = rawCookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
	let token: string | undefined;
	try { token = encodedToken ? decodeURIComponent(encodedToken) : undefined; } catch { /* Invalid cookies are not authenticated. */ }
	if (!token) throw new ApiFailure(401, "AUTHENTICATION_REQUIRED", "请先输入管理密码登录");
	requireEntry(request);
	// Stateless: the signed cookie carries the session, so no store read is needed here.
	const verified = verifySessionToken(token);
	const csrfToken = verified.csrfToken;
	if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
		const origin = request.headers.get("origin");
		const csrf = csrfTokenOverride || request.headers.get("x-csrf-token");
		if (!origin || !constantTimeEqual(origin, managementOrigin()) || !csrf || !constantTimeEqual(csrf, csrfToken)) throw new ApiFailure(403, "CSRF_REJECTED", "写入请求的来源或 CSRF 令牌不合法");
	}
	return { user: verified.user, csrfToken, environment: runtimeEnvironment(), productionPublish: await serviceEnabled("publish", suppliedStore || getStore(), getSiteId()) };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (context, next) => {
	if (!context.get("session")) {
		const session = await authenticateRequest(context.req.raw, undefined, context.get("store"));
		context.set("user", session.user);
		context.set("session", session);
	}
	context.header("Cache-Control", "no-store");
	await next();
};

export function registerAuthRoutes(app: AdminApp, suppliedStore?: FileStore) {
	if (suppliedStore) app.use("/api/*", async (context, next) => { context.set("store", suppliedStore); await next(); });
	registerEntryRoutes(app, suppliedStore);
	const currentSession = (context: Context<AppEnv>) => context.json({ data: context.get("session") });
	app.get("/api/auth/session", requireAdmin, currentSession);
	app.get("/api/session", requireAdmin, currentSession);
	app.post("/api/auth/logout", requireAdmin, async (context) => {
		// Stateless sessions are discarded by clearing the cookie; nothing to delete server-side.
		const options = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, maxAge: 0 };
		deleteCookie(context, SESSION_COOKIE, options);
		deleteCookie(context, ENTRY_COOKIE, options);
		deleteCookie(context, "__Host-admin-oauth", options);
		return context.json({ data: { loggedOut: true } });
	});
}
