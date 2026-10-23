import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryStore, collection } from "../server/file-store.js";
import { createPost, getPost, savePost, listPostHistory, restorePostVersion } from "../server/content.js";
import { importRepository, synchronizeRepository, compareRepositoryFiles } from "../server/repository.js";
import { getManagedEntity, saveManagedEntity } from "../server/settings.js";
import { ApiFailure, digest } from "../server/security.js";

const source = '---\n# original YAML comment\ntitle: "旧标题"\npublished: 2026-09-10\ndraft: false\nunknown: { keep: [1, 2] }\n---\n<div>literal HTML</div>\n\nbody\n';
const firstSha = "a".repeat(40);
const nextSha = "b".repeat(40);
function fixture(id = randomUUID()) {
	const mapping = { id, filePath: "src/content/posts/original.md", slug: "original", sourceSha256: digest(source) };
	const publishedState = { schemaVersion: 1, posts: [mapping], taskId: null, snapshotId: null, publicContentDigest: null };
	return { headSha: firstSha, publishedState, files: [
		{ path: mapping.filePath, source },
		{ path: "src/data/published-state.json", source: JSON.stringify(publishedState) },
		{ path: "src/data/managed-settings.json", source: JSON.stringify({ schemaVersion: 1, settings: { title: "Original", retained: { unmanaged: true } }, navigation: { links: [] }, icons: {}, friends: [] }) },
		{ path: "src/data/redirects.json", source: "[]" },
		{ path: "src/config/siteConfig.ts", source: "export const original = true;\n" },
		{ path: "vercel.json", source: JSON.stringify({ headers: [], redirects: [] }) },
	] };
}
const failure = (code: string) => (error: unknown) => error instanceof ApiFailure && error.code === code;

