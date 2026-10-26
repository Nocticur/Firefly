import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
	collection,
	createFileStore,
	createMemoryStore,
	type DocumentBackend,
	type FileStore,
	type Row,
} from "../server/file-store.js";
import { listPostHistory } from "../server/content.js";
import { ApiFailure } from "../server/security.js";
import {
	claimMaintenanceTask,
	cleanupExpiredData,
	createBackup,
	partitionBackup,
	processMaintenanceTask,
	restoreBackup,
	type Backup,
	type BackupProvider,
} from "../server/maintenance.js";
const site = "Nocticur/Firefly:production";
/** Mirrors the Cloudflare KV layout: articles and settings hot, history and snapshots cold. */
function twoDocumentBackend(): {
	backend: DocumentBackend;
	values: { hot: string | null; cold: string | null };
} {
	const values: { hot: string | null; cold: string | null } = {
		hot: null,
		cold: null,
	};
	const etag = (value: string | null) =>
		value === null ? null : createHash("sha256").update(value).digest("hex");
	return {
		values,
		backend: {
			async read() {
				return values.hot === null
					? null
					: { json: values.hot, etag: etag(values.hot)! };
			},
			async write(json, expected) {
				if (etag(values.hot) !== expected) return false;
				values.hot = json;
				return true;
			},
			async readCold() {
				return values.cold === null
					? null
					: { json: values.cold, etag: etag(values.cold)! };
			},
			async writeCold(json, expected) {
				if (etag(values.cold) !== expected) return false;
				values.cold = json;
				return true;
			},
		},
	};
}
class MemoryBackupStore implements BackupProvider {
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
	const now = new Date().toISOString();
	await store.update((state) => {
		collection(state, "entities")[`post:${id}`] = {
			id,
			kind: "post",
			data: { source, draft: true },
			revision: 1,
			created_at: now,
			updated_at: now,
		};
	});
	return id;
}
/**
 * Writes one history row and one release snapshot the way content.ts and releases.ts do:
 * history is a `post_version` row inside `entities`, snapshots are their own collection.
 */
async function coldContent(store: FileStore, postId: string, source: string) {
	const createdAt = new Date().toISOString();
	const versionId = randomUUID();
	await store.updateCold((state) => {
		collection(state, "entities")[`post_version:${versionId}`] = {
			id: versionId,
			kind: "post_version",
			data: { id: versionId, postId, source, revision: 1, createdAt, reason: "save" },
			revision: 1,
			created_at: createdAt,
			updated_at: createdAt,
		};
		collection(state, "release_snapshots").snapshot = {
			id: "snapshot",
			digest: "digest",
			data: { sources: [{ id: postId, source }] },
			created_at: createdAt,
		};
	});
	return versionId;
}
function backupPayload(provider: MemoryBackupStore, record: Row): Backup {
	return JSON.parse(provider.objects.get(String(record.pathname))!.toString());
}
async function replaceBackupPayload(
	store: FileStore,
	provider: MemoryBackupStore,
	record: Row,
	backup: Backup,
): Promise<Buffer> {
	const bytes = Buffer.from(JSON.stringify(backup));
	provider.objects.set(String(record.pathname), bytes);
	await store.update((state) => {
		collection(state, "maintenance_backups")[String(record.id)].sha256 = createHash(
			"sha256",
		)
			.update(bytes)
			.digest("hex");
	});
	return bytes;
}
const failure = (code: string) => (error: unknown) =>
	error instanceof ApiFailure && error.code === code;

