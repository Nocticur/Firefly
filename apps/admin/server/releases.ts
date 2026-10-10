import { randomUUID } from "node:crypto";
import { z } from "zod";
import { start } from "workflow/api";
import type { AdminApp } from "./types.js";
import type { PostRecord, TaskRecord } from "../shared/contracts.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, requireProduction, readJson } from "./security.js";
import { githubProvider, GitHubError, type GitHubProvider, type RepositoryFile } from "./github.js";
import { assertDeploymentConfigRedirects, buildDeploymentConfig, canonicalJson, publicContentDigest, publicSettings, publishedSource, sha256, type PublishedPost, type Redirect } from "./release-format.js";
import { publishWorkflow } from "../workflows/publish.js";
import { requireAdmin } from "./auth.js";

type Row = Record<string, unknown>;
export type ReleaseTaskRow = Row & { id: string; kind: string; state: string; details: Row; snapshot_id: string; base_sha: string; target_sha: string | null; fence: number | null; created_at: string; updated_at: string };
export type FrozenSnapshot = {
	id: string; taskId: string; digest: string; posts: PublishedPost[]; sources: Array<{ id: string; revision: number; source: string; originalSource?: string; filePath: string; slug: string }>;
	files: RepositoryFile[]; deletions: string[]; settings: Record<string, unknown>; redirects: Redirect[];
	entityRevisions: Array<{ kind: string; id: string; revision: number }>; friendIds: string[];
	friendRevisions: Record<string, number>; selectedIds: string[];
	friendNotifications?: Record<string, { name: string; email: string; revision: number }>;
	media?: Record<string, Row & { id: string; pathname: string; digest: string; size: number; contentType: string; revision: number }>;
	originalSettings?: Record<string, unknown>;
	deploymentConfig?: Record<string, unknown>;
};
const mediaPattern = /(?:media:([a-zA-Z0-9-]+)|\/api\/media\/([a-zA-Z0-9-]+)\/content)/g;
function referencedMedia(sources: FrozenSnapshot["sources"], settings: Record<string, unknown>): string[] {
	return [...new Set([...sources.map((source) => source.source), JSON.stringify(settings)].flatMap((value) => [...value.matchAll(mediaPattern)].map((match) => (match[1] || match[2])!)))];
}
function replaceMedia(value: unknown, urls: Record<string, string>): unknown {
	if (typeof value === "string") return value.replace(mediaPattern, (_match, a: string, b: string) => { const url = urls[a || b]; if (!url) throw new Error("Frozen media copy is missing"); return url; });
	if (Array.isArray(value)) return value.map((item) => replaceMedia(item, urls));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceMedia(item, urls)]));
	return value;
}
const terminalStates = new Set(["verified", "failed", "conflict"]);
export function assertPublishCapability(): void {
	requireProduction();
	if (process.env.ENABLE_PRODUCTION_PUBLISH !== "true") throw new ApiFailure(403, "PUBLISH_DISABLED", "生产发布开关尚未启用");
	for (const name of ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "VERCEL_TOKEN", "VERCEL_BLOG_PROJECT_ID"]) {
		if (!process.env[name]) throw new ApiFailure(503, "PUBLISH_CONFIGURATION_REQUIRED", `缺少 ${name}`);
	}
}
export function taskRecord(row: Row): TaskRecord {
	return { id: String(row.id), kind: String(row.kind), state: String(row.state), snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined,
		targetSha: row.target_sha ? String(row.target_sha) : null, productionSha: row.production_sha ? String(row.production_sha) : null,
		deploymentId: row.deployment_id ? String(row.deployment_id) : null, message: row.message ? String(row.message) : null,
		createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
}
const releaseInput = z.object({ postIds: z.array(z.string().min(1)).max(200), expectedRevisions: z.record(z.string(), z.number().int().nonnegative()), idempotencyKey: z.string().min(8).max(200) });
export async function freezeRelease(input: z.infer<typeof releaseInput>, db = getDatabase(), site = getSiteId()): Promise<TaskRecord> {
	return db.transaction(async (tx) => {
		// Serialise only the short snapshot transaction, never a deployment wait.
		await tx.query("INSERT INTO release_locks(site_id) VALUES($1) ON CONFLICT DO NOTHING", [site]);
		await tx.query("SELECT site_id FROM release_locks WHERE site_id=$1 FOR UPDATE", [site]);
		const existing = await tx.query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND idempotency_key=$2", [site, input.idempotencyKey]);
		if (existing[0]) return taskRecord(existing[0]);
		if ((await tx.query("SELECT id FROM release_tasks WHERE site_id=$1 AND kind='publish' AND details->>'restoreRequiresReconciliation'='true' LIMIT 1", [site])).length) throw new ApiFailure(409, "RESTORED_PUBLISH_RECONCILIATION_REQUIRED", "恢复的发布记录必须先核查 Git 与生产结果，不能直接重新发布旧草稿");
		const baseline = await tx.query<Row>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline'", [site]);
		const base = baseline[0]?.data as Record<string, unknown> | undefined;
		if (typeof base?.headSha !== "string") throw new ApiFailure(409, "BASELINE_REQUIRED", "先导入仓库基线，再发布内容");
		const postRows = await tx.query<Row>("SELECT id,data,revision FROM entities WHERE site_id=$1 AND kind='post' ORDER BY id FOR SHARE", [site]);
		const selected = new Set(input.postIds);
		if (selected.size !== input.postIds.length) throw new ApiFailure(400, "DUPLICATE_POST", "发布选择包含重复文章");
		for (const id of selected) if (!postRows.some((row) => row.id === id)) throw new ApiFailure(404, "POST_NOT_FOUND", `文章不存在: ${id}`);
		const sources: FrozenSnapshot["sources"] = [];
		for (const row of postRows) {
			const post = row.data as PostRecord;
			if (selected.has(String(row.id))) {
				if (input.expectedRevisions[String(row.id)] !== Number(row.revision)) throw new ApiFailure(409, "REVISION_CONFLICT", "文章已更新，请重新选择当前版本", { id: row.id, expected: input.expectedRevisions[String(row.id)], actual: Number(row.revision) });
				if (post.draft) throw new ApiFailure(409, "PRIVATE_DRAFT_SELECTED", "请先明确取消草稿标记并保存，再选择发布", { id: row.id });
				let source: string;
				try { source = publishedSource(post.source); } catch (error) { throw new ApiFailure(400, "INVALID_PUBLISH_SOURCE", (error as Error).message); }
				sources.push({ id: String(row.id), revision: Number(row.revision), filePath: post.filePath, slug: post.slug, source, originalSource: source });
			} else if (typeof post.publishedSource === "string") {
				const publishedPosts = Array.isArray(base.posts) ? base.posts as PublishedPost[] : [];
				const old = publishedPosts.find((item) => item.id === row.id);
				sources.push({ id: String(row.id), revision: post.publishedRevision ?? 1, filePath: old?.filePath || post.filePath, slug: old?.slug || post.slug, source: post.publishedSource });
			}
		}
		const entityRows = await tx.query<Row>("SELECT kind,id,data,revision FROM entities WHERE site_id=$1 AND kind IN ('settings','navigation','icons') ORDER BY kind,id FOR SHARE", [site]);
		const settingsRow = entityRows.find((row) => row.kind === "settings" && row.id === "default");
		const settings: Record<string, unknown> = { schemaVersion: 1, settings: publicSettings((settingsRow?.data || {}) as Record<string, unknown>), navigation: null, icons: {} };
		const navigation = entityRows.find((row) => row.kind === "navigation" && row.id === "default");
		if (navigation) settings.navigation = navigation.data;
		const icons = entityRows.find((row) => row.kind === "icons" && row.id === "default");
		if (icons) settings.icons = icons.data;
		const friends = await tx.query<Row>("SELECT id,name,url,avatar,description,email,group_name,sort_order,revision FROM friends WHERE site_id=$1 AND status IN ('approved','published') ORDER BY group_name,sort_order,id FOR SHARE", [site]);
		settings.friends = friends.map((row) => ({ id: row.id, name: row.name, url: row.url, avatar: row.avatar, description: row.description, group: row.group_name, sortOrder: row.sort_order }));
		const oldPosts = Array.isArray(base.posts) ? base.posts as PublishedPost[] : [];
		const previousRedirects = (Array.isArray(base.redirects) ? base.redirects : []) as Redirect[];
		const redirects = structuredClone(previousRedirects);
		for (const source of sources) {
			const old = oldPosts.find((post) => post.id === source.id);
			if (old && old.slug !== source.slug) {
				const from = `/posts/${old.slug.replace(/^\/+|\/+$/g, "")}/`; const to = `/posts/${source.slug.replace(/^\/+|\/+$/g, "")}/`;
				for (const redirect of redirects) if (redirect.to === from) redirect.to = to;
				const prior = redirects.find((redirect) => redirect.from === from);
				if (prior) prior.to = to; else redirects.push({ from, to, permanent: true });
			}
		}
		if (new Set(sources.map((post) => post.slug)).size !== sources.length) throw new ApiFailure(409, "SLUG_CONFLICT", "公开文章网址重复");
		if (new Set(sources.map((post) => post.filePath)).size !== sources.length) throw new ApiFailure(409, "PATH_CONFLICT", "公开文章文件路径重复");
		const activeRoutes = new Map(sources.map((post) => [`/posts/${post.slug.replace(/^\/+|\/+$/g, "")}/`, post.id]));
		for (const redirect of redirects) if (activeRoutes.has(redirect.from)) throw new ApiFailure(409, "SLUG_REDIRECT_CONFLICT", "该网址保留为已发布文章的永久重定向，请为当前文章选择其他 slug", { id: activeRoutes.get(redirect.from), from: redirect.from, to: redirect.to });
		const taskId = randomUUID(); const snapshotId = randomUUID();
		const posts = sources.map(({ id, filePath, slug, source }) => ({ id, filePath, slug, sourceSha256: sha256(source) }));
		const digest = publicContentDigest(posts, settings, redirects);
		const files = sources.map(({ filePath, source }) => ({ path: filePath, source }));
		const publishedState = { schemaVersion: 1, posts, taskId, snapshotId, publicContentDigest: digest };
		files.push({ path: "src/data/published-state.json", source: `${JSON.stringify(publishedState, null, 2)}\n` }, { path: "src/data/managed-settings.json", source: `${JSON.stringify(settings, null, 2)}\n` }, { path: "src/data/redirects.json", source: `${JSON.stringify(redirects, null, 2)}\n` });
		const snapshot: FrozenSnapshot = { id: snapshotId, taskId, digest, posts, sources, files, settings, redirects, friendIds: friends.map((row) => String(row.id)), friendRevisions: Object.fromEntries(friends.map((row) => [String(row.id), Number(row.revision)])), selectedIds: [...selected], entityRevisions: entityRows.map((row) => ({ kind: String(row.kind), id: String(row.id), revision: Number(row.revision) })), deletions: oldPosts.filter((old) => selected.has(old.id) && !posts.some((post) => post.filePath === old.filePath)).map((old) => old.filePath) };
		try { snapshot.deploymentConfig = buildDeploymentConfig(base.deploymentConfig, redirects, previousRedirects); }
		catch (error) { throw new ApiFailure(409, "PERMANENT_REDIRECT_CONFIGURATION_REQUIRED", (error as Error).message); }
		if (snapshot.deploymentConfig) files.push({ path: "vercel.json", source: `${JSON.stringify(snapshot.deploymentConfig, null, 2)}\n` });
		const mediaIds = referencedMedia(sources, settings);
		const mediaRows = await tx.query<Row>("SELECT id,data,revision FROM entities WHERE site_id=$1 AND kind='media' AND id=ANY($2::text[]) FOR SHARE", [site, mediaIds]);
		snapshot.media = {};
		for (const mediaId of mediaIds) {
			const mediaRow = mediaRows.find((row) => row.id === mediaId); const data = mediaRow?.data as Row | undefined;
			if (!mediaRow || !data || data.deleted || typeof data.pathname !== "string" || typeof data.digest !== "string" || typeof data.contentType !== "string" || typeof data.size !== "number") throw new ApiFailure(409, "MEDIA_REFERENCE_INVALID", "发布快照中的私有媒体不存在或记录不完整", { id: mediaId });
			snapshot.media[mediaId] = { ...data, id: mediaId, pathname: data.pathname, digest: data.digest, contentType: data.contentType, size: data.size, revision: Number(mediaRow.revision) };
		}
		snapshot.originalSettings = structuredClone(settings);
		// Notification recipients stay in the private SQL snapshot, never in Git or manifests.
		snapshot.friendNotifications = Object.fromEntries(friends.map((row) => [String(row.id), { name: String(row.name), email: String(row.email), revision: Number(row.revision) }]));
		for (const file of files) if (!(file.path === "vercel.json" || /^src\/(?:content\/posts\/[^\0]+\.mdx?|data\/(?:published-state|managed-settings|redirects)\.json)$/.test(file.path)) || file.path.split("/").includes("..")) throw new ApiFailure(400, "UNSAFE_REPOSITORY_PATH", "发布路径不在允许的内容目录");
		await tx.query("INSERT INTO release_snapshots(site_id,id,digest,data) VALUES($1,$2,$3,$4::jsonb)", [site, snapshotId, digest, JSON.stringify(snapshot)]);
		const rows = await tx.query<Row>("INSERT INTO release_tasks(site_id,id,idempotency_key,state,snapshot_id,base_sha) VALUES($1,$2,$3,'preparing',$4,$5) RETURNING *", [site, taskId, input.idempotencyKey, snapshotId, base.headSha]);
		return taskRecord(rows[0]);
	});
}

export async function claimReleaseTask(db: Database, site: string, id: string, reconcileRestored = false): Promise<number | null> {
	return db.transaction(async (tx) => {
		const locks = await tx.query<Row>("SELECT * FROM release_locks WHERE site_id=$1 FOR UPDATE", [site]);
		const lock = locks[0];
		if (!lock) return null;
		if (!reconcileRestored && (await tx.query("SELECT id FROM release_tasks WHERE site_id=$1 AND kind='publish' AND details->>'restoreRequiresReconciliation'='true' LIMIT 1", [site])).length) return null;
		const [task] = await tx.query<ReleaseTaskRow>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2 FOR UPDATE", [site, id]);
		if (!task || task.kind !== "publish" || terminalStates.has(task.state) || !reconcileRestored && (task.state === "blocked" || task.details?.restoreRequiresReconciliation)) return null;
		const [lease] = await tx.query<Row>("SELECT lease_until>now() AS active FROM release_locks WHERE site_id=$1", [site]);
		if (lock.task_id === id && lease.active) return null;
		if (lock.task_id && lock.task_id !== id) {
			const owner = await tx.query<Row>("SELECT state FROM release_tasks WHERE site_id=$1 AND id=$2", [site, lock.task_id]);
			// An expired lease never transfers an unfinished/unknown side effect to another task.
			if (!owner[0] || !terminalStates.has(String(owner[0].state))) return null;
		}
		const rows = await tx.query<Row>("UPDATE release_locks SET task_id=$2,fencing_token=fencing_token+1,lease_until=now()+interval '150 seconds' WHERE site_id=$1 RETURNING fencing_token", [site, id]);
		const fence = Number(rows[0].fencing_token);
		await tx.query("UPDATE release_tasks SET fence=$3,state=CASE WHEN $4::boolean AND state='blocked' THEN CASE WHEN target_sha IS NULL THEN 'unknown' ELSE 'deploying' END ELSE state END,updated_at=now() WHERE site_id=$1 AND id=$2", [site, id, fence, reconcileRestored]);
		return fence;
	});
}
async function updateTask(db: Database, site: string, id: string, fence: number, state: string, fields: Row = {}): Promise<boolean> {
	const rows = await db.query<Row>("UPDATE release_tasks SET state=$4,target_sha=COALESCE($5,target_sha),production_sha=COALESCE($6,production_sha),deployment_id=COALESCE($7,deployment_id),message=$8,details=details || $9::jsonb,updated_at=now() WHERE site_id=$1 AND id=$2 AND fence=$3 AND state NOT IN ('verified','failed','conflict','blocked') AND EXISTS(SELECT 1 FROM release_locks WHERE site_id=$1 AND task_id=$2 AND fencing_token=$3 AND lease_until>now()) RETURNING id", [site, id, fence, state, fields.targetSha || null, fields.productionSha || null, fields.deploymentId || null, fields.message || null, JSON.stringify(fields.details || {})]);
	return rows.length === 1;
}
async function renewReleaseLease(db: Database, site: string, id: string, fence: number): Promise<boolean> {
	return (await db.query("UPDATE release_locks SET lease_until=now()+interval '150 seconds' WHERE site_id=$1 AND task_id=$2 AND fencing_token=$3 AND lease_until>now() RETURNING site_id", [site, id, fence])).length === 1;
}
function refreshSnapshotFiles(snapshot: FrozenSnapshot): void {
	snapshot.posts = snapshot.sources.map(({ id, filePath, slug, source }) => ({ id, filePath, slug, sourceSha256: sha256(source) }));
	snapshot.digest = publicContentDigest(snapshot.posts, snapshot.settings, snapshot.redirects);
	snapshot.files = snapshot.sources.map(({ filePath, source }) => ({ path: filePath, source }));
	snapshot.files.push({ path: "src/data/published-state.json", source: `${JSON.stringify({ schemaVersion: 1, posts: snapshot.posts, taskId: snapshot.taskId, snapshotId: snapshot.id, publicContentDigest: snapshot.digest }, null, 2)}\n` }, { path: "src/data/managed-settings.json", source: `${JSON.stringify(snapshot.settings, null, 2)}\n` }, { path: "src/data/redirects.json", source: `${JSON.stringify(snapshot.redirects, null, 2)}\n` });
	if (snapshot.deploymentConfig) {
		assertDeploymentConfigRedirects(snapshot.deploymentConfig, snapshot.redirects);
		snapshot.files.push({ path: "vercel.json", source: `${JSON.stringify(snapshot.deploymentConfig, null, 2)}\n` });
	} else if (snapshot.redirects.length) throw new ApiFailure(409, "PERMANENT_REDIRECT_CONFIGURATION_REQUIRED", "永久重定向必须与冻结的 Vercel 配置一同提交");
}

export type DeploymentVerification = { status: "waiting" | "failed" | "verified"; sha?: string; deploymentId?: string; message?: string };
export interface DeploymentProvider { verify(sha: string, snapshot: FrozenSnapshot): Promise<DeploymentVerification> }
async function vercel<T>(path: string): Promise<T> {
	const team = process.env.VERCEL_TEAM_ID;
	const response = await fetch(`https://api.vercel.com${path}${team ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(team)}` : ""}`, { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
	if (!response.ok) throw new Error(`Vercel verification failed (${response.status})`);
	return response.json() as Promise<T>;
}
export const deploymentProvider: DeploymentProvider = {
	async verify(targetSha, snapshot) {
		const projectId = process.env.VERCEL_BLOG_PROJECT_ID;
		if (!projectId) throw new Error("Vercel blog project is not configured");
		const listing = await vercel<{ deployments: Array<Row> }>(`/v6/deployments?projectId=${encodeURIComponent(projectId || "")}&target=production&limit=50`);
		const deployment = listing.deployments.find((entry) => String((entry.meta as Row)?.githubCommitSha || (entry.gitSource as Row)?.sha || "") === targetSha);
		if (!deployment) return { status: "waiting", message: "等待目标 Git 版本构建" };
		if (["ERROR", "CANCELED"].includes(String(deployment.state || deployment.readyState))) return { status: "failed", message: "目标生产构建失败", deploymentId: String(deployment.uid || deployment.id) };
		if ((deployment.state || deployment.readyState) !== "READY") return { status: "waiting", message: "完整构建仍在运行" };
		const alias = await vercel<Row>("/v4/aliases/blog.mourn.top");
		const deployedId = String(deployment.uid || deployment.id);
		const aliasDeployment = typeof alias.deployment === "object" ? String((alias.deployment as Row).id) : String(alias.deploymentId || "");
		if (String(alias.projectId) !== projectId || aliasDeployment !== deployedId) return { status: "waiting", message: "生产域名尚未指向目标项目部署" };
		const detail = await vercel<Row>(`/v13/deployments/${encodeURIComponent(deployedId)}`);
		if (String(detail.projectId) !== projectId || detail.target !== "production" || detail.readyState !== "READY" || String((detail.meta as Row)?.githubCommitSha || (detail.gitSource as Row)?.sha || "") !== targetSha) return { status: "waiting", message: "目标项目、Git 版本或生产环境不一致" };
		const host = String(detail.url || deployment.url);
		if (!/^[a-zA-Z0-9.-]+\.vercel\.app$/.test(host)) throw new Error("Unsafe deployment verification URL");
		const manifests = await Promise.all([`https://${host}`, "https://blog.mourn.top"].map(async (origin) => {
			const response = await fetch(`${origin}/release-manifest.json?task=${encodeURIComponent(snapshot.taskId)}&nonce=${randomUUID()}`, { cache: "no-store", redirect: "error", headers: { "Cache-Control": "no-cache", ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) }, signal: AbortSignal.timeout(15_000) });
			if (!response.ok) return null;
			return response.json() as Promise<Row>;
		}));
		if (manifests.some((manifest) => !manifest || manifest.schemaVersion !== 1 || manifest.gitSha !== targetSha || manifest.publicContentDigest !== snapshot.digest || manifest.snapshotId !== snapshot.id || (manifest.taskId || manifest.releaseTaskId) !== snapshot.taskId)) return { status: "waiting", message: "部署地址及生产域名发布清单尚未同时匹配冻结快照" };
		if (canonicalJson(manifests[0]) !== canonicalJson(manifests[1])) return { status: "waiting", message: "生产域名与部署产物清单不同" };
		const currentAlias = await vercel<Row>("/v4/aliases/blog.mourn.top");
		const currentDeployment = typeof currentAlias.deployment === "object" && currentAlias.deployment !== null ? String((currentAlias.deployment as Row).id) : String(currentAlias.deploymentId || "");
		if (String(currentAlias.projectId) !== projectId || currentDeployment !== deployedId) return { status: "waiting", message: "核验期间生产域名已切换，请继续核对当前部署" };
		return { status: "verified", sha: targetSha, deploymentId: deployedId };
	},
};