test("file content writes preserve exact bytes/history and allow one concurrent revision", async () => {
	const site = "tests/content:development";
	const store = createMemoryStore(site);
	const post = await createPost(store, site, source, "固定中文网址");
	assert.equal(post.publishedSource, null);
	const results = await Promise.allSettled([
		savePost(store, site, post.id, source.replace("旧标题", "修改 A"), 1),
		savePost(store, site, post.id, source.replace("旧标题", "修改 B"), 1),
	]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	const failed = results.find(result => result.status === "rejected");
	assert.ok(failed?.status === "rejected" && failure("REVISION_CONFLICT")(failed.reason));
	const current = await getPost(store, site, post.id);
	assert.equal(current.revision, 2);
	assert.equal(current.slug, post.slug);
	assert.equal(current.filePath, post.filePath);
	const history = await listPostHistory(store, site, post.id);
	assert.equal(history.length, 1);
	assert.equal(history[0].source, source);
	await assert.rejects(restorePostVersion(store, site, post.id, history[0].id, 1), failure("REVISION_CONFLICT"));
	const restored = await restorePostVersion(store, site, post.id, history[0].id, 2);
	assert.equal(restored.source, source);
	assert.equal(restored.revision, 3);
	assert.ok((await listPostHistory(store, site, post.id)).some(version => version.source === current.source));
	assert.equal(restored.publishedSource, null);
});

test("slug reservation is atomic and site mismatch cannot expose content", async () => {
	const site = "tests/slugs:development";
	const store = createMemoryStore(site);
	const results = await Promise.allSettled([createPost(store, site, source, "同一网址"), createPost(store, site, source, "同一网址")]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	const post = Object.values(collection(await store.read(), "entities")).find(row => row.kind === "post");
	assert.ok(post);
	await assert.rejects(getPost(store, "tests/other:development", String(post.id)), failure("STORE_SITE_MISMATCH"));
	const other = await createPost(store, site, source, "other");
	await assert.rejects(savePost(store, site, other.id, source.replace('title: "旧标题"', 'title: "旧标题"\nslug: "同一网址"'), 1), failure("SLUG_EXISTS"));
	assert.equal((await getPost(store, site, other.id)).revision, 1);
});

test("repository import is atomic, idempotent, retains drafts and unknown settings", async () => {
	const site = "tests/import:development";
	const store = createMemoryStore(site);
	const repository = fixture();
	const id = repository.publishedState.posts[0].id;
	assert.equal((await importRepository(store, site, async () => repository)).imported, true);
	const imported = await getPost(store, site, id);
	assert.equal(imported.source, source);
	assert.equal(imported.publishedSource, source);
	await savePost(store, site, id, source.replace("旧标题", "私稿改标题"), 1);
	assert.equal((await importRepository(store, site, async () => repository)).imported, false);
	assert.equal((await getPost(store, site, id)).title, "私稿改标题");
	const settings = await saveManagedEntity(store, site, "settings", { title: "设置草稿" }, 1);
	assert.deepEqual(settings.data.retained, { unmanaged: true });
	await assert.rejects(saveManagedEntity(store, site, "settings", { title: "stale" }, 1), failure("REVISION_CONFLICT"));
	assert.equal((await getManagedEntity(store, site, "settings")).revision, 2);
	const bad = createMemoryStore("tests/bad:development");
	await assert.rejects(importRepository(bad, "tests/bad:development", async () => ({ ...repository, publishedState: { ...repository.publishedState, posts: [{ ...repository.publishedState.posts[0], sourceSha256: "invalid" }] } })), failure("BASELINE_SOURCE_MISMATCH"));
	assert.equal(Object.keys(collection(await bad.read(), "entities")).length, 0);
});

test("a draft created before the repository was readable adopts the baseline instead of blocking it", async () => {
	const site = "tests/import-conflict:development";
	const store = createMemoryStore(site);
	const repository = fixture();
	const repositoryId = repository.publishedState.posts[0].id;
	// This is the state a bad token leaves behind: local drafts, no baseline at all.
	const local = await createPost(store, site, source.replace("旧标题", "本地草稿"), "original");
	assert.equal(collection(await store.read(), "entities")["repository:baseline"], undefined);

	const result = await importRepository(store, site, async () => repository);
	assert.equal(result.imported, true);
	assert.ok(collection(await store.read(), "entities")["repository:baseline"]);
	// The repository owns this path, but the edited bytes are the user's and must survive
	// the import; the article adopts published-state's stable id so its identity is stable.
	const adopted = await getPost(store, site, repositoryId);
	assert.equal(adopted.title, "本地草稿");
	assert.equal(adopted.filePath, "src/content/posts/original.md");
	assert.equal(adopted.revision, 1);
	await assert.rejects(getPost(store, site, local.id), failure("POST_NOT_FOUND"));
	// Exactly one record per repository file: the draft was adopted, not duplicated.
	const posts = Object.values(collection(await store.read(), "entities")).filter(row => row.kind === "post");
	assert.equal(posts.length, 1);
});

test("repository synchronization preserves drafts, detects byte changes, and blocks uncertain publish", async () => {
	const site = "tests/sync:development";
	const store = createMemoryStore(site);
	const repository = fixture();
	const id = repository.publishedState.posts[0].id;
	await importRepository(store, site, async () => repository);
	await savePost(store, site, id, source + "private change\n", 1);
	const before = await getPost(store, site, id);
	const history = await listPostHistory(store, site, id);
	assert.equal((await synchronizeRepository(store, site, firstSha, async () => ({ ...repository, headSha: nextSha }))).headSha, nextSha);
	assert.deepEqual(await getPost(store, site, id), before);
	assert.deepEqual(await listPostHistory(store, site, id), history);
	await assert.rejects(synchronizeRepository(store, site, firstSha, async () => repository), failure("BASELINE_REVISION_CONFLICT"));
	await assert.rejects(synchronizeRepository(store, site, nextSha, async () => ({ ...repository, headSha: "c".repeat(40), files: repository.files.map(file => file.path.endsWith("original.md") ? { ...file, source: file.source + "external\n" } : file) })), failure("MANAGED_REPOSITORY_CONFLICT"));
	await store.update(state => { collection(state, "release_tasks").uncertain = { id: "uncertain", kind: "publish", state: "unknown", details: {} }; });
	await assert.rejects(synchronizeRepository(store, site, nextSha, async () => ({ ...repository, headSha: "c".repeat(40) })), failure("PUBLISH_RECONCILIATION_REQUIRED"));
	await store.update(state => { collection(state, "release_tasks").uncertain.state = "failed"; collection(state, "release_tasks").uncertain.details = { restoreRequiresReconciliation: true }; });
	await assert.rejects(synchronizeRepository(store, site, nextSha, async () => ({ ...repository, headSha: "c".repeat(40) })), failure("PUBLISH_RECONCILIATION_REQUIRED"));
});

test("managed file comparison detects additions/removals and exact newline bytes", () => {
	const diff = compareRepositoryFiles([{ path: "deleted", source: "old" }, { path: "changed", source: "CRLF\r\n" }], [{ path: "added", source: "new" }, { path: "changed", source: "CRLF\n" }]);
	assert.deepEqual(diff.map(item => item.path), ["added", "changed", "deleted"]);
	assert.notEqual(diff[1].expectedSha256, diff[1].remoteSha256);
});

test("initial import retains MDX bytes and does not publish a repository draft", async () => {
	const site = "tests/mdx:development"; const store = createMemoryStore(site);
	const mdx = '---\ntitle: "MDX"\npublished: 2026-09-11\ndraft: true\n---\nimport Widget from "./Widget.astro";\n\n<Widget value={{ keep: "bytes" }} />\n';
	const original = fixture();
	const imported = await importRepository(store, site, async () => ({ ...original, files: [...original.files, { path: "src/content/posts/draft.mdx", source: mdx }] }));
	assert.equal(imported.records, 2); assert.equal(imported.publicPosts, 1);
	const row = Object.values(collection(await store.read(), "entities")).find(row => row.kind === "post" && (row.data as { format: string }).format === "mdx");
	assert.ok(row);
	const draft = await getPost(store, site, String(row.id));
	assert.equal(draft.source, mdx); assert.equal(draft.publishedSource, null); assert.equal(draft.publishedRevision, null);
});

test("older baselines use immutable Git evidence and reject an advancing baseline during fetch", async () => {
	const site = "tests/history-sync:development"; const store = createMemoryStore(site); const original = fixture();
	await importRepository(store, site, async () => original);
	await store.update(state => { delete (collection(state, "entities")["repository:baseline"].data as Record<string, unknown>).repositoryFiles; });
	const reads: Array<string | undefined> = [];
	await synchronizeRepository(store, site, firstSha, async sha => { reads.push(sha); return sha === firstSha ? original : { ...original, headSha: nextSha }; });
	assert.deepEqual(reads, [undefined, firstSha]);
	await store.update(state => { const baseline = collection(state, "entities")["repository:baseline"].data as Record<string, unknown>; baseline.headSha = firstSha; delete baseline.repositoryFiles; });
	await assert.rejects(synchronizeRepository(store, site, firstSha, async () => ({ ...original, headSha: nextSha })), failure("BASELINE_EVIDENCE_INVALID"));
	await store.update(state => { (collection(state, "entities")["repository:baseline"].data as Record<string, unknown>).repositoryFiles = original.files; });
	await assert.rejects(synchronizeRepository(store, site, firstSha, async () => {
		await store.update(state => { (collection(state, "entities")["repository:baseline"].data as Record<string, unknown>).headSha = "c".repeat(40); });
		return { ...original, headSha: nextSha };
	}), failure("BASELINE_REVISION_CONFLICT"));
	assert.equal((collection(await store.read(), "entities")["repository:baseline"].data as Record<string, unknown>).headSha, "c".repeat(40));
});
