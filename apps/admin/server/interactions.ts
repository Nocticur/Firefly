import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, readJson, runtimeEnvironment } from "./security.js";
import { publicContentDigest, type PublishedPost, type Redirect } from "./release-format.js";
import { parseSourceDocument } from "./source-document.js";
import { dispatchMailWorkflow } from "./mail.js";

type Row = Record<string, unknown>;
type Dependencies = { db?: Database; site?: string; fetcher?: typeof fetch; dispatchMail?: (id: string) => Promise<void> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumPublicRows = 10_000;

function text(value: unknown, field: string, maximum: number, optional = false): string {
	if (optional && (value === undefined || value === null || value === "")) return "";
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ApiFailure(400, "INVALID_INPUT", `${field} 格式不合法`);
	return value.trim();
}
function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !uuid.test(value)) throw new ApiFailure(400, "INVALID_ID", `${field} 必须是有效 UUID`);
	return value.toLowerCase();
}
function email(value: unknown, optional = false): string {
	const address = text(value, "邮箱", 254, optional);
	if (address && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || /[\r\n]/.test(address))) throw new ApiFailure(400, "INVALID_EMAIL", "邮箱格式不合法");
	return address;
}
export function safeInteractionUrl(value: unknown, optional = false): string {
	const input = text(value, "网址", 2000, optional);
	if (!input && optional) return "";
	let parsed: URL;
	try { parsed = new URL(input); } catch { throw new ApiFailure(400, "INVALID_URL", "请使用有效的 HTTP 或 HTTPS 网址"); }
	if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /[\s\\]/.test(input)) throw new ApiFailure(400, "INVALID_URL", "请使用有效的 HTTP 或 HTTPS 网址");
	return parsed.href;
}
function timestamp(value: unknown): string { return new Date(value as string).toISOString(); }
function commentRecord(row: Row, administrative = false): Row {
	const deleted = row.status === "deleted";
	return { id: row.id, articleId: row.article_id, parentId: row.parent_id, name: deleted ? "已删除的评论" : row.name, body: deleted ? "此评论已删除。" : row.body, status: row.status, createdAt: timestamp(row.created_at), ...(administrative ? { visitorId: row.visitor_id } : {}) };
}
function friendRecord(row: Row): Row {
	return { id: row.id, name: row.name, url: row.url, description: row.description, avatar: row.avatar, email: row.email, status: row.status, group: row.group_name, sortOrder: Number(row.sort_order), rejectionReason: row.rejection_reason, publishedAt: row.published_at ? timestamp(row.published_at) : null, revision: Number(row.revision), createdAt: timestamp(row.created_at) };
}

