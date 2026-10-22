import { randomUUID } from "node:crypto";
import { z } from "zod";
import { start } from "workflow/api";
import type { AdminApp } from "./types.js";
import type { PostRecord, TaskRecord } from "../shared/contracts.js";
import { getStore, getSiteId, collection, assertSite, type FileStore, type StoreState } from "./file-store.js";
import { storageConfig } from "./storage-config.js";
import { ApiFailure, requireProduction, readJson } from "./security.js";
import { serviceEnabled } from "./service-settings.js";
import { githubProvider, GitHubError, personalToken, type GitHubProvider, type RepositoryFile } from "./github.js";
import { assertDeploymentConfigRedirects, buildDeploymentConfig, canonicalJson, publicContentDigest, publicSettings, publishedSource, sha256, type PublishedPost, type Redirect } from "./release-format.js";
import { publishWorkflow } from "../workflows/publish.js";
import { requireAdmin } from "./auth.js";
import { synchronizeRepository } from "./repository.js";
import { vercelProjectId } from "./runtime-config.js";

type Row = Record<string, unknown>;
export type ReleaseTaskRow = Row & { id: string; kind: string; state: string; details: Row; snapshot_id: string; base_sha: string; target_sha: string | null; fence: number | null; created_at: string; updated_at: string };
export type FrozenSnapshot = {
	id: string; taskId: string; digest: string; posts: PublishedPost[]; sources: Array<{ id: string; revision: number; source: string; originalSource?: string; filePath: string; slug: string }>;
	files: RepositoryFile[]; deletions: string[]; settings: Record<string, unknown>; redirects: Redirect[];
	entityRevisions: Array<{ kind: string; id: string; revision: number }>; friendIds: string[];
	friendRevisions: Record<string, number>; selectedIds: string[];
	media?: Record<string, Row & { id: string; publishedUrl: string; pathname?: string; digest: string; size: number; contentType: string; revision: number }>;
	originalSettings?: Record<string, unknown>;
	deploymentConfig?: Record<string, unknown>;
	repositoryFiles?: RepositoryFile[];
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
export async function assertPublishCapability(): Promise<void> {
	requireProduction(await serviceEnabled("publish"));
	// A personal access token is enough on its own; the App credentials are only
	// required when no PAT is configured.
	if (!personalToken()) {
		for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
			if (!process.env[name]) throw new ApiFailure(503, "PUBLISH_CONFIGURATION_REQUIRED", `缺少 GITHUB_TOKEN 或 ${name}`);
		}
	}
	if (!process.env.VERCEL_TOKEN) throw new ApiFailure(503, "PUBLISH_CONFIGURATION_REQUIRED", "缺少 VERCEL_TOKEN");
	if (!vercelProjectId()) throw new ApiFailure(503, "PUBLISH_CONFIGURATION_REQUIRED", "无法识别当前 Vercel 项目，请检查系统变量");
}
export function taskRecord(row: Row): TaskRecord {
	return { id: String(row.id), kind: String(row.kind), state: String(row.state), snapshotId: row.snapshot_id ? String(row.snapshot_id) : undefined,
		targetSha: row.target_sha ? String(row.target_sha) : null, productionSha: row.production_sha ? String(row.production_sha) : null,
		deploymentId: row.deployment_id ? String(row.deployment_id) : null, message: row.message ? String(row.message) : null,
		createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
}
const releaseInput = z.object({ postIds: z.array(z.string().min(1)).max(200), expectedRevisions: z.record(z.string(), z.number().int().nonnegative()), idempotencyKey: z.string().min(8).max(200) });
export async function freezeRelease(input: z.infer<typeof releaseInput>, store = getStore(), site = getSiteId()): Promise<TaskRecord> {
	const taskId = randomUUID(); const snapshotId = randomUUID();
	return store.update((state) => {
		assertSite(state, site);
		if (restoreActive(state)) throw new ApiFailure(409, "RESTORE_IN_PROGRESS", "恢复进行中，暂不能冻结发布");
		const tasks = collection(state, "release_tasks");
		const existing = Object.values(tasks).find((row) => row.idempotency_key === input.idempotencyKey);
		if (existing) return taskRecord(existing);
		if (Object.values(tasks).some((row) => row.kind === "publish" && (row.details as Row)?.restoreRequiresReconciliation)) throw new ApiFailure(409, "RESTORED_PUBLISH_RECONCILIATION_REQUIRED", "恢复的发布记录必须先核查 Git 与生产结果，不能直接重新发布旧草稿");
		const entities = collection(state, "entities");
		const base = entities["repository:baseline"]?.data as Row | undefined;
		if (typeof base?.headSha !== "string") throw new ApiFailure(409, "BASELINE_REQUIRED", "先导入仓库基线，再发布内容");
		const postRows = Object.values(entities).filter((row) => row.kind === "post").sort((a,b) => String(a.id).localeCompare(String(b.id)));

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
		const entityRows = Object.values(entities).filter((row) => ["settings", "navigation", "icons"].includes(String(row.kind))).sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
		const settingsRow = entityRows.find((row) => row.kind === "settings" && row.id === "default");
		const settings: Record<string, unknown> = { schemaVersion: 1, settings: publicSettings((settingsRow?.data || {}) as Record<string, unknown>), navigation: null, icons: {} };
		const navigation = entityRows.find((row) => row.kind === "navigation" && row.id === "default");
		if (navigation) settings.navigation = navigation.data;
		const icons = entityRows.find((row) => row.kind === "icons" && row.id === "default");
		if (icons) settings.icons = icons.data;
		const friends = Object.values(collection(state, "friends")).filter((row) => ["approved", "published"].includes(String(row.status))).sort((a,b) => String(a.group_name).localeCompare(String(b.group_name)) || Number(a.sort_order)-Number(b.sort_order) || String(a.id).localeCompare(String(b.id)));
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
		const mediaRows = mediaIds.map((id) => entities[`media:${id}`]).filter((row): row is Row => Boolean(row));
		snapshot.media = {};
		for (const mediaId of mediaIds) {
			const mediaRow = mediaRows.find((row) => row.id === mediaId); const data = mediaRow?.data as Row | undefined;
			if (!mediaRow || !data || data.deleted || typeof data.publishedUrl !== "string" || !/^https:\/\//.test(data.publishedUrl) || typeof data.digest !== "string" || typeof data.contentType !== "string" || typeof data.size !== "number") throw new ApiFailure(409, "MEDIA_REFERENCE_INVALID", "发布快照中的媒体不存在、尚未迁移到图床或记录不完整", { id: mediaId });
			snapshot.media[mediaId] = { ...data, id: mediaId, publishedUrl: data.publishedUrl, digest: data.digest, contentType: data.contentType, size: data.size, revision: Number(mediaRow.revision) };
		}
		snapshot.originalSettings = structuredClone(settings);
		for (const file of files) if (!(file.path === "vercel.json" || /^src\/(?:content\/posts\/[^\0]+\.mdx?|data\/(?:published-state|managed-settings|redirects)\.json)$/.test(file.path)) || file.path.split("/").includes("..")) throw new ApiFailure(400, "UNSAFE_REPOSITORY_PATH", "发布路径不在允许的内容目录");
		const now = new Date().toISOString();
		collection(state, "release_snapshots")[snapshotId] = { id: snapshotId, digest, data: snapshot, created_at: now };
		const task: ReleaseTaskRow = { id: taskId, kind: "publish", idempotency_key: input.idempotencyKey, state: "preparing", snapshot_id: snapshotId, base_sha: base.headSha, target_sha: null, production_sha: null, deployment_id: null, message: null, details: {}, fence: null, created_at: now, updated_at: now };
		tasks[taskId] = task;
		collection(state, "release_locks")[site] ||= { task_id: null, fencing_token: 0, lease_until: now };
		return taskRecord(task);
	});
}
function restoreActive(state: StoreState): boolean {
	const lock = collection(state, "maintenance_locks").main;
	return Boolean(lock?.kind === "restore" && new Date(String(lock.lease_until)).getTime() > Date.now());
}
function ownedLease(state: StoreState, site: string, id: string, fence: number): boolean {
	const lock = collection(state, "release_locks")[site];
	return !restoreActive(state) && Boolean(lock && lock.task_id === id && lock.fencing_token === fence && new Date(String(lock.lease_until)).getTime() > Date.now());
}
export async function claimReleaseTask(store: FileStore, site: string, id: string, reconcileRestored = false, retryFailedDeployment = false): Promise<number | null> {
	return store.update((state) => {
		assertSite(state, site);
		if (restoreActive(state)) return null;
		const lock = collection(state, "release_locks")[site];
		const tasks = collection(state, "release_tasks");
		if (!lock || !reconcileRestored && Object.values(tasks).some((row) => row.kind === "publish" && (row.details as Row)?.restoreRequiresReconciliation)) return null;
		const task = tasks[id] as ReleaseTaskRow | undefined;
		const retryFailed = retryFailedDeployment && task?.state === "failed" && typeof task.target_sha === "string" && /^[a-f0-9]{40}$/i.test(task.target_sha);
		if (!task || task.kind !== "publish" || terminalStates.has(task.state) && !retryFailed || !reconcileRestored && (task.state === "blocked" || task.details?.restoreRequiresReconciliation)) return null;
		if (lock.task_id === id && new Date(String(lock.lease_until)).getTime() > Date.now()) return null;
		if (lock.task_id && lock.task_id !== id) {
			const owner = tasks[String(lock.task_id)];
			if (!owner || !terminalStates.has(String(owner.state))) return null;
		}
		const fence = Number(lock.fencing_token) + 1;
		Object.assign(lock, { task_id: id, fencing_token: fence, lease_until: new Date(Date.now()+150_000).toISOString() });
		task.fence = fence;
		if (retryFailed) task.state = "deploying";
		else if (reconcileRestored && task.state === "blocked") task.state = task.target_sha ? "deploying" : "unknown";
		task.updated_at = new Date().toISOString();
		return fence;
	});
}
function updateTaskState(state: StoreState, site: string, id: string, fence: number, status: string, fields: Row = {}): boolean {
	const task = collection(state, "release_tasks")[id] as ReleaseTaskRow | undefined;
	if (!task || task.fence !== fence || terminalStates.has(task.state) || task.state === "blocked" || !ownedLease(state, site, id, fence)) return false;
	Object.assign(task, { state: status, target_sha: fields.targetSha || task.target_sha, production_sha: fields.productionSha || task.production_sha, deployment_id: fields.deploymentId || task.deployment_id, message: fields.message || null, details: { ...task.details, ...((fields.details || {}) as Row) }, updated_at: new Date().toISOString() });
	return true;
}
async function updateTask(store: FileStore, site: string, id: string, fence: number, state: string, fields: Row = {}): Promise<boolean> {
	return store.update((current) => { assertSite(current, site); return updateTaskState(current, site, id, fence, state, fields); });
}
async function renewReleaseLease(store: FileStore, site: string, id: string, fence: number): Promise<boolean> {
	return store.update((state) => { assertSite(state, site); if (!ownedLease(state, site, id, fence)) return false; collection(state, "release_locks")[site]!.lease_until = new Date(Date.now()+150_000).toISOString(); return true; });
}
async function releaseRow(store: FileStore, site: string, id: string): Promise<ReleaseTaskRow | undefined> { const state = await store.read(); assertSite(state, site); return collection(state, "release_tasks")[id] as ReleaseTaskRow | undefined; }
async function snapshotRow(store: FileStore, site: string, id: string): Promise<Row | undefined> { const state = await store.read(); assertSite(state, site); return collection(state, "release_snapshots")[id]; }

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
		const projectId = vercelProjectId();
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
	store?: FileStore; site?: string; github?: GitHubProvider; deployment?: DeploymentProvider; skipCapabilityCheck?: boolean;
	// Only an explicit authenticated reconcile action may inspect restored jobs.
	reconcileRestored?: boolean;
	// An authenticated operator may only recheck an already committed failed SHA.
	retryFailedDeployment?: boolean;
	prepareMedia?: (ids: string[], taskId: string, snapshot: FrozenSnapshot) => Promise<Record<string, string>>;
	afterVerified?: (snapshot: FrozenSnapshot, store: FileStore, site: string) => Promise<void>;
};
function releaseFinalized(task: ReleaseTaskRow): boolean {
	return (task.details?.finalizationState ?? task.details?.notificationState) === "done";
}
/**
 * Once a release is verified the published source lives in Git, so keeping every local
 * version of those posts only inflates the stored state document. Pruning here keeps the
 * state (and the single Cloudflare KV value) from growing with each publish.
 */
async function prunePublishedHistory(store: FileStore, site: string, snapshot: FrozenSnapshot): Promise<void> {
	const published = new Set(snapshot.sources.map((source) => source.id));
	if (!published.size) return;
	await store.update((state) => {
		assertSite(state, site);
		const entities = collection(state, "entities");
		for (const [key, row] of Object.entries(entities)) {
			if (row.kind === "post_version" && published.has(String((row.data as { postId?: unknown })?.postId))) delete entities[key];
		}
	});
}
async function completeReleaseFinalization(id: string, store: FileStore, site: string, afterVerified?: ReleaseDependencies["afterVerified"]): Promise<void> {
	const task = await releaseRow(store, site, id);
	if (!task || task.kind !== "publish" || task.state !== "verified" || task.details?.restored || task.details?.restoreRequiresReconciliation || releaseFinalized(task)) return;
	if (!task.target_sha || task.production_sha !== task.target_sha || !task.deployment_id) throw new ApiFailure(409, "VERIFIED_RELEASE_REQUIRED", "发布收尾任务的身份不完整");
	const record = await snapshotRow(store, site, task.snapshot_id); const snapshot = record?.data as FrozenSnapshot | undefined;
	if (!snapshot || snapshot.id !== task.snapshot_id || snapshot.taskId !== id || snapshot.digest !== record?.digest || publicContentDigest(snapshot.posts, snapshot.settings, snapshot.redirects) !== snapshot.digest) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "发布收尾任务的冻结快照不完整");
	if (afterVerified) await afterVerified(snapshot, store, site);
	else { const { markFriendsPublished } = await import("./interactions.js"); await markFriendsPublished(snapshot.friendIds, id, snapshot.friendRevisions, { store, site }); }
	const done = await store.update((state) => {
		assertSite(state, site); const current = collection(state, "release_tasks")[id] as ReleaseTaskRow | undefined;
		if (!current || current.state !== "verified" || current.snapshot_id !== snapshot.id || current.target_sha !== current.production_sha || current.details?.restored || current.details?.restoreRequiresReconciliation) return false;
		current.details = { ...current.details, finalizationState: "done", finalizationCompletedAt: new Date().toISOString() }; current.updated_at = new Date().toISOString(); return true;
	});
	if (!done) throw new ApiFailure(409, "RELEASE_FINALIZATION_PENDING", "发布状态已变化，收尾任务仍须核查");
	await prunePublishedHistory(store, site, snapshot);
}
/** Repairs verified friend publication state after interrupted Workflow execution. */
export async function reconcileVerifiedReleaseFinalization(store = getStore(), site = getSiteId()): Promise<void> {
	const state = await store.read(); assertSite(state, site);
	const tasks = Object.values(collection(state, "release_tasks")).filter((row) => row.kind === "publish" && row.state === "verified" && !(row.details as Row)?.restored && !(row.details as Row)?.restoreRequiresReconciliation && !releaseFinalized(row as ReleaseTaskRow)).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)));
	let failed = false;
	for (const task of tasks) try { await completeReleaseFinalization(String(task.id), store, site); } catch { failed = true; }
	if (failed) throw new ApiFailure(503, "RELEASE_FINALIZATION_PENDING", "部分已核验发布尚未完成友链状态更新；已保留记录，稍后继续核查");
}
export async function processReleaseTask(id: string, dependencies?: ReleaseDependencies): Promise<{ done: boolean; state: string }> {
	if (!dependencies?.skipCapabilityCheck) await assertPublishCapability();
	const store = dependencies?.store || getStore(); const site = dependencies?.site || getSiteId(); const git = dependencies?.github || githubProvider; const deployment = dependencies?.deployment || deploymentProvider;
	const initial = await releaseRow(store, site, id);
	if (!initial) throw new ApiFailure(404, "TASK_NOT_FOUND", "发布任务不存在");
	if (initial.kind !== "publish") throw new ApiFailure(400, "NOT_A_PUBLISH_TASK", "维护任务不能进入发布流程");
	const restored = Boolean(initial.details?.restoreRequiresReconciliation);
	if ((initial.state === "blocked" || restored) && !dependencies?.reconcileRestored) return { done: false, state: "blocked" };
	const retryFailed = Boolean(dependencies?.retryFailedDeployment && initial.state === "failed" && initial.target_sha);
	if (terminalStates.has(initial.state) && !retryFailed) {
		if (initial.state === "verified") await completeReleaseFinalization(id, store, site, dependencies?.afterVerified);
		return { done: true, state: initial.state };
	}
	const fence = await claimReleaseTask(store, site, id, Boolean(dependencies?.reconcileRestored), retryFailed); if (fence === null) return { done: false, state: "queued" };
	let task = (await releaseRow(store, site, id))!;
	let target = task.target_sha;
	let commitAttempted = false;
	let finalizationPending = false;
	let lostLease = false;
	let heartbeatRunning = false;
	const heartbeat = setInterval(() => {
		if (heartbeatRunning || lostLease) return;
		heartbeatRunning = true;
		void renewReleaseLease(store, site, id, fence).then((active) => { if (!active) lostLease = true; }, () => { lostLease = true; }).finally(() => { heartbeatRunning = false; });
	}, 30_000);
	heartbeat.unref();
	const retainLease = async () => {
		if (lostLease || !await renewReleaseLease(store, site, id, fence)) { lostLease = true; throw new Error("Release lease was superseded"); }
	};
	const persistedState = async (): Promise<{ done: boolean; state: string }> => {
		const current = await releaseRow(store, site, id);
		return { done: Boolean(current && terminalStates.has(current.state)), state: current?.state || "unknown" };
	};
	try {
		const record = await snapshotRow(store, site, task.snapshot_id);
		const snapshot = record?.data as FrozenSnapshot | undefined;
		if (!snapshot || snapshot.id !== task.snapshot_id || snapshot.taskId !== id || snapshot.digest !== record?.digest || publicContentDigest(snapshot.posts, snapshot.settings, snapshot.redirects) !== snapshot.digest || snapshot.sources.some((source) => snapshot.posts.find((post) => post.id === source.id)?.sourceSha256 !== sha256(source.source))) throw new ApiFailure(409, "SNAPSHOT_INTEGRITY_FAILED", "冻结发布快照校验失败；保留记录并重新审核快照");
		if (restored && !target && !["committing", "unknown"].includes(String(initial.details?.restorePreviousState))) {
			await updateTask(store, site, id, fence, "failed", { message: "恢复的任务尚未提交；已保留草稿，重新选择当前版本并冻结后再发布", details: { restoreRequiresReconciliation: false, restoredTaskCanceled: true } });
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
					urls = await publishMediaForSnapshot(ids, id, { store, site, frozenMedia: snapshot.media });
				}
				for (const source of snapshot.sources) source.source = replaceMedia(source.source, urls) as string;
				snapshot.settings = replaceMedia(snapshot.settings, urls) as Record<string, unknown>;
			}
			refreshSnapshotFiles(snapshot);
			const frozen = await store.update((state) => {
				assertSite(state, site); if (!updateTaskState(state, site, id, fence, "frozen")) return false;
				Object.assign(collection(state, "release_snapshots")[snapshot.id]!, { digest: snapshot.digest, data: snapshot }); return true;
			});
			if (!frozen) return persistedState();
			task.state = "frozen";
		}
		if (!target && ["committing", "unknown"].includes(task.state)) {
			await retainLease();
			target = await git.findCommit(id, snapshot.digest);
			if (!target) {
				await updateTask(store, site, id, fence, "unknown", { message: "提交结果仍未知；禁止再次执行提交，先核查 Git 任务标记" });
				return persistedState();
			}
			if (!await updateTask(store, site, id, fence, "deploying", { targetSha: target })) return persistedState();
		}
		if (!target) {
			await retainLease();
			const repository = await git.readRepositoryFiles();
			if (repository.headSha !== task.base_sha) {
				const diff = snapshot.files.filter((file) => repository.files.find((current) => current.path === file.path)?.source !== file.source).map((file) => ({ path: file.path, expectedSource: file.source, remoteSource: repository.files.find((current) => current.path === file.path)?.source ?? null }));
				await updateTask(store, site, id, fence, "conflict", { message: "发布分支有未导入的外部修改，请比较差异后重新导入", details: { baseSha: task.base_sha, remoteSha: repository.headSha, diff } });
				return persistedState();
			}
			const committedFiles = new Map(repository.files.map((file) => [file.path, file]));
			for (const path of snapshot.deletions) committedFiles.delete(path);
			for (const file of snapshot.files) committedFiles.set(file.path, file);
			snapshot.repositoryFiles = [...committedFiles.values()];
			await retainLease();
			const committing = await store.update((state) => {
				assertSite(state, site); if (!updateTaskState(state, site, id, fence, "committing")) return false;
				collection(state, "release_snapshots")[snapshot.id]!.data = snapshot; return true;
			});
			if (!committing) return persistedState();
			// Persist the intention before the only non-idempotent external side effect.
			task.state = "committing";
			commitAttempted = true;
			target = await git.commit({ baseSha: task.base_sha, taskId: id, digest: snapshot.digest, files: snapshot.files, deletions: snapshot.deletions });
			if (!await updateTask(store, site, id, fence, "deploying", { targetSha: target })) return persistedState();
		}
		await retainLease();
		const verified = await deployment.verify(target, snapshot);
		if (verified.status === "failed") {
			await updateTask(store, site, id, fence, "failed", { message: verified.message, deploymentId: verified.deploymentId, details: restored ? { restoreRequiresReconciliation: false } : {} });
			return persistedState();
		}
		if (verified.status !== "verified" || verified.sha !== target || !verified.deploymentId) {
			await updateTask(store, site, id, fence, "deploying", { message: verified.message || "生产部署身份尚未完整核验" });
			return persistedState();
		}
		const finalized = await store.update((state) => {
			assertSite(state, site); const entities = collection(state, "entities");
			const baseline = entities["repository:baseline"]; const base = baseline?.data as Row | undefined; const baselineHead = base?.headSha;
			if (baselineHead !== task.base_sha && baselineHead !== target) {
				updateTaskState(state, site, id, fence, "conflict", { productionSha: target, deploymentId: verified.deploymentId, message: "生产版本已核验，但管理基线已推进；保留证据，须审阅后合并，不能回写旧基线", details: { baselineSha: baselineHead ?? null, verifiedSha: target } }); return false;
			}
			if (!updateTaskState(state, site, id, fence, "verified", { productionSha: target, deploymentId: verified.deploymentId, message: "Git、目标项目生产别名及两处发布清单已核验一致", details: { ...(restored ? { restoreRequiresReconciliation: false } : {}), finalizationState: initial.details?.restored ? "skipped" : "pending" } })) return false;
			for (const source of snapshot.sources) { const post = entities[`post:${source.id}`]; if (post) { post.data = { ...(post.data as Row), publishedSource: source.source, publishedRevision: source.revision }; post.updated_at = new Date().toISOString(); } }
			if (baseline && base) { delete base.repositoryFiles; Object.assign(base, { headSha: target, posts: snapshot.posts, redirects: snapshot.redirects, snapshotId: snapshot.id, taskId: id, publicContentDigest: snapshot.digest, publishedSettings: snapshot.settings.settings, publishedNavigation: snapshot.settings.navigation, publishedIcons: snapshot.settings.icons, ...(snapshot.repositoryFiles ? { repositoryFiles: snapshot.repositoryFiles } : {}), ...(snapshot.deploymentConfig ? { deploymentConfig: snapshot.deploymentConfig } : {}) }); baseline.updated_at = new Date().toISOString(); }
			const lock = collection(state, "release_locks")[site]!; lock.task_id = null; lock.lease_until = new Date().toISOString(); return true;
		});
		if (!finalized) return persistedState();
		// Replaying a verified task repairs an interrupted friend state update.
		if (!initial.details?.restored) try { await completeReleaseFinalization(id, store, site, dependencies?.afterVerified); } catch {
			finalizationPending = true;
			throw new Error("Production is verified; the durable release finalization must be reconciled");
		}
		return { done: true, state: "verified" };
	} catch (error) {
		if (finalizationPending) throw error;
		if (lostLease) return persistedState();
		const state = error instanceof GitHubError && error.conflict && !error.uncertain ? "conflict" : !target && (commitAttempted || task.state === "unknown" || task.state === "committing" || error instanceof GitHubError && error.uncertain) ? "unknown" : target ? "deploying" : error instanceof ApiFailure && error.status < 500 ? "failed" : task.state;
		await updateTask(store, site, id, fence, state, { message: error instanceof GitHubError || error instanceof ApiFailure ? error.message : "外部服务核验失败，请检查配置后继续核验" });
		return persistedState();
	} finally {
		clearInterval(heartbeat);
		await store.update((state) => { assertSite(state, site); const lock = collection(state, "release_locks")[site]; if (lock?.task_id === id && lock.fencing_token === fence) lock.lease_until = new Date().toISOString(); });
	}
}
/**
 * Without a shared store there is no way to hand a task to a workflow that runs in a
 * different function instance: the in-process store dies with the request. In that case
 * the release runs inline, which keeps publishing working without any database.
 */