test("private flat-file backups freeze a consistent immutable snapshot and deduplicate by task", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
		id = randomUUID();
	const postId = await post(store, "private draft");
	const entered = deferred(),
		release = deferred();
	backupProvider.onPut = async () => {
		entered.resolve();
		await release.promise;
	};
	const first = createBackup(id, store, site, { backupProvider });
	await entered.promise;
	await assert.rejects(
		() => createBackup(id, store, site, { backupProvider }),
		failure("MAINTENANCE_BUSY"),
	);
	release.resolve();
	const record = await first;
	assert.equal(record.state, "verified");
	assert.equal(backupProvider.puts.length, 1);
	const backup = JSON.parse(
		backupProvider.objects.get(String(record.pathname))!.toString(),
	);
	assert.equal(backup.schemaVersion, 3);
	assert.equal(
		backup.collections.entities[`post:${postId}`].data.source,
		"private draft",
	);
	assert.equal(backup.collections.sessions, undefined);
	assert.equal(backup.collections.mail_outbox, undefined);
	assert.equal(
		(await createBackup(id, store, site, { backupProvider })).sha256,
		record.sha256,
	);
	assert.equal(backupProvider.puts.length, 1);
});

test("backup upload with a lost acknowledgement is recovered by immutable checksum", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore();
	await post(store, "one");
	backupProvider.onPut = async () => {
		throw new Error("acknowledgement lost");
	};
	const record = await createBackup(randomUUID(), store, site, { backupProvider });
	assert.equal(record.state, "verified");
	assert.equal(backupProvider.puts.length, 1);
});

test("restore makes a safety backup, invalidates sessions and leaves retired mail history untouched", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
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
	const backup = await createBackup("old", store, site, { backupProvider });
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
			backupProvider,
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
		backupProvider = new MemoryBackupStore();
	await post(store, "draft");
	const publishId = await task(store, "publish");
	await createBackup("old", store, site, { backupProvider });
	await store.update((state) => {
		collection(state, "release_tasks")[publishId].state = "failed";
	});
	const restore = await task(store, "restore", { backupId: "old" });
	await restoreBackup("old", restore, {
		store,
		site,
		backupProvider,
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
			backupProvider = new MemoryBackupStore(),
			postId = await post(store, "old");
		await createBackup("old", store, site, { backupProvider });
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
					backupProvider,
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
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "old");
	await createBackup("old", store, site, { backupProvider });
	await store.update((state) => {
		(collection(state, "entities")[`post:${postId}`].data as Row).source =
			"new";
	});
	const restore = await task(store, "restore");
	backupProvider.onPut = async () => {
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
				backupProvider,
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
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "old");
	const record = await createBackup("legacy", store, site, { backupProvider });
	const legacy = JSON.parse(backupProvider.objects.get(String(record.pathname))!.toString());
	legacy.schemaVersion = 2;
	legacy.collections.mail_outbox = { obsolete: { oldProviderFormat: true } };
	const bytes = Buffer.from(JSON.stringify(legacy));
	backupProvider.objects.set(String(record.pathname), bytes);
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
		store, site, backupProvider, skipCapabilityCheck: true,
	});
	const state = await store.read();
	assert.equal((collection(state, "entities")[`post:${postId}`].data as Row).source, "old");
	assert.equal(JSON.stringify(collection(state, "mail_outbox")), before);
	assert.deepEqual(backupProvider.objects.get(String(record.pathname)), bytes);
});

test("legacy backup compatibility still rejects unknown collections and malformed retained records", async () => {
	for (const invalid of ["unknown-collection", "malformed-post"]) {
		const store = createMemoryStore(site), backupProvider = new MemoryBackupStore();
		const postId = await post(store, "current");
		const record = await createBackup("legacy", store, site, { backupProvider });
		const backup = JSON.parse(backupProvider.objects.get(String(record.pathname))!.toString());
		backup.schemaVersion = 2;
		backup.collections.mail_outbox = {};
		if (invalid === "unknown-collection") backup.collections.unknown = {};
		else backup.collections.entities[`post:${postId}`].id = "mismatched";
		const bytes = Buffer.from(JSON.stringify(backup));
		backupProvider.objects.set(String(record.pathname), bytes);
		await store.update((state) => {
			collection(state, "maintenance_backups").legacy.sha256 =
				createHash("sha256").update(bytes).digest("hex");
		});
		const restore = await task(store, "restore");
		await assert.rejects(() => restoreBackup("legacy", restore, {
			store, site, backupProvider, skipCapabilityCheck: true,
		}), /Unknown backup collection|Invalid backup collection/);
		assert.equal((collection(await store.read(), "entities")[`post:${postId}`].data as Row).source, "current");
	}
});