export type ReleaseDependencies = {
	db?: Database; site?: string; github?: GitHubProvider; deployment?: DeploymentProvider; skipCapabilityCheck?: boolean;
	// Only an explicit authenticated reconcile action may inspect restored jobs.
	reconcileRestored?: boolean;
	prepareMedia?: (ids: string[], taskId: string, snapshot: FrozenSnapshot) => Promise<Record<string, string>>;
	afterVerified?: (snapshot: FrozenSnapshot, db: Database, site: string) => Promise<void>;
};
export async function processReleaseTask(id: string, dependencies?: ReleaseDependencies): Promise<{ done: boolean; state: string }> {
	if (!dependencies?.skipCapabilityCheck) assertPublishCapability();
	const db = dependencies?.db || getDatabase(); const site = dependencies?.site || getSiteId(); const git = dependencies?.github || githubProvider; const deployment = dependencies?.deployment || deploymentProvider;
	const notifyVerified = async (snapshot: FrozenSnapshot) => {
		if (dependencies?.afterVerified) await dependencies.afterVerified(snapshot, db, site);
		else {
			const { markFriendsPublished } = await import("./interactions.js");
			await markFriendsPublished(snapshot.friendIds, id, snapshot.friendRevisions, { db, site });
		}
	};
	const [initial] = await db.query<ReleaseTaskRow>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [site, id]);
	if (!initial) throw new ApiFailure(404, "TASK_NOT_FOUND", "发布任务不存在");
	if (initial.kind !== "publish") throw new ApiFailure(400, "NOT_A_PUBLISH_TASK", "维护任务不能进入发布流程");
	const restored = Boolean(initial.details?.restoreRequiresReconciliation);
	if ((initial.state === "blocked" || restored) && !dependencies?.reconcileRestored) return { done: false, state: "blocked" };
	if (terminalStates.has(initial.state)) {
		if (initial.state === "verified" && !initial.details?.restored) {
			const [record] = await db.query<Row>("SELECT data FROM release_snapshots WHERE site_id=$1 AND id=$2", [site, initial.snapshot_id]);
			if (record) await notifyVerified(record.data as FrozenSnapshot);
		}
		return { done: true, state: initial.state };
	}
	const fence = await claimReleaseTask(db, site, id, Boolean(dependencies?.reconcileRestored)); if (fence === null) return { done: false, state: "queued" };
	let task = (await db.query<ReleaseTaskRow>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [site, id]))[0]!;
	let target = task.target_sha;
	let commitAttempted = false;
	let notificationPending = false;
	let lostLease = false;
	let heartbeatRunning = false;
	const heartbeat = setInterval(() => {
		if (heartbeatRunning || lostLease) return;
		heartbeatRunning = true;
		void renewReleaseLease(db, site, id, fence).then((active) => { if (!active) lostLease = true; }, () => { lostLease = true; }).finally(() => { heartbeatRunning = false; });
	}, 30_000);
	heartbeat.unref();
	const retainLease = async () => {
		if (lostLease || !await renewReleaseLease(db, site, id, fence)) { lostLease = true; throw new Error("Release lease was superseded"); }
	};
	const persistedState = async (): Promise<{ done: boolean; state: string }> => {
		const [current] = await db.query<ReleaseTaskRow>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [site, id]);
		return { done: Boolean(current && terminalStates.has(current.state)), state: current?.state || "unknown" };
	};
	try {
		const [record] = await db.query<Row>("SELECT data,digest FROM release_snapshots WHERE site_id=$1 AND id=$2", [site, task.snapshot_id]);
		const snapshot = record?.data as FrozenSnapshot | undefined;
		if (!snapshot || snapshot.id !== task.snapshot_id || snapshot.taskId !== id || snapshot.digest !== record?.digest || publicContentDigest(snapshot.posts, snapshot.settings, snapshot.redirects) !== snapshot.digest || snapshot.sources.some((source) => snapshot.posts.find((post) => post.id === source.id)?.sourceSha256 !== sha256(source.source))) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "冻结发布快照校验失败；保留记录并重新审核快照");
		if (restored && !target && !["committing", "unknown"].includes(String(initial.details?.restorePreviousState))) {
			await updateTask(db, site, id, fence, "failed", { message: "恢复的任务尚未提交；已保留草稿，重新选择当前版本并冻结后再发布", details: { restoreRequiresReconciliation: false, restoredTaskCanceled: true } });
			return persistedState();
		}
		if (task.state === "preparing") {
			const ids = referencedMedia(snapshot.sources, snapshot.settings);
			if (ids.length) {
				await retainLease();
				let urls: Record<string, string>;
				if (dependencies?.prepareMedia) urls = await dependencies.prepareMedia(ids, id, snapshot);
				else {
					const { publishMediaForSnapshot } = await import("./media.js");
					urls = await publishMediaForSnapshot(ids, id, { db, site, frozenMedia: snapshot.media });
				}
				for (const source of snapshot.sources) source.source = replaceMedia(source.source, urls) as string;
				snapshot.settings = replaceMedia(snapshot.settings, urls) as Record<string, unknown>;
			}
			refreshSnapshotFiles(snapshot);
			const frozen = await db.transaction(async (tx) => {
				await tx.query("SELECT site_id FROM release_locks WHERE site_id=$1 FOR UPDATE", [site]);
				if (!await updateTask(tx, site, id, fence, "frozen")) return false;
				await tx.query("UPDATE release_snapshots SET digest=$3,data=$4::jsonb WHERE site_id=$1 AND id=$2", [site, snapshot.id, snapshot.digest, JSON.stringify(snapshot)]);
				return true;
			});
			if (!frozen) return persistedState();
			task.state = "frozen";
		}
		if (!target && ["committing", "unknown"].includes(task.state)) {
			await retainLease();
			target = await git.findCommit(id, snapshot.digest);
			if (!target) {
				await updateTask(db, site, id, fence, "unknown", { message: "提交结果仍未知；禁止再次执行提交，先核查 Git 任务标记" });
				return persistedState();
			}
			if (!await updateTask(db, site, id, fence, "deploying", { targetSha: target })) return persistedState();
		}
		if (!target) {
			await retainLease();
			const repository = await git.readRepositoryFiles();
			if (repository.headSha !== task.base_sha) {
				const diff = snapshot.files.filter((file) => repository.files.find((current) => current.path === file.path)?.source !== file.source).map((file) => ({ path: file.path, expectedSource: file.source, remoteSource: repository.files.find((current) => current.path === file.path)?.source ?? null }));
				await updateTask(db, site, id, fence, "conflict", { message: "发布分支有未导入的外部修改，请比较差异后重新导入", details: { baseSha: task.base_sha, remoteSha: repository.headSha, diff } });
				return persistedState();
			}
			await retainLease();
			if (!await updateTask(db, site, id, fence, "committing")) return persistedState();
			// Persist the intention before the only non-idempotent external side effect.
			task.state = "committing";
			commitAttempted = true;
			target = await git.commit({ baseSha: task.base_sha, taskId: id, digest: snapshot.digest, files: snapshot.files, deletions: snapshot.deletions });
			if (!await updateTask(db, site, id, fence, "deploying", { targetSha: target })) return persistedState();
		}
		await retainLease();
		const verified = await deployment.verify(target, snapshot);
		if (verified.status === "failed") {
			await updateTask(db, site, id, fence, "failed", { message: verified.message, deploymentId: verified.deploymentId, details: restored ? { restoreRequiresReconciliation: false } : {} });
			return persistedState();
		}
		if (verified.status !== "verified" || verified.sha !== target || !verified.deploymentId) {
			await updateTask(db, site, id, fence, "deploying", { message: verified.message || "生产部署身份尚未完整核验" });
			return persistedState();
		}
		const finalized = await db.transaction(async (tx) => {
			await tx.query("SELECT site_id FROM release_locks WHERE site_id=$1 FOR UPDATE", [site]);
			if (!await updateTask(tx, site, id, fence, "verified", { productionSha: target, deploymentId: verified.deploymentId, message: "Git、目标项目生产别名及两处发布清单已核验一致", details: restored ? { restoreRequiresReconciliation: false } : {} })) return false;
			for (const source of snapshot.sources) await tx.query("UPDATE entities SET data=jsonb_set(jsonb_set(data,'{publishedSource}',to_jsonb($3::text)),'{publishedRevision}',to_jsonb($4::int)),updated_at=now() WHERE site_id=$1 AND kind='post' AND id=$2", [site, source.id, source.source, source.revision]);
			await tx.query("UPDATE entities SET data=data || $2::jsonb,updated_at=now() WHERE site_id=$1 AND kind='repository' AND id='baseline'", [site, JSON.stringify({ headSha: target, posts: snapshot.posts, redirects: snapshot.redirects, snapshotId: snapshot.id, taskId: id, publicContentDigest: snapshot.digest, publishedSettings: snapshot.settings.settings, publishedNavigation: snapshot.settings.navigation, publishedIcons: snapshot.settings.icons, ...(snapshot.deploymentConfig ? { deploymentConfig: snapshot.deploymentConfig } : {}) })]);
			await tx.query("UPDATE release_locks SET task_id=NULL,lease_until=now() WHERE site_id=$1 AND task_id=$2 AND fencing_token=$3", [site, id, fence]);
			return true;
		});
		if (!finalized) return persistedState();
		// Replaying a verified task repairs an interrupted notification transaction.
		if (!initial.details?.restored) try { await notifyVerified(snapshot); } catch {
			notificationPending = true;
			throw new Error("Production is verified; the durable notification hook must be reconciled");
		}
		return { done: true, state: "verified" };
	} catch (error) {
		if (notificationPending) throw error;
		if (lostLease) return persistedState();
		const state = error instanceof GitHubError && error.conflict && !error.uncertain ? "conflict" : !target && (commitAttempted || task.state === "unknown" || task.state === "committing" || error instanceof GitHubError && error.uncertain) ? "unknown" : target ? "deploying" : error instanceof ApiFailure && error.status < 500 ? "failed" : task.state;
		await updateTask(db, site, id, fence, state, { message: error instanceof GitHubError || error instanceof ApiFailure ? error.message : "外部服务核验失败，请检查配置后继续核验" });
		return persistedState();
	} finally {
		clearInterval(heartbeat);
		await db.query("UPDATE release_locks SET lease_until=now() WHERE site_id=$1 AND task_id=$2 AND fencing_token=$3", [site, id, fence]);
	}
}
export async function scheduleReleaseTask(id: string): Promise<void> {
	const run = await start(publishWorkflow, [id]);
	await getDatabase().query("UPDATE release_tasks SET workflow_id=$3,updated_at=now() WHERE site_id=$1 AND id=$2", [getSiteId(), id, run.runId]);
}
export function registerReleaseRoutes(app: AdminApp): void {
	app.post("/api/releases", requireAdmin, async (c) => {
		assertPublishCapability();
		const parsed = releaseInput.safeParse(await readJson(c.req.raw)); if (!parsed.success) throw new ApiFailure(400, "INVALID_RELEASE", "提供 postIds、expectedRevisions 和幂等键");
		const task = await freezeRelease(parsed.data);
		try { await scheduleReleaseTask(task.id); } catch { /* Durable task remains in DB; cron/open-dashboard reconcile resumes it. */ }
		return c.json({ data: task }, 202);
	});
	app.get("/api/tasks", requireAdmin, async (c) => {
		const rows = await getDatabase().query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 ORDER BY created_at DESC LIMIT 100", [getSiteId()]);
		return c.json({ data: rows.map(taskRecord) });
	});
	app.get("/api/tasks/:id", requireAdmin, async (c) => {
		const rows = await getDatabase().query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [getSiteId(), c.req.param("id")]);
		if (!rows[0]) throw new ApiFailure(404, "TASK_NOT_FOUND", "任务不存在");
		return c.json({ data: { ...taskRecord(rows[0]), details: rows[0].details } });
	});
	app.post("/api/tasks/:id/reconcile", requireAdmin, async (c) => {
		const id = c.req.param("id");
		const [task] = await getDatabase().query<Row>("SELECT kind,details FROM release_tasks WHERE site_id=$1 AND id=$2", [getSiteId(), id]);
		if (!task) throw new ApiFailure(404, "TASK_NOT_FOUND", "任务不存在");
		if (task.kind === "publish") {
			const restored = Boolean((task.details as Row)?.restoreRequiresReconciliation);
			if (restored) {
				const input = await readJson(c.req.raw, 4096);
				if (input.reconcileRestored !== true) throw new ApiFailure(409, "RESTORED_PUBLISH_CONFIRMATION_REQUIRED", "恢复的任务须明确提供 reconcileRestored:true 后手工核查；不会重新提交旧草稿");
			}
			await processReleaseTask(id, { reconcileRestored: restored });
		}
		else { const { processMaintenanceTask } = await import("./maintenance.js"); await processMaintenanceTask(id); }
		const rows = await getDatabase().query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [getSiteId(), id]);
		return c.json({ data: taskRecord(rows[0]) });
	});
}
