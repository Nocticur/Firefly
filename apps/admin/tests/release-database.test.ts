import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, type Database } from "../server/db.js";
import { createPost, getPost, savePost } from "../server/content.js";
import { ApiFailure } from "../server/security.js";
import { GitHubError, type GitHubProvider } from "../server/github.js";
import { freezeRelease, processReleaseTask, type FrozenSnapshot, type DeploymentProvider } from "../server/releases.js";
import { publicContentDigest, sha256 } from "../server/release-format.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const baseSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const source = '---\n# preserve this comment\ntitle: "Frozen"\npublished: 2026-09-10\ndraft: false\nunknown: { untouched: [1, 2] }\n---\n<div>Original HTML</div>\n';
const verified: DeploymentProvider = { async verify(sha) { return { status: "verified", sha, deploymentId: "deployment-verified" }; } };
const noNotification = async () => {};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function seed(db: Database, site: string, inputSource = source) {
	await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'repository','baseline',$2::jsonb)", [site, JSON.stringify({ headSha: baseSha, posts: [], redirects: [] })]);
	for (const [kind, data] of [["settings", { title: "Original", retainedPrivateField: "never public" }], ["navigation", { links: [{ name: "Home", url: "/" }] }], ["icons", {}]] as const) await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,$2,'default',$3::jsonb)", [site, kind, JSON.stringify(data)]);
	return createPost(db, site, inputSource, "固定网址");
}
const input = (id: string, revision = 1) => ({ postIds: [id], expectedRevisions: { [id]: revision }, idempotencyKey: randomUUID() });
function github(overrides: Partial<GitHubProvider> = {}): GitHubProvider {
	return { async readRepositoryFiles() { return { headSha: baseSha, files: [] }; }, async commit() { return targetSha; }, async findCommit() { return null; }, ...overrides };
}

