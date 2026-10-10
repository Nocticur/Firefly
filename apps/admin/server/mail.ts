import { createHash, randomUUID } from "node:crypto";
import { Resend } from "resend";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { requireAdmin } from "./auth.js";
import { ApiFailure, readJson } from "./security.js";
import type { AdminApp } from "./types.js";

export type MailRow = Record<string, unknown> & { id: string; notification_key: string; recipient: string; subject: string; text_body: string; status: string; provider_id: string | null; attempts: number; first_attempt_at: Date | null; next_attempt_at: Date; created_at: Date; };
type ProviderResult<T> = { data?: T | null; error?: { name: string; statusCode?: number | null } | null };
type MailTags = Record<string, string> | Array<{ name: string; value: string }>;
type ProviderEmail = { id: string; to: string[]; subject: string; tags?: MailTags; last_event?: string };
export type MailWebhookEvent = { type: string; data: unknown };
export interface MailProvider {
	emails: {
		send(input: { from: string; to: string; subject: string; text: string; tags: Array<{ name: string; value: string }> }, options: { idempotencyKey: string }): Promise<ProviderResult<{ id: string }>>;
		list(options: { limit: number; after?: string }): Promise<ProviderResult<{ data: ProviderEmail[]; has_more?: boolean }>>;
		get(id: string): Promise<ProviderResult<ProviderEmail>>;
	};
	webhooks?: { verify(input: { payload: string; headers: { id: string; timestamp: string; signature: string }; webhookSecret: string }): MailWebhookEvent };
}
export type MailDependencies = { db?: Database; site?: string; provider?: MailProvider; from?: string; now?: () => Date; webhookSecret?: string };
export type MailDeliveryResult = { state: string; retryAfterMs?: number };
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLAIM_WINDOW_MS = 5 * 60 * 1000;
const successfulEvents = new Set(["sent", "delivered", "opened", "clicked"]);
const failedEvents = new Set(["bounced", "complained", "failed", "suppressed", "canceled"]);
const providerFailure = (event: string) => ({ bounced: "邮件退信", complained: "收件人投诉邮件", failed: "邮件服务发送失败", suppressed: "邮件被服务商抑制", canceled: "邮件已取消" } as Record<string, string>)[event] || "邮件服务发送失败";

export function productionMailConfiguration(environment: NodeJS.ProcessEnv = process.env): { key: string; from: string } {
	if (environment.APP_ENV !== "production" || environment.VERCEL_ENV !== "production" || environment.ENABLE_PRODUCTION_EMAIL !== "true") throw new ApiFailure(403, "PRODUCTION_EMAIL_DISABLED", "正式邮件仅允许显式启用的生产环境发送");
	if (!environment.RESEND_API_KEY || !environment.RESEND_FROM) throw new ApiFailure(503, "MAIL_CONFIGURATION_REQUIRED", "缺少 Resend 配置");
	return { key: environment.RESEND_API_KEY, from: environment.RESEND_FROM };
}

function dependencies(options: MailDependencies) {
	// Only direct callers can supply an adapter. HTTP routes always use the production gate.
	const configuration = options.provider ? undefined : productionMailConfiguration();
	return { db: options.db || getDatabase(), site: options.site || getSiteId(), provider: options.provider || new Resend(configuration!.key), from: options.from || configuration?.from || "test-adapter@example.invalid", now: options.now || (() => new Date()) };
}
export function mailIdempotencyKey(id: string, site = getSiteId()): string { return `firefly-${createHash("sha256").update(`${site}:${id}`).digest("hex")}`; }
export async function enqueueMail(tx: Database, notificationKey: string, recipient: string, subject: string, text: string, site = getSiteId()): Promise<string> {
	const rows = await tx.query<{ id: string }>("INSERT INTO mail_outbox(site_id,id,notification_key,recipient,subject,text_body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(site_id,notification_key) DO UPDATE SET notification_key=excluded.notification_key RETURNING id", [site, randomUUID(), notificationKey, recipient, subject, text]);
	return rows[0]!.id;
}
export async function dispatchMailWorkflow(id: string): Promise<void> {
	try {
		const [{ start }, { mailWorkflow }] = await Promise.all([import("workflow/api"), import("../workflows/mail.js")]);
		await start(mailWorkflow, [id]);
	} catch {
		// Transaction already committed; the durable outbox is picked up by daily maintenance.
		await getDatabase().query("UPDATE mail_outbox SET last_error='Workflow dispatch pending; daily maintenance will resume',updated_at=now() WHERE site_id=$1 AND id=$2 AND status='pending'", [getSiteId(), id]);
	}
}