test("invalid backup and lost maintenance ownership fail before restored content writes", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "current");
	const record = await createBackup("corrupt", store, site, { backupProvider });
	backupProvider.objects.set(String(record.pathname), Buffer.from("tampered"));
	const restore = await task(store, "restore");
	await assert.rejects(
		() =>
			restoreBackup("corrupt", restore, {
				store,
				site,
				backupProvider,
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
				{ store, site, backupProvider, skipCapabilityCheck: true },
				lease!,
			),
		/superseded/,
	);
});

test("daily maintenance completes verified release business when new publishing is disabled", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore();
	await post(store, "draft");
	const daily = await task(store, "daily");
	let reconciled = 0,
		published = 0;
	const result = await processMaintenanceTask(daily, {
		store,
		site,
		backupProvider,
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
		backupProvider = new MemoryBackupStore(),
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
		const operations = collection(state, "storage_operations");
		operations["op-old"] = { id: "op-old", kind: "cross-document", state: "completed", payload: [], created_at: old, updated_at: old };
		operations["op-recent"] = { id: "op-recent", kind: "cross-document", state: "completed", payload: [], created_at: recent, updated_at: recent };
	});
	backupProvider.objects.set("backups/old.json", Buffer.from("old"));
	backupProvider.objects.set("backups/recent.json", Buffer.from("recent"));

	const result = await cleanupExpiredData(store, site, backupProvider, now);
	const state = await store.read();
	assert.equal(result.postVersions, 2);
	assert.equal(result.releaseTasks, 1);
	assert.equal(result.releaseSnapshots, 1);
	assert.equal(result.backups, 1);
	// Finished cross-document journal entries expire with the rest of the aged history.
	assert.equal(result.storageOperations, 1);
	assert.equal(collection(state, "storage_operations")["op-old"], undefined);
	assert.ok(collection(state, "storage_operations")["op-recent"]);
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
	assert.deepEqual(backupProvider.deletes, ["backups/old.json"]);
	// The same cleanup runs on every cron tick, so a second run must delete nothing and
	// report zero instead of recounting rows that are already gone.
	const repeated = await cleanupExpiredData(store, site, backupProvider, now);
	assert.deepEqual(repeated, {
		postVersions: 0,
		releaseTasks: 0,
		releaseSnapshots: 0,
		backups: 0,
		maintenanceOutbox: 0,
		backupClaims: 0,
		storageOperations: 0,
	});
	assert.ok(collection(await store.read(), "release_snapshots")["baseline-snapshot"]);
});

test("private backups freeze cold history rows and release snapshots", async () => {
	const { backend } = twoDocumentBackend();
	const store = createFileStore(backend, site);
	const postId = await post(store, "cold draft");
	const versionId = await coldContent(store, postId, "previous source");
	const backupProvider = new MemoryBackupStore();
	const record = await createBackup("cold", store, site, { backupProvider });
	const backup = backupPayload(backupProvider, record);
	assert.equal(backup.schemaVersion, 3);
	assert.equal(
		(backup.collections.entities[`post_version:${versionId}`].data as Row).source,
		"previous source",
	);
	assert.ok(backup.collections.release_snapshots.snapshot);
	// Operational state never enters a backup.
	assert.equal(backup.collections.storage_operations, undefined);
	assert.equal(backup.collections.sessions, undefined);
	assert.equal(backup.collections.oauth_states, undefined);
	const counts = (record.data as Row).collectionCounts as Record<string, number>;
	assert.equal(counts.entities, 2);
	assert.equal(counts.release_snapshots, 1);
});