test("PostgreSQL release tasks preserve snapshots and reconcile concurrent or uncertain side effects", { skip: !databaseUrl }, async (t) => {
	const db = createDatabase(databaseUrl!); const sites: string[] = [];
	const newSite = () => { const site = `tests/releases-${randomUUID()}:development`; sites.push(site); return site; };
	try {
		for (const file of ["001-core.sql", "002-release.sql", "003-interactions.sql", "004-maintenance-guards.sql"]) await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
		await t.test("selected draft and stale revisions are rejected; idempotency freezes original bytes", async () => {
			const site = newSite(); const draft = await seed(db, site, source.replace("draft: false", "draft: true"));
			await assert.rejects(() => freezeRelease(input(draft.id), db, site), (error: unknown) => error instanceof ApiFailure && error.code === "PRIVATE_DRAFT_SELECTED");
			await savePost(db, site, draft.id, source, 1);
			await assert.rejects(() => freezeRelease(input(draft.id), db, site), (error: unknown) => error instanceof ApiFailure && error.code === "REVISION_CONFLICT");
			const request = input(draft.id, 2); const release = await freezeRelease(request, db, site);
			await savePost(db, site, draft.id, source.replace("Original HTML", "Later private draft"), 2);
			assert.equal((await freezeRelease(request, db, site)).id, release.id);
			const [snapshot] = await db.query<Record<string, unknown> & { data: FrozenSnapshot }>("SELECT data FROM release_snapshots WHERE site_id=$1 AND id=$2", [site, release.snapshotId]);
			assert.equal(snapshot.data.sources[0].source, source); assert.equal(snapshot.data.sources[0].revision, 2);
			assert.equal(snapshot.data.sources[0].originalSource, source);
			assert.equal(snapshot.data.digest, publicContentDigest(snapshot.data.posts, snapshot.data.settings, snapshot.data.redirects));
			assert.deepEqual(snapshot.data.settings, { schemaVersion: 1, settings: { title: "Original" }, navigation: { links: [{ name: "Home", url: "/" }] }, icons: {}, friends: [] });
		});
		await t.test("a later editor save stays private when the frozen revision reaches production", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			await savePost(db, site, post.id, source.replace("Original HTML", "Later private draft"), 1);
			let notifications = 0; let committed: FrozenSnapshot | undefined;
			const git = github({ async commit(commit) { assert.equal(commit.baseSha, baseSha); assert.equal(commit.files.find((file) => file.path === post.filePath)?.source, source); return targetSha; } });
			const result = await processReleaseTask(release.id, { db, site, github: git, deployment: { async verify(sha, snapshot) { committed = snapshot; return verified.verify(sha, snapshot); } }, skipCapabilityCheck: true, afterVerified: async () => { notifications++; } });
			assert.deepEqual(result, { done: true, state: "verified" }); assert.equal(notifications, 1);
			const current = await getPost(db, site, post.id); assert.equal(current.source, source.replace("Original HTML", "Later private draft")); assert.equal(current.revision, 2); assert.equal(current.publishedSource, source); assert.equal(current.publishedRevision, 1);
			const [baseline] = await db.query<Record<string, unknown> & { data: Record<string, unknown> }>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository' AND id='baseline'", [site]);
			assert.equal(baseline.data.headSha, targetSha); assert.equal(baseline.data.publicContentDigest, committed!.digest);
		});
		await t.test("commit timeout persists unknown and retries only reconciliation until the commit is found", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			let commits = 0; let reconciliations = 0; let found: string | null = null;
			const git = github({ async commit() { commits++; throw new GitHubError(0, "transport timed out after submit", true); }, async findCommit() { reconciliations++; return found; } });
			const deps = { db, site, github: git, deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification };
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown");
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown"); assert.equal(commits, 1); assert.equal(reconciliations, 1);
			found = targetSha; assert.equal((await processReleaseTask(release.id, deps)).state, "verified"); assert.equal(commits, 1); assert.equal(reconciliations, 2);
		});
		await t.test("overlapping workers cannot execute a second commit", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			const entered = deferred<void>(); const proceed = deferred<void>(); let commits = 0;
			const git = github({ async readRepositoryFiles() { entered.resolve(); await proceed.promise; return { headSha: baseSha, files: [] }; }, async commit() { commits++; return targetSha; } });
			const deps = { db, site, github: git, deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification };
			const first = processReleaseTask(release.id, deps); await entered.promise;
			assert.deepEqual(await processReleaseTask(release.id, deps), { done: false, state: "queued" }); proceed.resolve();
			assert.equal((await first).state, "verified"); assert.equal(commits, 1);
		});
		await t.test("superseded verification cannot mark production or notify friends", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			const entered = deferred<void>(); const proceed = deferred<void>(); let notifications = 0;
			const first = processReleaseTask(release.id, { db, site, github: github(), deployment: { async verify(sha, snapshot) { entered.resolve(); await proceed.promise; return verified.verify(sha, snapshot); } }, skipCapabilityCheck: true, afterVerified: async () => { notifications++; } });
			await entered.promise;
			await db.query("UPDATE release_locks SET fencing_token=fencing_token+1,lease_until=now() WHERE site_id=$1", [site]); proceed.resolve();
			const result = await first; assert.equal(result.done, false); assert.equal(result.state, "deploying"); assert.equal(notifications, 0); assert.equal((await getPost(db, site, post.id)).publishedSource, null);
		});
		await t.test("only exact CAS failures terminate as conflict and deployment identity must match", async () => {
			const conflictSite = newSite(); const conflictPost = await seed(db, conflictSite); const conflict = await freezeRelease(input(conflictPost.id), db, conflictSite);
			assert.equal((await processReleaseTask(conflict.id, { db, site: conflictSite, github: github({ async commit() { throw new GitHubError(409, "expected head differs", false, true); } }), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification })).state, "conflict");
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			assert.equal((await processReleaseTask(release.id, { db, site, github: github(), deployment: { async verify() { return { status: "verified", sha: "wrong", deploymentId: "wrong-project" }; } }, skipCapabilityCheck: true, afterVerified: noNotification })).state, "deploying");
			assert.equal((await getPost(db, site, post.id)).publishedSource, null);
		});
		await t.test("private media in posts and settings use the frozen record and leave draft bytes intact", async () => {
			const site = newSite(); const mediaId = randomUUID(); const withMedia = source + `![image](media:${mediaId})\n`; const post = await seed(db, site, withMedia);
			const media = { id: mediaId, pathname: `drafts/${mediaId}.png`, digest: sha256("original bytes"), size: 14, contentType: "image/png" };
			await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'media',$2,$3::jsonb)", [site, mediaId, JSON.stringify(media)]);
			await db.query("UPDATE entities SET data=data || $2::jsonb WHERE site_id=$1 AND kind='settings'", [site, JSON.stringify({ avatar: `media:${mediaId}` })]);
			const release = await freezeRelease(input(post.id), db, site);
			await db.query("UPDATE entities SET data=data || $3::jsonb,revision=revision+1 WHERE site_id=$1 AND kind='media' AND id=$2", [site, mediaId, JSON.stringify({ pathname: "changed-private-path.png", digest: "different" })]);
			const publicUrl = "https://example.public.blob.vercel-storage.com/frozen.png";
			assert.equal((await processReleaseTask(release.id, { db, site, github: github(), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification, prepareMedia: async (ids, _id, snapshot) => { assert.deepEqual(ids, [mediaId]); assert.equal(snapshot.media![mediaId].pathname, media.pathname); assert.equal(snapshot.media![mediaId].revision, 1); return { [mediaId]: publicUrl }; } })).state, "verified");
			const current = await getPost(db, site, post.id); assert.equal(current.source, withMedia); assert.ok(current.publishedSource!.includes(publicUrl));
			const [record] = await db.query<Record<string, unknown> & { data: FrozenSnapshot }>("SELECT data FROM release_snapshots WHERE site_id=$1 AND id=$2", [site, release.snapshotId]);
			assert.equal(record.data.settings.settings && (record.data.settings.settings as Record<string, unknown>).avatar, publicUrl); assert.equal(record.data.originalSettings!.settings && (record.data.originalSettings!.settings as Record<string, unknown>).avatar, `media:${mediaId}`);
		});
		await t.test("restored unknown tasks block publication and cannot silently replay", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			await db.query("UPDATE release_tasks SET state='blocked',details=$3::jsonb WHERE site_id=$1 AND id=$2", [site, release.id, JSON.stringify({ restored: true, restoreRequiresReconciliation: true })]);
			const result = await processReleaseTask(release.id, { db, site, github: github({ async commit() { throw new Error("must never commit"); } }), deployment: verified, skipCapabilityCheck: true }); assert.deepEqual(result, { done: false, state: "blocked" });
			await assert.rejects(() => freezeRelease(input(post.id), db, site), (error: unknown) => error instanceof ApiFailure && error.code === "RESTORED_PUBLISH_RECONCILIATION_REQUIRED");
		});
		await t.test("manual restore reconciliation only reads providers and never commits old drafts or resends mail", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			await db.query("UPDATE release_tasks SET state='blocked',details=$3::jsonb WHERE site_id=$1 AND id=$2", [site, release.id, JSON.stringify({ restored: true, restoreRequiresReconciliation: true, restorePreviousState: "unknown" })]);
			let found: string | null = null; let reads = 0;
			const deps = { db, site, github: github({ async commit() { throw new Error("restored drafts must never be committed"); }, async findCommit() { reads++; return found; } }), deployment: verified, skipCapabilityCheck: true, reconcileRestored: true, afterVerified: async () => { throw new Error("historical notification must never be replayed"); } };
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown");
			assert.equal((await processReleaseTask(release.id, { ...deps, reconcileRestored: false })).state, "blocked");
			found = targetSha; assert.equal((await processReleaseTask(release.id, deps)).state, "verified"); assert.equal(reads, 2);
			const next = await freezeRelease(input(post.id), db, site); assert.ok(next.id !== release.id);
			await db.query("UPDATE release_tasks SET state='blocked',details=$3::jsonb WHERE site_id=$1 AND id=$2", [site, next.id, JSON.stringify({ restored: true, restoreRequiresReconciliation: true, restorePreviousState: "frozen" })]);
			assert.equal((await processReleaseTask(next.id, deps)).state, "failed"); assert.equal(reads, 2); assert.equal((await getPost(db, site, post.id)).source, source);
		});
		await t.test("a crashed post-verification notification retries without another Git commit", async () => {
			const site = newSite(); const post = await seed(db, site); const release = await freezeRelease(input(post.id), db, site);
			let commits = 0; let notifications = 0;
			const deps = { db, site, github: github({ async commit() { commits++; return targetSha; } }), deployment: verified, skipCapabilityCheck: true, afterVerified: async () => { if (++notifications === 1) throw new Error("database interruption"); } };
			await assert.rejects(() => processReleaseTask(release.id, deps), /durable notification/);
			assert.equal((await getPost(db, site, post.id)).publishedSource, source);
			assert.deepEqual(await processReleaseTask(release.id, deps), { done: true, state: "verified" }); assert.equal(commits, 1); assert.equal(notifications, 2);
		});
	} finally {
		for (const site of sites) for (const table of ["entities", "friends", "release_tasks", "release_snapshots", "release_locks"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [site]);
		await db.close();
	}
});
