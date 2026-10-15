import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import {
	assertSite,
	collection,
	getStore,
	getSiteId,
	type FileStore,
	type StoreState,
} from "./file-store.js";
import { ApiFailure, readJson, runtimeEnvironment } from "./security.js";
import {
	publicContentDigest,
	type PublishedPost,
	type Redirect,
} from "./release-format.js";
import { parseSourceDocument } from "./source-document.js";
import {
	previewOrigin,
	publicCommentsEnabled,
	siteOrigin,
} from "./runtime-config.js";

type Row = Record<string, unknown>;
type Dependencies = {
	store?: FileStore;
	site?: string;
	fetcher?: typeof fetch;
};
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumPublicRows = 10_000;
const maximumCommentPageBytes = 512 * 1024 - 512;
type TurnstileAction = "comments" | "friend_request";

function requirePublicComments(): void {
	if (!publicCommentsEnabled())
		throw new ApiFailure(
			503,
			"PUBLIC_COMMENTS_DISABLED",
			"本站暂未开放公开评论",
		);
}
function commentPagination(
	limitValue?: string,
	cursorValue?: string,
	articleId?: string,
): { limit: number; timestamp: string | null; id: string | null } {
	const limit = limitValue === undefined ? 50 : Number(limitValue);
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		(limitValue !== undefined && !/^[1-9]\d{0,2}$/.test(limitValue))
	)
		throw new ApiFailure(
			400,
			"INVALID_COMMENT_PAGE",
			"每页评论数量必须为 1 至 100",
		);
	if (cursorValue === undefined) return { limit, timestamp: null, id: null };
	let cursor: unknown;
	try {
		if (!/^[A-Za-z0-9_-]{20,240}$/.test(cursorValue)) throw new Error();
		cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
	} catch {
		throw new ApiFailure(400, "INVALID_COMMENT_CURSOR", "评论分页游标不合法");
	}
	if (
		!Array.isArray(cursor) ||
		cursor.length !== 3 ||
		cursor[0] !== articleId ||
		typeof cursor[1] !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor[1]) ||
		!Number.isFinite(Date.parse(cursor[1])) ||
		new Date(cursor[1]).toISOString().slice(0, 19) !== cursor[1].slice(0, 19) ||
		typeof cursor[2] !== "string" ||
		!uuid.test(cursor[2])
	)
		throw new ApiFailure(400, "INVALID_COMMENT_CURSOR", "评论分页游标不合法");
	return { limit, timestamp: cursor[1], id: cursor[2].toLowerCase() };
}
function commentCursor(articleId: string, row: Row): string {
	return Buffer.from(
		JSON.stringify([articleId, row.cursor_created_at, row.id]),
	).toString("base64url");
}

function text(
	value: unknown,
	field: string,
	maximum: number,
	optional = false,
): string {
	if (optional && (value === undefined || value === null || value === ""))
		return "";
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maximum ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
	)
		throw new ApiFailure(400, "INVALID_INPUT", `${field} 格式不合法`);
	return value.trim();
}
function identifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !uuid.test(value))
		throw new ApiFailure(400, "INVALID_ID", `${field} 必须是有效 UUID`);
	return value.toLowerCase();
}
function email(value: unknown, optional = false): string {
	const address = text(value, "邮箱", 254, optional);
	if (
		address &&
		(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || /[\r\n]/.test(address))
	)
		throw new ApiFailure(400, "INVALID_EMAIL", "邮箱格式不合法");
	return address;
}
export function safeInteractionUrl(value: unknown, optional = false): string {
	const input = text(value, "网址", 2000, optional);
	if (!input && optional) return "";
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new ApiFailure(400, "INVALID_URL", "请使用有效的 HTTP 或 HTTPS 网址");
	}
	if (
		!/^https?:$/.test(parsed.protocol) ||
		parsed.username ||
		parsed.password ||
		/[\s\\]/.test(input)
	)
		throw new ApiFailure(400, "INVALID_URL", "请使用有效的 HTTP 或 HTTPS 网址");
	return parsed.href;
}
function timestamp(value: unknown): string {
	return new Date(value as string).toISOString();
}
function commentRecord(row: Row, administrative = false): Row {
	const deleted = row.status === "deleted";
	return {
		id: row.id,
		articleId: row.article_id,
		parentId: row.parent_id,
		name: deleted ? "已删除的评论" : row.name,
		body: deleted ? "此评论已删除。" : row.body,
		status: row.status,
		createdAt: timestamp(row.created_at),
		...(administrative ? { visitorId: row.visitor_id } : {}),
	};
}
function friendRecord(row: Row): Row {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		description: row.description,
		avatar: row.avatar,
		email: row.email,
		status: row.status,
		group: row.group_name,
		sortOrder: Number(row.sort_order),
		rejectionReason: row.rejection_reason,
		publishedAt: row.published_at ? timestamp(row.published_at) : null,
		revision: Number(row.revision),
		createdAt: timestamp(row.created_at),
	};
}

