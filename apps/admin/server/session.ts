import { randomBytes } from "node:crypto";
import type { AdminUser } from "../shared/contracts.js";
import type { Database } from "./db.js";
import { digest } from "./security.js";

export const SESSION_COOKIE = "__Host-admin-session";
export const SESSION_SECONDS = 12 * 60 * 60;
export const PASSWORD_ADMIN_ID = "password-admin";
const administrator: AdminUser = { id: PASSWORD_ADMIN_ID, login: "Nocticur", name: "Nocticur", avatarUrl: "" };

export function csrfForSession(token: string): string { return digest(`firefly-admin-csrf:${token}`); }

/** Internal only: the login route calls this after verifying ADMIN_ENTRY_PASSWORD. */
export async function issueSession(database: Database, siteId: string, previousToken?: string): Promise<{ token: string; csrfToken: string }> {
	const token = randomBytes(32).toString("base64url");
	const csrfToken = csrfForSession(token);
	await database.transaction(async (tx) => {
		await tx.query("INSERT INTO sessions(site_id,token_hash,user_data,csrf_hash,expires_at) VALUES($1,$2,$3::jsonb,$4,now()+($5::text || ' seconds')::interval)", [siteId, digest(token), JSON.stringify(administrator), digest(csrfToken), SESSION_SECONDS]);
		// Replace the browser's prior session atomically; never keep a fixed login token.
		if (previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken)) await tx.query("DELETE FROM sessions WHERE site_id=$1 AND token_hash=$2", [siteId, digest(previousToken)]);
	});
	return { token, csrfToken };
}
