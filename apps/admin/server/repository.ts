import { randomUUID } from "node:crypto";
import type { PostRecord } from "../shared/contracts.js";
import type { Database } from "./db.js";
import { ApiFailure, digest } from "./security.js";
import { validatePostSource } from "./source-document.js";
import { readRepositoryFiles } from "./github.js";

type SourceFile = { path: string; source: string };
type RepositoryReader = (sha?: string) => Promise<Awaited<ReturnType<typeof readRepositoryFiles>>>;
type PublishedPost = { id?: string; filePath?: string; path?: string; slug?: string; sourceSha256?: string };
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function readJsonFile(files: SourceFile[], path: string): unknown {
	const file = files.find((entry) => entry.path === path);
	if (!file) return undefined;
	try { return JSON.parse(file.source); } catch { throw new ApiFailure(422, "REPOSITORY_CONFIGURATION_INVALID", `GitHub ${path} JSON 不合法`); }
}
function baselineSlug(path: string): string {
	return path.replace(/^src\/content\/posts\//, "").replace(/\.(?:md|mdx)$/i, "").replace(/(?:^|\/)index$/, "").replace(/\/$/, "");
}

export async function importRepository(database: Database, siteId: string, reader: RepositoryReader = readRepositoryFiles) {
	let repository: Awaited<ReturnType<typeof readRepositoryFiles>>;
	try { repository = await reader(); }
	catch (error) {
		if (error instanceof ApiFailure) throw error;
		const message = error instanceof Error ? error.message : "GitHub 仓库读取失败";
		if (message.startsWith("Missing environment configuration:")) throw new ApiFailure(503, "GITHUB_APP_CONFIGURATION_REQUIRED", message);
		throw new ApiFailure(503, "GITHUB_REPOSITORY_UNAVAILABLE", "GitHub 仓库暂时无法读取；请检查受限 GitHub App 的仓库权限与网络连接");
	}
	const files: SourceFile[] = repository.files;
	const state = repository.publishedState || readJsonFile(files, "src/data/published-state.json");
	const mapping: PublishedPost[] = isRecord(state) && Array.isArray(state.posts) ? state.posts.filter(isRecord) as PublishedPost[] : [];
	const managed = readJsonFile(files, "src/data/managed-settings.json");
	const redirects = readJsonFile(files, "src/data/redirects.json");
	const deploymentConfig = readJsonFile(files, "vercel.json");
	if (deploymentConfig !== undefined && (!isRecord(deploymentConfig) || deploymentConfig.redirects !== undefined && !Array.isArray(deploymentConfig.redirects))) throw new ApiFailure(422, "REPOSITORY_CONFIGURATION_INVALID", "GitHub vercel.json 必须为包含有效重定向规则的 JSON 对象");
	if (!isRecord(managed) || !isRecord(managed.settings) || !isRecord(managed.navigation)) throw new ApiFailure(503, "BASELINE_CONFIGURATION_REQUIRED", "仓库须包含 src/data/managed-settings.json 的真实 settings/navigation 基线；不能用空配置替换主题");
	const posts = files.filter((file) => /^src\/content\/posts\/.+\.(md|mdx)$/.test(file.path));
	if (!posts.length) throw new ApiFailure(422, "REPOSITORY_POSTS_MISSING", "GitHub 仓库没有读取到文章源码");
	return database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${siteId}:repository-import`]);
		const [existing] = await tx.query<Record<string, unknown> & { data: Record<string, unknown> }>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline'", [siteId]);
		if (existing) {
			// Upgrade an earlier import only at the exact recorded Git revision.
			// Post drafts and their published baseline remain unchanged.
			if (existing.data.deploymentConfig === undefined && deploymentConfig !== undefined && existing.data.headSha === repository.headSha) await tx.query("UPDATE entities SET data=data || $2::jsonb,updated_at=now() WHERE site_id=$1 AND kind='repository' AND id='baseline'", [siteId, JSON.stringify({ deploymentConfig })]);
			return { imported: false, headSha: existing.data.headSha, message: "管理基线已存在；不会覆盖草稿或重复发布" };
		}
		if ((await tx.query("SELECT id FROM entities WHERE site_id=$1 AND kind='post' LIMIT 1", [siteId])).length) throw new ApiFailure(409, "BASELINE_IMPORT_CONFLICT", "当前已有管理草稿但尚无仓库基线，请先处理导入冲突");
		for (const file of posts) {
			const metadata = validatePostSource(file.source);
			const map = mapping.find((item) => (item.filePath || item.path) === file.path) || mapping.find((item) => item.slug === baselineSlug(file.path));
			if (map?.sourceSha256 && map.sourceSha256 !== digest(file.source)) throw new ApiFailure(409, "BASELINE_SOURCE_MISMATCH", `文章 ${file.path} 与发布基线的字节哈希不一致`);
			const slug = map?.slug || (typeof metadata.slug === "string" ? metadata.slug : baselineSlug(file.path));
			const draft = metadata.draft === true;
			const post: PostRecord = { id: map?.id || randomUUID(), filePath: file.path, slug, title: String(metadata.title), published: String(metadata.published), draft, format: file.path.endsWith(".mdx") ? "mdx" : "md", source: file.source, metadata, revision: 1, publishedRevision: draft ? null : 1, publishedSource: draft ? null : file.source, updatedAt: new Date().toISOString() };
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(post.id)) throw new ApiFailure(422, "BASELINE_ID_INVALID", `文章 ${file.path} 的稳定 ID 须为 UUID`);
			await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'post',$2,$3::jsonb)", [siteId, post.id, JSON.stringify(post)]);
		}
		for (const kind of ["settings", "navigation"] as const) await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,$2,'default',$3::jsonb)", [siteId, kind, JSON.stringify(managed[kind])]);
		if (isRecord(managed.icons)) await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'icons','default',$2::jsonb)", [siteId, JSON.stringify(managed.icons)]);
		const baseline = { headSha: repository.headSha, repositoryFiles: files, snapshotId: isRecord(state) ? state.snapshotId || null : null, importedAt: new Date().toISOString(), importedPosts: posts.length, publishedSettings: managed.settings, publishedNavigation: managed.navigation, publishedIcons: managed.icons || {}, publishedState: state || null, posts: mapping, redirects: Array.isArray(redirects) ? redirects : [], ...(deploymentConfig !== undefined ? { deploymentConfig } : {}) };
		await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'repository','baseline',$2::jsonb)", [siteId, JSON.stringify(baseline)]);
		return { imported: true, headSha: repository.headSha, records: posts.length, publicPosts: posts.filter((file) => validatePostSource(file.source).draft !== true).length };
	});
}

export type RepositoryDifference = { path: string; expectedSource: string | null; remoteSource: string | null; expectedSha256: string | null; remoteSha256: string | null };
export function compareRepositoryFiles(expected: SourceFile[], remote: SourceFile[]): RepositoryDifference[] {
	const before = new Map(expected.map((file) => [file.path, file.source])); const after = new Map(remote.map((file) => [file.path, file.source]));
	return [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => before.get(path) !== after.get(path)).map((path) => {
		const expectedSource = before.get(path) ?? null; const remoteSource = after.get(path) ?? null;
		return { path, expectedSource, remoteSource, expectedSha256: expectedSource === null ? null : digest(expectedSource), remoteSha256: remoteSource === null ? null : digest(remoteSource) };
	});
}

/** Only code-only Git changes may advance the baseline. Private SQL drafts stay untouched. */
export async function synchronizeRepository(database: Database, siteId: string, expectedHeadSha: string, reader: RepositoryReader = readRepositoryFiles) {
	if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) throw new ApiFailure(400, "BASELINE_REVISION_REQUIRED", "提供已读取基线的完整 expectedHeadSha");
	const [initial] = await database.query<Record<string, unknown> & { data: Record<string, unknown> }>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline'", [siteId]);
	if (!initial) throw new ApiFailure(409, "BASELINE_REQUIRED", "先导入仓库基线，再核对代码更新");
	if (initial.data.headSha !== expectedHeadSha) throw new ApiFailure(409, "BASELINE_REVISION_CONFLICT", "仓库基线已变化，请刷新后重新核对");
	const remote = await reader();
	if (!/^[a-f0-9]{40}$/i.test(remote.headSha)) throw new ApiFailure(503, "REPOSITORY_REVISION_INVALID", "远端未返回有效 Git 版本");
	// Earlier baselines do not store a file ledger. Read their immutable Git tree,
	// never current master, rather than inventing an empty or mutable baseline.
	let evidence: SourceFile[];
	if (Array.isArray(initial.data.repositoryFiles)) evidence = initial.data.repositoryFiles as SourceFile[];
	else {
		const historical = await reader(expectedHeadSha);
		if (historical.headSha !== expectedHeadSha) throw new ApiFailure(409, "BASELINE_EVIDENCE_INVALID", "未能读取基线的固定 Git 版本，拒绝同步");
		evidence = historical.files;
	}
	if (evidence.some((file) => !isRecord(file) || typeof file.path !== "string" || typeof file.source !== "string") || new Set(evidence.map((file) => file.path)).size !== evidence.length) throw new ApiFailure(409, "BASELINE_EVIDENCE_INVALID", "基线文件证据不完整，保留草稿并人工检查");
	const differences = compareRepositoryFiles(evidence, remote.files);
	return database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [`${siteId}:production-write`]);
		await tx.query("INSERT INTO release_locks(site_id) VALUES($1) ON CONFLICT DO NOTHING", [siteId]);
		await tx.query("SELECT site_id FROM release_locks WHERE site_id=$1 FOR UPDATE", [siteId]);
		const [current] = await tx.query<Record<string, unknown> & { data: Record<string, unknown> }>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline' FOR UPDATE", [siteId]);
		if (current?.data.headSha !== expectedHeadSha) throw new ApiFailure(409, "BASELINE_REVISION_CONFLICT", "核对期间仓库基线已变化，请重新读取");
		if ((await tx.query("SELECT id FROM release_tasks WHERE site_id=$1 AND kind='publish' AND (state NOT IN ('verified','failed','conflict') OR details->>'restoreRequiresReconciliation'='true') LIMIT 1", [siteId])).length) throw new ApiFailure(409, "PUBLISH_RECONCILIATION_REQUIRED", "先核查所有未完成或恢复的发布，再同步代码基线");
		if (differences.length) throw new ApiFailure(409, "MANAGED_REPOSITORY_CONFLICT", "远端管理内容已变更；请审阅逐文件差异并通过独立合并处理，未推进基线且保留全部私有草稿", { baseSha: expectedHeadSha, remoteSha: remote.headSha, diff: differences });
		const rows = await tx.query("UPDATE entities SET data=data || $3::jsonb,updated_at=now() WHERE site_id=$1 AND kind='repository' AND id='baseline' AND data->>'headSha'=$2 RETURNING id", [siteId, expectedHeadSha, JSON.stringify({ headSha: remote.headSha, repositoryFiles: remote.files, synchronizedAt: new Date().toISOString() })]);
		if (!rows.length) throw new ApiFailure(409, "BASELINE_REVISION_CONFLICT", "仓库基线已变化，请重新核对");
		return { synchronized: true, previousHeadSha: expectedHeadSha, headSha: remote.headSha, managedFiles: remote.files.length, message: "已确认管理文件字节完全相同，代码基线已同步；所有私有草稿保持原版本" };
	});
}
