import { randomUUID } from "node:crypto";
import type { PostRecord } from "../shared/contracts.js";
import { assertSite, collection, type FileStore, type Row } from "./file-store.js";
import { ApiFailure, digest } from "./security.js";
import { validatePostSource } from "./source-document.js";
import { readRepositoryFiles, personalToken, GitHubError } from "./github.js";
import { deriveManagedSettings, MANAGED_SETTINGS_PATH } from "./managed-settings.js";

type SourceFile = { path: string; source: string };
type RepositoryReader = (sha?: string) => Promise<Awaited<ReturnType<typeof readRepositoryFiles>>>;
type PublishedPost = { id?: string; filePath?: string; path?: string; slug?: string; sourceSha256?: string };
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
/**
 * Reading the repository is the first thing the admin does, so its failure must name the
 * actual cause instead of one catch-all sentence. The status code decides the remedy:
 * an expired token, a token without Contents, a wrong repository name and a network
 * failure are all fixed in different places.
 */
function repositoryReadFailure(error: unknown): ApiFailure {
	if (error instanceof ApiFailure) return error;
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("Missing environment configuration:")) {
		return new ApiFailure(503, "GITHUB_APP_CONFIGURATION_REQUIRED", "后台还没有配置 GitHub 令牌：请在 Vercel 环境变量里设置 GITHUB_TOKEN（细粒度 PAT，权限 Contents: Read and write + Metadata: Read）");
	}
	const repository = (process.env.GITHUB_REPOSITORY || "Nocticur/Firefly").trim();
	const branch = (process.env.GITHUB_BRANCH || "master").trim();
	const status = error instanceof GitHubError ? error.status : 0;
	// Without a PAT the App fallback needs its own installation on the target repository.
	const noToken = !personalToken();
	const remedy = status === 401 ? "令牌无效或已过期，请重新生成后更新 GITHUB_TOKEN"
		: status === 403 ? "令牌权限不足或触发 GitHub 限流，请确认该令牌对目标仓库有 Contents: Read and write"
		: status === 404 ? (noToken
			? `仓库或分支不存在，或凭据未授权该仓库；当前没有设置 GITHUB_TOKEN，正在走 GitHub App 回退，需确认该 App 已安装到 ${repository} 且有 Contents 权限（推荐改为配置 GITHUB_TOKEN）`
			: `仓库或分支不存在，或令牌没有授权 ${repository}；请核对 GITHUB_REPOSITORY / GITHUB_BRANCH 与令牌的仓库授权范围`)
		: status === 0 ? "无法连接 api.github.com，请检查部署环境的出网访问与 DNS"
		: status >= 500 ? "GitHub 服务端暂时异常，稍后重试"
		: "请检查令牌、仓库名与分支配置";
	return new ApiFailure(503, "GITHUB_REPOSITORY_UNAVAILABLE", `GitHub 仓库暂时无法读取（${repository}@${branch}）：${remedy}`, { repository, branch, status });
}
function readJsonFile(files: SourceFile[], path: string): unknown {
	const file = files.find((entry) => entry.path === path);
	if (!file) return undefined;
	try { return JSON.parse(file.source); } catch { throw new ApiFailure(422, "REPOSITORY_CONFIGURATION_INVALID", `GitHub ${path} JSON 不合法`); }
}
function baselineSlug(path: string): string {
	return path.replace(/^src\/content\/posts\//, "").replace(/\.(?:md|mdx)$/i, "").replace(/(?:^|\/)index$/, "").replace(/\/$/, "");
}

export async function importRepository(store: FileStore, siteId: string, reader: RepositoryReader = readRepositoryFiles) {
	let repository: Awaited<ReturnType<typeof readRepositoryFiles>>;
	try { repository = await reader(); }
	catch (error) { throw repositoryReadFailure(error); }
	const files: SourceFile[] = repository.files;
	const publishedState = repository.publishedState || readJsonFile(files, "src/data/published-state.json");
	const mapping: PublishedPost[] = isRecord(publishedState) && Array.isArray(publishedState.posts) ? publishedState.posts.filter(isRecord) as PublishedPost[] : [];
	const managed = deriveManagedSettings(files);
	const redirects = readJsonFile(files, "src/data/redirects.json");
	const deploymentConfig = readJsonFile(files, "vercel.json");
	if (deploymentConfig !== undefined && (!isRecord(deploymentConfig) || deploymentConfig.redirects !== undefined && !Array.isArray(deploymentConfig.redirects))) throw new ApiFailure(422, "REPOSITORY_CONFIGURATION_INVALID", "GitHub vercel.json 必须为包含有效重定向规则的 JSON 对象");
	// A repository that stores neither file must not silently import empty settings,
	// which would blank out the theme's real configuration.
	const derivedLinks = Array.isArray(managed.navigation.links) ? managed.navigation.links : [];
	if (!Object.keys(managed.settings).length && !derivedLinks.length) throw new ApiFailure(503, "BASELINE_CONFIGURATION_REQUIRED", `仓库须包含 ${MANAGED_SETTINGS_PATH} 或可解析的 src/config/siteConfig.ts；不能用空配置替换主题`);
	const posts = files.filter((file) => /^src\/content\/posts\/.+\.(md|mdx)$/.test(file.path));
	if (!posts.length) throw new ApiFailure(422, "REPOSITORY_POSTS_MISSING", "GitHub 仓库没有读取到文章源码");
	return store.update((state) => {
		assertSite(state, siteId);
		const entities = collection(state, "entities");
		const existing = entities["repository:baseline"] as (Row & { data: Record<string, unknown> }) | undefined;
		if (existing) {
			// Upgrade an earlier import only at the exact recorded Git revision.
			// Post drafts and their published baseline remain unchanged.
			if (existing.data.deploymentConfig === undefined && deploymentConfig !== undefined && existing.data.headSha === repository.headSha) {
				existing.data = { ...existing.data, deploymentConfig }; existing.updated_at = new Date().toISOString();
			}
			return { imported: false, headSha: existing.data.headSha, message: "管理基线已存在；不会覆盖草稿或重复发布" };
		}
		// A draft created before any baseline existed (for example while the repository
		// was unreadable) must not lock the console out of its first import. The local
		// records the repository already owns are adopted in place, so their edited
		// bytes survive, and anything else stays a local draft waiting to be published.
		const localPosts = Object.values(entities).filter(row => row.kind === "post") as (Row & { data: PostRecord })[];
		const localByPath = new Map(localPosts.map(row => [`path:${row.data.filePath}`, row]));
		const localBySlug = new Map(localPosts.map(row => [`slug:${row.data.slug}`, row]));
		for (const file of posts) {
			const metadata = validatePostSource(file.source);
			const map = mapping.find((item) => (item.filePath || item.path) === file.path) || mapping.find((item) => item.slug === baselineSlug(file.path));
			if (map?.sourceSha256 && map.sourceSha256 !== digest(file.source)) throw new ApiFailure(409, "BASELINE_SOURCE_MISMATCH", `文章 ${file.path} 与发布基线的字节哈希不一致`);
			const slug = map?.slug || (typeof metadata.slug === "string" ? metadata.slug : baselineSlug(file.path));
			const adopted = localByPath.get(`path:${file.path}`) ?? localBySlug.get(`slug:${slug}`);
			if (adopted) {
				// Keep the published state's stable id so the article's identity does not
				// change just because the console could not read the repository earlier.
				const targetId = typeof map?.id === "string" ? map.id : String(adopted.id);
				if (targetId !== String(adopted.id)) {
					if (entities[`post:${targetId}`]) throw new ApiFailure(409, "BASELINE_IMPORT_CONFLICT", "本地草稿与仓库文章的稳定 ID 冲突，请人工核对");
					delete entities[`post:${String(adopted.id)}`];
					for (const row of Object.values(entities)) if (row.kind === "post_version" && (row.data as { postId?: unknown }).postId === adopted.id) (row.data as { postId?: string }).postId = targetId;
				}
				entities[`post:${targetId}`] = { ...adopted, id: targetId, data: { ...adopted.data, id: targetId, filePath: file.path } };
				continue;
			}
			const draft = metadata.draft === true;
			const post: PostRecord = { id: map?.id || randomUUID(), filePath: file.path, slug, title: String(metadata.title), published: String(metadata.published), draft, format: file.path.endsWith(".mdx") ? "mdx" : "md", source: file.source, metadata, revision: 1, publishedRevision: draft ? null : 1, publishedSource: draft ? null : file.source, updatedAt: new Date().toISOString() };
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(post.id)) throw new ApiFailure(422, "BASELINE_ID_INVALID", `文章 ${file.path} 的稳定 ID 须为 UUID`);
			if (entities[`post:${post.id}`] || Object.values(entities).some(row => row.kind === "post" && (row.data as PostRecord).slug === slug)) throw new ApiFailure(409, "BASELINE_IMPORT_CONFLICT", "仓库中存在重复的文章稳定 ID 或固定网址");
			entities[`post:${post.id}`] = { id: post.id, kind: "post", data: post, revision: 1, created_at: post.updatedAt, updated_at: post.updatedAt };
		}
		const now = new Date().toISOString();
		for (const kind of ["settings", "navigation"] as const) entities[`${kind}:default`] = { id: "default", kind, data: managed[kind], revision: 1, created_at: now, updated_at: now };
		if (isRecord(managed.icons)) entities["icons:default"] = { id: "default", kind: "icons", data: managed.icons, revision: 1, created_at: now, updated_at: now };
		const baseline = { headSha: repository.headSha, repositoryFiles: files, snapshotId: isRecord(publishedState) ? publishedState.snapshotId || null : null, importedAt: new Date().toISOString(), importedPosts: posts.length, publishedSettings: managed.settings, publishedNavigation: managed.navigation, publishedIcons: managed.icons || {}, settingsSource: managed.source, publishedState: publishedState || null, posts: mapping, redirects: Array.isArray(redirects) ? redirects : [], ...(deploymentConfig !== undefined ? { deploymentConfig } : {}) };
		entities["repository:baseline"] = { id: "baseline", kind: "repository", data: baseline, revision: 1, created_at: now, updated_at: now };
		return { imported: true, headSha: repository.headSha, records: posts.length, publicPosts: posts.filter((file) => validatePostSource(file.source).draft !== true).length };
	});
}