export function publicInteractionOrigin(): string {
	const environment = runtimeEnvironment();
	const configured =
		environment === "production"
			? siteOrigin
			: environment === "preview"
				? process.env.PUBLIC_PREVIEW_ORIGIN || previewOrigin()
				: process.env.PUBLIC_DEV_ORIGIN || "http://localhost:4321";
	if (
		!configured ||
		(environment === "production" &&
			process.env.PUBLIC_SITE_ORIGIN &&
			process.env.PUBLIC_SITE_ORIGIN !== configured)
	)
		throw new ApiFailure(
			503,
			"INTERACTION_CONFIGURATION_REQUIRED",
			"请配置当前环境的公开域名",
		);
	let parsed: URL;
	try {
		parsed = new URL(configured);
	} catch {
		throw new ApiFailure(
			503,
			"INTERACTION_CONFIGURATION_REQUIRED",
			"公开域名配置不合法",
		);
	}
	if (
		parsed.origin !== configured ||
		(environment !== "development" && parsed.protocol !== "https:") ||
		(environment === "development" &&
			!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
	)
		throw new ApiFailure(
			503,
			"INTERACTION_CONFIGURATION_REQUIRED",
			"公开域名配置不合法",
		);
	return configured;
}
function turnstileConfiguration(request: Request): {
	secret: string;
	hostname: string;
} {
	const origin = publicInteractionOrigin();
	if (request.headers.get("origin") !== origin)
		throw new ApiFailure(
			403,
			"PUBLIC_ORIGIN_REJECTED",
			"公开互动请求来源不合法",
		);
	const secret = process.env.TURNSTILE_SECRET_KEY;
	if (!secret)
		throw new ApiFailure(
			503,
			"TURNSTILE_CONFIGURATION_REQUIRED",
			"尚未配置 Turnstile 服务端密钥",
		);
	return { secret, hostname: new URL(origin).hostname };
}
function clientAddress(request: Request): string {
	// Vercel overwrites this header at its edge. Never trust arbitrary forwarding
	// headers in preview/production hosted outside that trusted platform.
	const trusted =
		process.env.VERCEL === "1"
			? request.headers.get("x-vercel-forwarded-for")
			: runtimeEnvironment() === "development"
				? request.headers.get("x-forwarded-for") || "127.0.0.1"
				: null;
	const address = trusted?.split(",")[0]?.trim();
	if (!address || !isIP(address))
		throw new ApiFailure(
			503,
			"VISITOR_IDENTITY_UNAVAILABLE",
			"无法验证访客来源，请检查受信代理配置",
		);
	return address;
}
export function visitorSubject(request: Request, site: string): string {
	const { secret } = turnstileConfiguration(request);
	return createHmac("sha256", process.env.INTERACTION_HASH_SECRET || secret)
		.update(`${site}\0${clientAddress(request)}`)
		.digest("hex");
}
export async function verifyTurnstile(
	request: Request,
	token: unknown,
	action: TurnstileAction,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const { secret, hostname } = turnstileConfiguration(request);
	const responseToken = text(token, "人机验证令牌", 2048);
	let response: Response;
	try {
		response = await fetcher(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					secret,
					response: responseToken,
					remoteip: clientAddress(request),
				}).toString(),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			},
		);
	} catch {
		throw new ApiFailure(
			503,
			"TURNSTILE_UNAVAILABLE",
			"人机验证服务暂时不可用",
		);
	}
	if (!response.ok)
		throw new ApiFailure(
			503,
			"TURNSTILE_UNAVAILABLE",
			"人机验证服务暂时不可用",
		);
	let result: Row;
	try {
		result = (await response.json()) as Row;
	} catch {
		throw new ApiFailure(
			503,
			"TURNSTILE_UNAVAILABLE",
			"人机验证服务返回无效结果",
		);
	}
	const challengeTime =
		typeof result?.challenge_ts === "string"
			? Date.parse(result.challenge_ts)
			: NaN;
	if (
		!result ||
		result.success !== true ||
		result.hostname !== hostname ||
		result.action !== action ||
		!Number.isFinite(challengeTime) ||
		challengeTime < Date.now() - 5 * 60_000 ||
		challengeTime > Date.now() + 60_000 ||
		(Array.isArray(result["error-codes"]) && result["error-codes"].length)
	)
		throw new ApiFailure(
			403,
			"TURNSTILE_REJECTED",
			"人机验证未通过，请重新验证",
		);
}

