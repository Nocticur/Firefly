import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMemoryStore, collection, type FileStore, type Row } from "../server/file-store.js";
import { createPost, getPost, savePost } from "../server/content.js";
import { ApiFailure } from "../server/security.js";
import { GitHubError, type GitHubProvider } from "../server/github.js";
import { freezeRelease, processReleaseTask, reconcileVerifiedReleaseFinalization, type FrozenSnapshot, type DeploymentProvider } from "../server/releases.js";
import { publicContentDigest, sha256 } from "../server/release-format.js";

const baseSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const source = '---\n# preserve this comment\ntitle: "Frozen"\npublished: 2026-09-10\ndraft: false\nunknown: { untouched: [1, 2] }\n---\n<div>Original HTML</div>\n';
const verified: DeploymentProvider = { async verify(sha) { return { status: "verified", sha, deploymentId: "deployment-verified" }; } };
const noNotification = async () => {};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function seed(store: FileStore, site: string, inputSource = source) {
	await store.update((state) => { const rows = collection(state, "entities");
		for (const [kind, id, data] of [["repository", "baseline", { headSha: baseSha, posts: [], redirects: [] }], ["settings", "default", { title: "Original", retainedPrivateField: "never public" }], ["navigation", "default", { links: [{ name: "Home", url: "/" }] }], ["icons", "default", {}]] as const) rows[`${kind}:${id}`] = { id, kind, data, revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
	});
	return createPost(store, site, inputSource, "固定网址");
}
async function record(store: FileStore, name: string, id: string) { return collection(await store.read(), name)[id]!; }
async function patchTask(store: FileStore, id: string, patch: Row) { await store.update((state) => Object.assign(collection(state, "release_tasks")[id]!, patch)); }
async function patchEntity(store: FileStore, key: string, patch: Row, revision?: number) { await store.update((state) => { const row = collection(state, "entities")[key]!; row.data = { ...(row.data as Row), ...patch }; if (revision !== undefined) row.revision = revision; }); }

const input = (id: string, revision = 1) => ({ postIds: [id], expectedRevisions: { [id]: revision }, idempotencyKey: randomUUID() });
function github(overrides: Partial<GitHubProvider> = {}): GitHubProvider {
	return { async readRepositoryFiles() { return { headSha: baseSha, files: [] }; }, async commit() { return targetSha; }, async findCommit() { return null; }, ...overrides };
}

test("flat-file release tasks preserve snapshots and reconcile concurrent or uncertain side effects", async (t) => {
	let store: FileStore;
	const newSite = () => { const site = `tests/releases-${randomUUID()}:development`; store = createMemoryStore(site); return site; };
		await t.test("selected draft and stale revisions are rejected; idempotency freezes original bytes", async () => {
			const site = newSite(); const draft = await seed(store, site, source.replace("draft: false", "draft: true"));
			await savePost(store, site, draft.id, source, 1);
			await assert.rejects(() => freezeRelease(input(draft.id), store, site), (error: unknown) => error instanceof ApiFailure && error.code === "REVISION_CONFLICT");
			const request = input(draft.id, 2); const release = await freezeRelease(request, store, site);
			await savePost(store, site, draft.id, source.replace("Original HTML", "Later private draft"), 2);
			assert.equal((await freezeRelease(request, store, site)).id, release.id);
			const snapshot = await record(store, "release_snapshots", release.snapshotId!);
			assert.equal((snapshot.data as FrozenSnapshot).sources[0].source, source); assert.equal((snapshot.data as FrozenSnapshot).sources[0].revision, 2);
			assert.equal((snapshot.data as FrozenSnapshot).sources[0].originalSource, source);
			assert.equal((snapshot.data as FrozenSnapshot).digest, publicContentDigest((snapshot.data as FrozenSnapshot).posts, (snapshot.data as FrozenSnapshot).settings, (snapshot.data as FrozenSnapshot).redirects));
			assert.deepEqual((snapshot.data as FrozenSnapshot).settings, { schemaVersion: 1, settings: { title: "Original" }, navigation: { links: [{ name: "Home", url: "/" }] }, icons: {}, friends: [] });
		});
		await t.test("a repository draft is released by publishing it instead of being refused", async () => {
			const site = newSite(); const draft = await seed(store, site, source.replace("draft: false", "draft: true"));
			const release = await freezeRelease(input(draft.id), store, site);
			const frozen = (await record(store, "release_snapshots", release.snapshotId!)).data as FrozenSnapshot;
			// The private-draft feature is gone, so publishing clears the flag for the site build.
			assert.match(frozen.sources[0].source, /draft: false/);
			assert.doesNotMatch(frozen.sources[0].source, /draft: true/);
			assert.match(frozen.sources[0].source, /<div>Original HTML<\/div>/);
		});
		await t.test("a later editor save stays private when the frozen revision reaches production", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			await savePost(store, site, post.id, source.replace("Original HTML", "Later private draft"), 1);
			let notifications = 0; let committed: FrozenSnapshot | undefined;
			const git = github({ async commit(commit) { assert.equal(commit.baseSha, baseSha); assert.equal(commit.files.find((file) => file.path === post.filePath)?.source, source); return targetSha; } });
			const result = await processReleaseTask(release.id, { store, site, github: git, deployment: { async verify(sha, snapshot) { committed = snapshot; return verified.verify(sha, snapshot); } }, skipCapabilityCheck: true, afterVerified: async () => { notifications++; } });
			assert.deepEqual(result, { done: true, state: "verified" }); assert.equal(notifications, 1);
			const current = await getPost(store, site, post.id); assert.equal(current.source, source.replace("Original HTML", "Later private draft")); assert.equal(current.revision, 2); assert.equal(current.publishedSource, source); assert.equal(current.publishedRevision, 1);
			const baseline = await record(store, "entities", "repository:baseline");
			assert.equal((baseline.data as Row).headSha, targetSha); assert.equal((baseline.data as Row).publicContentDigest, committed!.digest);
			const task = await record(store, "release_tasks", release.id);
			assert.equal((task.details as Row).finalizationState, "done");
			assert.equal("notificationState" in (task.details as Row), false);
			assert.equal("friendNotifications" in committed!, false);
		});
		await t.test("verified production updates approved friend state without snapshot recipients or mail creation", async () => {
			const site = newSite(); const post = await seed(store, site); const friendId = randomUUID();
			await store.update((state) => {
				collection(state, "friends")[friendId] = { id: friendId, name: "Friend", url: "https://friend.example/", description: "Public description", avatar: "", email: "private-contact@example.com", group_name: "", sort_order: 0, status: "approved", revision: 3 };
			});
			const release = await freezeRelease(input(post.id), store, site);
			const snapshot = (await record(store, "release_snapshots", release.snapshotId!)).data as FrozenSnapshot;
			assert.equal("friendNotifications" in snapshot, false);
			assert.equal(JSON.stringify(snapshot).includes("private-contact@example.com"), false);
			assert.equal((await processReleaseTask(release.id, { store, site, github: github(), deployment: verified, skipCapabilityCheck: true })).state, "verified");
			const state = await store.read(); const friend = collection(state, "friends")[friendId];
			assert.equal(friend.status, "published"); assert.ok(friend.published_at); assert.equal(friend.email, "private-contact@example.com");
			assert.equal(state.collections.mail_outbox, undefined);
			assert.equal((collection(state, "release_tasks")[release.id].details as Row).finalizationState, "done");
		});
		await t.test("commit timeout persists unknown and retries only reconciliation until the commit is found", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			let commits = 0; let reconciliations = 0; let found: string | null = null;
			const git = github({ async commit() { commits++; throw new GitHubError(0, "transport timed out after submit", true); }, async findCommit() { reconciliations++; return found; } });
			const deps = { store, site, github: git, deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification };
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown");
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown"); assert.equal(commits, 1); assert.equal(reconciliations, 1);
			found = targetSha; assert.equal((await processReleaseTask(release.id, deps)).state, "verified"); assert.equal(commits, 1); assert.equal(reconciliations, 2);
		});
		await t.test("overlapping workers cannot execute a second commit", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			const entered = deferred<void>(); const proceed = deferred<void>(); let commits = 0;
			const git = github({ async readRepositoryFiles() { entered.resolve(); await proceed.promise; return { headSha: baseSha, files: [] }; }, async commit() { commits++; return targetSha; } });
			const deps = { store, site, github: git, deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification };
			const first = processReleaseTask(release.id, deps); await entered.promise;
			assert.deepEqual(await processReleaseTask(release.id, deps), { done: false, state: "queued" }); proceed.resolve();
			assert.equal((await first).state, "verified"); assert.equal(commits, 1);
		});
		await t.test("superseded verification cannot mark production or finalize friend state", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			const entered = deferred<void>(); const proceed = deferred<void>(); let notifications = 0;
			const first = processReleaseTask(release.id, { store, site, github: github(), deployment: { async verify(sha, snapshot) { entered.resolve(); await proceed.promise; return verified.verify(sha, snapshot); } }, skipCapabilityCheck: true, afterVerified: async () => { notifications++; } });
			await entered.promise;
			await store.update((state) => { const lock = collection(state, "release_locks")[site]!; lock.fencing_token = Number(lock.fencing_token)+1; lock.lease_until = new Date().toISOString(); }); proceed.resolve();
			const result = await first; assert.equal(result.done, false); assert.equal(result.state, "deploying"); assert.equal(notifications, 0); assert.equal((await getPost(store, site, post.id)).publishedSource, null);
		});
		await t.test("only exact CAS failures terminate as conflict and deployment identity must match", async () => {
			const conflictSite = newSite(); const conflictPost = await seed(store, conflictSite); const conflict = await freezeRelease(input(conflictPost.id), store, conflictSite);
			assert.equal((await processReleaseTask(conflict.id, { store, site: conflictSite, github: github({ async commit() { throw new GitHubError(409, "expected head differs", false, true); } }), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification })).state, "conflict");
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			assert.equal((await processReleaseTask(release.id, { store, site, github: github(), deployment: { async verify() { return { status: "verified", sha: "wrong", deploymentId: "wrong-project" }; } }, skipCapabilityCheck: true, afterVerified: noNotification })).state, "deploying");
			assert.equal((await getPost(store, site, post.id)).publishedSource, null);
		});
		await t.test("private media in posts and settings use the frozen record and leave draft bytes intact", async () => {
			const site = newSite(); const mediaId = randomUUID(); const withMedia = source + `![image](media:${mediaId})\n`; const post = await seed(store, site, withMedia);
			const media = { id: mediaId, pathname: `drafts/${mediaId}.png`, digest: sha256("original bytes"), size: 14, contentType: "image/png", publishedUrl: "https://image.example/frozen.png" };
			await store.update((state) => { collection(state, "entities")[`media:${mediaId}`] = { id: mediaId, kind: "media", data: media, revision: 1 }; });
			await patchEntity(store, "settings:default", { avatar: `media:${mediaId}` });
			const release = await freezeRelease(input(post.id), store, site);
			await patchEntity(store, `media:${mediaId}`, { pathname: "changed-private-path.png", digest: "different" }, 2);
			const publicUrl = "https://image.example/frozen.png";
			assert.equal((await processReleaseTask(release.id, { store, site, github: github(), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification, prepareMedia: async (ids, _id, snapshot) => { assert.deepEqual(ids, [mediaId]); assert.equal(snapshot.media![mediaId].publishedUrl, media.publishedUrl); assert.equal(snapshot.media![mediaId].revision, 1); return { [mediaId]: publicUrl }; } })).state, "verified");
			const current = await getPost(store, site, post.id); assert.equal(current.source, withMedia); assert.ok(current.publishedSource!.includes(publicUrl));
			const recordRow = await record(store, "release_snapshots", release.snapshotId!);
			assert.equal((recordRow.data as FrozenSnapshot).settings.settings && ((recordRow.data as FrozenSnapshot).settings.settings as Record<string, unknown>).avatar, publicUrl); assert.equal((recordRow.data as FrozenSnapshot).originalSettings!.settings && ((recordRow.data as FrozenSnapshot).originalSettings!.settings as Record<string, unknown>).avatar, `media:${mediaId}`);
		});
		await t.test("restored unknown tasks block publication and cannot silently replay", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			await patchTask(store, release.id, { state: "blocked", details: { restored: true, restoreRequiresReconciliation: true } });
			const result = await processReleaseTask(release.id, { store, site, github: github({ async commit() { throw new Error("must never commit"); } }), deployment: verified, skipCapabilityCheck: true }); assert.deepEqual(result, { done: false, state: "blocked" });
			await assert.rejects(() => freezeRelease(input(post.id), store, site), (error: unknown) => error instanceof ApiFailure && error.code === "RESTORED_PUBLISH_RECONCILIATION_REQUIRED");
		});
		await t.test("manual restore reconciliation only reads providers and never commits old drafts or replays finalization", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			await patchTask(store, release.id, { state: "blocked", details: { restored: true, restoreRequiresReconciliation: true, restorePreviousState: "unknown" } });
			let found: string | null = null; let reads = 0;
			const deps = { store, site, github: github({ async commit() { throw new Error("restored drafts must never be committed"); }, async findCommit() { reads++; return found; } }), deployment: verified, skipCapabilityCheck: true, reconcileRestored: true, afterVerified: async () => { throw new Error("historical finalization must never be replayed"); } };
			assert.equal((await processReleaseTask(release.id, deps)).state, "unknown");
			assert.equal((await processReleaseTask(release.id, { ...deps, reconcileRestored: false })).state, "blocked");
			found = targetSha; assert.equal((await processReleaseTask(release.id, deps)).state, "verified"); assert.equal(reads, 2);
			const next = await freezeRelease(input(post.id), store, site); assert.ok(next.id !== release.id);
			await patchTask(store, next.id, { state: "blocked", details: { restored: true, restoreRequiresReconciliation: true, restorePreviousState: "frozen" } });
			assert.equal((await processReleaseTask(next.id, deps)).state, "failed"); assert.equal(reads, 2); assert.equal((await getPost(store, site, post.id)).source, source);
		});
		await t.test("a crashed post-verification finalization retries without another Git commit", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			let commits = 0; let notifications = 0;
			const deps = { store, site, github: github({ async commit() { commits++; return targetSha; } }), deployment: verified, skipCapabilityCheck: true, afterVerified: async () => { if (++notifications === 1) throw new Error("file storage interruption"); } };
			await assert.rejects(() => processReleaseTask(release.id, deps), /durable release finalization/);
			assert.equal((await getPost(store, site, post.id)).publishedSource, source);
			assert.deepEqual(await processReleaseTask(release.id, deps), { done: true, state: "verified" }); assert.equal(commits, 1); assert.equal(notifications, 2);
		});
		await t.test("a failed build can recheck the existing SHA without issuing another Git commit", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site); let commits = 0;
			const git = github({ async commit() { commits++; return targetSha; } });
			const failed = { store, site, github: git, deployment: { async verify() { return { status: "failed" as const, deploymentId: "failed-build" }; } }, skipCapabilityCheck: true, afterVerified: noNotification };
			assert.equal((await processReleaseTask(release.id, failed)).state, "failed"); assert.equal(commits, 1);
			const recheck = { ...failed, deployment: verified };
			assert.equal((await processReleaseTask(release.id, recheck)).state, "failed");
			assert.equal((await processReleaseTask(release.id, { ...recheck, retryFailedDeployment: true })).state, "verified"); assert.equal(commits, 1);
			assert.equal((await getPost(store, site, post.id)).publishedSource, source);
		});
		await t.test("rechecking a failed SHA cannot rewind a baseline advanced by another release", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site); let commits = 0;
			const deps = { store, site, github: github({ async commit() { commits++; return targetSha; } }), deployment: { async verify() { return { status: "failed" as const, deploymentId: "failed-build" }; } }, skipCapabilityCheck: true, afterVerified: noNotification };
			assert.equal((await processReleaseTask(release.id, deps)).state, "failed");
			const newer = "c".repeat(40); await patchEntity(store, "repository:baseline", { headSha: newer });
			assert.equal((await processReleaseTask(release.id, { ...deps, deployment: verified, retryFailedDeployment: true })).state, "conflict"); assert.equal(commits, 1);
			const baseline = await record(store, "entities", "repository:baseline");
			assert.equal((baseline.data as Record<string, unknown>).headSha, newer); assert.equal((await getPost(store, site, post.id)).publishedSource, null);
		});
		await t.test("durable verified finalization pending is repaired independently of a stopped Workflow", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site); let commits = 0;
			await assert.rejects(() => processReleaseTask(release.id, { store, site, github: github({ async commit() { commits++; return targetSha; } }), deployment: verified, skipCapabilityCheck: true, afterVerified: async () => { throw new Error("worker stopped after verification"); } }), /durable release finalization/);
			const pending = await record(store, "release_tasks", release.id);
			assert.equal(pending.state, "verified"); assert.equal((pending.details as Record<string, unknown>).finalizationState, "pending");
			await reconcileVerifiedReleaseFinalization(store, site);
			const completed = await record(store, "release_tasks", release.id);
			assert.equal((completed.details as Record<string, unknown>).finalizationState, "done");
			await reconcileVerifiedReleaseFinalization(store, site); assert.equal(commits, 1);
		});
		await t.test("legacy completion markers prevent replay while legacy pending tasks finish without mail", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			await processReleaseTask(release.id, { store, site, github: github(), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification });
			await patchTask(store, release.id, { details: { notificationState: "done" } });
			await processReleaseTask(release.id, { store, site, skipCapabilityCheck: true, afterVerified: async () => { throw new Error("completed legacy work must not replay"); } });
			await reconcileVerifiedReleaseFinalization(store, site);
			assert.deepEqual((await record(store, "release_tasks", release.id)).details, { notificationState: "done" });
			await patchTask(store, release.id, { details: { notificationState: "pending" } });
			await reconcileVerifiedReleaseFinalization(store, site);
			const details = (await record(store, "release_tasks", release.id)).details as Row;
			assert.equal(details.finalizationState, "done"); assert.equal(details.notificationState, "pending");
			assert.equal((await store.read()).collections.mail_outbox, undefined);
		});
		await t.test("an active restore lease blocks snapshot freezing and external release work", async () => {
			const site = newSite(); const post = await seed(store, site); const release = await freezeRelease(input(post.id), store, site);
			await store.update((state) => { collection(state, "maintenance_locks").main = { kind: "restore", lease_until: new Date(Date.now() + 60_000).toISOString() }; });
			await assert.rejects(() => freezeRelease(input(post.id), store, site), (error: unknown) => error instanceof ApiFailure && error.code === "RESTORE_IN_PROGRESS");
			const result = await processReleaseTask(release.id, { store, site, skipCapabilityCheck: true, github: github({ async readRepositoryFiles() { throw new Error("must not read or commit while restoring"); } }), afterVerified: noNotification });
			assert.deepEqual(result, { done: false, state: "queued" });
		});
});

test("a verified publish drops the local version copies it already committed", async () => {
	const site = `tests/releases-${randomUUID()}:development`;
	const store = createMemoryStore(site);
	const published = await seed(store, site);
	const edit = await savePost(store, site, published.id, source.replace("Original HTML", "Edited before publish"), 1);
	const untouched = await createPost(store, site, source.replace('title: "Frozen"', 'title: "Untouched"'), "未发布文章");
	await savePost(store, site, untouched.id, source.replace('title: "Frozen"', 'title: "Untouched"').replace("Original HTML", "Still a draft"), 1);
	const versions = async () => Object.values(collection(await store.read(), "entities")).filter((row) => row.kind === "post_version");
	assert.equal((await versions()).length, 2);

	const release = await freezeRelease(input(published.id, edit.revision), store, site);
	assert.equal((await processReleaseTask(release.id, { store, site, github: github(), deployment: verified, skipCapabilityCheck: true, afterVerified: noNotification })).state, "verified");

	const remaining = await versions();
	// The published post's history is now redundant with Git; the unpublished draft keeps its own.
	assert.equal(remaining.length, 1);
	assert.equal((remaining[0].data as Row).postId, untouched.id);
	assert.equal((await getPost(store, site, published.id)).source, edit.source);
});
