import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	collection,
	createMemoryStore,
	type FileStore,
	type Row,
} from "../server/file-store.js";
import { ApiFailure } from "../server/security.js";
import {
	claimMaintenanceTask,
	cleanupExpiredData,
	createBackup,
	processMaintenanceTask,
	restoreBackup,
	type BackupBlobProvider,
} from "../server/maintenance.js";
const site = "Nocticur/Firefly:production";
class MemoryBlob implements BackupBlobProvider {
	objects = new Map<string, Buffer>();
	puts: string[] = [];
	deletes: string[] = [];
	onPut?: () => Promise<void>;
	async put(path: string, bytes: Buffer) {
		this.puts.push(path);
		if (this.objects.has(path)) throw new Error("immutable");
		this.objects.set(path, Buffer.from(bytes));
		await this.onPut?.();
	}
	async get(path: string) {
		return this.objects.get(path) || null;
	}
	async delete(path: string) {
		this.deletes.push(path);
		this.objects.delete(path);
	}
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { resolve, promise };
}
async function task(store: FileStore, kind: string, details: Row = {}) {
	const id = randomUUID();
	await store.update((state) => {
		collection(state, "release_tasks")[id] = {
			id,
			kind,
			state: "queued",
			details,
			created_at: new Date().toISOString(),
		};
	});
	return id;
}
async function post(store: FileStore, source: string) {
	const id = randomUUID();
	await store.update((state) => {
		collection(state, "entities")[`post:${id}`] = {
			id,
			kind: "post",
			data: { source, draft: true },
			revision: 1,
		};
	});
	return id;
}
const failure = (code: string) => (error: unknown) =>
	error instanceof ApiFailure && error.code === code;

test("private flat-file backups freeze a consistent immutable snapshot and deduplicate by task", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		id = randomUUID();
	const postId = await post(store, "private draft");
	const entered = deferred(),
		release = deferred();
	blob.onPut = async () => {
		entered.resolve();
		await release.promise;
	};
	const first = createBackup(id, store, site, { blob });
	await entered.promise;
	await assert.rejects(
		() => createBackup(id, store, site, { blob }),
		failure("MAINTENANCE_BUSY"),
	);
	release.resolve();
	const record = await first;
	assert.equal(record.state, "verified");
	assert.equal(blob.puts.length, 1);
	const backup = JSON.parse(
		blob.objects.get(String(record.pathname))!.toString(),
	);
	assert.equal(backup.schemaVersion, 3);
	assert.equal(
		backup.collections.entities[`post:${postId}`].data.source,
		"private draft",
	);
	assert.equal(backup.collections.sessions, undefined);
	assert.equal(backup.collections.mail_outbox, undefined);
	assert.equal(
		(await createBackup(id, store, site, { blob })).sha256,
		record.sha256,
	);
	assert.equal(blob.puts.length, 1);
});

test("backup upload with a lost acknowledgement is recovered by immutable checksum", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob();
	await post(store, "one");
	blob.onPut = async () => {
		throw new Error("acknowledgement lost");
	};
	const record = await createBackup(randomUUID(), store, site, { blob });
	assert.equal(record.state, "verified");
	assert.equal(blob.puts.length, 1);
});