export type RepositoryDifference = { path: string; expectedSource: string | null; remoteSource: string | null; expectedSha256: string | null; remoteSha256: string | null };

/**
 * The admin console reads content from the Git repository. A fresh deployment starts
 * with empty state, so the first authorized read primes it from the repository rather
 * than rendering a blank console. Import is idempotent and never overwrites drafts.
 */
let priming: Promise<unknown> | null = null;
export async function ensureBaseline(store: FileStore, siteId: string): Promise<void> {
	try {
		if (collection(await store.read(), "entities")["repository:baseline"]) return;
	} catch { return; }
	// The failure is surfaced rather than logged: a bad token used to leave the admin
	// looking empty, which is indistinguishable from a repository that has no content.
	if (!priming) priming = importRepository(store, siteId).finally(() => { priming = null; });
	await priming;
}export function compareRepositoryFiles(expected: SourceFile[], remote: SourceFile[]): RepositoryDifference[] {
	const before = new Map(expected.map((file) => [file.path, file.source])); const after = new Map(remote.map((file) => [file.path, file.source]));
	return [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => before.get(path) !== after.get(path)).map((path) => {
		const expectedSource = before.get(path) ?? null; const remoteSource = after.get(path) ?? null;
		return { path, expectedSource, remoteSource, expectedSha256: expectedSource === null ? null : digest(expectedSource), remoteSha256: remoteSource === null ? null : digest(remoteSource) };
	});
}

