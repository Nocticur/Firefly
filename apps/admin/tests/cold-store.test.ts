import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMemoryStore, createFileStore, collection, type DocumentBackend, type FileStore, type StoreState } from "../server/file-store.js";
import { createPost, listPostHistory, savePost } from "../server/content.js";

/** A backend with two documents, mirroring the Cloudflare KV hot/cold layout. */
function twoDocumentBackend(options: { failHotWritesAfter?: number } = {}): { backend: DocumentBackend; values: { hot: string | null; cold: string | null } } {
	const values: { hot: string | null; cold: string | null } = { hot: null, cold: null };
	let hotWrites = 0;
	const etag = (value: string | null) => value === null ? null : createHash("sha256").update(value).digest("hex");
	return {
		values,
		backend: {
			async read() { return values.hot === null ? null : { json: values.hot, etag: etag(values.hot)! }; },
			async write(json, expected) {
				hotWrites++;
				if (options.failHotWritesAfter !== undefined && hotWrites > options.failHotWritesAfter) throw new Error("simulated hot write failure");
				if (etag(values.hot) !== expected) return false;
				values.hot = json; return true;
			},
			async readCold() { return values.cold === null ? null : { json: values.cold, etag: etag(values.cold)! }; },
			async writeCold(json, expected) { if (etag(values.cold) !== expected) return false; values.cold = json; return true; },
		},
	};
}

const source = '---\ntitle: "冷热拆分"\npublished: 2026-10-01\ndraft: false\n---\n\n正文\n';

/** A healthy backend over documents left behind by a failed attempt. */
function twoDocumentBackendWithValues(values: { hot: string | null; cold: string | null }): DocumentBackend {
	const etag = (value: string | null) => value === null ? null : createHash("sha256").update(value).digest("hex");
	return {
		async read() { return values.hot === null ? null : { json: values.hot, etag: etag(values.hot)! }; },
		async write(json, expected) { if (etag(values.hot) !== expected) return false; values.hot = json; return true; },
		async readCold() { return values.cold === null ? null : { json: values.cold, etag: etag(values.cold)! }; },
		async writeCold(json, expected) { if (etag(values.cold) !== expected) return false; values.cold = json; return true; },
	};
}

test("history is written to the cold document and never inflates the hot one", async () => {
	const { backend, values } = twoDocumentBackend();
	const site = "tests/cold:production";
	const store = createFileStore(backend, site);
	const post = await createPost(store, site, source);
	await savePost(store, site, post.id, source.replace("正文", "改过一次"), 1);

	const hot = await store.read();
	assert.equal(Object.values(collection(hot, "entities")).filter((row) => row.kind === "post_version").length, 0);
	const cold = await store.readCold();
	assert.equal(Object.values(collection(cold, "entities")).filter((row) => row.kind === "post_version").length, 1);
	assert.equal((await listPostHistory(store, site, post.id)).length, 1);
	// The version body only exists in the cold document on disk.
	assert.doesNotMatch(values.hot!, /"kind":"post_version"/);
	assert.match(values.cold!, /"kind":"post_version"/);
});

test("a freeze-style change writes the task hot and the snapshot cold", async () => {
	const { backend } = twoDocumentBackend();
	const site = "tests/cold:production";
	const store = createFileStore(backend, site);
	await store.updateBoth((hot: StoreState, cold: StoreState) => {
		collection(hot, "release_tasks").task = { id: "task", kind: "publish", state: "preparing" };
		collection(cold, "release_snapshots").snap = { id: "snap", digest: "d", data: { sources: [{ source: "长正文".repeat(50) }] } };
	});
	const hot = await store.read();
	const cold = await store.readCold();
	assert.ok(collection(hot, "release_tasks").task);
	assert.equal(collection(hot, "release_snapshots").snap, undefined);
	assert.ok(collection(cold, "release_snapshots").snap);
});