function writable(state: StoreState, site: string): void {
	assertSite(state, site);
	const lock = collection(state, "maintenance_locks").main;
	if (
		lock?.kind === "restore" &&
		lock.owner_id &&
		Date.parse(String(lock.lease_until)) > Date.now()
	)
		throw new ApiFailure(409, "MAINTENANCE_BUSY", "正在恢复备份，请稍后重试");
}
async function consumeRateLimit(
	store: FileStore,
	site: string,
	subject: string,
	resource: "comments" | "friends",
): Promise<void> {
	const seconds = resource === "comments" ? 60 : 3600;
	const maximum = resource === "comments" ? 5 : 3;
	const window = Math.floor(Date.now() / (seconds * 1000));
	const key = `${resource}:${subject}:${window}`;
	const hits = await store.update((state) => {
		writable(state, site);
		const counters = collection(state, "interaction_rate_limits");
		for (const [id, row] of Object.entries(counters))
			if (Number(row.expires_at) < Date.now()) delete counters[id];
		const count = Number(counters[key]?.hits || 0) + 1;
		counters[key] = {
			id: key,
			hits: count,
			expires_at: (window + 2) * seconds * 1000,
		};
		return count;
	});
	if (hits > maximum)
		throw new ApiFailure(
			429,
			"INTERACTION_RATE_LIMITED",
			"提交过于频繁，请稍后再试",
		);
}
function visitorAllowed(state: StoreState, subject: string): void {
	if (
		Object.values(collection(state, "visitor_bans")).some(
			(row) => row.subject === subject,
		)
	)
		throw new ApiFailure(403, "VISITOR_BANNED", "当前访客已被禁言");
}
function publishedArticle(state: StoreState, id: string): void {
	const entities = collection(state, "entities");
	const post = entities[`post:${id}`]?.data as Row | undefined;
	const baseline = entities["repository:baseline"]?.data as Row | undefined;
	if (
		!post ||
		typeof post.publishedSource !== "string" ||
		!Array.isArray(baseline?.posts) ||
		!baseline.posts.some((row: Row) => row.id === id) ||
		parseSourceDocument(post.publishedSource).metadata.comment === false
	)
		throw new ApiFailure(
			404,
			"PUBLISHED_ARTICLE_REQUIRED",
			"此文章尚未公开或未开放评论",
		);
}
type VerifiedSnapshot = Row & {
	id: string;
	taskId: string;
	digest: string;
	friendIds: string[];
	friendRevisions: Record<string, number>;
	settings: Row;
	posts: PublishedPost[];
	redirects: Redirect[];
};
function readVerifiedSnapshot(row: Row, state: StoreState): VerifiedSnapshot {
	const snapshotRow = collection(state, "release_snapshots")[
		String(row.snapshot_id)
	];
	const snapshot = snapshotRow?.data as VerifiedSnapshot | undefined;
	if (
		!snapshot ||
		snapshot.id !== row.snapshot_id ||
		snapshot.taskId !== row.id ||
		snapshot.digest !== snapshotRow.digest ||
		!Array.isArray(snapshot.posts) ||
		!Array.isArray(snapshot.redirects) ||
		!snapshot.settings ||
		publicContentDigest(
			snapshot.posts,
			snapshot.settings,
			snapshot.redirects,
		) !== snapshot.digest
	)
		throw new ApiFailure(
			409,
			"SNAPSHOT_INTEGRITY_FAILED",
			"公开友链发布快照校验失败",
		);
	return snapshot;
}
function verifiedTask(row: Row): boolean {
	const details = row.details as Row | undefined;
	return (
		row.kind === "publish" &&
		row.state === "verified" &&
		typeof row.target_sha === "string" &&
		/^[0-9a-f]{40}$/.test(row.target_sha) &&
		row.production_sha === row.target_sha &&
		typeof row.deployment_id === "string" &&
		Boolean(row.deployment_id) &&
		!details?.restored &&
		!details?.restoreRequiresReconciliation
	);
}
function publicFriends(state: StoreState): Row[] {
	const baseline = collection(state, "entities")["repository:baseline"]?.data as
		| Row
		| undefined;
	const row = collection(state, "release_tasks")[String(baseline?.taskId)];
	if (!row || !verifiedTask(row)) return [];
	const snapshot = readVerifiedSnapshot(row, state);
	if (
		baseline?.snapshotId !== snapshot.id ||
		baseline.publicContentDigest !== snapshot.digest ||
		baseline.headSha !== row.production_sha
	)
		throw new ApiFailure(
			409,
			"SNAPSHOT_INTEGRITY_FAILED",
			"当前公开基线与核验发布不一致",
		);
	if (!Array.isArray(snapshot.settings.friends)) return [];
	if (snapshot.settings.friends.length > maximumPublicRows)
		throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "公开友链数量异常");
	return (snapshot.settings.friends as Row[]).map((friend) => {
		if (
			typeof friend.sortOrder !== "number" ||
			!Number.isSafeInteger(friend.sortOrder)
		)
			throw new ApiFailure(
				409,
				"SNAPSHOT_INTEGRITY_FAILED",
				"公开友链排序异常",
			);
		return {
			id: identifier(friend.id, "友链 ID"),
			name: text(friend.name, "站点名称", 120),
			url: safeInteractionUrl(friend.url),
			description: text(friend.description, "站点描述", 2000),
			avatar: safeInteractionUrl(friend.avatar, true),
			group: text(friend.group, "分组", 120, true),
			sortOrder: friend.sortOrder,
		};
	});
}
/** Only verified immutable snapshots may advance a friend's published state. */
export async function markFriendsPublished(
	ids: string[],
	releaseId: string,
	revisions?: Record<string, number>,
	dependencies: Dependencies = {},
): Promise<void> {
	const store = dependencies.store || getStore();
	const site = dependencies.site || getSiteId();
	const now = new Date().toISOString();
	await store.update((state) => {
		writable(state, site);
		const row = collection(state, "release_tasks")[releaseId];
		if (!row || !verifiedTask(row))
			throw new ApiFailure(
				409,
				"VERIFIED_RELEASE_REQUIRED",
				"友链上线状态必须关联已核验的真实发布",
			);
		const snapshot = readVerifiedSnapshot(row, state);
		const expected = revisions || {};
		if (
			!Array.isArray(snapshot.friendIds) ||
			!snapshot.friendRevisions ||
			!Array.isArray(snapshot.settings.friends) ||
			ids.length !== snapshot.friendIds.length ||
			new Set(ids).size !== ids.length ||
			ids.some(
				(id) =>
					!snapshot.friendIds.includes(id) ||
					expected[id] !== snapshot.friendRevisions[id] ||
					!Number.isSafeInteger(expected[id]) ||
					expected[id] < 1,
			)
		)
			throw new ApiFailure(
				409,
				"FROZEN_FRIEND_REVISION_REQUIRED",
				"友链上线状态必须使用核验快照中的冻结版本",
			);
		const baseline = collection(state, "entities")["repository:baseline"]
			?.data as Row | undefined;
		const current = baseline?.taskId === releaseId;
		if (
			current &&
			(baseline.snapshotId !== snapshot.id ||
				baseline.publicContentDigest !== snapshot.digest ||
				baseline.headSha !== row.production_sha)
		)
			throw new ApiFailure(
				409,
				"SNAPSHOT_INTEGRITY_FAILED",
				"公开友链基线与发布不一致",
			);
		for (const id of ids) {
			const publicFriend = (snapshot.settings.friends as Row[]).find(
				(friend) => friend.id === id,
			);
			if (!publicFriend)
				throw new ApiFailure(
					409,
					"SNAPSHOT_INTEGRITY_FAILED",
					"公开友链与冻结申请不一致",
				);
			const candidate = collection(state, "friends")[id];
			const friend =
				candidate &&
				Number(candidate.revision) === expected[id] &&
				["approved", "published"].includes(String(candidate.status))
					? candidate
					: undefined;
			if (friend && current) {
				friend.status = "published";
				friend.published_at ||= now;
				friend.updated_at = now;
			}
		}
	});
}
export function registerInteractionRoutes(
	app: AdminApp,
	dependencies: Dependencies = {},
): void {
	const store = () => dependencies.store || getStore();
	const siteId = () => dependencies.site || getSiteId();
	app.use("/api/public/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/api/public/comments", async (c) => {
		requirePublicComments();
		const articleId = identifier(c.req.query("articleId"), "文章 ID");
		const page = commentPagination(
			c.req.query("limit"),
			c.req.query("cursor"),
			articleId,
		);
		const state = await store().read();
		assertSite(state, siteId());
		publishedArticle(state, articleId);
		const rows = Object.values(collection(state, "comments"))
			.filter(
				(row) =>
					row.article_id === articleId &&
					(!page.timestamp ||
						String(row.cursor_created_at) > page.timestamp ||
						(row.cursor_created_at === page.timestamp &&
							String(row.id) > String(page.id))),
			)
			.sort(
				(a, b) =>
					String(a.cursor_created_at).localeCompare(
						String(b.cursor_created_at),
					) || String(a.id).localeCompare(String(b.id)),
			)
			.slice(0, page.limit + 1);
		const data: Row[] = [];
		let bytes = 0;
		for (const row of rows.slice(0, page.limit)) {
			const record = commentRecord(row);
			const size = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
			if (bytes + size > maximumCommentPageBytes) {
				if (!data.length)
					throw new ApiFailure(
						409,
						"COMMENT_DATA_INVALID",
						"评论数据超过安全响应上限",
					);
				break;
			}
			data.push(record);
			bytes += size;
		}
		return c.json({
			data,
			nextCursor:
				rows.length > data.length
					? commentCursor(articleId, rows[data.length - 1])
					: null,
		});
	});
	app.post("/api/public/comments", async (c) => {
		requirePublicComments();
		const body = await readJson(c.req.raw, 32 * 1024);
		const articleId = identifier(body.articleId, "文章 ID");
		const parentId =
			body.parentId == null ? null : identifier(body.parentId, "回复 ID");
		const name = text(body.name, "昵称", 120);
		const content = text(body.body, "评论", 10_000);
		const address = email(body.email, true);
		const current = store();
		const site = siteId();
		const visitor = visitorSubject(c.req.raw, site);
		await consumeRateLimit(current, site, visitor, "comments");
		await verifyTurnstile(
			c.req.raw,
			body.turnstileToken,
			"comments",
			dependencies.fetcher,
		);
		const id = randomUUID();
		const now = new Date().toISOString();
		const data = await current.update((state) => {
			writable(state, site);
			visitorAllowed(state, visitor);
			publishedArticle(state, articleId);
			const rows = collection(state, "comments");
			if (
				parentId &&
				!(
					rows[parentId]?.article_id === articleId &&
					rows[parentId]?.status === "visible"
				)
			)
				throw new ApiFailure(
					400,
					"INVALID_COMMENT_PARENT",
					"回复必须属于同一篇文章中的可见评论",
				);
			const row = {
				id,
				article_id: articleId,
				parent_id: parentId,
				name,
				body: content,
				email: address || null,
				visitor_id: visitor,
				status: "visible",
				created_at: now,
				updated_at: now,
				cursor_created_at: `${now.slice(0, -1)}000Z`,
			};
			rows[id] = row;
			return commentRecord(row);
		});
		return c.json({ data }, 201);
	});
	app.get("/api/public/friends", async (c) => {
		const state = await store().read();
		assertSite(state, siteId());
		return c.json({ data: publicFriends(state) });
	});
	app.post("/api/public/friends", async (c) => {
		const body = await readJson(c.req.raw, 16 * 1024);
		const name = text(body.name, "站点名称", 120);
		const url = safeInteractionUrl(body.url);
		const description = text(body.description, "站点描述", 2000);
		const avatar = safeInteractionUrl(body.avatar, true);
		const address = email(body.email);
		const current = store();
		const site = siteId();
		const visitor = visitorSubject(c.req.raw, site);
		await consumeRateLimit(current, site, visitor, "friends");
		await verifyTurnstile(
			c.req.raw,
			body.turnstileToken,
			"friend_request",
			dependencies.fetcher,
		);
		const id = randomUUID();
		const now = new Date().toISOString();
		const data = await current.update((state) => {
			writable(state, site);
			visitorAllowed(state, visitor);
			const rows = collection(state, "friends");
			if (
				Object.values(rows).some(
					(row) =>
						row.url === url &&
						["pending", "approved", "published"].includes(String(row.status)),
				)
			)
				throw new ApiFailure(
					409,
					"FRIEND_APPLICATION_EXISTS",
					"此站点已有申请，请勿重复提交",
				);
			rows[id] = {
				id,
				name,
				url,
				description,
				avatar,
				email: address,
				status: "pending",
				group_name: "",
				sort_order: 0,
				revision: 1,
				rejection_reason: null,
				published_at: null,
				created_at: now,
				updated_at: now,
			};
			return { id, status: "pending" };
		});
		return c.json({ data }, 201);
	});
	app.get("/api/comments", requireAdmin, async (c) =>
		c.json({
			data: Object.values(collection(await store().read(), "comments"))
				.sort(
					(a, b) =>
						String(b.created_at).localeCompare(String(a.created_at)) ||
						String(a.id).localeCompare(String(b.id)),
				)
				.slice(0, 1000)
				.map((row) => commentRecord(row, true)),
		}),
	);
	app.post("/api/comments/:id/delete", requireAdmin, async (c) => {
		const id = identifier(c.req.param("id"), "评论 ID");
		const data = await store().update((state) => {
			writable(state, siteId());
			const row = collection(state, "comments")[id];
			if (!row) throw new ApiFailure(404, "COMMENT_NOT_FOUND", "评论不存在");
			Object.assign(row, {
				status: "deleted",
				body: "",
				name: "",
				email: null,
				updated_at: new Date().toISOString(),
			});
			return commentRecord(row, true);
		});
		return c.json({ data });
	});
	app.get("/api/bans", requireAdmin, async (c) =>
		c.json({
			data: Object.values(collection(await store().read(), "visitor_bans"))
				.sort((a, b) =>
					String(b.created_at).localeCompare(String(a.created_at)),
				)
				.map((row) => ({
					id: row.id,
					subject: row.subject,
					createdAt: row.created_at,
				})),
		}),
	);
	app.post("/api/bans", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096);
		const subject = text(body.subject, "访客标识", 64);
		if (!/^[0-9a-f]{64}$/.test(subject))
			throw new ApiFailure(400, "INVALID_VISITOR_SUBJECT", "访客标识不合法");
		const id = randomUUID();
		const now = new Date().toISOString();
		const data = await store().update((state) => {
			writable(state, siteId());
			const rows = collection(state, "visitor_bans");
			const row = Object.values(rows).find(
				(row) => row.subject === subject,
			) || { id, subject, created_at: now };
			rows[String(row.id)] = row;
			return { id: row.id, subject, createdAt: row.created_at };
		});
		return c.json({ data });
	});
	app.delete("/api/bans/:id", requireAdmin, async (c) => {
		const id = identifier(c.req.param("id"), "禁言 ID");
		await store().update((state) => {
			writable(state, siteId());
			const rows = collection(state, "visitor_bans");
			if (!rows[id])
				throw new ApiFailure(404, "BAN_NOT_FOUND", "禁言记录不存在");
			delete rows[id];
		});
		return c.json({ data: { id, deleted: true } });
	});
	app.get("/api/friends", requireAdmin, async (c) =>
		c.json({
			data: Object.values(collection(await store().read(), "friends"))
				.sort(
					(a, b) =>
						String(a.group_name).localeCompare(String(b.group_name)) ||
						Number(a.sort_order) - Number(b.sort_order) ||
						String(b.created_at).localeCompare(String(a.created_at)),
				)
				.map(friendRecord),
		}),
	);
	app.post("/api/friends/:id/approve", requireAdmin, async (c) => {
		const id = identifier(c.req.param("id"), "友链 ID");
		const data = await store().update((state) => {
			writable(state, siteId());
			const row = collection(state, "friends")[id];
			if (!row) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在");
			if (!["approved", "published"].includes(String(row.status)))
				row.revision = Number(row.revision) + 1;
			if (row.status !== "published") row.status = "approved";
			row.rejection_reason = null;
			row.updated_at = new Date().toISOString();
			return friendRecord(row);
		});
		return c.json({ data });
	});
	app.post("/api/friends/:id/reject", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096);
		const reason = text(body.reason, "拒绝理由", 2000);
		const id = identifier(c.req.param("id"), "友链 ID");
		const current = store();
		const site = siteId();
		const now = new Date().toISOString();
		const result = await current.update((state) => {
			writable(state, site);
			const row = collection(state, "friends")[id];
			if (!row) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在");
			if (row.status !== "rejected" || row.rejection_reason !== reason)
				row.revision = Number(row.revision) + 1;
			Object.assign(row, {
				status: "rejected",
				rejection_reason: reason,
				updated_at: now,
			});
			return friendRecord(row);
		});
		return c.json({ data: result });
	});
	app.patch("/api/friends/:id", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 4096);
		const group = text(body.group, "分组", 120, true);
		const order = body.sortOrder;
		if (
			typeof order !== "number" ||
			!Number.isSafeInteger(order) ||
			order < -2147483648 ||
			order > 2147483647
		)
			throw new ApiFailure(400, "INVALID_SORT_ORDER", "排序值必须是有效整数");
		const id = identifier(c.req.param("id"), "友链 ID");
		const data = await store().update((state) => {
			writable(state, siteId());
			const row = collection(state, "friends")[id];
			if (!row) throw new ApiFailure(404, "FRIEND_NOT_FOUND", "友链申请不存在");
			if (row.group_name !== group || row.sort_order !== order)
				row.revision = Number(row.revision) + 1;
			Object.assign(row, {
				group_name: group,
				sort_order: order,
				updated_at: new Date().toISOString(),
			});
			return friendRecord(row);
		});
		return c.json({ data });
	});
}
