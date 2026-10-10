import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { Resend } from "resend";
import { createDatabase, type Database } from "../server/db.js";
import { ApiFailure } from "../server/security.js";
import { deliverMail, enqueueMail, mailIdempotencyKey, processResendWebhook, productionMailConfiguration, reconcileMail, registerMailRoutes, type MailDependencies, type MailProvider, type MailRow } from "../server/mail.js";
import type { AppEnv } from "../server/types.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const recipient = "recipient@example.invalid"; const subject = "Frozen notification"; const body = "Original notification body";
const secretBytes = Buffer.from("test webhook signing secret, no provider credentials");
const webhookSecret = `whsec_${secretBytes.toString("base64")}`;
const signatureProvider = new Resend("re_test_not_a_real_credential").webhooks;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const failure = (code: string) => (error: unknown) => error instanceof ApiFailure && error.code === code;
function provider(overrides: Partial<MailProvider["emails"]> = {}) {
	const calls = { send: 0, list: 0, get: [] as string[] };
	const adapter: MailProvider = {
		emails: {
			async send() { calls.send++; return { data: { id: randomUUID() } }; },
			async list() { calls.list++; return { data: { data: [], has_more: false } }; },
			async get(id) { calls.get.push(id); return { data: null, error: { name: "not_found", statusCode: 404 } }; },
			...overrides,
		},
		webhooks: signatureProvider,
	};
	return { adapter, calls };
}
function signed(type: string, id: string, data: Record<string, unknown> = {}) {
	const payload = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: "provider-verified", to: [recipient], subject, tags: { notification_id: id }, ...data } });
	const headers = { id: `msg_${randomUUID()}`, timestamp: `${Math.floor(Date.now() / 1000)}`, signature: "" };
	headers.signature = `v1,${createHmac("sha256", secretBytes).update(`${headers.id}.${headers.timestamp}.${payload}`).digest("base64")}`;
	return { payload, headers };
}
async function callback(deps: MailDependencies, type: string, id: string, data: Record<string, unknown> = {}) {
	const event = signed(type, id, data);
	await processResendWebhook(event.payload, event.headers, { ...deps, webhookSecret });
}

test("formal mail requires both production markers, explicit enablement, and provider configuration", () => {
	const enabled = { APP_ENV: "production", VERCEL_ENV: "production", ENABLE_PRODUCTION_EMAIL: "true", RESEND_API_KEY: "test-key", RESEND_FROM: "sender@example.invalid" };
	assert.deepEqual(productionMailConfiguration(enabled), { key: "test-key", from: "sender@example.invalid" });
	for (const value of ["development", "preview", undefined]) {
		assert.throws(() => productionMailConfiguration({ ...enabled, APP_ENV: value }), failure("PRODUCTION_EMAIL_DISABLED"));
		assert.throws(() => productionMailConfiguration({ ...enabled, VERCEL_ENV: value }), failure("PRODUCTION_EMAIL_DISABLED"));
	}
	for (const value of [undefined, "false", "TRUE"]) assert.throws(() => productionMailConfiguration({ ...enabled, ENABLE_PRODUCTION_EMAIL: value }), failure("PRODUCTION_EMAIL_DISABLED"));
	for (const name of ["RESEND_API_KEY", "RESEND_FROM"]) assert.throws(() => productionMailConfiguration({ ...enabled, [name]: undefined }), failure("MAIL_CONFIGURATION_REQUIRED"));
	assert.equal(mailIdempotencyKey("notification", "repo/site:production"), mailIdempotencyKey("notification", "repo/site:production"));
	assert.notEqual(mailIdempotencyKey("notification", "repo/site:production"), mailIdempotencyKey("notification", "repo/site:preview"));
});

test("webhook HTTP route fails closed in development even with provider-shaped request fields", async () => {
	const previous = process.env.APP_ENV; process.env.APP_ENV = "development";
	try {
		const app = new Hono<AppEnv>(); registerMailRoutes(app);
		app.onError((error, c) => error instanceof ApiFailure ? c.json({ error: error.code }, error.status as 403) : c.json({ error: "unexpected" }, 500));
		const event = signed("email.sent", randomUUID());
		const response = await app.request("http://localhost/api/webhooks/resend", { method: "POST", headers: { "svix-id": event.headers.id, "svix-timestamp": event.headers.timestamp, "svix-signature": event.headers.signature }, body: event.payload });
		assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "PRODUCTION_EMAIL_DISABLED" });
	} finally { if (previous === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previous; }
});

