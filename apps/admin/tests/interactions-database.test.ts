import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import { createDatabase, getDatabase, getSiteId, type Database } from "../server/db.js";
import { issueSession } from "../server/auth.js";
import { ApiFailure } from "../server/security.js";
import { publicContentDigest } from "../server/release-format.js";
import { markFriendsPublished, registerInteractionRoutes } from "../server/interactions.js";

type Row = Record<string, unknown>;
const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const publicOrigin = "http://localhost:4321";
const publishedSource = '---\ntitle: "公开文章"\npublished: "2026-09-10"\ndraft: false\ncomment: true\n---\nbody\n';

test("real PostgreSQL persists public interactions and enforces authenticated moderation and verified notifications", { skip: !databaseUrl }, async (t) => {
	process.env.APP_ENV = "development";
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	process.env.ADMIN_DEVELOPMENT_DATABASE_URL = databaseUrl;
	process.env.ADMIN_GITHUB_USER_ID = "285582250";
	process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
	process.env.PUBLIC_DEV_ORIGIN = publicOrigin;
	process.env.TURNSTILE_SECRET_KEY = "isolated-test-secret";
	process.env.INTERACTION_HASH_SECRET = "stable-isolated-test-visitor-secret";
	process.env.GITHUB_REPOSITORY = `tests/interactions-${randomUUID()}`;
	const db = getDatabase(); const site = getSiteId();
	for (const name of ["001-core.sql", "002-release.sql", "003-interactions.sql"]) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
	const article = randomUUID(); const otherArticle = randomUUID(); const draft = randomUUID(); const disabled = randomUUID();
	let turnstileResult: Row = { success: true, hostname: "localhost", challenge_ts: new Date().toISOString() };
	let failNetwork = false; let validations = 0;
	const dispatched: string[] = [];
	const dispatchMail = async (id: string) => {
		// This query uses another transaction: dispatch cannot see an uncommitted
		// insertion, and tests never start a real workflow or send real mail.
		const [row] = await db.query<Row>("SELECT id FROM mail_outbox WHERE site_id=$1 AND id=$2", [site, id]); assert.ok(row); dispatched.push(id);
	};
	const fetcher: typeof fetch = async (input, init) => {
		validations++; assert.equal(input, "https://challenges.cloudflare.com/turnstile/v0/siteverify"); assert.equal(init?.redirect, "error");
		const form = new URLSearchParams(String(init?.body)); assert.equal(form.get("secret"), "isolated-test-secret"); assert.ok(form.get("response")); assert.ok(form.get("remoteip"));
		if (failNetwork) throw new Error("isolated unavailable provider");
		return new Response(JSON.stringify(turnstileResult), { headers: { "Content-Type": "application/json" } });
	};
	function makeApp(database = db): Hono<AppEnv> {
		const app = new Hono<AppEnv>(); app.onError((error, c) => error instanceof ApiFailure ? error.getResponse() : c.json({ error: { code: "INTERNAL_TEST_FAILURE", message: error.message } }, 500)); registerInteractionRoutes(app, { db: database, site, fetcher, dispatchMail }); return app;
	}
	const app = makeApp();
	const session = await issueSession(db, site, { id: "285582250", login: "Nocticur", name: "Nocticur", avatarUrl: "https://github.com/Nocticur.png" });
	const cookie = `__Host-admin-session=${session.token}`;
	const administrativeHeaders = { cookie, Origin: "http://localhost:3000", "Content-Type": "application/json", "x-csrf-token": session.csrfToken };
	const publicHeaders = (ip = "192.0.2.1") => ({ Origin: publicOrigin, "Content-Type": "application/json", "x-forwarded-for": ip });
	const postComment = (body: Row, ip = "192.0.2.1", target = app) => target.request(`${publicOrigin}/api/public/comments`, { method: "POST", headers: publicHeaders(ip), body: JSON.stringify({ articleId: article, name: "访客", body: "普通文本", turnstileToken: "verified-in-isolated-provider", ...body }) });
	const moderate = (path: string, body: Row = {}, method = "POST", target = app) => target.request(`http://localhost:3000/api${path}`, { method, headers: administrativeHeaders, body: JSON.stringify(body) });
	const friendApplication = (name: string, ip: string) => app.request(`${publicOrigin}/api/public/friends`, { method: "POST", headers: publicHeaders(ip), body: JSON.stringify({ name, url: `https://${name}.example/`, description: "我的站点", avatar: "https://avatars.example/avatar.png", email: `${name}@example.com`, turnstileToken: "verified-in-isolated-provider" }) });
	const notificationRows = () => db.query<Row>("SELECT * FROM mail_outbox WHERE site_id=$1 ORDER BY created_at", [site]);
	function failOutboxDatabase(): Database {
		function wrap(connection: Database): Database {
			return { ...connection, async query<T extends Row>(sql: string, params?: unknown[]): Promise<T[]> { if (sql.startsWith("INSERT INTO mail_outbox")) throw new Error("isolated outbox insert failure"); return connection.query<T>(sql, params); }, transaction: async <T>(fn: (tx: Database) => Promise<T>) => connection.transaction((tx) => fn(wrap(tx))) };
		} return wrap(db);
	}
	async function storeRelease(friends: Row[], revisions: Record<string, number>, state = "verified", details: Row = {}, freezeRecipients = true): Promise<string> {
		const id = randomUUID(); const snapshotId = randomUUID(); const headSha = "a".repeat(40); const settings = { friends }; const posts: [] = []; const redirects: [] = []; const digest = publicContentDigest(posts, settings, redirects);
		const friendNotifications: Record<string, Row> = {};
		for (const friend of friends) { const [stored] = await db.query<Row>("SELECT email FROM friends WHERE site_id=$1 AND id=$2", [site, friend.id]); friendNotifications[String(friend.id)] = { name: friend.name, email: stored.email, revision: revisions[String(friend.id)] }; }
		const snapshot = { id: snapshotId, taskId: id, digest, posts, settings, redirects, friendIds: friends.map((friend) => friend.id), friendRevisions: revisions, ...(freezeRecipients ? { friendNotifications } : {}) };
		await db.transaction(async (tx) => {
			await tx.query("INSERT INTO release_snapshots(site_id,id,digest,data) VALUES($1,$2,$3,$4::jsonb)", [site, snapshotId, digest, JSON.stringify(snapshot)]);
			await tx.query("INSERT INTO release_tasks(site_id,id,idempotency_key,state,snapshot_id,target_sha,production_sha,deployment_id,details) VALUES($1,$2,$2,$3,$4,$5,$5,'dpl_isolated_test',$6::jsonb)", [site, id, state, snapshotId, headSha, JSON.stringify(details)]);
			await tx.query("UPDATE entities SET data=data || $2::jsonb WHERE site_id=$1 AND kind='repository' AND id='baseline'", [site, JSON.stringify({ taskId: id, snapshotId, headSha, publicContentDigest: digest })]);
		}); return id;
	}
	try {
		for (const id of [article, otherArticle, draft, disabled]) await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'post',$2,$3::jsonb)", [site, id, JSON.stringify({ publishedSource: id === draft ? null : id === disabled ? publishedSource.replace("comment: true", "comment: false") : publishedSource, metadata: { comment: false } })]);
		await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'repository','baseline',$2::jsonb)", [site, JSON.stringify({ posts: [article, otherArticle, disabled].map((id) => ({ id })) })]);
		await t.test("public endpoints require actual published UUID articles, whitelist private fields and preserve pure text replies", async () => {
			assert.equal((await app.request(`${publicOrigin}/api/public/comments?articleId=legacy-slug`)).status, 400);
			assert.equal((await app.request(`${publicOrigin}/api/public/comments?articleId=${draft}`)).status, 404);
			assert.equal((await postComment({ articleId: draft }, "192.0.2.2")).status, 404);
			assert.equal((await postComment({ articleId: disabled }, "192.0.2.3")).status, 404);
			const first = await postComment({ body: "<script>alert('literal text')</script>", email: "private@example.com" }); assert.equal(first.status, 201);
			const firstBody = await first.json(); const parent = firstBody.data.id;
			assert.equal(firstBody.data.body, "<script>alert('literal text')</script>"); assert.equal("email" in firstBody.data, false); assert.equal("visitorId" in firstBody.data, false);
			const reply = await postComment({ parentId: parent }, "192.0.2.4"); assert.equal(reply.status, 201);
			assert.equal((await postComment({ articleId: otherArticle, parentId: parent }, "192.0.2.5")).status, 400);
			assert.equal((await app.request(`http://localhost:3000/api/comments`)).status, 401);
			assert.equal((await app.request(`http://localhost:3000/api/comments/${parent}/delete`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);
			assert.equal((await moderate(`/comments/${parent}/delete`)).status, 200);
			const listed = await (await app.request(`${publicOrigin}/api/public/comments?articleId=${article}`)).json();
			const deleted = listed.data.find((comment: Row) => comment.id === parent); assert.equal(deleted.status, "deleted"); assert.equal(deleted.body, "此评论已删除。"); assert.equal(deleted.name, "已删除的评论"); assert.equal("email" in deleted, false); assert.equal("visitorId" in deleted, false);
			assert.ok(listed.data.some((comment: Row) => comment.parentId === parent));
			assert.equal((await postComment({ parentId: parent }, "192.0.2.6")).status, 400);
			const [stored] = await db.query<Row>("SELECT * FROM comments WHERE site_id=$1 AND id=$2", [site, parent]); assert.equal(stored.body, ""); assert.equal(stored.email, null);
		});
		await t.test("Turnstile fails closed for missing configuration, wrong origin/hostname, false success, stale and unavailable provider", async () => {
			const before = (await db.query<Row>("SELECT id FROM comments WHERE site_id=$1", [site])).length;
			delete process.env.TURNSTILE_SECRET_KEY; assert.equal((await postComment({}, "192.0.2.10")).status, 503); process.env.TURNSTILE_SECRET_KEY = "isolated-test-secret";
			assert.equal((await app.request(`${publicOrigin}/api/public/comments`, { method: "POST", headers: { ...publicHeaders("192.0.2.11"), Origin: "https://attacker.example" }, body: JSON.stringify({ articleId: article, name: "x", body: "x", turnstileToken: "x" }) })).status, 403);
			for (const result of [{ success: true, hostname: "attacker.example", challenge_ts: new Date().toISOString() }, { success: "true", hostname: "localhost", challenge_ts: new Date().toISOString() }, { success: false, hostname: "localhost", challenge_ts: new Date().toISOString() }, { success: true, hostname: "localhost", challenge_ts: new Date(Date.now() - 600_000).toISOString() }]) { turnstileResult = result; assert.equal((await postComment({}, "192.0.2.12")).status, 403); }
			failNetwork = true; assert.equal((await postComment({}, "192.0.2.13")).status, 503); failNetwork = false;
			turnstileResult = { success: true, hostname: "localhost", challenge_ts: new Date().toISOString() };
			assert.equal((await db.query<Row>("SELECT id FROM comments WHERE site_id=$1", [site])).length, before);
			assert.ok(validations > 0);
		});
		await t.test("rate counters and visitor bans survive another API/database connection, and unban restores writing", async () => {
			const submitted = await postComment({}, "192.0.2.20"); assert.equal(submitted.status, 201); const id = (await submitted.json()).data.id;
			const administrative = await (await app.request("http://localhost:3000/api/comments", { headers: { cookie } })).json(); const subject = administrative.data.find((comment: Row) => comment.id === id).visitorId; assert.match(subject, /^[0-9a-f]{64}$/);
			const banned = await moderate("/bans", { subject }); assert.equal(banned.status, 200); const banId = (await banned.json()).data.id;
			const reopened = createDatabase(databaseUrl!);
			try {
				const otherApp = makeApp(reopened); assert.equal((await postComment({}, "192.0.2.20", otherApp)).status, 403);
				assert.equal((await moderate(`/bans/${banId}`, {}, "DELETE")).status, 200); assert.equal((await postComment({}, "192.0.2.20", otherApp)).status, 201);
				for (let index = 0; index < 5; index++) assert.equal((await postComment({}, "192.0.2.21", index % 2 ? otherApp : app)).status, 201);
				assert.equal((await postComment({}, "192.0.2.21", otherApp)).status, 429);
				const [counter] = await reopened.query<Row>("SELECT max(hits)::int AS hits FROM interaction_rate_limits WHERE site_id=$1", [site]); assert.ok(Number(counter.hits) >= 6);
			} finally { await reopened.close(); }
		});
		await t.test("friend applications validate URLs, stay private pending verification, and rejection plus unique outbox are one transaction", async () => {
			const application = await friendApplication("pending", "192.0.2.30"); assert.equal(application.status, 201); const id = (await application.json()).data.id;
			assert.equal((await friendApplication("pending", "192.0.2.31")).status, 409);
			const invalid = await app.request(`${publicOrigin}/api/public/friends`, { method: "POST", headers: publicHeaders("192.0.2.32"), body: JSON.stringify({ name: "bad", url: "javascript:alert(1)", description: "x", email: "a@example.com", turnstileToken: "x" }) }); assert.equal(invalid.status, 400);
			assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []);
			assert.equal((await moderate(`/friends/${id}/reject`, { reason: "未满足申请条件" }, "POST", makeApp(failOutboxDatabase()))).status, 500);
			const [unchanged] = await db.query<Row>("SELECT status,revision FROM friends WHERE site_id=$1 AND id=$2", [site, id]); assert.equal(unchanged.status, "pending"); assert.equal(Number(unchanged.revision), 1); assert.equal((await notificationRows()).length, 0);
			assert.equal(dispatched.length, 0);
			assert.equal((await moderate(`/friends/${id}/reject`, { reason: "未满足申请条件" })).status, 200); assert.equal((await moderate(`/friends/${id}/reject`, { reason: "未满足申请条件" })).status, 200);
			const notices = await notificationRows(); assert.equal(notices.length, 1); assert.equal(notices[0].recipient, "pending@example.com"); assert.equal(notices[0].status, "pending"); assert.equal(notices[0].attempts, 0);
			assert.ok(dispatched.includes(String(notices[0].id)));
		});
		await t.test("only durable verified frozen revisions publish friends; interrupted hooks roll back and replay repairs exactly one mail", async () => {
			const application = await friendApplication("publish", "192.0.2.40"); const id = (await application.json()).data.id;
			const approved = await (await moderate(`/friends/${id}/approve`)).json(); const revision = approved.data.revision;
			const frozen = { id, name: "publish", url: "https://publish.example/", description: "我的站点", avatar: "https://avatars.example/avatar.png", group: "", sortOrder: 0 };
			const unverified = await storeRelease([frozen], { [id]: revision }, "deploying");
			await assert.rejects(() => markFriendsPublished([id], unverified, { [id]: revision }, { db, site }), (error: unknown) => error instanceof ApiFailure && error.code === "VERIFIED_RELEASE_REQUIRED"); assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []);
			const verified = await storeRelease([frozen], { [id]: revision });
			await assert.rejects(() => markFriendsPublished([id], verified, { [id]: revision + 1 }, { db, site }), (error: unknown) => error instanceof ApiFailure && error.code === "FROZEN_FRIEND_REVISION_REQUIRED");
			await assert.rejects(() => markFriendsPublished([id], verified, { [id]: revision }, { db: failOutboxDatabase(), site }));
			const [rolledBack] = await db.query<Row>("SELECT status FROM friends WHERE site_id=$1 AND id=$2", [site, id]); assert.equal(rolledBack.status, "approved");
			await Promise.all([markFriendsPublished([id], verified, { [id]: revision }, { db, site, dispatchMail }), markFriendsPublished([id], verified, { [id]: revision }, { db, site, dispatchMail })]);
			const notices = (await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`); assert.equal(notices.length, 1); assert.equal(notices[0].status, "pending"); assert.equal(notices[0].attempts, 0);
			assert.ok(dispatched.includes(String(notices[0].id)));
			const [published] = await db.query<Row>("SELECT status,published_at FROM friends WHERE site_id=$1 AND id=$2", [site, id]); assert.equal(published.status, "published"); assert.ok(published.published_at);
			const before = (await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data; assert.deepEqual(before, [frozen]); assert.equal("email" in before[0], false);
			assert.equal((await moderate(`/friends/${id}`, { group: "新分组", sortOrder: -5 }, "PATCH")).status, 200);
			assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, [frozen]);
			assert.equal((await moderate(`/friends/${id}/reject`, { reason: "后续审核拒绝" })).status, 200); assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, [frozen]);
			const nextRelease = await storeRelease([], {}); await markFriendsPublished([], nextRelease, {}, { db, site }); assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []);
			await markFriendsPublished([id], verified, { [id]: revision }, { db, site }); assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []); assert.equal((await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`).length, 1);
		});
		await t.test("private frozen recipients recover notices after later edits without changing mutable revision/status; restored tasks fail closed", async () => {
			const application = await friendApplication("changed", "192.0.2.50"); const id = (await application.json()).data.id; const approved = await (await moderate(`/friends/${id}/approve`)).json(); const revision = approved.data.revision;
			const frozen = { id, name: "changed", url: "https://changed.example/", description: "我的站点", avatar: "", group: "", sortOrder: 0 };
			const verified = await storeRelease([frozen], { [id]: revision }); await moderate(`/friends/${id}`, { group: "草稿修改", sortOrder: 1 }, "PATCH");
			await db.query("UPDATE friends SET email='new-recipient@example.com',revision=revision+1 WHERE site_id=$1 AND id=$2", [site, id]);
			const [before] = await db.query<Row>("SELECT status,revision FROM friends WHERE site_id=$1 AND id=$2", [site, id]);
			await markFriendsPublished([id], verified, { [id]: revision }, { db, site, dispatchMail });
			const notices = (await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`); assert.equal(notices.length, 1); assert.equal(notices[0].recipient, "changed@example.com"); assert.ok(dispatched.includes(String(notices[0].id)));
			const [after] = await db.query<Row>("SELECT status,revision FROM friends WHERE site_id=$1 AND id=$2", [site, id]); assert.deepEqual(after, before);
			assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, [frozen]);
			const restored = await storeRelease([frozen], { [id]: revision }, "verified", { restored: true }); await assert.rejects(() => markFriendsPublished([id], restored, { [id]: revision }, { db, site }), (error: unknown) => error instanceof ApiFailure && error.code === "VERIFIED_RELEASE_REQUIRED"); assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []);
		});
		await t.test("legacy snapshots refuse changed recipients and failed workflow dispatch leaves a durable retry record", async () => {
			const application = await friendApplication("legacy", "192.0.2.60"); const id = (await application.json()).data.id; const approved = await (await moderate(`/friends/${id}/approve`)).json(); const revision = approved.data.revision;
			const frozen = { id, name: "legacy", url: "https://legacy.example/", description: "旧快照", avatar: "", group: "", sortOrder: 0 };
			const legacyRelease = await storeRelease([frozen], { [id]: revision }, "verified", {}, false);
			await moderate(`/friends/${id}`, { group: "后续分组", sortOrder: 1 }, "PATCH");
			await markFriendsPublished([id], legacyRelease, { [id]: revision }, { db, site, dispatchMail }); assert.equal((await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`).length, 0);
			const [current] = await db.query<Row>("SELECT revision FROM friends WHERE site_id=$1 AND id=$2", [site, id]); const currentRevision = Number(current.revision);
			const recoveredRelease = await storeRelease([frozen], { [id]: currentRevision });
			await markFriendsPublished([id], recoveredRelease, { [id]: currentRevision }, { db, site, dispatchMail: async () => { throw new Error("isolated scheduler unavailable"); } });
			const [notice] = (await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`); assert.equal(notice.status, "pending"); assert.match(String(notice.last_error), /daily maintenance/);
			await markFriendsPublished([id], recoveredRelease, { [id]: currentRevision }, { db, site, dispatchMail }); assert.equal((await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`).length, 1); assert.ok(dispatched.includes(String(notice.id)));
			const emptyRelease = await storeRelease([], {}); await markFriendsPublished([], emptyRelease, undefined, { db, site, dispatchMail });
		});
		await t.test("a verified old release repairs a missed frozen notice after the public baseline advances", async () => {
			const application = await friendApplication("interrupted", "192.0.2.70"); const id = (await application.json()).data.id; const approved = await (await moderate(`/friends/${id}/approve`)).json(); const revision = approved.data.revision;
			const frozen = { id, name: "interrupted", url: "https://interrupted.example/", description: "冻结公告", avatar: "", group: "", sortOrder: 0 };
			const oldRelease = await storeRelease([frozen], { [id]: revision });
			const newRelease = await storeRelease([], {}); await markFriendsPublished([], newRelease, {}, { db, site, dispatchMail });
			await markFriendsPublished([id], oldRelease, { [id]: revision }, { db, site, dispatchMail });
			const [notice] = (await notificationRows()).filter((row) => row.notification_key === `friend-published:${id}`); assert.equal(notice.recipient, "interrupted@example.com"); assert.ok(dispatched.includes(String(notice.id)));
			const [current] = await db.query<Row>("SELECT status,revision,published_at FROM friends WHERE site_id=$1 AND id=$2", [site, id]); assert.equal(current.status, "approved"); assert.equal(Number(current.revision), revision); assert.equal(current.published_at, null);
			assert.deepEqual((await (await app.request(`${publicOrigin}/api/public/friends`)).json()).data, []);
		});
	} finally {
		for (const table of ["comments", "visitor_bans", "friends", "interaction_rate_limits", "mail_outbox", "release_tasks", "release_snapshots", "entities", "sessions"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [site]);
		await db.close();
	}
});