/** Only code-only Git changes may advance the baseline. Private file drafts stay untouched. */
export async function synchronizeRepository(store: FileStore, siteId: string, expectedHeadSha: string, reader: RepositoryReader = readRepositoryFiles) {
	if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) throw new ApiFailure(400, "BASELINE_REVISION_REQUIRED", "提供已读取基线的完整 expectedHeadSha");
	const initialState = await store.read(); assertSite(initialState, siteId);
	const initial = collection(initialState, "entities")["repository:baseline"] as (Row & { data: Record<string, unknown> }) | undefined;
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
	return store.update((state) => {
		assertSite(state, siteId);
		const current = collection(state, "entities")["repository:baseline"] as (Row & { data: Record<string, unknown> }) | undefined;
		if (current?.data.headSha !== expectedHeadSha) throw new ApiFailure(409, "BASELINE_REVISION_CONFLICT", "核对期间仓库基线已变化，请重新读取");
		if (Object.values(collection(state, "release_tasks")).some(row => row.kind === "publish" && (!["verified", "failed", "conflict"].includes(String(row.state)) || (row.details as Row | undefined)?.restoreRequiresReconciliation === true))) throw new ApiFailure(409, "PUBLISH_RECONCILIATION_REQUIRED", "先核查所有未完成或恢复的发布，再同步代码基线");
		if (differences.length) throw new ApiFailure(409, "MANAGED_REPOSITORY_CONFLICT", "远端管理内容已变更；请审阅逐文件差异并通过独立合并处理，未推进基线且保留全部私有草稿", { baseSha: expectedHeadSha, remoteSha: remote.headSha, diff: differences });
		current.data = { ...current.data, headSha: remote.headSha, repositoryFiles: remote.files, synchronizedAt: new Date().toISOString() };
		current.updated_at = new Date().toISOString(); current.revision = Number(current.revision) + 1;
		return { synchronized: true, previousHeadSha: expectedHeadSha, headSha: remote.headSha, managedFiles: remote.files.length, message: "已确认管理文件字节完全相同，代码基线已同步；所有私有草稿保持原版本" };
	});
}