test("in-process stores merge history once because both views are the same document", async () => {
	const store = createMemoryStore(site);
	const postId = await post(store, "memory draft");
	await coldContent(store, postId, "memory history");
	const backupProvider = new MemoryBackupStore();
	const record = await createBackup("memory", store, site, { backupProvider });
	const backup = backupPayload(backupProvider, record);
	const versions = Object.values(backup.collections.entities).filter(
		(row) => row.kind === "post_version",
	);
	assert.equal(versions.length, 1);
	assert.equal(
		(JSON.stringify(backup).match(/"kind":"post_version"/g) || []).length,
		1,
	);
	assert.ok(backup.collections.release_snapshots.snapshot);
});

test("partitionBackup routes embedded history and snapshots to the cold side", () => {
	const backup = {
		schemaVersion: 2,
		siteId: site,
		id: "legacy",
		createdAt: new Date().toISOString(),
		authenticationPolicy: "invalidate-sessions",
		mediaManifest: [],
		collections: {
			entities: {
				"post:kept": { id: "kept", kind: "post", data: {}, revision: 1 },
				"post_version:old": {
					id: "old",
					kind: "post_version",
					data: {},
					revision: 1,
				},
			},
			comments: {},
			visitor_bans: {},
			friends: {},
			media_upload_intents: {},
			release_snapshots: { snapshot: { id: "snapshot", data: {} } },
			release_tasks: {
				task: { id: "task", kind: "publish", state: "verified" },
			},
		},
	} as Backup;
	const partition = partitionBackup(backup);
	assert.ok(partition.hotCollections.entities["post:kept"]);
	assert.equal(partition.hotCollections.entities["post_version:old"], undefined);
	assert.ok(partition.coldCollections.entities["post_version:old"]);
	assert.ok(partition.coldCollections.release_snapshots.snapshot);
	assert.equal(partition.hotCollections.release_snapshots, undefined);
	assert.ok(partition.hotCollections.release_tasks.task);
	assert.ok(partition.hotCollections.comments);
});

test("restoring a legacy backup with history embedded in entities keeps history and snapshots readable", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "first source");
	const versionId = await coldContent(store, postId, "first history");
	const record = await createBackup("legacy", store, site, { backupProvider });
	// The older format is the same flat layout with `post_version` rows inline in
	// `entities` and the retired mail collection; restoring must not reject or drop it.
	const legacy = backupPayload(backupProvider, record);
	legacy.schemaVersion = 2;
	legacy.collections.mail_outbox = { obsolete: { oldProviderFormat: true } };
	await replaceBackupPayload(store, backupProvider, record, legacy);
	await store.update((state) => {
		const entities = collection(state, "entities");
		(entities[`post:${postId}`].data as Row).source = "second source";
		for (const key of Object.keys(entities))
			if (entities[key].kind === "post_version") delete entities[key];
		delete collection(state, "release_snapshots").snapshot;
	});
	const restore = await task(store, "restore", { backupId: "legacy" });
	await restoreBackup("legacy", restore, {
		store,
		site,
		backupProvider,
		skipCapabilityCheck: true,
	});
	const state = await store.read();
	assert.equal(
		(collection(state, "entities")[`post:${postId}`].data as Row).source,
		"first source",
	);
	const history = await listPostHistory(store, site, postId);
	assert.equal(history.length, 1);
	assert.equal(history[0].id, versionId);
	assert.equal(history[0].source, "first history");
	assert.ok(collection(await store.readCold(), "release_snapshots").snapshot);
});

