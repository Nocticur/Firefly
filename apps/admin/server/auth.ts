import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { AdminApp, AppEnv } from "./types.js";
import type { AdminSession, AdminUser } from "../shared/contracts.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, constantTimeEqual, digest, managementOrigin, runtimeEnvironment, productionEnvironment } from "./security.js";

const SESSION_COOKIE = "__Host-admin-session";
const OAUTH_COOKIE = "__Host-admin-oauth";
const CALLBACK = "https://admin.mourn.top/api/auth/callback";
const SESSION_SECONDS = 12 * 60 * 60;

type SessionRow = Record<string, unknown> & { user_data: AdminUser; csrf_hash: string };
export function adminGithubId(): string {
	const id = process.env.ADMIN_GITHUB_USER_ID;
	if (!id || !/^[1-9]\d*$/.test(id)) throw new ApiFailure(503, "ADMIN_ID_CONFIGURATION_REQUIRED", "请配置管理员的 GitHub 数字用户 ID：ADMIN_GITHUB_USER_ID");
	return id;
}
export function csrfForSession(token: string): string { return digest(`firefly-admin-csrf:${token}`); }

/** Used only after verified OAuth. No HTTP route can create a session without GitHub identity verification. */
export async function issueSession(database: Database, siteId: string, user: AdminUser): Promise<{ token: string; csrfToken: string }> {
	if (!constantTimeEqual(user.id, adminGithubId())) throw new ApiFailure(403, "ADMIN_ACCESS_DENIED", "此 GitHub 账号没有管理权限");
	const token = randomBytes(32).toString("base64url");
	const csrfToken = csrfForSession(token);
	await database.query("INSERT INTO sessions(site_id,token_hash,user_data,csrf_hash,expires_at) VALUES($1,$2,$3::jsonb,$4,now()+($5::text || ' seconds')::interval)", [siteId, digest(token), JSON.stringify(user), digest(csrfToken), SESSION_SECONDS]);
	return { token, csrfToken };
}

export async function authenticateRequest(request: Request, csrfTokenOverride?: string): Promise<AdminSession> {
	const configuredId = adminGithubId();
	const rawCookie = request.headers.get("cookie") || "";
	const encodedToken = rawCookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
	let token: string | undefined;
	try { token = encodedToken ? decodeURIComponent(encodedToken) : undefined; } catch { /* Invalid cookies are not authenticated. */ }
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiFailure(401, "AUTHENTICATION_REQUIRED", "请先通过 GitHub 登录");
	const [row] = await getDatabase().query<SessionRow>("SELECT user_data,csrf_hash FROM sessions WHERE site_id=$1 AND token_hash=$2 AND expires_at > now()", [getSiteId(), digest(token)]);
	if (!row || !constantTimeEqual(String(row.user_data.id), configuredId)) throw new ApiFailure(401, "SESSION_EXPIRED", "登录已失效，请重新登录");
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

function cookieOptions(maxAge: number) {
	return { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, maxAge };
}
function oauthConfiguration() {
	adminGithubId();
	const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
	const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new ApiFailure(503, "GITHUB_OAUTH_CONFIGURATION_REQUIRED", "缺少 GITHUB_OAUTH_CLIENT_ID 或 GITHUB_OAUTH_CLIENT_SECRET；OAuth 回调须为 https://admin.mourn.top/api/auth/callback");
	return { clientId, clientSecret };
}
function requireCanonicalOAuthRequest(context: Context<AppEnv>) {
	if (new URL(context.req.url).origin !== "https://admin.mourn.top") throw new ApiFailure(403, "OAUTH_ORIGIN_REQUIRED", "GitHub 登录只能在固定管理域名 https://admin.mourn.top 上进行");
}
async function githubRequest(url: string, init: RequestInit): Promise<Response> {
	try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
	catch { throw new ApiFailure(503, "GITHUB_UNAVAILABLE", "GitHub 认证服务暂时不可用"); }
}

export function registerAuthRoutes(app: AdminApp) {
	app.get("/api/auth/github", async (context) => {
		requireCanonicalOAuthRequest(context);
		const { clientId } = oauthConfiguration();
		const state = randomBytes(32).toString("base64url");
		const nonce = randomBytes(32).toString("base64url");
		await getDatabase().query("INSERT INTO oauth_states(site_id,state_hash,cookie_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [getSiteId(), digest(state), digest(nonce)]);
		setCookie(context, OAUTH_COOKIE, nonce, cookieOptions(600));
		context.header("Cache-Control", "no-store");
		const url = new URL("https://github.com/login/oauth/authorize");
		url.searchParams.set("client_id", clientId);
		url.searchParams.set("redirect_uri", CALLBACK);
		url.searchParams.set("state", state);
		url.searchParams.set("scope", "read:user");
		return context.redirect(url.toString());
	});
	app.get("/api/auth/callback", async (context) => {
		requireCanonicalOAuthRequest(context);
		const { clientId, clientSecret } = oauthConfiguration();
		const state = context.req.query("state");
		const code = context.req.query("code");
		const nonce = getCookie(context, OAUTH_COOKIE);
		deleteCookie(context, OAUTH_COOKIE, cookieOptions(0));
		if (!state || !code || !nonce || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ApiFailure(400, "OAUTH_STATE_INVALID", "OAuth 状态不合法或已过期");
		const rows = await getDatabase().query("DELETE FROM oauth_states WHERE site_id=$1 AND state_hash=$2 AND cookie_hash=$3 AND expires_at>now() RETURNING state_hash", [getSiteId(), digest(state), digest(nonce)]);
		if (rows.length !== 1) throw new ApiFailure(400, "OAUTH_STATE_INVALID", "OAuth 状态不合法或已过期");
		const response = await githubRequest("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: CALLBACK }) });
		if (!response.ok) throw new ApiFailure(502, "OAUTH_TOKEN_FAILED", "GitHub 授权失败");
		const tokenBody = await response.json() as { access_token?: string; error?: string };
		if (!tokenBody.access_token || tokenBody.error) throw new ApiFailure(401, "OAUTH_TOKEN_FAILED", "GitHub 授权失败，请重试登录");
		const identity = await githubRequest("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Nocticur-Firefly-Admin" } });
		if (!identity.ok) throw new ApiFailure(502, "OAUTH_IDENTITY_FAILED", "无法校验 GitHub 身份");
		const profile = await identity.json() as { id?: number; login?: string; name?: string; avatar_url?: string };
		if (!Number.isSafeInteger(profile.id) || !profile.login) throw new ApiFailure(502, "OAUTH_IDENTITY_FAILED", "GitHub 返回无效身份");
		const user: AdminUser = { id: String(profile.id), login: profile.login, name: profile.name || profile.login, avatarUrl: profile.avatar_url || "" };
		const session = await issueSession(getDatabase(), getSiteId(), user);
		setCookie(context, SESSION_COOKIE, session.token, cookieOptions(SESSION_SECONDS));
		context.header("Cache-Control", "no-store");
		return context.redirect("/");
	});
	const currentSession = (context: Context<AppEnv>) => context.json({ data: context.get("session") });
	app.get("/api/auth/session", requireAdmin, currentSession);
	app.get("/api/session", requireAdmin, currentSession);
	app.post("/api/auth/logout", requireAdmin, async (context) => {
		const token = getCookie(context, SESSION_COOKIE);
		if (token) await getDatabase().query("DELETE FROM sessions WHERE site_id=$1 AND token_hash=$2", [getSiteId(), digest(token)]);
		deleteCookie(context, SESSION_COOKIE, cookieOptions(0));
		return context.json({ data: { loggedOut: true } });
	});
}
