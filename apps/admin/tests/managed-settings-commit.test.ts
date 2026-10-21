import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore, collection, type FileStore, type StoreState } from "../server/file-store.js";
import { commitManagedEntity } from "../server/settings.js";
import { MANAGED_SETTINGS_PATH } from "../server/managed-settings.js";

const SITE = "Nocticur/blog:test";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

function seed(store: FileStore, headSha = HEAD): Promise<unknown> {
	const now = new Date().toISOString();
	return store.update((state: StoreState) => {
		const entities = collection(state, "entities");
		entities["repository:baseline"] = { id: "repository:baseline", kind: "repository", revision: 1, created_at: now, updated_at: now, data: { headSha, repositoryFiles: [{ path: MANAGED_SETTINGS_PATH, source: "{}" }] } };
		entities["settings:default"] = { id: "settings:default", kind: "settings", revision: 1, created_at: now, updated_at: now, data: { title: "旧标题" } };
		entities["navigation:default"] = { id: "navigation:default", kind: "navigation", revision: 1, created_at: now, updated_at: now, data: { links: [{ name: "主页", url: "/" }] } };
		entities["icons:default"] = { id: "icons:default", kind: "icons", revision: 1, created_at: now, updated_at: now, data: {} };
	});
}

function headOf(state: StoreState): unknown {
	return (collection(state, "entities")["repository:baseline"]?.data as Record<string, unknown> | undefined)?.headSha;
}

test("saving settings commits the managed document and advances the baseline", async () => {
	const store = createMemoryStore(SITE);
	await seed(store);
	let committed: Array<{ path: string; source: string }> = [];
	const result = await commitManagedEntity(store, SITE, "settings", { title: "新标题" }, 1, {
		readRepository: async () => ({ headSha: HEAD, files: [{ path: MANAGED_SETTINGS_PATH, source: JSON.stringify({ unmanaged: "keep" }) }] }),
		commit: async (input) => { committed = input.files as Array<{ path: string; source: string }>; return NEXT; },
	});
	assert.equal(result.committedSha, NEXT);

	// Exactly one managed file is written, and unknown fields in the existing file survive.
	assert.equal(committed.length, 1);
	assert.equal(committed[0].path, MANAGED_SETTINGS_PATH);
	const parsed = JSON.parse(committed[0].source);
	assert.equal(parsed.unmanaged, "keep");
	assert.equal(parsed.settings.title, "新标题");
	assert.deepEqual(parsed.icons, {});

	assert.equal(headOf(await store.read()), NEXT);
});

test("a baseline that moved under us is never overwritten by a later commit", async () => {
	const store = createMemoryStore(SITE);
	await seed(store, "c".repeat(40));
	await commitManagedEntity(store, SITE, "settings", { title: "新标题" }, 1, {
		readRepository: async () => ({ headSha: HEAD, files: [] }),
		commit: async () => NEXT,
	});
	// The read head did not match the stored baseline, so the stale baseline stays put.
	assert.equal(headOf(await store.read()), "c".repeat(40));
});
