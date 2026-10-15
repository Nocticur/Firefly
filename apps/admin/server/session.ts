import { randomBytes } from "node:crypto";
import type { AdminUser } from "../shared/contracts.js";
import { assertSite, collection, type FileStore } from "./file-store.js";
import { digest } from "./security.js";

export const SESSION_COOKIE = "__Host-admin-session";
export const SESSION_SECONDS = 12 * 60 * 60;
export const PASSWORD_ADMIN_ID = "password-admin";
const administrator: AdminUser = { id: PASSWORD_ADMIN_ID, login: "Nocticur", name: "Nocticur", avatarUrl: "" };

export function csrfForSession(token: string): string { return digest(`firefly-admin-csrf:${token}`); }

/** Internal only: the login route calls this after verifying ADMIN_ENTRY_PASSWORD. */
export async function issueSession(store: FileStore, siteId: string, previousToken?: string): Promise<{ token: string; csrfToken: string }> {
	const token = randomBytes(32).toString("base64url");
	const csrfToken = csrfForSession(token);
	await store.update((state) => {
		assertSite(state, siteId);
		const sessions = collection(state, "sessions");
		const now = Date.now();
		for (const [key, row] of Object.entries(sessions)) if (new Date(String(row.expires_at)).getTime() <= now) delete sessions[key];
		sessions[digest(token)] = { site_id: siteId, token_hash: digest(token), user_data: administrator, csrf_hash: digest(csrfToken), expires_at: new Date(now + SESSION_SECONDS * 1000).toISOString() };
		// Replace the browser's prior session atomically; never keep a fixed login token.
		if (previousToken && /^[A-Za-z0-9_-]{43}$/.test(previousToken)) delete sessions[digest(previousToken)];
	});
	return { token, csrfToken };
}