function notificationId(tags: MailTags | undefined): string | undefined {
	if (!tags || typeof tags !== "object") return undefined;
	if (!Array.isArray(tags)) return typeof tags.notification_id === "string" ? tags.notification_id : undefined;
	const matches = tags.filter((tag) => tag?.name === "notification_id");
	return matches.length === 1 && typeof matches[0]?.value === "string" ? matches[0].value : undefined;
}
async function currentRow(db: Database, site: string, id: string) { return (await db.query<MailRow>("SELECT * FROM mail_outbox WHERE site_id=$1 AND id=$2", [site, id]))[0]; }
function deliveryResult(row: MailRow | undefined, now: Date): MailDeliveryResult {
	if (!row) return { state: "missing" };
	return row.status === "pending" ? { state: "pending", retryAfterMs: Math.max(1, new Date(row.next_attempt_at).getTime() - now.getTime()) } : { state: row.status };
}

export async function reconcileMail(id: string, suppliedProviderId?: string, options: MailDependencies = {}): Promise<string> {
	const { db, site, provider, now } = dependencies(options);
	const row = await currentRow(db, site, id);
	if (!row) throw new ApiFailure(404, "MAIL_NOT_FOUND", "邮件记录不存在");
	if (row.status === "sent" || (row.status === "failed" && row.provider_id)) return row.status;
	if (suppliedProviderId && row.provider_id && suppliedProviderId !== row.provider_id) throw new ApiFailure(409, "MAIL_RECONCILIATION_MISMATCH", "服务记录与通知唯一标识不一致");
	const providerIds = suppliedProviderId || row.provider_id ? [suppliedProviderId || row.provider_id!] : [];
	if (!providerIds.length) {
		// Search actual records; missing records never prove that a send did not happen.
		let after: string | undefined;
		for (let page = 0; page < 10; page++) {
			const recent = await provider.emails.list({ limit: 100, ...(after ? { after } : {}) });
			if (recent.error || !recent.data) throw new ApiFailure(502, "MAIL_RECONCILIATION_FAILED", "无法查询邮件服务发送记录");
			for (const email of recent.data.data) if (email.subject === row.subject && email.to.includes(row.recipient)) providerIds.push(email.id);
			const cursor = recent.data.data.at(-1)?.id;
			if (!recent.data.has_more || !cursor || cursor === after) break;
			after = cursor;
		}
	}
	for (const providerId of providerIds) {
		const result = await provider.emails.get(providerId); const email = result.data;
		if (result.error || !email || email.id !== providerId || notificationId(email.tags) !== row.id || !email.to.includes(row.recipient) || email.subject !== row.subject) continue;
		const state = successfulEvents.has(email.last_event || "") ? "sent" : failedEvents.has(email.last_event || "") ? "failed" : "unknown";
		await db.query("UPDATE mail_outbox SET status=$4,provider_id=$3,last_error=$5,updated_at=now() WHERE site_id=$1 AND id=$2 AND (provider_id IS NULL OR provider_id=$3) AND NOT(status='failed' AND provider_id IS NOT NULL) AND (status<>'sent' OR $4='failed')", [site, id, providerId, state, state === "failed" ? providerFailure(email.last_event!) : state === "unknown" ? "服务商已接收；尚未确认发送，禁止重发" : null]);
		return (await currentRow(db, site, id))!.status;
	}
	if (suppliedProviderId) throw new ApiFailure(409, "MAIL_RECONCILIATION_MISMATCH", "服务记录与通知唯一标识不一致");
	// A read that raced a webhook or a new claim must not erase the verified result.
	await db.query("UPDATE mail_outbox SET status='unknown',last_error=$5,updated_at=now() WHERE site_id=$1 AND id=$2 AND status=$3 AND attempts=$4 AND provider_id IS NOT DISTINCT FROM $6 AND status NOT IN ('sent','failed')", [site, id, row.status, row.attempts, row.first_attempt_at && now().getTime() - new Date(row.first_attempt_at).getTime() >= IDEMPOTENCY_WINDOW_MS ? "幂等窗口已过期；需核查提供商记录，禁止自动重发" : "发送结果未知；等待签名回调或提供商记录核验", row.provider_id]);
	return (await currentRow(db, site, id))!.status;
}