test("PostgreSQL durable mail claims, unknown outcomes, and signed provider evidence", { skip: !databaseUrl }, async (t) => {
	const db = createDatabase(databaseUrl!); const sites: string[] = [];
	const newSite = () => { const site = `tests/mail-${randomUUID()}:production`; sites.push(site); return site; };
	const read = async (site: string, id: string) => (await db.query<MailRow>("SELECT * FROM mail_outbox WHERE site_id=$1 AND id=$2", [site, id]))[0]!;
	const seed = (site: string, key = randomUUID()) => db.transaction((tx) => enqueueMail(tx, key, recipient, subject, body, site));
	const depsFor = (site: string, adapter: MailProvider, now = () => new Date()) => ({ db, site, provider: adapter, from: "sender@example.invalid", now });
	try {
		await t.test("transaction rollback and concurrent notification uniqueness keep one immutable payload", async () => {
			const site = newSite(); const key = randomUUID();
			await assert.rejects(() => db.transaction(async (tx) => { await enqueueMail(tx, key, recipient, subject, body, site); throw new Error("roll back owner mutation"); }), /roll back/);
			assert.equal((await db.query("SELECT id FROM mail_outbox WHERE site_id=$1", [site])).length, 0);
			const [first, duplicate] = await Promise.all([seed(site, key), seed(site, key)]); assert.equal(first, duplicate);
			assert.equal(await db.transaction((tx) => enqueueMail(tx, key, "changed@example.invalid", "Changed subject", "Changed body", site)), first);
			const row = await read(site, first); assert.equal(row.recipient, recipient); assert.equal(row.subject, subject); assert.equal(row.text_body, body);
		});
		await t.test("overlapping workers send once with stable site-scoped provider idempotency and frozen content", async () => {
			const site = newSite(); const id = await seed(site); const entered = deferred<void>(); const release = deferred<void>(); let sends = 0;
			const { adapter } = provider({ async send(input, options) { sends++; assert.deepEqual(input, { from: "sender@example.invalid", to: recipient, subject, text: body, tags: [{ name: "notification_id", value: id }] }); assert.equal(options.idempotencyKey, mailIdempotencyKey(id, site)); entered.resolve(); await release.promise; return { data: { id: "provider-once" } }; } });
			const deps = depsFor(site, adapter); const first = deliverMail(id, deps); await entered.promise;
			assert.equal((await deliverMail(id, deps)).state, "sending"); release.resolve(); assert.equal((await first).state, "sent");
			assert.equal((await deliverMail(id, deps)).state, "sent"); assert.equal(sends, 1); assert.equal((await read(site, id)).attempts, 1);
		});
		await t.test("429 persists delay across workers; resumed future pending waits then sends using the original key", async () => {
			const site = newSite(); const id = await seed(site); let time = new Date(Date.now() + 1000); const keys: string[] = [];
			const { adapter } = provider({ async send(_input, options) { keys.push(options.idempotencyKey); return keys.length === 1 ? { error: { name: "rate_limit_exceeded", statusCode: 429 } } : { data: { id: "provider-after-limit" } }; } });
			const deps = depsFor(site, adapter, () => time); const result = await deliverMail(id, deps);
			assert.deepEqual(result, { state: "pending", retryAfterMs: 120000 }); const saved = await read(site, id);
			assert.equal(saved.status, "pending"); assert.equal(new Date(saved.next_attempt_at).getTime(), time.getTime() + 120000);
			const resumed = await deliverMail(id, deps); assert.deepEqual(resumed, result); assert.equal(keys.length, 1); assert.equal((await read(site, id)).attempts, 1);
			time = new Date(time.getTime() + resumed.retryAfterMs!); assert.equal((await deliverMail(id, deps)).state, "sent");
			assert.deepEqual(keys, [mailIdempotencyKey(id, site), mailIdempotencyKey(id, site)]); assert.equal((await read(site, id)).attempts, 2);
		});
		await t.test("lost send response reconciles tagged provider records without another send", async () => {
			const site = newSite(); const id = await seed(site); let sends = 0; let records = false; const gets: string[] = [];
			const { adapter } = provider({ async send() { sends++; throw new Error("response lost after provider accepted"); }, async list() { return { data: { data: records ? [{ id: "same-subject-wrong-notification", to: [recipient], subject }, { id: "provider-lost", to: [recipient], subject }] : [] } }; }, async get(providerId) { gets.push(providerId); return { data: { id: providerId, to: [recipient], subject, last_event: "sent", tags: [{ name: "notification_id", value: providerId === "provider-lost" ? id : randomUUID() }] } }; } });
			const deps = depsFor(site, adapter); assert.equal((await deliverMail(id, deps)).state, "unknown");
			assert.equal((await deliverMail(id, deps)).state, "unknown"); assert.equal(sends, 1);
			records = true; assert.equal((await deliverMail(id, deps)).state, "sent"); assert.equal(sends, 1); assert.deepEqual(gets, ["same-subject-wrong-notification", "provider-lost"]); assert.equal((await read(site, id)).provider_id, "provider-lost");
		});
		await t.test("pending past the 24-hour key window never calls any provider method or increments attempts", async () => {
			const site = newSite(); const id = await seed(site); const time = new Date();
			await db.query("UPDATE mail_outbox SET attempts=1,first_attempt_at=$3 WHERE site_id=$1 AND id=$2", [site, id, new Date(time.getTime() - 86400000)]);
			const { adapter, calls } = provider(); assert.deepEqual(await deliverMail(id, depsFor(site, adapter, () => time)), { state: "unknown" });
			assert.deepEqual(calls, { send: 0, list: 0, get: [] }); const row = await read(site, id); assert.equal(row.attempts, 1); assert.match(String(row.last_error), /幂等窗口已过期/);
		});
		await t.test("a stale sending claim becomes unknown and only searches provider records", async () => {
			const site = newSite(); const id = await seed(site); const time = new Date();
			await db.query("UPDATE mail_outbox SET status='sending',attempts=1,claimed_at=$3,first_attempt_at=$3 WHERE site_id=$1 AND id=$2", [site, id, new Date(time.getTime() - 300001)]);
			const { adapter, calls } = provider(); assert.equal((await deliverMail(id, depsFor(site, adapter, () => time))).state, "unknown");
			assert.equal(calls.send, 0); assert.equal(calls.list, 1); assert.equal((await read(site, id)).attempts, 1);
		});
		await t.test("an expired in-flight worker cannot rewrite a recovered unknown claim", async () => {
			const site = newSite(); const id = await seed(site); let time = new Date(Date.now() + 1000);
			const entered = deferred<void>(); const release = deferred<void>(); let sends = 0;
			const { adapter } = provider({ async send() { sends++; entered.resolve(); await release.promise; return { data: { id: "late-worker-provider" } }; } });
			const deps = depsFor(site, adapter, () => time); const sender = deliverMail(id, deps); await entered.promise;
			time = new Date(time.getTime() + 300001); assert.equal((await deliverMail(id, deps)).state, "unknown");
			release.resolve(); assert.equal((await sender).state, "unknown"); const row = await read(site, id);
			assert.equal(row.status, "unknown"); assert.equal(row.provider_id, null); assert.equal(row.attempts, 1); assert.equal(sends, 1);
		});
		await t.test("a late sender cannot erase a signed sent callback with a transport error or 429", async () => {
			for (const result of ["throw", "429"] as const) {
				const site = newSite(); const id = await seed(site); const entered = deferred<void>(); const release = deferred<void>();
				const { adapter } = provider({ async send() { entered.resolve(); await release.promise; if (result === "throw") throw new Error("lost response"); return { error: { name: "rate_limit_exceeded", statusCode: 429 } }; } });
				const deps = depsFor(site, adapter); const sender = deliverMail(id, deps); await entered.promise; await callback(deps, "email.sent", id); release.resolve();
				assert.equal((await sender).state, "sent"); const row = await read(site, id); assert.equal(row.status, "sent"); assert.equal(row.provider_id, "provider-verified"); assert.equal(row.last_error, null);
			}
		});
		await t.test("an unmatched reconciliation cannot overwrite a concurrently verified callback", async () => {
			const site = newSite(); const id = await seed(site); await db.query("UPDATE mail_outbox SET status='unknown' WHERE site_id=$1 AND id=$2", [site, id]);
			const entered = deferred<void>(); const release = deferred<void>();
			const { adapter } = provider({ async list() { entered.resolve(); await release.promise; return { data: { data: [] } }; } });
			const deps = depsFor(site, adapter); const reconciliation = reconcileMail(id, undefined, deps); await entered.promise;
			await callback(deps, "email.delivered", id); release.resolve(); assert.equal(await reconciliation, "sent"); assert.equal((await read(site, id)).provider_id, "provider-verified");
		});
		await t.test("signed callbacks require unchanged payload, exact notification, recipient, subject, and provider identity", async () => {
			const site = newSite(); const id = await seed(site); const { adapter } = provider(); const deps = depsFor(site, adapter);
			const event = signed("email.sent", id);
			await assert.rejects(() => processResendWebhook(event.payload.replace(subject, "Tampered subject"), event.headers, { ...deps, webhookSecret }), failure("MAIL_WEBHOOK_SIGNATURE_INVALID"));
			await assert.rejects(() => processResendWebhook(event.payload, { ...event.headers, signature: "v1,invalid" }, { ...deps, webhookSecret }), failure("MAIL_WEBHOOK_SIGNATURE_INVALID"));
			for (const mismatch of [{ tags: { notification_id: randomUUID() } }, { to: ["other@example.invalid"] }, { subject: "Other subject" }, { tags: [{ name: "notification_id", value: id }, { name: "notification_id", value: id }] }]) { await callback(deps, "email.sent", id, mismatch); assert.equal((await read(site, id)).status, "pending"); }
			await callback(deps, "email.sent", id, { tags: [{ name: "notification_id", value: id }] }); assert.equal((await read(site, id)).status, "sent");
			await callback(deps, "email.bounced", id, { email_id: "other-provider-id" }); assert.equal((await read(site, id)).status, "sent"); assert.equal((await read(site, id)).provider_id, "provider-verified");
		});
		await t.test("inbound, scheduled, and delayed events cannot confirm sending; real outbound failures persist", async () => {
			for (const type of ["email.received", "email.scheduled", "email.delivery_delayed", "contact.created"]) {
				const site = newSite(); const id = await seed(site); const { adapter } = provider(); const deps = depsFor(site, adapter);
				await callback(deps, type, id); assert.equal((await read(site, id)).status, "pending");
			}
			for (const type of ["email.bounced", "email.complained", "email.failed", "email.suppressed"]) {
				const site = newSite(); const id = await seed(site); const { adapter, calls } = provider(); const deps = depsFor(site, adapter);
				await callback(deps, "email.delivered", id); await callback(deps, type, id); await callback(deps, "email.sent", id);
				assert.equal((await read(site, id)).status, "failed"); assert.ok((await read(site, id)).last_error); assert.equal((await deliverMail(id, deps)).state, "failed"); assert.equal(calls.send, 0);
			}
		});
		await t.test("bounce before send acknowledgment stays failed with its provider identity", async () => {
			const site = newSite(); const id = await seed(site); const entered = deferred<void>(); const release = deferred<void>();
			const { adapter } = provider({ async send() { entered.resolve(); await release.promise; return { data: { id: "provider-verified" } }; } }); const deps = depsFor(site, adapter);
			const sender = deliverMail(id, deps); await entered.promise; await callback(deps, "email.bounced", id, { bounce: { message: "Mailbox does not exist" } }); release.resolve();
			assert.equal((await sender).state, "failed"); const row = await read(site, id); assert.equal(row.status, "failed"); assert.equal(row.last_error, "邮件退信：Mailbox does not exist");
		});
		await t.test("provider reconciliation respects actual last_event and matches recipient plus notification tag", async () => {
			for (const [event, expected] of [["sent", "sent"], ["delivered", "sent"], ["queued", "unknown"], ["scheduled", "unknown"], ["delivery_delayed", "unknown"], ["bounced", "failed"], ["complained", "failed"], ["failed", "failed"], ["canceled", "failed"]]) {
				const site = newSite(); const id = await seed(site); await db.query("UPDATE mail_outbox SET status='unknown' WHERE site_id=$1 AND id=$2", [site, id]);
				const { adapter, calls } = provider({ async get(providerId) { return { data: { id: providerId, to: [recipient], subject, tags: { notification_id: id }, last_event: event } }; } });
				assert.equal(await reconcileMail(id, "provider-history", depsFor(site, adapter)), expected); assert.equal((await read(site, id)).provider_id, "provider-history"); assert.equal(calls.send, 0);
				if (expected === "unknown") { assert.equal((await deliverMail(id, depsFor(site, adapter))).state, "unknown"); assert.equal(calls.send, 0); }
			}
			const site = newSite(); const id = await seed(site); const { adapter } = provider({ async get(providerId) { return { data: { id: providerId, to: ["unrelated@example.invalid"], subject, tags: { notification_id: id }, last_event: "sent" } }; } });
			await assert.rejects(() => reconcileMail(id, "unrelated-record", depsFor(site, adapter)), failure("MAIL_RECONCILIATION_MISMATCH")); assert.equal((await read(site, id)).status, "pending");
		});
		await t.test("reconciliation searches older pages conservatively without sending", async () => {
			const site = newSite(); const id = await seed(site); await db.query("UPDATE mail_outbox SET status='unknown' WHERE site_id=$1 AND id=$2", [site, id]); const pages: Array<string | undefined> = [];
			const { adapter, calls } = provider({ async list(options) { pages.push(options.after); return { data: { data: [{ id: options.after ? "older-provider" : "newer-provider", to: [recipient], subject }], has_more: !options.after } }; }, async get(providerId) { return { data: { id: providerId, to: [recipient], subject, tags: [{ name: "notification_id", value: providerId === "older-provider" ? id : randomUUID() }], last_event: "sent" } }; } });
			assert.equal(await reconcileMail(id, undefined, depsFor(site, adapter)), "sent"); assert.deepEqual(pages, [undefined, "newer-provider"]); assert.equal(calls.send, 0);
		});
	} finally {
		for (const site of sites) await db.query("DELETE FROM mail_outbox WHERE site_id=$1", [site]);
		await db.close();
	}
});
