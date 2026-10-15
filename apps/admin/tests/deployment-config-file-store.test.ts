import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryStore, collection, type FileStore } from "../server/file-store.js";
import { createPost, getPost, savePost } from "../server/content.js";
import { importRepository } from "../server/repository.js";
import { freezeRelease, processReleaseTask, type FrozenSnapshot } from "../server/releases.js";
import { ApiFailure } from "../server/security.js";
import { sha256, type Redirect } from "../server/release-format.js";
import type { GitHubProvider, RepositoryFile } from "../server/github.js";

const baseSha = "a".repeat(40);
const firstSha = "b".repeat(40);
const secondSha = "c".repeat(40);
const source = '---\n# preserve original front matter\ntitle: "中文文章"\npublished: 2026-09-10\ndraft: false\nslug: "云端/旧中文"\n---\nOriginal body\n';
const oldRoute = "/posts/云端/旧中文/";
const newRoute = "/posts/云端/新中文/";
const previous: Redirect[] = [{ from: "/posts/更早中文/", to: oldRoute, permanent: true }];
const config = {
	$schema: "https://openapi.vercel.sh/vercel.json", framework: null, installCommand: "pnpm install --frozen-lockfile", buildCommand: "pnpm build:vercel",
	headers: [{ source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }],
	crons: [{ path: "/api/maintenance/cron", schedule: "0 19 * * *" }],
	redirects: [{ source: "/legacy/:path*", destination: "https://legacy.example/:path*", permanent: false }, { source: "/posts/:path*", destination: "https://archive.example/:path*", permanent: false }, { source: previous[0].from, destination: previous[0].to, permanent: true }],
};
const request = (id: string, revision: number) => ({ postIds: [id], expectedRevisions: { [id]: revision }, idempotencyKey: randomUUID() });
async function baseline(store: FileStore, _site: string) { return collection(await store.read(), "entities")["repository:baseline"]!.data as Record<string, unknown>; }
async function snapshot(store: FileStore, _site: string, id: string) { return collection(await store.read(), "release_snapshots")[id]!.data as FrozenSnapshot; }

function repository(id: string, deploymentConfig?: unknown, redirects: Redirect[] = previous) {
	const files: RepositoryFile[] = [
		{ path: "src/content/posts/legacy.md", source },
		{ path: "src/data/managed-settings.json", source: JSON.stringify({ schemaVersion: 1, settings: { title: "Nocticur" }, navigation: { links: [] }, icons: {} }) },
		{ path: "src/data/redirects.json", source: JSON.stringify(redirects) },
		...(deploymentConfig !== undefined ? [{ path: "vercel.json", source: JSON.stringify(deploymentConfig) }] : []),
	];
	return { headSha: baseSha, files, publishedState: { posts: [{ id, filePath: files[0].path, slug: "云端/旧中文", sourceSha256: sha256(source) }] } };
}