export async function scheduleReleaseTask(id: string): Promise<void> {
	if (!storageConfig()) {
		await processReleaseTask(id);
		return;
	}
	const run = await start(publishWorkflow, [id]);
	await getStore().update((state) => { const task = collection(state, "release_tasks")[id]; if (task) { task.workflow_id = run.runId; task.updated_at = new Date().toISOString(); } });
}
export function registerReleaseRoutes(app: AdminApp): void {
	app.get("/api/repository", requireAdmin, async (c) => {
		const row = collection(await getStore().read(), "entities")["repository:baseline"]; const data = row?.data as Row | undefined;
		return c.json({ data: { headSha: typeof data?.headSha === "string" ? data.headSha : null, synchronizedAt: data?.synchronizedAt || null } });
	});
	app.post("/api/repository/sync", requireAdmin, async (c) => {
		const input = await readJson(c.req.raw, 4096); if (typeof input.expectedHeadSha !== "string") throw new ApiFailure(400, "BASELINE_REVISION_REQUIRED", "提供已读取基线的 expectedHeadSha");
		return c.json({ data: await synchronizeRepository(getStore(), getSiteId(), input.expectedHeadSha) });
	});
	app.post("/api/releases", requireAdmin, async (c) => {
		await assertPublishCapability(); const parsed = releaseInput.safeParse(await readJson(c.req.raw)); if (!parsed.success) throw new ApiFailure(400, "INVALID_RELEASE", "提供 postIds、expectedRevisions 和幂等键");
		const task = await freezeRelease(parsed.data); try { await scheduleReleaseTask(task.id); } catch { /* Persisted task remains available for reconciliation. */ }
		return c.json({ data: task }, 202);
	});
	app.get("/api/tasks", requireAdmin, async (c) => { const rows = Object.values(collection(await getStore().read(), "release_tasks")).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0,100); return c.json({ data: rows.map(taskRecord) }); });
	app.get("/api/tasks/:id", requireAdmin, async (c) => { const row = await releaseRow(getStore(), getSiteId(), c.req.param("id")); if (!row) throw new ApiFailure(404, "TASK_NOT_FOUND", "任务不存在"); return c.json({ data: { ...taskRecord(row), details: row.details } }); });
	app.post("/api/tasks/:id/reconcile", requireAdmin, async (c) => {
		const id = c.req.param("id"); const task = await releaseRow(getStore(), getSiteId(), id); if (!task) throw new ApiFailure(404, "TASK_NOT_FOUND", "任务不存在");
		if (task.kind === "publish") {
			const restored = Boolean(task.details?.restoreRequiresReconciliation); if (restored) { const input = await readJson(c.req.raw, 4096); if (input.reconcileRestored !== true) throw new ApiFailure(409, "RESTORED_PUBLISH_CONFIRMATION_REQUIRED", "恢复的任务须明确提供 reconcileRestored:true 后手工核查；不会重新提交旧草稿"); }
			const result = await processReleaseTask(id, { reconcileRestored: restored, retryFailedDeployment: true }); if (!result.done && result.state !== "blocked") try { await scheduleReleaseTask(id); } catch { /* Persisted task can be reconciled later. */ }
		} else { const { processMaintenanceTask } = await import("./maintenance.js"); await processMaintenanceTask(id); }
		return c.json({ data: taskRecord((await releaseRow(getStore(), getSiteId(), id))!) });
	});
}
