import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "./db.js";
import { ApiFailure, runtimeEnvironment } from "./security.js";

function loginClientAddress(request: Request): string {
	const forwarded = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : runtimeEnvironment() === "development" ? request.headers.get("x-forwarded-for") || "127.0.0.1" : null;
	const address = forwarded?.split(",")[0]?.trim();
	if (!address || !isIP(address)) throw new ApiFailure(503, "LOGIN_CLIENT_UNVERIFIED", "无法验证登录请求来源，请检查受信代理配置");
	return address;
}

/** Persistent password login quotas; never store the client IP. */
export async function consumeLoginAllowance(database: Database, siteId: string, request: Request, secret: string, namespace: "entry"): Promise<void> {
	const subject = `${namespace}:ip:${createHmac("sha256", secret).update(`${siteId}\0${loginClientAddress(request)}`).digest("hex")}`;
	const globalSubject = `${namespace}:global`;
	const allowed = await database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${siteId}:${namespace}-login-rate`]);
		await tx.query("DELETE FROM oauth_states WHERE site_id=$1 AND expires_at<=now()", [siteId]);
		await tx.query("DELETE FROM sessions WHERE site_id=$1 AND expires_at<=now()", [siteId]);
		await tx.query("DELETE FROM interaction_rate_limits WHERE site_id=$1 AND subject LIKE $2 AND window_start<now()-interval '20 minutes'", [siteId, `${namespace}:%`]);
		const counters = await tx.query<Record<string, unknown> & { subject: string; hits: number }>("SELECT subject,hits FROM interaction_rate_limits WHERE site_id=$1 AND subject IN ($2,$3) AND window_start=to_timestamp(floor(extract(epoch FROM now())/600)*600)", [siteId, subject, globalSubject]);
		if (counters.some((row) => Number(row.hits) >= (row.subject === globalSubject ? 100 : 5))) return false;
		// Check the global quota before allocating a row for a new IP.
		await tx.query("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,$2,to_timestamp(floor(extract(epoch FROM now())/600)*600),1),($1,$3,to_timestamp(floor(extract(epoch FROM now())/600)*600),1) ON CONFLICT(site_id,subject,window_start) DO UPDATE SET hits=interaction_rate_limits.hits+1", [siteId, subject, globalSubject]);
		return true;
	});
	if (!allowed) throw new ApiFailure(429, "ENTRY_RATE_LIMITED", "尝试次数过多，请稍后再试");
}