test("restore makes a safety backup, invalidates sessions and leaves retired mail history untouched", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		postId = await post(store, "old source");
	await store.update((state) => {
		collection(state, "mail_outbox").pending = {
			id: "pending",
			notification_key: "key",
			recipient: "reader@example.invalid",
			status: "pending",
			provider_id: null,
		};
	});
	const backup = await createBackup("old", store, site, { blob });
	assert.equal(backup.state, "verified");
	await store.update((state) => {
		(collection(state, "entities")[`post:${postId}`].data as Row).source =
			"new source";
		collection(state, "entities")["service_settings:default"] = {
			id: "default",
			kind: "service_settings",
			data: { publish: false, maintenance: false },
			revision: 4,
		};
		collection(state, "sessions").session = { token_hash: "secret" };
		collection(state, "mail_outbox").sent = {
			id: "sent",
			notification_key: "receipt",
			recipient: "reader@example.invalid",
			status: "sent",
			provider_id: "irreversible-provider-id",
		};
		collection(state, "maintenance_outbox").date = {
			date_key: "date",
			task_id: "existing",
		};
	});
	const restore = await task(store, "restore", { backupId: "old" });
	assert.deepEqual(
		await processMaintenanceTask(restore, {
			store,
			site,
			blob,
			skipCapabilityCheck: true,
		}),
		{ done: true, state: "verified" },
	);
	const state = await store.read();
	assert.equal(
		(collection(state, "entities")[`post:${postId}`].data as Row).source,
		"old source",
	);
	assert.equal(
		collection(state, "entities")["service_settings:default"].revision,
		4,
	);
	assert.deepEqual(Object.keys(collection(state, "sessions")), []);
	assert.equal(
		collection(state, "mail_outbox").sent.provider_id,
		"irreversible-provider-id",
	);
	assert.equal(collection(state, "mail_outbox").pending.status, "pending");
	assert.ok(
		Object.keys(collection(state, "maintenance_backups")).some((id) =>
			id.startsWith(`before-restore-${restore}-`),
		),
	);
	assert.equal(
		collection(state, "maintenance_outbox").date.task_id,
		"existing",
	);
});

test("restored publish tasks cannot replay and current non-publish tasks survive", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob();
	await post(store, "draft");
	const publishId = await task(store, "publish");
	await createBackup("old", store, site, { blob });
	await store.update((state) => {
		collection(state, "release_tasks")[publishId].state = "failed";
	});
	const restore = await task(store, "restore", { backupId: "old" });
	await restoreBackup("old", restore, {
		store,
		site,
		blob,
		skipCapabilityCheck: true,
	});
	const row = collection(await store.read(), "release_tasks")[publishId];
	assert.equal(row.state, "blocked");
	assert.equal((row.details as Row).restoreRequiresReconciliation, true);
	assert.ok(collection(await store.read(), "release_tasks")[restore]);
});

test("restore refuses active or unknown publishes before any content change", async () => {
	for (const publishState of ["running", "unknown"]) {
		const store = createMemoryStore(site),
			blob = new MemoryBlob(),
			postId = await post(store, "old");
		await createBackup("old", store, site, { blob });
		await store.update((state) => {
			(collection(state, "entities")[`post:${postId}`].data as Row).source =
				"new";
			collection(state, "release_tasks").uncertain = {
				id: "uncertain",
				kind: "publish",
				state: publishState,
			};
		});
		const restore = await task(store, "restore");
		await assert.rejects(
			() =>
				restoreBackup("old", restore, {
					store,
					site,
					blob,
					skipCapabilityCheck: true,
				}),
			failure("RESTORE_RECONCILIATION_REQUIRED"),
		);
		assert.equal(
			(collection(await store.read(), "entities")[`post:${postId}`].data as Row)
				.source,
			"new",
		);
	}
});

test("concurrent write during safety backup aborts restore rather than overwriting newer data", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		postId = await post(store, "old");
	await createBackup("old", store, site, { blob });
	await store.update((state) => {
		(collection(state, "entities")[`post:${postId}`].data as Row).source =
			"new";
	});
	const restore = await task(store, "restore");
	blob.onPut = async () => {
		await store.update((state) => {
			(collection(state, "entities")[`post:${postId}`].data as Row).source =
				"concurrent";
		});
	};
	await assert.rejects(
		() =>
			restoreBackup("old", restore, {
				store,
				site,
				blob,
				skipCapabilityCheck: true,
			}),
		failure("RESTORE_STATE_CHANGED"),
	);
	assert.equal(
		(collection(await store.read(), "entities")[`post:${postId}`].data as Row)
			.source,
		"concurrent",
	);
});