test("flat files freeze and verify actual Vercel redirects with the repository configuration", async (t) => {
	let store: FileStore;
	const site = () => { const value = `tests/deployment-config-${randomUUID()}:development`; store = createMemoryStore(value); return value; };
		await t.test("Chinese slug changes, media replacement and subsequent releases preserve root config and durable redirect chains", async () => {
			const currentSite = site(); const id = randomUUID(); const originalRepository = repository(id, config);
			await importRepository(store, currentSite, async () => originalRepository);
			assert.deepEqual((await baseline(store, currentSite)).deploymentConfig, config);
			const mediaId = randomUUID(); const media = { id: mediaId, pathname: `drafts/${mediaId}.png`, digest: sha256("frozen bytes"), size: 12, contentType: "image/png" };
			await store.update((state) => { collection(state, "entities")[`media:${mediaId}`] = { id: mediaId, kind: "media", data: media, revision: 1 }; });
			const savedSource = source.replace('slug: "云端/旧中文"', 'slug: "云端/新中文"') + `![private image](media:${mediaId})\n`;
			const edited = await savePost(store, currentSite, id, savedSource, 1);
			const release = await freezeRelease(request(id, edited.revision), store, currentSite);
			const frozen = await snapshot(store, currentSite, release.snapshotId!);
			const expectedRedirects: Redirect[] = [{ from: previous[0].from, to: newRoute, permanent: true }, { from: oldRoute, to: newRoute, permanent: true }];
			const expectedConfig = { ...config, redirects: [...expectedRedirects.map(({ from, to }) => ({ source: from, destination: to, permanent: true })), config.redirects[0], config.redirects[1]] };
			assert.deepEqual(frozen.deploymentConfig, expectedConfig); assert.deepEqual(frozen.redirects, expectedRedirects);
			assert.deepEqual(JSON.parse(frozen.files.find((file) => file.path === "vercel.json")!.source), expectedConfig);
			let commits = 0; let committedFiles: RepositoryFile[] = []; const publicUrl = "https://example.public.blob.vercel-storage.com/frozen.png";
			const git: GitHubProvider = {
				async readRepositoryFiles() { return originalRepository; },
				async commit(input) {
					commits++; assert.equal(input.baseSha, baseSha); committedFiles = input.files;
					assert.deepEqual(JSON.parse(input.files.find((file) => file.path === "vercel.json")!.source), expectedConfig);
					assert.deepEqual(JSON.parse(input.files.find((file) => file.path === "src/data/redirects.json")!.source), expectedRedirects);
					assert.ok(input.files.find((file) => file.path === "src/content/posts/legacy.md")!.source.includes(publicUrl));
					return firstSha;
				}, async findCommit() { return null; },
			};
			assert.deepEqual(await processReleaseTask(release.id, { store, site: currentSite, github: git, deployment: { async verify(sha, item) { assert.deepEqual(item.deploymentConfig, expectedConfig); return { status: "verified", sha, deploymentId: "first-production" }; } }, skipCapabilityCheck: true, afterVerified: async () => {}, prepareMedia: async (ids, _taskId, item) => { assert.deepEqual(ids, [mediaId]); assert.equal(item.media![mediaId].pathname, media.pathname); return { [mediaId]: publicUrl }; } }), { done: true, state: "verified" });
			assert.equal(commits, 1); assert.deepEqual((await baseline(store, currentSite)).deploymentConfig, expectedConfig);
			assert.equal((await getPost(store, currentSite, id)).source, savedSource);
			const secondSource = savedSource.replace('slug: "云端/新中文"', 'slug: "最终中文"');
			const secondEdit = await savePost(store, currentSite, id, secondSource, edited.revision);
			const next = await freezeRelease(request(id, secondEdit.revision), store, currentSite);
			const nextFrozen = await snapshot(store, currentSite, next.snapshotId!);
			const nextRedirects: Redirect[] = [...expectedRedirects.map((redirect) => ({ ...redirect, to: "/posts/最终中文/" })), { from: newRoute, to: "/posts/最终中文/", permanent: true }];
			const nextConfig = { ...config, redirects: [...nextRedirects.map(({ from, to }) => ({ source: from, destination: to, permanent: true })), config.redirects[0], config.redirects[1]] };
			assert.deepEqual(nextFrozen.deploymentConfig, nextConfig); assert.deepEqual(nextFrozen.redirects, nextRedirects);
			const nextGit: GitHubProvider = { ...git, async readRepositoryFiles() { return { headSha: firstSha, files: committedFiles }; }, async commit(input) { commits++; assert.equal(input.baseSha, firstSha); assert.deepEqual(JSON.parse(input.files.find((file) => file.path === "vercel.json")!.source), nextConfig); return secondSha; } };
			assert.equal((await processReleaseTask(next.id, { store, site: currentSite, github: nextGit, deployment: { async verify(sha) { return { status: "verified", sha, deploymentId: "second-production" }; } }, skipCapabilityCheck: true, afterVerified: async () => {}, prepareMedia: async () => ({ [mediaId]: publicUrl }) })).state, "verified");
			const final = await baseline(store, currentSite); assert.equal(final.headSha, secondSha); assert.deepEqual(final.deploymentConfig, nextConfig); assert.equal(commits, 2);
		});
		await t.test("missing root configuration refuses nonempty permanent redirects without leaving a task or snapshot", async () => {
			const currentSite = site(); const id = randomUUID(); await importRepository(store, currentSite, async () => repository(id, undefined, []));
			const changed = await savePost(store, currentSite, id, source.replace('slug: "云端/旧中文"', 'slug: "新中文"'), 1);
			await assert.rejects(freezeRelease(request(id, changed.revision), store, currentSite), (error: unknown) => error instanceof ApiFailure && error.status === 409 && error.code === "PERMANENT_REDIRECT_CONFIGURATION_REQUIRED");
			assert.equal(Object.keys(collection(await store.read(), "release_tasks")).length, 0);
			assert.equal(Object.keys(collection(await store.read(), "release_snapshots")).length, 0);
			assert.equal((await getPost(store, currentSite, id)).source, changed.source);
		});
		await t.test("an existing unmanaged rule for the renamed URL rejects the release and preserves configuration", async () => {
			const currentSite = site(); const id = randomUUID(); const conflictingConfig = { ...config, redirects: [...config.redirects, { source: oldRoute, destination: "https://unmanaged.example/", permanent: false }] };
			await importRepository(store, currentSite, async () => repository(id, conflictingConfig));
			const changed = await savePost(store, currentSite, id, source.replace('slug: "云端/旧中文"', 'slug: "新中文"'), 1);
			await assert.rejects(freezeRelease(request(id, changed.revision), store, currentSite), (error: unknown) => error instanceof ApiFailure && error.code === "PERMANENT_REDIRECT_CONFIGURATION_REQUIRED");
			assert.deepEqual((await baseline(store, currentSite)).deploymentConfig, conflictingConfig);
		});
		await t.test("an article cannot occupy a published old URL retained as a permanent redirect", async () => {
			const currentSite = site(); const id = randomUUID(); await importRepository(store, currentSite, async () => repository(id, config));
			const renamed = await savePost(store, currentSite, id, source.replace('slug: "云端/旧中文"', 'slug: "新中文"'), 1);
			const replacement = await createPost(store, currentSite, source.replace("Original body", "A different new article"), "云端/旧中文");
			await assert.rejects(freezeRelease({ postIds: [id, replacement.id], expectedRevisions: { [id]: renamed.revision, [replacement.id]: replacement.revision }, idempotencyKey: randomUUID() }, store, currentSite), (error: unknown) => error instanceof ApiFailure && error.status === 409 && error.code === "SLUG_REDIRECT_CONFLICT");
			assert.equal(Object.keys(collection(await store.read(), "release_tasks")).length, 0);
			assert.equal((await getPost(store, currentSite, replacement.id)).publishedSource, null);
			assert.deepEqual((await baseline(store, currentSite)).deploymentConfig, config);
		});
		await t.test("older imports acquire deployment configuration only at the same recorded Git SHA and preserve edited drafts", async () => {
			const currentSite = site(); const id = randomUUID(); await importRepository(store, currentSite, async () => repository(id, undefined, []));
			const changed = await savePost(store, currentSite, id, source.replace("Original body", "private later edit"), 1);
			const addition = repository(id, { ...config, redirects: [] }, []);
			assert.equal((await importRepository(store, currentSite, async () => ({ ...addition, headSha: firstSha }))).imported, false);
			assert.equal((await baseline(store, currentSite)).deploymentConfig, undefined);
			assert.equal((await importRepository(store, currentSite, async () => addition)).imported, false);
			assert.deepEqual((await baseline(store, currentSite)).deploymentConfig, { ...config, redirects: [] });
			const current = await getPost(store, currentSite, id); assert.equal(current.source, changed.source); assert.equal(current.revision, changed.revision); assert.equal(current.publishedSource, source);
		});
});