test("restore writes history and snapshots back to the cold document, not the hot one", async () => {
	const { backend, values } = twoDocumentBackend();
	const store = createFileStore(backend, site);
	const postId = await post(store, "cold restore draft");
	const versionId = await coldContent(store, postId, "cold history");
	const backupProvider = new MemoryBackupStore();
	await createBackup("split", store, site, { backupProvider });
	await store.update((state) => {
		(collection(state, "entities")[`post:${postId}`].data as Row).source =
			"changed after backup";
		collection(state, "sessions").token = { token_hash: "secret" };
	});
	const restore = await task(store, "restore", { backupId: "split" });
	await restoreBackup("split", restore, {
		store,
		site,
		backupProvider,
		skipCapabilityCheck: true,
	});
	// Read the two raw documents: cold material must never be written into the hot one.
	assert.doesNotMatch(values.hot!, /post_version/);
	assert.doesNotMatch(values.hot!, /"release_snapshots":\{"snapshot"/);
	assert.match(values.cold!, /post_version/);
	assert.match(values.cold!, /"release_snapshots":\{"snapshot"/);
	const hot = await store.read();
	assert.equal(
		(collection(hot, "entities")[`post:${postId}`].data as Row).source,
		"cold restore draft",
	);
	assert.deepEqual(Object.keys(collection(hot, "sessions")), []);
	const history = await listPostHistory(store, site, postId);
	assert.deepEqual(
		history.map((version) => version.id),
		[versionId],
	);
	assert.ok(collection(await store.readCold(), "release_snapshots").snapshot);
});

test("restoring the same backup twice does not duplicate tasks or articles", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "draft"),
		keptTask = await task(store, "backup"),
		publishId = await task(store, "publish");
	await store.update((state) => {
		collection(state, "release_tasks")[publishId].state = "verified";
	});
	await createBackup("repeat", store, site, { backupProvider });
	await store.update((state) => {
		delete collection(state, "release_tasks")[publishId];
		delete collection(state, "entities")[`post:${postId}`];
	});
	const first = await task(store, "restore", { backupId: "repeat" });
	await restoreBackup("repeat", first, {
		store,
		site,
		backupProvider,
		skipCapabilityCheck: true,
	});
	const afterFirst = Object.keys(
		collection(await store.read(), "release_tasks"),
	);
	assert.deepEqual(afterFirst.sort(), [keptTask, publishId, first].sort());
	const second = await task(store, "restore", { backupId: "repeat" });
	await restoreBackup("repeat", second, {
		store,
		site,
		backupProvider,
		skipCapabilityCheck: true,
	});
	const state = await store.read();
	const afterSecond = Object.keys(collection(state, "release_tasks"));
	assert.deepEqual(
		afterSecond.sort(),
		[keptTask, publishId, first, second].sort(),
	);
	assert.equal(
		Object.values(collection(state, "entities")).filter(
			(row) => row.kind === "post",
		).length,
		1,
	);
});

test("after a restore the article, history and task read paths agree with the backup", async () => {
	const store = createMemoryStore(site),
		backupProvider = new MemoryBackupStore(),
		postId = await post(store, "restorable source"),
		publishId = await task(store, "publish");
	const versionId = await coldContent(store, postId, "restorable history");
	await store.update((state) => {
		collection(state, "release_tasks")[publishId].state = "verified";
	});
	await createBackup("reads", store, site, { backupProvider });
	await store.update((state) => {
		(collection(state, "entities")[`post:${postId}`].data as Row).source =
			"diverged";
		delete collection(state, "release_tasks")[publishId];
		const entities = collection(state, "entities");
		for (const key of Object.keys(entities))
			if (entities[key].kind === "post_version") delete entities[key];
		delete collection(state, "release_snapshots").snapshot;
	});
	const restore = await task(store, "restore", { backupId: "reads" });
	await restoreBackup("reads", restore, {
		store,
		site,
		backupProvider,
		skipCapabilityCheck: true,
	});
	const state = await store.read();
	// Article list (GET /api/posts) sees exactly the backed-up article.
	const posts = Object.values(collection(state, "entities")).filter(
		(row) => row.kind === "post",
	);
	assert.equal(posts.length, 1);
	assert.equal((posts[0].data as Row).source, "restorable source");
	// History list (GET /api/posts/:id/history) still reads the cold view.
	const history = await listPostHistory(store, site, postId);
	assert.equal(history.length, 1);
	assert.equal(history[0].id, versionId);
	// Task list (GET /api/release/tasks) keeps the terminal publish and the live restore task.
	const tasks = Object.values(collection(state, "release_tasks"));
	const restored = tasks.find((row) => row.id === publishId)!;
	assert.equal(restored.state, "verified");
	assert.equal((restored.details as Row).restored, true);
	assert.ok(tasks.some((row) => row.id === restore));
	assert.ok(collection(state, "release_snapshots").snapshot);
});

