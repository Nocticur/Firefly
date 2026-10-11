import { deleteCookie, getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { AdminApp, AppEnv } from "./types.js";
import type { AdminSession, AdminUser } from "../shared/contracts.js";
import { getDatabase, getSiteId } from "./db.js";
import { ApiFailure, constantTimeEqual, digest, managementOrigin, runtimeEnvironment, productionEnvironment } from "./security.js";
import { ENTRY_COOKIE, registerEntryRoutes, requireEntry } from "./entry.js";
import { csrfForSession, PASSWORD_ADMIN_ID, SESSION_COOKIE } from "./session.js";

export { issueSession, csrfForSession } from "./session.js";

type SessionRow = Record<string, unknown> & { user_data: AdminUser; csrf_hash: string };

export async function authenticateRequest(request: Request, csrfTokenOverride?: string): Promise<AdminSession> {
	const rawCookie = request.headers.get("cookie") || "";
	const encodedToken = rawCookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
	let token: string | undefined;
	try { token = encodedToken ? decodeURIComponent(encodedToken) : undefined; } catch { /* Invalid cookies are not authenticated. */ }
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiFailure(401, "AUTHENTICATION_REQUIRED", "请先输入管理密码登录");
	requireEntry(request);
	const [row] = await getDatabase().query<SessionRow>("SELECT user_data,csrf_hash FROM sessions WHERE site_id=$1 AND token_hash=$2 AND expires_at > now()", [getSiteId(), digest(token)]);
	if (!row || !constantTimeEqual(String(row.user_data?.id), PASSWORD_ADMIN_ID)) throw new ApiFailure(401, "SESSION_EXPIRED", "登录已失效，请重新输入密码");
	const csrfToken = csrfForSession(token);
	if (!constantTimeEqual(row.csrf_hash, digest(csrfToken))) throw new ApiFailure(401, "SESSION_INVALID", "会话校验失败");
	const session: AdminSession = { user: row.user_data, csrfToken, environment: runtimeEnvironment(), productionPublish: productionEnvironment() };
	if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
		const origin = request.headers.get("origin");
		const csrf = csrfTokenOverride || request.headers.get("x-csrf-token");
		if (!origin || !constantTimeEqual(origin, managementOrigin()) || !csrf || !constantTimeEqual(csrf, csrfToken)) throw new ApiFailure(403, "CSRF_REJECTED", "写入请求的来源或 CSRF 令牌不合法");
	}
	return session;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (context, next) => {
	if (!context.get("session")) {
		const session = await authenticateRequest(context.req.raw);
		context.set("user", session.user);
		context.set("session", session);
	}
	context.header("Cache-Control", "no-store");
	await next();
};

export function registerAuthRoutes(app: AdminApp) {
	registerEntryRoutes(app);
	const currentSession = (context: Context<AppEnv>) => context.json({ data: context.get("session") });
	app.get("/api/auth/session", requireAdmin, currentSession);
	app.get("/api/session", requireAdmin, currentSession);
	app.post("/api/auth/logout", requireAdmin, async (context) => {
		const token = getCookie(context, SESSION_COOKIE);
		if (token) await getDatabase().query("DELETE FROM sessions WHERE site_id=$1 AND token_hash=$2", [getSiteId(), digest(token)]);
		const options = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, maxAge: 0 };
		deleteCookie(context, SESSION_COOKIE, options);
		deleteCookie(context, ENTRY_COOKIE, options);
		deleteCookie(context, "__Host-admin-oauth", options);
		return context.json({ data: { loggedOut: true } });
	});
}