test("legacy backups ignore retired mail data and preserve all live history including unfinished records", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		postId = await post(store, "old");
	const record = await createBackup("legacy", store, site, { blob });
	const legacy = JSON.parse(blob.objects.get(String(record.pathname))!.toString());
	legacy.schemaVersion = 2;
	legacy.collections.mail_outbox = { obsolete: { oldProviderFormat: true } };
	const bytes = Buffer.from(JSON.stringify(legacy));
	blob.objects.set(String(record.pathname), bytes);
	await store.update((state) => {
		collection(state, "maintenance_backups").legacy.sha256 =
			createHash("sha256").update(bytes).digest("hex");
		(collection(state, "entities")[`post:${postId}`].data as Row).source = "new";
		collection(state, "mail_outbox").history = {
			id: "history",
			status: "sending",
			provider_id: "untouched-receipt",
		};
	});
	const before = JSON.stringify(collection(await store.read(), "mail_outbox"));
	const restore = await task(store, "restore");
	await restoreBackup("legacy", restore, {
		store, site, blob, skipCapabilityCheck: true,
	});
	const state = await store.read();
	assert.equal((collection(state, "entities")[`post:${postId}`].data as Row).source, "old");
	assert.equal(JSON.stringify(collection(state, "mail_outbox")), before);
	assert.deepEqual(blob.objects.get(String(record.pathname)), bytes);
});

test("legacy backup compatibility still rejects unknown collections and malformed retained records", async () => {
	for (const invalid of ["unknown-collection", "malformed-post"]) {
		const store = createMemoryStore(site), blob = new MemoryBlob();
		const postId = await post(store, "current");
		const record = await createBackup("legacy", store, site, { blob });
		const backup = JSON.parse(blob.objects.get(String(record.pathname))!.toString());
		backup.schemaVersion = 2;
		backup.collections.mail_outbox = {};
		if (invalid === "unknown-collection") backup.collections.unknown = {};
		else backup.collections.entities[`post:${postId}`].id = "mismatched";
		const bytes = Buffer.from(JSON.stringify(backup));
		blob.objects.set(String(record.pathname), bytes);
		await store.update((state) => {
			collection(state, "maintenance_backups").legacy.sha256 =
				createHash("sha256").update(bytes).digest("hex");
		});
		const restore = await task(store, "restore");
		await assert.rejects(() => restoreBackup("legacy", restore, {
			store, site, blob, skipCapabilityCheck: true,
		}), /Unknown backup collection|Invalid backup collection/);
		assert.equal((collection(await store.read(), "entities")[`post:${postId}`].data as Row).source, "current");
	}
});

test("invalid backup and lost maintenance ownership fail before restored content writes", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		postId = await post(store, "current");
	const record = await createBackup("corrupt", store, site, { blob });
	blob.objects.set(String(record.pathname), Buffer.from("tampered"));
	const restore = await task(store, "restore");
	await assert.rejects(
		() =>
			restoreBackup("corrupt", restore, {
				store,
				site,
				blob,
				skipCapabilityCheck: true,
			}),
		/checksum/,
	);
	assert.equal(
		(collection(await store.read(), "entities")[`post:${postId}`].data as Row)
			.source,
		"current",
	);
	const next = await task(store, "backup"),
		lease = await claimMaintenanceTask(store, site, next);
	assert.ok(lease);
	assert.equal(await claimMaintenanceTask(store, site, next), null);
	await store.update((state) => {
		Object.assign(collection(state, "maintenance_locks").main, {
			owner_id: "new-owner",
			fencing_token: lease!.fence + 1,
		});
	});
	await assert.rejects(
		() =>
			restoreBackup(
				"corrupt",
				next,
				{ store, site, blob, skipCapabilityCheck: true },
				lease!,
			),
		/superseded/,
	);
});

