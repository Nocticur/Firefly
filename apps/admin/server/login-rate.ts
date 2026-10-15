import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { assertSite, collection, type FileStore } from "./file-store.js";
import { ApiFailure, runtimeEnvironment } from "./security.js";

function loginClientAddress(request: Request): string {
	const forwarded = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : runtimeEnvironment() === "development" ? request.headers.get("x-forwarded-for") || "127.0.0.1" : null;
	const address = forwarded?.split(",")[0]?.trim();
	if (!address || !isIP(address)) throw new ApiFailure(503, "LOGIN_CLIENT_UNVERIFIED", "无法验证登录请求来源，请检查受信代理配置");
	return address;
}

/** Persistent password login quotas; never store the client IP. */
export async function consumeLoginAllowance(store: FileStore, siteId: string, request: Request, secret: string, namespace: "entry"): Promise<void> {
	const subject = `${namespace}:ip:${createHmac("sha256", secret).update(`${siteId}\0${loginClientAddress(request)}`).digest("hex")}`;
	const globalSubject = `${namespace}:global`;
	const now = Date.now(); const window = Math.floor(now / 600_000) * 600_000;
	const allowed = await store.update((state) => {
		assertSite(state, siteId);
		for (const kind of ["sessions", "oauth_states"]) for (const [id, row] of Object.entries(collection(state, kind))) if (new Date(String(row.expires_at)).getTime() <= now) delete collection(state, kind)[id];
		const limits = collection(state, "interaction_rate_limits");
		for (const [id, row] of Object.entries(limits)) if (String(row.subject).startsWith(`${namespace}:`) && Number(row.window_start) < now - 1_200_000) delete limits[id];
		if ([subject, globalSubject].some(key => Number(limits[`${key}:${window}`]?.hits ?? 0) >= (key === globalSubject ? 100 : 5))) return false;
		for (const key of [subject, globalSubject]) { const id = `${key}:${window}`; limits[id] = { subject: key, window_start: window, hits: Number(limits[id]?.hits ?? 0) + 1 }; }
		return true;
	});
	if (!allowed) throw new ApiFailure(429, "ENTRY_RATE_LIMITED", "尝试次数过多，请稍后再试");
}