export function publicInteractionOrigin(): string {
	const environment = runtimeEnvironment();
	const configured = environment === "production" ? "https://blog.mourn.top" : environment === "preview" ? process.env.PUBLIC_PREVIEW_ORIGIN : process.env.PUBLIC_DEV_ORIGIN || "http://localhost:4321";
	if (!configured || (environment === "production" && process.env.PUBLIC_SITE_ORIGIN && process.env.PUBLIC_SITE_ORIGIN !== configured)) throw new ApiFailure(503, "INTERACTION_CONFIGURATION_REQUIRED", "请配置当前环境的公开域名");
	let parsed: URL;
	try { parsed = new URL(configured); } catch { throw new ApiFailure(503, "INTERACTION_CONFIGURATION_REQUIRED", "公开域名配置不合法"); }
	if (parsed.origin !== configured || (environment !== "development" && parsed.protocol !== "https:") || (environment === "development" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new ApiFailure(503, "INTERACTION_CONFIGURATION_REQUIRED", "公开域名配置不合法");
	return configured;
}
function turnstileConfiguration(request: Request): { secret: string; hostname: string } {
	const origin = publicInteractionOrigin();
	if (request.headers.get("origin") !== origin) throw new ApiFailure(403, "PUBLIC_ORIGIN_REJECTED", "公开互动请求来源不合法");
	const secret = process.env.TURNSTILE_SECRET_KEY;
	if (!secret) throw new ApiFailure(503, "TURNSTILE_CONFIGURATION_REQUIRED", "尚未配置 Turnstile 服务端密钥");
	return { secret, hostname: new URL(origin).hostname };
}
function clientAddress(request: Request): string {
	// Vercel overwrites this header at its edge. Never trust arbitrary forwarding
	// headers in preview/production hosted outside that trusted platform.
	const trusted = process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : runtimeEnvironment() === "development" ? request.headers.get("x-forwarded-for") || "127.0.0.1" : null;
	const address = trusted?.split(",")[0]?.trim();
	if (!address || !isIP(address)) throw new ApiFailure(503, "VISITOR_IDENTITY_UNAVAILABLE", "无法验证访客来源，请检查受信代理配置");
	return address;
}
export function visitorSubject(request: Request, site: string): string {
	const { secret } = turnstileConfiguration(request);
	return createHmac("sha256", process.env.INTERACTION_HASH_SECRET || secret).update(`${site}\0${clientAddress(request)}`).digest("hex");
}
export async function verifyTurnstile(request: Request, token: unknown, fetcher: typeof fetch = fetch): Promise<void> {
	const { secret, hostname } = turnstileConfiguration(request);
	const responseToken = text(token, "人机验证令牌", 2048);
	let response: Response;
	try {
		response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ secret, response: responseToken, remoteip: clientAddress(request) }).toString(), redirect: "error", signal: AbortSignal.timeout(10_000) });
	} catch { throw new ApiFailure(503, "TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用"); }
	if (!response.ok) throw new ApiFailure(503, "TURNSTILE_UNAVAILABLE", "人机验证服务暂时不可用");
	let result: Row;
	try { result = await response.json() as Row; } catch { throw new ApiFailure(503, "TURNSTILE_UNAVAILABLE", "人机验证服务返回无效结果"); }
	const challengeTime = typeof result?.challenge_ts === "string" ? Date.parse(result.challenge_ts) : NaN;
	if (!result || result.success !== true || result.hostname !== hostname || !Number.isFinite(challengeTime) || challengeTime < Date.now() - 5 * 60_000 || challengeTime > Date.now() + 60_000 || (Array.isArray(result["error-codes"]) && result["error-codes"].length)) throw new ApiFailure(403, "TURNSTILE_REJECTED", "人机验证未通过，请重新验证");
}
async function consumeRateLimit(db: Database, site: string, subject: string, resource: "comments" | "friends"): Promise<void> {
	const seconds = resource === "comments" ? 60 : 3600;
	const limit = resource === "comments" ? 5 : 3;
	const [counter] = await db.query<Row>("INSERT INTO interaction_rate_limits(site_id,subject,window_start,hits) VALUES($1,$2,to_timestamp(floor(extract(epoch FROM now())/$3::int)*$3::int),1) ON CONFLICT(site_id,subject,window_start) DO UPDATE SET hits=interaction_rate_limits.hits+1 RETURNING hits", [site, `${resource}:${subject}`, seconds]);
	if (Number(counter.hits) > limit) throw new ApiFailure(429, "INTERACTION_RATE_LIMITED", "提交过于频繁，请稍后再试");
}
async function lockVisitor(tx: Database, site: string, subject: string): Promise<void> {
	await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${site}:visitor:${subject}`]);
	if ((await tx.query("SELECT id FROM visitor_bans WHERE site_id=$1 AND subject=$2", [site, subject])).length) throw new ApiFailure(403, "VISITOR_BANNED", "当前访客已被禁言");
}
async function publishedArticle(db: Database, site: string, id: string): Promise<void> {
	const [post] = await db.query<Row>("SELECT p.id,p.data->>'publishedSource' AS source FROM entities p JOIN entities b ON b.site_id=p.site_id AND b.kind='repository' AND b.id='baseline' WHERE p.site_id=$1 AND p.kind='post' AND p.id=$2 AND jsonb_typeof(p.data->'publishedSource')='string' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.data->'posts')='array' THEN b.data->'posts' ELSE '[]'::jsonb END) mapped WHERE mapped->>'id'=p.id) FOR SHARE OF p,b", [site, id]);
	if (!post || parseSourceDocument(String(post.source)).metadata.comment === false) throw new ApiFailure(404, "PUBLISHED_ARTICLE_REQUIRED", "此文章尚未公开或未开放评论");
}

type VerifiedSnapshot = Row & { id: string; taskId: string; digest: string; friendIds: string[]; friendRevisions: Record<string, number>; friendNotifications?: Record<string, { name: string; email: string; revision: number }>; settings: Row; posts: PublishedPost[]; redirects: Redirect[] };
function readVerifiedSnapshot(row: Row): VerifiedSnapshot {
	const snapshot = row.snapshot as VerifiedSnapshot | undefined;
	if (!snapshot || snapshot.id !== row.snapshot_id || snapshot.taskId !== row.id || snapshot.digest !== row.digest || !Array.isArray(snapshot.posts) || !Array.isArray(snapshot.redirects) || !snapshot.settings || publicContentDigest(snapshot.posts, snapshot.settings, snapshot.redirects) !== snapshot.digest) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链发布快照校验失败");
	return snapshot;
}
function verifiedTask(row: Row): boolean {
	const details = row.details as Row | undefined;
	return row.kind === "publish" && row.state === "verified" && typeof row.target_sha === "string" && /^[0-9a-f]{40}$/.test(row.target_sha) && row.production_sha === row.target_sha && typeof row.deployment_id === "string" && Boolean(row.deployment_id) && !details?.restored && !details?.restoreRequiresReconciliation;
}
async function publicFriends(db: Database, site: string): Promise<Row[]> {
	const [row] = await db.query<Row>("SELECT t.*,s.digest,s.data AS snapshot,b.data AS baseline FROM entities b JOIN release_tasks t ON t.site_id=b.site_id AND t.id=b.data->>'taskId' JOIN release_snapshots s ON s.site_id=t.site_id AND s.id=t.snapshot_id WHERE b.site_id=$1 AND b.kind='repository' AND b.id='baseline'", [site]);
	if (!row || !verifiedTask(row)) return [];
	const snapshot = readVerifiedSnapshot(row); const baseline = row.baseline as Row;
	if (baseline.snapshotId !== snapshot.id || baseline.publicContentDigest !== snapshot.digest || baseline.headSha !== row.production_sha) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "当前公开基线与核验发布不一致");
	if (!Array.isArray(snapshot.settings.friends)) return [];
	if (snapshot.settings.friends.length > maximumPublicRows) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链数量异常");
	return (snapshot.settings.friends as Row[]).map((friend) => {
		const order = friend.sortOrder;
		if (typeof order !== "number" || !Number.isSafeInteger(order)) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链排序异常");
		return { id: identifier(friend.id, "友链 ID"), name: text(friend.name, "站点名称", 120), url: safeInteractionUrl(friend.url), description: text(friend.description, "站点描述", 2000), avatar: safeInteractionUrl(friend.avatar, true), group: text(friend.group, "分组", 120, true), sortOrder: order };
	});
}
async function enqueueNotification(tx: Database, site: string, key: string, recipient: string, subject: string, body: string): Promise<string | undefined> {
	const [row] = await tx.query<Row>("INSERT INTO mail_outbox(site_id,id,notification_key,recipient,subject,text_body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(site_id,notification_key) DO UPDATE SET notification_key=EXCLUDED.notification_key RETURNING id,status", [site, randomUUID(), key, recipient, subject, body]);
	return row.status === "pending" ? String(row.id) : undefined;
}
async function dispatchNotifications(ids: Array<string | undefined>, db: Database, site: string, dependencies: Dependencies): Promise<void> {
	const dispatch = dependencies.dispatchMail || (process.env.APP_ENV === "production" && process.env.VERCEL_ENV === "production" && process.env.ENABLE_PRODUCTION_EMAIL === "true" ? dispatchMailWorkflow : undefined);
	if (!dispatch) return;
	for (const id of new Set(ids.filter((value): value is string => Boolean(value)))) {
		try { await dispatch(id); }
		catch { await db.query("UPDATE mail_outbox SET last_error='Workflow dispatch pending; daily maintenance will resume',updated_at=now() WHERE site_id=$1 AND id=$2 AND status='pending'", [site, id]); }
	}
}

/** Called after durable deployment verification; replay repairs a interrupted hook. */
export async function markFriendsPublished(ids: string[], releaseId: string, revisions?: Record<string, number>, dependencies: Dependencies = {}): Promise<void> {
	const db = dependencies.db || getDatabase(); const site = dependencies.site || getSiteId();
	const pending = await db.transaction(async (tx) => {
		// Match the restore write-gate lock ordering before locking release rows.
		await tx.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [`${site}:production-write`]);
		const [row] = await tx.query<Row>("SELECT t.*,s.digest,s.data AS snapshot FROM release_tasks t JOIN release_snapshots s ON s.site_id=t.site_id AND s.id=t.snapshot_id WHERE t.site_id=$1 AND t.id=$2 FOR SHARE OF t,s", [site, releaseId]);
		if (!row || !verifiedTask(row)) throw new ApiFailure(409, "VERIFIED_RELEASE_REQUIRED", "友链通知必须关联已核验的真实发布");
		const snapshot = readVerifiedSnapshot(row);
		const expected = revisions || {};
		if (!Array.isArray(snapshot.friendIds) || !snapshot.friendRevisions || !Array.isArray(snapshot.settings.friends) || ids.length !== snapshot.friendIds.length || new Set(ids).size !== ids.length || ids.some((id) => !snapshot.friendIds.includes(id) || expected[id] !== snapshot.friendRevisions[id] || !Number.isSafeInteger(expected[id]) || expected[id] < 1)) throw new ApiFailure(409, "FROZEN_FRIEND_REVISION_REQUIRED", "友链通知必须使用核验快照中的冻结版本");
		const [baselineRow] = await tx.query<Row>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline' FOR SHARE", [site]);
		const baseline = baselineRow?.data as Row | undefined;
		const currentRelease = baseline?.taskId === releaseId;
		if (currentRelease && (baseline.snapshotId !== snapshot.id || baseline.publicContentDigest !== snapshot.digest || baseline.headSha !== row.production_sha)) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链基线与发布不一致");
		const outbox: Array<string | undefined> = [];
		for (const id of ids) {
			const publicFriend = (snapshot.settings.friends as Row[]).find((friend) => friend.id === id);
			if (!publicFriend) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链与冻结申请不一致");
			const [friend] = await tx.query<Row>("SELECT * FROM friends WHERE site_id=$1 AND id=$2 AND revision=$3 AND status IN ('approved','published') FOR UPDATE", [site, id, expected[id]]);
			if (friend && currentRelease) await tx.query("UPDATE friends SET status='published',published_at=coalesce(published_at,now()),updated_at=now() WHERE site_id=$1 AND id=$2 AND revision=$3", [site, id, expected[id]]);
			const notification = snapshot.friendNotifications?.[id];
			if (snapshot.friendNotifications && (!notification || notification.revision !== expected[id] || notification.name !== publicFriend.name)) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "友链通知与冻结版本不一致");
			// New releases freeze private recipients separately from their public
			// settings. Older snapshots can only recover an unchanged application.
			const recipient = notification ? email(notification.email) : friend ? email(friend.email) : undefined;
			if (!recipient) continue;
			const name = text(publicFriend.name, "站点名称", 120);
			outbox.push(await enqueueNotification(tx, site, `friend-published:${id}`, recipient, "友链已上线", `您好，您的友链「${name}」已经上线。\nhttps://blog.mourn.top/friends/`));
		}
		return outbox;
	});
	await dispatchNotifications(pending, db, site, dependencies);
}