test("history kept inline by an older deployment migrates on the first cold read", async () => {
	const { backend, values } = twoDocumentBackend();
	const site = "tests/cold:production";
	const legacy = createFileStore(backend, site);
	const post = await createPost(legacy, site, source);
	// Simulate the old layout: a version row sitting inside the hot document.
	await legacy.update((state) => {
		collection(state, "entities")["post_version:legacy"] = { id: "legacy", kind: "post_version", data: { id: "legacy", postId: post.id, source: "旧版本", revision: 1, createdAt: new Date().toISOString(), reason: "save" }, revision: 1 };
	});
	assert.match(values.hot!, /旧版本/);

	const store = createFileStore(backend, site);
	const cold = await store.readCold();
	assert.ok(collection(cold, "entities")["post_version:legacy"]);
	const hot = await store.read();
	assert.equal(collection(hot, "entities")["post_version:legacy"], undefined);
	assert.doesNotMatch(values.hot!, /旧版本/);
	assert.match(values.cold!, /旧版本/);});

test("an in-process backend keeps history inline and still serves history", async () => {
	const store: FileStore = createMemoryStore("tests/cold:development");
	const post = await createPost(store, "tests/cold:development", source);
	await savePost(store, "tests/cold:development", post.id, source.replace("正文", "内存改动"), 1);
	assert.equal((await listPostHistory(store, "tests/cold:development", post.id)).length, 1);
});

test("an interrupted cross-document write is finished by the next request", async () => {
	const site = "tests/journal:production";
	const { backend, values } = twoDocumentBackend({ failHotWritesAfter: 1 });
	const broken = createFileStore(backend, site);
	// The cold document accepts the write, then every hot write fails: the classic half-done state.
	await assert.rejects(
		broken.updateBoth((hot: StoreState, cold: StoreState) => {
			collection(hot, "release_tasks").task = { id: "task", kind: "publish", state: "prepared" };
			collection(cold, "release_snapshots").snap = { id: "snap", digest: "d" };
		}),
		(error: unknown) => error instanceof Error && (error as { code?: string }).code === "STORAGE_OPERATION_PENDING",
	);
	assert.match(values.cold!, /"snap"/);
	assert.match(values.hot!, /storage_operations/);

	// A later request against a healthy backend replays the journalled patch.
	const healthy = createFileStore(twoDocumentBackendWithValues(values), site);
	const recovered = await healthy.read();
	assert.ok(collection(recovered, "release_tasks").task);
	const journal = collection(recovered, "storage_operations");
	assert.equal(Object.values(journal).filter((row) => row.state === "completed").length, 1);
});

test("recovery is idempotent and never duplicates the cold payload", async () => {
	const site = "tests/journal:production";
	const { backend, values } = twoDocumentBackend({ failHotWritesAfter: 1 });
	const broken = createFileStore(backend, site);
	await assert.rejects(broken.updateBoth((hot: StoreState, cold: StoreState) => {
		collection(hot, "release_tasks").task = { id: "task", kind: "publish", state: "prepared" };
		collection(cold, "release_snapshots").snap = { id: "snap", digest: "d" };
	}));
	const healthy = createFileStore(twoDocumentBackendWithValues(values), site);
	await healthy.read();
	await healthy.recoverPendingOperations();
	await healthy.recoverPendingOperations();
	const cold = await healthy.readCold();
	assert.equal(Object.keys(collection(cold, "release_snapshots")).length, 1);
	const hot = await healthy.read();
	assert.equal(Object.keys(collection(hot, "release_tasks")).length, 1);
});

test("a failed history write stays visible instead of vanishing", async () => {
	const store = createMemoryStore("tests/journal:development");
	await store.noteOperation("post-history", { postId: "p1", versionId: "v1", revision: 3, reason: "save" }, "ApiFailure");
	const state = await store.read();
	const operations = Object.values(collection(state, "storage_operations"));
	assert.equal(operations.length, 1);
	assert.equal(operations[0].kind, "post-history");
	assert.equal(operations[0].state, "failed");
	const payload = operations[0].payload as Record<string, unknown>;
	assert.equal(payload.postId, "p1");
	assert.equal(payload.versionId, "v1");
	assert.equal(payload.error, "ApiFailure");
});