export async function deliverMail(id: string, options: MailDependencies = {}): Promise<MailDeliveryResult> {
	const { db, site, provider, from, now } = dependencies(options); const startedAt = now();
	await db.query("UPDATE mail_outbox SET status='unknown',last_error='发送进程中断；先核查发送记录',updated_at=now() WHERE site_id=$1 AND id=$2 AND status='sending' AND (claimed_at IS NULL OR claimed_at<=$3)", [site, id, new Date(startedAt.getTime() - CLAIM_WINDOW_MS)]);
	// Check before claiming: a rate-limited pending job can outlive the provider's key window.
	const expired = await db.query<MailRow>("UPDATE mail_outbox SET status='unknown',last_error='幂等窗口已过期；禁止自动重发',updated_at=now() WHERE site_id=$1 AND id=$2 AND status='pending' AND first_attempt_at<=$3 RETURNING *", [site, id, new Date(startedAt.getTime() - IDEMPOTENCY_WINDOW_MS)]);
	if (expired.length) return { state: "unknown" };
	const current = await currentRow(db, site, id);
	if (current?.status === "unknown") return { state: await reconcileMail(id, undefined, { ...options, db, site, provider, from, now }) };
	const claimed = await db.query<MailRow>("UPDATE mail_outbox SET status='sending',claimed_at=$3,attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,$3),updated_at=now() WHERE site_id=$1 AND id=$2 AND status='pending' AND next_attempt_at<=$3 RETURNING *", [site, id, startedAt]);
	const row = claimed[0]; if (!row) return deliveryResult(await currentRow(db, site, id), now());
	// attempts is the claim's fencing token; only that active sender may write its result.
	const write = async (state: string, providerId: string | null, error: string | null, retryAfterMs = 0) => {
		await db.query("UPDATE mail_outbox SET status=$4,provider_id=coalesce($5,provider_id),last_error=$6,next_attempt_at=$7,updated_at=now() WHERE site_id=$1 AND id=$2 AND status='sending' AND attempts=$3", [site, id, row.attempts, state, providerId, error, new Date(now().getTime() + retryAfterMs)]);
		return deliveryResult(await currentRow(db, site, id), now());
	};
	try {
		const result = await provider.emails.send({ from, to: row.recipient, subject: row.subject, text: row.text_body, tags: [{ name: "notification_id", value: row.id }] }, { idempotencyKey: mailIdempotencyKey(row.id, site) });
		if (result.error) {
			const status = result.error.statusCode;
			if (status === 429 && row.attempts < 8) return await write("pending", null, "邮件服务限流，等待重试", Math.min(60 * 60 * 1000, 60000 * 2 ** Math.min(row.attempts, 6)));
			const state = !status || status >= 500 || status === 409 ? "unknown" : "failed";
			return await write(state, null, `邮件服务拒绝请求：${result.error.name}`);
		}
		if (!result.data?.id) throw new Error("Provider returned no delivery identifier");
		return await write("sent", result.data.id, null);
	} catch {
		return await write("unknown", null, "发送结果未知；禁止盲目重试");
	}
}
export async function deliverMailBatch(): Promise<{ checked: number }> {
	productionMailConfiguration();
	const rows = await getDatabase().query<{ id: string }>("SELECT id FROM mail_outbox WHERE site_id=$1 AND ((status='pending' AND next_attempt_at<=now()) OR status='unknown' OR (status='sending' AND (claimed_at IS NULL OR claimed_at<now()-interval '5 minutes'))) ORDER BY created_at LIMIT 20", [getSiteId()]);
	for (const row of rows) await deliverMail(row.id);
	return { checked: rows.length };
}
export async function reconcileUnknownMail(): Promise<{ checked: number }> {
	productionMailConfiguration(); const rows = await getDatabase().query<{ id: string }>("SELECT id FROM mail_outbox WHERE site_id=$1 AND status='unknown' ORDER BY updated_at LIMIT 20", [getSiteId()]);
	for (const row of rows) await reconcileMail(row.id); return { checked: rows.length };
}