test("daily maintenance completes verified release business when new publishing is disabled", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob();
	await post(store, "draft");
	const daily = await task(store, "daily");
	let reconciled = 0,
		published = 0;
	const result = await processMaintenanceTask(daily, {
		store,
		site,
		blob,
		skipCapabilityCheck: true,
		reconcileFinalization: async () => {
			reconciled++;
		},
		processPublish: async () => {
			published++;
		},
	});
	assert.deepEqual(result, { done: true, state: "verified" });
	assert.equal(reconciled, 1);
	assert.equal(published, 0);
});

test("cleanup removes data older than 30 days but keeps active and baseline release records", async () => {
	const store = createMemoryStore(site),
		blob = new MemoryBlob(),
		now = Date.parse("2026-10-17T00:00:00.000Z"),
		old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
		boundary = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
		recent = new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString();
	await store.update((state) => {
		const entities = collection(state, "entities"),
			tasks = collection(state, "release_tasks"),
			snapshots = collection(state, "release_snapshots"),
			backups = collection(state, "maintenance_backups");
		entities["repository:baseline"] = { id: "baseline", kind: "repository", data: { taskId: "baseline-task", snapshotId: "baseline-snapshot" }, created_at: old };
		entities["post-version-old"] = { id: "post-version-old", kind: "post_version", data: {}, created_at: old };
		entities["post-version-boundary"] = { id: "post-version-boundary", kind: "post_version", data: {}, created_at: boundary };
		entities["post-version-recent"] = { id: "post-version-recent", kind: "post_version", data: {}, created_at: recent };
		tasks["old-task"] = { id: "old-task", kind: "publish", state: "verified", snapshot_id: "old-snapshot", details: {}, created_at: old, updated_at: old };
		tasks["baseline-task"] = { id: "baseline-task", kind: "publish", state: "verified", snapshot_id: "baseline-snapshot", details: {}, created_at: old, updated_at: old };
		tasks["active-task"] = { id: "active-task", kind: "publish", state: "unknown", snapshot_id: "active-snapshot", details: {}, created_at: old, updated_at: old };
		tasks["recent-task"] = { id: "recent-task", kind: "publish", state: "verified", snapshot_id: "recent-snapshot", details: {}, created_at: recent, updated_at: recent };
		snapshots["old-snapshot"] = { id: "old-snapshot", created_at: old, data: {} };
		snapshots["baseline-snapshot"] = { id: "baseline-snapshot", created_at: old, data: {} };
		snapshots["active-snapshot"] = { id: "active-snapshot", created_at: old, data: {} };
		snapshots["recent-snapshot"] = { id: "recent-snapshot", created_at: recent, data: {} };
		backups.old = { id: "old", state: "verified", pathname: "backups/old.json", created_at: old };
		backups.recent = { id: "recent", state: "verified", pathname: "backups/recent.json", created_at: recent };
	});
	blob.objects.set("backups/old.json", Buffer.from("old"));
	blob.objects.set("backups/recent.json", Buffer.from("recent"));

	const result = await cleanupExpiredData(store, site, blob, now);
	const state = await store.read();
	assert.equal(result.postVersions, 2);
	assert.equal(result.releaseTasks, 1);
	assert.equal(result.releaseSnapshots, 1);
	assert.equal(result.backups, 1);
	assert.equal(collection(state, "entities")["post-version-old"], undefined);
	assert.equal(collection(state, "entities")["post-version-boundary"], undefined);
	assert.ok(collection(state, "entities")["post-version-recent"]);
	assert.equal(collection(state, "release_tasks")["old-task"], undefined);
	assert.ok(collection(state, "release_tasks")["baseline-task"]);
	assert.ok(collection(state, "release_tasks")["active-task"]);
	assert.ok(collection(state, "release_tasks")["recent-task"]);
	assert.equal(collection(state, "release_snapshots")["old-snapshot"], undefined);
	assert.ok(collection(state, "release_snapshots")["baseline-snapshot"]);
	assert.ok(collection(state, "release_snapshots")["active-snapshot"]);
	assert.equal(collection(state, "maintenance_backups").old, undefined);
	assert.ok(collection(state, "maintenance_backups").recent);
	assert.deepEqual(blob.deletes, ["backups/old.json"]);
});