export function registerInteractionRoutes(app: AdminApp, dependencies: Dependencies = {}): void {
	const database = () => dependencies.db || getDatabase(); const siteId = () => dependencies.site || getSiteId();
	app.use("/api/public/*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
	app.get("/api/public/comments", async (c) => {
		const articleId = identifier(c.req.query("articleId"), "文章 ID"); const db = database(); const site = siteId();
		const data = await db.transaction(async (tx) => { await publishedArticle(tx, site, articleId); return (await tx.query<Row>("SELECT id,article_id,parent_id,name,body,status,created_at FROM comments WHERE site_id=$1 AND article_id=$2 ORDER BY created_at,id LIMIT $3", [site, articleId, maximumPublicRows])).map((row) => commentRecord(row)); });
		return c.json({ data });
	});
	app.post("/api/public/comments", async (c) => {
		const body = await readJson(c.req.raw, 32 * 1024); const articleId = identifier(body.articleId, "文章 ID"); const parentId = body.parentId == null ? null : identifier(body.parentId, "回复 ID");
		const name = text(body.name, "昵称", 120); const content = text(body.body, "评论", 10_000); const address = email(body.email, true); const db = database(); const site = siteId(); const visitor = visitorSubject(c.req.raw, site);
		await consumeRateLimit(db, site, visitor, "comments"); await verifyTurnstile(c.req.raw, body.turnstileToken, dependencies.fetcher);
		const data = await db.transaction(async (tx) => {
			await lockVisitor(tx, site, visitor); await publishedArticle(tx, site, articleId);
			if (parentId && !(await tx.query("SELECT id FROM comments WHERE site_id=$1 AND id=$2 AND article_id=$3 AND status='visible' FOR SHARE", [site, parentId, articleId])).length) throw new ApiFailure(400, "INVALID_COMMENT_PARENT", "回复必须属于同一篇文章中的可见评论");
			const [row] = await tx.query<Row>("INSERT INTO comments(site_id,id,article_id,parent_id,name,body,email,visitor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [site, randomUUID(), articleId, parentId, name, content, address || null, visitor]); return commentRecord(row);
		});
		return c.json({ data }, 201);
	});
	app.get("/api/public/friends", async (c) => c.json({ data: await publicFriends(database(), siteId()) }));
	app.post("/api/public/friends", async (c) => {
		const body = await readJson(c.req.raw, 16 * 1024); const name = text(body.name, "站点名称", 120); const url = safeInteractionUrl(body.url); const description = text(body.description, "站点描述", 2000); const avatar = safeInteractionUrl(body.avatar, true); const address = email(body.email); const db = database(); const site = siteId(); const visitor = visitorSubject(c.req.raw, site);
		await consumeRateLimit(db, site, visitor, "friends"); await verifyTurnstile(c.req.raw, body.turnstileToken, dependencies.fetcher);
		const data = await db.transaction(async (tx) => {
			await lockVisitor(tx, site, visitor); await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${site}:friend-url:${url}`]);
			if ((await tx.query("SELECT id FROM friends WHERE site_id=$1 AND url=$2 AND status IN ('pending','approved','published')", [site, url])).length) throw new ApiFailure(409, "FRIEND_APPLICATION_EXISTS", "此站点已有申请，请勿重复提交");
			const [row] = await tx.query<Row>("INSERT INTO friends(site_id,id,name,url,description,avatar,email) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,status", [site, randomUUID(), name, url, description, avatar, address]); return row;
		});
		return c.json({ data }, 201);
	});
	app.get("/api/comments", requireAdmin, async (c) => c.json({ data: (await database().query<Row>("SELECT * FROM comments WHERE site_id=$1 ORDER BY created_at DESC,id LIMIT 1000", [siteId()])).map((row) => commentRecord(row, true)) }));
	app.post("/api/comments/:id/delete", requireAdmin, async (c) => {
		const rows = await database().query<Row>("UPDATE comments SET status='deleted',body='',name='',email=null,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING *", [siteId(), identifier(c.req.param("id"), "评论 ID")]);
		if (!rows[0]) throw new ApiFailure(404, "COMMENT_NOT_FOUND", "评论不存在"); return c.json({ data: commentRecord(rows[0], true) });
	});
	app.get("/api/bans", requireAdmin, async (c) => c.json({ data: (await database().query<Row>("SELECT * FROM visitor_bans WHERE site_id=$1 ORDER BY created_at DESC", [siteId()])).map((row) => ({ id: row.id, subject: row.subject, createdAt: timestamp(row.created_at) })) }));
	app.post("/api/bans", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096); const subject = text(body.subject, "访客标识", 64); if (!/^[0-9a-f]{64}$/.test(subject)) throw new ApiFailure(400, "INVALID_VISITOR_SUBJECT", "访客标识不合法"); const site = siteId();
		const row = await database().transaction(async (tx) => { await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${site}:visitor:${subject}`]); const [ban] = await tx.query<Row>("INSERT INTO visitor_bans(site_id,id,subject) VALUES($1,$2,$3) ON CONFLICT(site_id,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING *", [site, randomUUID(), subject]); return ban; });
		return c.json({ data: { id: row.id, subject: row.subject, createdAt: timestamp(row.created_at) } });
	});
	app.delete("/api/bans/:id", requireAdmin, async (c) => { const [row] = await database().query<Row>("DELETE FROM visitor_bans WHERE site_id=$1 AND id=$2 RETURNING id", [siteId(), identifier(c.req.param("id"), "禁言 ID")]); if (!row) throw new ApiFailure(404, "BAN_NOT_FOUND", "禁言记录不存在"); return c.json({ data: { id: row.id, deleted: true } }); });
	app.get("/api/friends", requireAdmin, async (c) => c.json({ data: (await database().query<Row>("SELECT * FROM friends WHERE site_id=$1 ORDER BY group_name,sort_order,created_at DESC", [siteId()])).map(friendRecord) }));
	app.post("/api/friends/:id/approve", requireAdmin, async (c) => {
		const [row] = await database().query<Row>("UPDATE friends SET status=CASE WHEN status='published' THEN 'published' ELSE 'approved' END,rejection_reason=null,revision=revision+CASE WHEN status IN ('approved','published') THEN 0 ELSE 1 END,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING *", [siteId(), identifier(c.req.param("id"), "友链 ID")]); if (!row) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在"); return c.json({ data: friendRecord(row) });
	});
	app.post("/api/friends/:id/reject", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096); const reason = text(body.reason, "拒绝理由", 2000); const id = identifier(c.req.param("id"), "友链 ID"); const site = siteId();
		const db = database();
		const result = await db.transaction(async (tx) => {
			const [friend] = await tx.query<Row>("SELECT * FROM friends WHERE site_id=$1 AND id=$2 FOR UPDATE", [site, id]); if (!friend) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在");
			const [updated] = await tx.query<Row>("UPDATE friends SET status='rejected',rejection_reason=$3,revision=revision+CASE WHEN status='rejected' AND rejection_reason=$3 THEN 0 ELSE 1 END,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING *", [site, id, reason]);
			const mailId = await enqueueNotification(tx, site, `friend-rejected:${id}:${updated.revision}`, String(updated.email), "友链申请审核结果", `您好，您的友链申请「${String(updated.name)}」未通过审核。\n理由：${reason}`); return { row: updated, mailId };
		});
		await dispatchNotifications([result.mailId], db, site, dependencies);
		return c.json({ data: friendRecord(result.row) });
	});
	app.patch("/api/friends/:id", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096); const group = text(body.group, "分组", 120, true); const order = body.sortOrder; if (typeof order !== "number" || !Number.isSafeInteger(order) || order < -2_147_483_648 || order > 2_147_483_647) throw new ApiFailure(400, "INVALID_SORT_ORDER", "排序值必须是有效整数");
		const [row] = await database().query<Row>("UPDATE friends SET group_name=$3,sort_order=$4,revision=revision+CASE WHEN group_name=$3 AND sort_order=$4 THEN 0 ELSE 1 END,updated_at=now() WHERE site_id=$1 AND id=$2 RETURNING *", [siteId(), identifier(c.req.param("id"), "友链 ID"), group, order]); if (!row) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在"); return c.json({ data: friendRecord(row) });
	});
}