export async function processResendWebhook(payload: string, headers: { id: string; timestamp: string; signature: string }, options: MailDependencies = {}): Promise<void> {
	const { db, site, provider } = dependencies(options); const secret = options.webhookSecret || process.env.RESEND_WEBHOOK_SECRET;
	if (!secret || !provider.webhooks) throw new ApiFailure(503, "MAIL_WEBHOOK_CONFIGURATION_REQUIRED", "缺少邮件签名回调配置");
	if (Buffer.byteLength(payload) > 128 * 1024) throw new ApiFailure(413, "REQUEST_TOO_LARGE", "回调过大");
	let event: MailWebhookEvent;
	try { event = provider.webhooks.verify({ payload, headers, webhookSecret: secret }); } catch { throw new ApiFailure(403, "MAIL_WEBHOOK_SIGNATURE_INVALID", "邮件回调签名无效"); }
	const eventName = event.type.startsWith("email.") ? event.type.slice(6) : "";
	if (!successfulEvents.has(eventName) && !failedEvents.has(eventName)) return;
	if (!event.data || typeof event.data !== "object") return;
	const data = event.data as { email_id?: string; to?: string[]; subject?: string; tags?: MailTags; bounce?: { message?: unknown }; failed?: { reason?: unknown }; suppressed?: { message?: unknown } };
	const id = notificationId(data.tags);
	if (!id || typeof data.email_id !== "string" || !Array.isArray(data.to) || !data.to.every((recipient) => typeof recipient === "string") || typeof data.subject !== "string") return;
	const failed = failedEvents.has(eventName);
	const reason = eventName === "bounced" ? data.bounce?.message : eventName === "failed" ? data.failed?.reason : data.suppressed?.message;
	const detail = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) : "";
	await db.query("UPDATE mail_outbox SET status=$5,provider_id=$3,last_error=$6,updated_at=now() WHERE site_id=$1 AND id=$2 AND recipient=ANY($4::text[]) AND subject=$7 AND (provider_id IS NULL OR provider_id=$3) AND ($5='failed' OR NOT(status='failed' AND provider_id IS NOT NULL))", [site, id, data.email_id, data.to, failed ? "failed" : "sent", failed ? `${providerFailure(eventName)}${detail ? `：${detail}` : ""}` : null, data.subject]);
}

export function registerMailRoutes(app: AdminApp): void {
	app.get("/api/mail", requireAdmin, async (c) => {
		const rows = await getDatabase().query("SELECT id,notification_key,recipient,subject,status,provider_id,attempts,last_error,created_at,updated_at FROM mail_outbox WHERE site_id=$1 ORDER BY created_at DESC LIMIT 500", [getSiteId()]);
		return c.json({ data: rows.map((row) => ({ id: row.id, notificationKey: row.notification_key, recipient: row.recipient, subject: row.subject, status: row.status, providerId: row.provider_id, attempts: row.attempts, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at })) });
	});
	app.post("/api/mail/:id/reconcile", requireAdmin, async (c) => { const body = await readJson(c.req.raw); return c.json({ data: { state: await reconcileMail(c.req.param("id"), typeof body.providerId === "string" ? body.providerId : undefined) } }); });
	app.post("/api/webhooks/resend", async (c) => {
		await processResendWebhook(await c.req.text(), { id: c.req.header("svix-id") || "", timestamp: c.req.header("svix-timestamp") || "", signature: c.req.header("svix-signature") || "" });
		return c.json({ data: { received: true } });
	});
}
