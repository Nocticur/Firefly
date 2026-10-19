import { createHash, randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { z } from "zod";
import type { AdminApp } from "./types.js";
import {
	assertSite,
	collection,
	getStore,
	getSiteId,
	type FileStore,
	type StoreState,
	type Row,
} from "./file-store.js";
import { requireAdmin } from "./auth.js";
import {
	ApiFailure,
	constantTimeEqual,
	productionEnvironment,
	readJson,
} from "./security.js";
import { storageConfig } from "./storage-config.js";
import { createKvBackupProvider } from "./kv.js";
import { createCloudflareKvBackupProvider } from "./cloudflare-kv.js";
import {
	processReleaseTask,
	reconcileVerifiedReleaseFinalization,
	taskRecord,
} from "./releases.js";
import { maintenanceWorkflow } from "../workflows/maintenance.js";
import { checkUpdates } from "./update-check.js";
import { serviceEnabled } from "./service-settings.js";
const backupNames = [
	"entities",
	"comments",
	"visitor_bans",
	"friends",
	"media_upload_intents",
	"release_snapshots",
	"release_tasks",
] as const;
type Backup = {
	schemaVersion: 2 | 3;
	siteId: string;
	id: string;
	createdAt: string;
	authenticationPolicy: "invalidate-sessions";
	collections: Record<string, Record<string, Row>>;
	mediaManifest: Row[];
};
const terminal = new Set(["verified", "failed", "conflict", "blocked"]);
export const DATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value: Uint8Array | string) =>
	createHash("sha256").update(value).digest("hex");
const LEASE_MS = 600000;
type Lease = { id: string; owner: string; fence: number };
export interface BackupProvider {
	put(key: string, bytes: Buffer): Promise<void>;
	get(key: string): Promise<Buffer | null>;
	delete(key: string): Promise<void>;
}
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
function configuredBackupProvider(): BackupProvider {
	const config = storageConfig();
	if (!config)
		throw new ApiFailure(
			503,
			"KV_CONFIGURATION_REQUIRED",
			"缺少 KV 配置，无法读写后台备份",
		);
	return config.provider === "cloudflare"
		? createCloudflareKvBackupProvider(config)
		: createKvBackupProvider(config);
}
export type MaintenanceDependencies = {
	store?: FileStore;
	site?: string;
	blob?: BackupProvider;
	mediaFetcher?: typeof fetch;
	skipCapabilityCheck?: boolean;
	processPublish?: (id: string) => Promise<unknown>;
	reconcileFinalization?: () => Promise<void>;
};
class LeaseLost extends Error {}
async function assertMaintenance(
	store?: FileStore,
	site?: string,
): Promise<void> {
	if (!productionEnvironment(true))
		throw new ApiFailure(
			403,
			"PRODUCTION_PERMISSION_REQUIRED",
			"开发及预览环境没有生产维护权限",
		);
	if (!(await serviceEnabled("maintenance", store, site)))
		throw new ApiFailure(
			403,
			"MAINTENANCE_DISABLED",
			"请在服务设置中启用生产维护",
		);
}
function busy() {
	return new ApiFailure(
		409,
		"MAINTENANCE_BUSY",
		"维护任务正在执行，请稍后核验任务状态",
	);
}
function owned(state: StoreState, site: string, lease: Lease): Row {
	assertSite(state, site);
	const lock = collection(state, "maintenance_locks").main;
	if (
		!lock ||
		lock.task_id !== lease.id ||
		lock.owner_id !== lease.owner ||
		lock.fencing_token !== lease.fence ||
		Date.parse(String(lock.lease_until)) <= Date.now()
	)
		throw new LeaseLost("Maintenance lease superseded");
	return lock;
}
function activeRestore(state: StoreState): boolean {
	const lock = collection(state, "maintenance_locks").main;
	return (
		lock?.kind === "restore" &&
		Boolean(lock.owner_id) &&
		Date.parse(String(lock.lease_until)) > Date.now()
	);
}
function capture(state: StoreState, id: string, now: string): Backup {
	const collections: Backup["collections"] = {};
	for (const name of backupNames)
		collections[name] = structuredClone(collection(state, name));
	for (const [key, row] of Object.entries(collections.entities))
		if (row.kind === "service_settings") delete collections.entities[key];
	return {
		schemaVersion: 3,
		siteId: state.siteId,
		id,
		createdAt: now,
		authenticationPolicy: "invalidate-sessions",
		collections,
		mediaManifest: Object.values(collections.entities)
			.filter((row) => row.kind === "media")
			.map((row) => ({ ...(row.data as Row), id: row.id })),
	};
}
/** One immutable JSON snapshot; ETag updates fence both backup and restore writers. */
export async function createBackup(
	id: string,
	store = getStore(),
	site = getSiteId(),
	options: {
		blob?: BackupProvider;
		restoreOwner?: boolean;
		expectedRevision?: number;
	} = {},
): Promise<Row> {
	const blob = options.blob || configuredBackupProvider(),
		owner = randomUUID(),
		now = new Date().toISOString();
	const claim = await store.update((state) => {
		assertSite(state, site);
		if (
			options.expectedRevision !== undefined &&
			state.revision !== options.expectedRevision
		)
			throw new ApiFailure(
				409,
				"RESTORE_STATE_CHANGED",
				"备份期间数据已变化，请重新执行恢复",
			);
		if (activeRestore(state) && !options.restoreOwner) throw busy();
		const existing = collection(state, "maintenance_backups")[id];
		if (existing?.state === "verified")
			return { existing, nextRevision: state.revision + 1 };
		const claims = collection(state, "maintenance_backup_claims"),
			previous = claims[id];
		if (
			previous?.owner_id &&
			Date.parse(String(previous.lease_until)) > Date.now()
		)
			throw busy();
		const fence = Number(previous?.fencing_token || 0) + 1;
		const payload =
			typeof previous?.payload === "string"
				? previous.payload
				: JSON.stringify(capture(state, id, now));
		const checksum = hash(payload),
			pathname = `admin-backup:${hash(site)}:${hash(id)}:${checksum}`;
		claims[id] = {
			id,
			owner_id: owner,
			fencing_token: fence,
			lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
			payload,
			sha256: checksum,
			pathname,
		};
		collection(state, "maintenance_backups")[id] = {
			id,
			state: "writing",
			created_at: existing?.created_at || now,
		};
		return {
			payload,
			checksum,
			pathname,
			fence,
			nextRevision: state.revision + 1,
		};
	});
	if (claim.existing)
		return { ...claim.existing, storeRevision: claim.nextRevision };
	const { payload, checksum, pathname, fence } = claim;
	const bytes = Buffer.from(payload!);
	try {
		const existing = await blob.get(pathname!);
		if (existing && hash(existing) !== checksum)
			throw new Error("Immutable backup contains different bytes");
		if (!existing)
			try {
				await blob.put(pathname!, bytes);
			} catch (error) {
				const recovered = await blob.get(pathname!);
				if (!recovered || hash(recovered) !== checksum) throw error;
			}
		const verified = await blob.get(pathname!);
		if (!verified || hash(verified) !== checksum)
			throw new Error("Private backup checksum verification failed");
		const backup = JSON.parse(payload!) as Backup;
		validateBackup(backup, site);
		return await store.update((state) => {
			assertSite(state, site);
			if (
				options.expectedRevision !== undefined &&
				state.revision !== claim.nextRevision
			)
				throw new ApiFailure(
					409,
					"RESTORE_STATE_CHANGED",
					"安全备份期间有其他写入，请重新执行恢复",
				);
			const current = collection(state, "maintenance_backup_claims")[id];
			if (
				current?.owner_id !== owner ||
				current.fencing_token !== fence ||
				Date.parse(String(current.lease_until)) <= Date.now()
			)
				throw new LeaseLost("Backup lease superseded");
			const record = {
				id,
				state: "verified",
				pathname,
				sha256: checksum,
				created_at: now,
				data: {
					schemaVersion: backup.schemaVersion,
					collectionCounts: Object.fromEntries(
						Object.entries(backup.collections).map(([name, rows]) => [
							name,
							Object.keys(rows).length,
						]),
					),
					mediaCount: backup.mediaManifest.length,
					authenticationPolicy: backup.authenticationPolicy,
				},
			};
			collection(state, "maintenance_backups")[id] = record;
			Object.assign(current, { owner_id: null, lease_until: now });
			delete current.payload;
			return { ...record, storeRevision: state.revision + 1 };
		});
	} catch (error) {
		await store.update((state) => {
			assertSite(state, site);
			const current = collection(state, "maintenance_backup_claims")[id];
			if (current?.owner_id === owner && current.fencing_token === fence)
				Object.assign(current, {
					owner_id: null,
					lease_until: new Date().toISOString(),
				});
		});
		throw error;
	}
}
function plain(value: unknown): value is Row {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function validateBackup(value: unknown, site: string): asserts value is Backup {
	if (
		!plain(value) ||
		(value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
		value.siteId !== site ||
		value.authenticationPolicy !== "invalidate-sessions" ||
		!plain(value.collections) ||
		!Array.isArray(value.mediaManifest)
	)
		throw new Error("Backup does not match this site and schema");
	const backup = value as Backup;
	if (
		Object.keys(backup.collections).some(
			(name) =>
				!backupNames.includes(name as (typeof backupNames)[number]) &&
				!(backup.schemaVersion === 2 && name === "mail_outbox"),
		)
	)
		throw new Error("Unknown backup collection");
	// Version 2 may contain retired mail history. It is deliberately ignored:
	// restore only replaces the retained collections below.
	for (const name of backupNames) {
		const rows = backup.collections[name];
		if (
			!plain(rows) ||
			Object.entries(rows).some(
				([id, row]) =>
					!plain(row) ||
					typeof row.id !== "string" ||
					(name === "entities"
						? id !== `${row.kind}:${row.id}`
						: id !== row.id),
			)
		)
			throw new Error(`Invalid backup collection: ${name}`);
	}
	const entities = Object.values(backup.collections.entities);
	const mediaIds = new Set(backup.mediaManifest.map((row) => String(row.id)));
	if (
		mediaIds.size !== backup.mediaManifest.length ||
		entities
			.filter((row) => row.kind === "media")
			.some((row) => !mediaIds.has(String(row.id)))
	)
		throw new Error("Backup media manifest mismatch");
	for (const row of entities)
		for (const match of JSON.stringify(row.data).matchAll(
			/(?:media:([a-zA-Z0-9-]+)|\/api\/media\/([a-zA-Z0-9-]+)\/content)/g,
		))
			if (!mediaIds.has(match[1] || match[2]))
				throw new Error("Backup contains missing media reference");
	for (const row of Object.values(backup.collections.comments))
		if (row.parent_id && !backup.collections.comments[String(row.parent_id)])
			throw new Error("Backup contains missing parent comment");
}
async function loadBackup(
	id: string,
	store: FileStore,
	site: string,
	blob: BackupProvider,
	mediaFetcher: typeof fetch = fetch,
): Promise<Backup> {
	const state = await store.read();
	assertSite(state, site);
	const record = collection(state, "maintenance_backups")[id];
	if (
		record?.state !== "verified" ||
		typeof record.pathname !== "string" ||
		typeof record.sha256 !== "string"
	)
		throw new ApiFailure(404, "BACKUP_NOT_FOUND", "找不到已验证的私有备份");
	const bytes = await blob.get(record.pathname);
	if (
		!bytes ||
		bytes.length > MAX_BACKUP_BYTES ||
		!constantTimeEqual(hash(bytes), record.sha256)
	)
		throw new Error("Backup checksum mismatch");
	const backup: unknown = JSON.parse(bytes.toString("utf8"));
	validateBackup(backup, site);
	if (backup.id !== id) throw new Error("Backup identity mismatch");
	for (const media of backup.mediaManifest) {
		// Media bytes live in the image bed, not in this store. Verify that every
		// frozen reference is still a reachable HTTPS image instead of re-hashing
		// bytes this project no longer owns.
		const url = media.publishedUrl;
		if (typeof url !== "string" || !/^https:\/\//.test(url))
			throw new Error("Media manifest incomplete");
		let response: Response;
		try {
			response = await mediaFetcher(url, {
				method: "HEAD",
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			throw new Error("Backup media URL is unavailable");
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new Error("Backup media URL is unavailable");
		}
		await response.body?.cancel().catch(() => {});
	}
	return backup;
}
async function heartbeat(
	store: FileStore,
	site: string,
	lease: Lease,
): Promise<void> {
	await store.update((state) => {
		const lock = owned(state, site, lease);
		lock.lease_until = new Date(Date.now() + LEASE_MS).toISOString();
	});
}
export async function claimMaintenanceTask(
	store: FileStore,
	site: string,
	id: string,
): Promise<Lease | null> {
	const owner = randomUUID();
	return store.update((state) => {
		assertSite(state, site);
		const locks = collection(state, "maintenance_locks"),
			lock = locks.main;
		if (lock?.owner_id && Date.parse(String(lock.lease_until)) > Date.now())
			return null;
		const task = collection(state, "release_tasks")[id];
		if (
			!task ||
			!["backup", "restore", "daily"].includes(String(task.kind)) ||
			terminal.has(String(task.state))
		)
			return null;
		const fence = Number(lock?.fencing_token || 0) + 1;
		locks.main = {
			task_id: id,
			owner_id: owner,
			kind: task.kind,
			fencing_token: fence,
			lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
		};
		Object.assign(task, {
			state: "running",
			fence,
			updated_at: new Date().toISOString(),
		});
		return { id, owner, fence };
	});
}
async function releaseLease(
	store: FileStore,
	site: string,
	lease: Lease,
): Promise<void> {
	await store.update((state) => {
		assertSite(state, site);
		const lock = collection(state, "maintenance_locks").main;
		if (
			lock?.task_id === lease.id &&
			lock.owner_id === lease.owner &&
			lock.fencing_token === lease.fence
		)
			Object.assign(lock, {
				owner_id: null,
				lease_until: new Date().toISOString(),
			});
	});
}
function safeToRestore(state: StoreState): void {
	const tasks = Object.values(collection(state, "release_tasks"));
	if (
		tasks.some(
			(row) =>
				row.kind === "publish" &&
				(!terminal.has(String(row.state)) ||
					Boolean((row.details as Row)?.restoreRequiresReconciliation)),
		)
	)
		throw new ApiFailure(
			409,
			"RESTORE_RECONCILIATION_REQUIRED",
			"有结果未明确的发布，先完成 Git/生产核验再恢复",
		);
}

export type CleanupSummary = {
	postVersions: number;
	releaseTasks: number;
	releaseSnapshots: number;
	backups: number;
	maintenanceOutbox: number;
	backupClaims: number;
};

function isOlderThanRetention(value: unknown, cutoff: number): boolean {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp <= cutoff;
}

/** Prune aged administrative history without deleting live drafts or the current publication baseline. */
export async function cleanupExpiredData(
	store: FileStore,
	site: string,
	blob: BackupProvider = configuredBackupProvider(),
	now = Date.now(),
): Promise<CleanupSummary> {
	const cutoff = now - DATA_RETENTION_MS;
	const summary: CleanupSummary = {
		postVersions: 0,
		releaseTasks: 0,
		releaseSnapshots: 0,
		backups: 0,
		maintenanceOutbox: 0,
		backupClaims: 0,
	};
	const before = await store.read();
	assertSite(before, site);
	const backupCandidates = Object.values(
		collection(before, "maintenance_backups"),
	).filter(
		(row) =>
			row.state === "verified" &&
			typeof row.pathname === "string" &&
			isOlderThanRetention(row.created_at, cutoff),
	);
	const deletedBackups = new Set<string>();
	for (const backup of backupCandidates) {
		try {
			await blob.delete(String(backup.pathname));
			deletedBackups.add(String(backup.id));
		} catch {
			// Keep the index if the immutable object could not be deleted.
		}
	}
	return store.update((state) => {
		assertSite(state, site);
		const entities = collection(state, "entities");
		for (const [id, row] of Object.entries(entities)) {
			if (
				row.kind === "post_version" &&
				isOlderThanRetention(row.created_at ?? (row.data as Row)?.createdAt, cutoff)
			) {
				delete entities[id];
				summary.postVersions++;
			}
		}

		const tasks = collection(state, "release_tasks");
		const baseline = entities["repository:baseline"]?.data as Row | undefined;
		const baselineTaskId = typeof baseline?.taskId === "string" ? baseline.taskId : "";
		const baselineSnapshotId = typeof baseline?.snapshotId === "string" ? baseline.snapshotId : "";
		for (const [id, row] of Object.entries(tasks)) {
			const publishTask = row.kind === "publish";
			const pruneableState = ["verified", "failed", "conflict"].includes(String(row.state));
			const details = (row.details ?? {}) as Row;
			if (
				id === baselineTaskId ||
				!pruneableState ||
				Boolean(details.restoreRequiresReconciliation) ||
				(row.state === "verified" && details.finalizationState === "pending") ||
				!isOlderThanRetention(row.created_at, cutoff)
			)
				continue;
			if (!publishTask && !["backup", "restore", "daily"].includes(String(row.kind)))
				continue;
			delete tasks[id];
			summary.releaseTasks++;
		}

		const referencedSnapshots = new Set(
			Object.values(tasks)
				.map((row) => row.snapshot_id)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		);
		if (baselineSnapshotId) referencedSnapshots.add(baselineSnapshotId);
		const snapshots = collection(state, "release_snapshots");
		for (const [id, row] of Object.entries(snapshots)) {
			if (
				!referencedSnapshots.has(id) &&
				isOlderThanRetention(row.created_at, cutoff)
			) {
				delete snapshots[id];
				summary.releaseSnapshots++;
			}
		}

		const backups = collection(state, "maintenance_backups");
		for (const [id, row] of Object.entries(backups)) {
			if (deletedBackups.has(id) && isOlderThanRetention(row.created_at, cutoff)) {
				delete backups[id];
				summary.backups++;
			}
		}

		const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
		const outbox = collection(state, "maintenance_outbox");
		for (const [dateKey, row] of Object.entries(outbox)) {
			if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey < cutoffDate) {
				delete outbox[dateKey];
				summary.maintenanceOutbox++;
			}
		}
		const claims = collection(state, "maintenance_backup_claims");
		for (const [id, row] of Object.entries(claims)) {
			if (
				!row.owner_id &&
				isOlderThanRetention(row.lease_until, cutoff) &&
				!backups[id]
			) {
				delete claims[id];
				summary.backupClaims++;
			}
		}
		return summary;
	});
}

export async function restoreBackup(
	backupId: string,
	taskId: string,
	dependencies: MaintenanceDependencies = {},
	suppliedLease?: Lease,
): Promise<void> {
	const store = dependencies.store || getStore(),
		site = dependencies.site || getSiteId(),
		blob = dependencies.blob || configuredBackupProvider();
	if (!dependencies.skipCapabilityCheck) await assertMaintenance(store, site);
	const lease =
		suppliedLease || (await claimMaintenanceTask(store, site, taskId));
	if (!lease) throw busy();
	try {
		await heartbeat(store, site, lease);
		const backup = await loadBackup(
			backupId,
			store,
			site,
			blob,
			dependencies.mediaFetcher ?? fetch,
		);
		const captured = await store.read();
		owned(captured, site, lease);
		safeToRestore(captured);
		const safety = await createBackup(
			`before-restore-${taskId}-${captured.revision}`,
			store,
			site,
			{ blob, restoreOwner: true, expectedRevision: captured.revision },
		);
		await store.update((state) => {
			owned(state, site, lease);
			if (state.revision !== safety.storeRevision)
				throw new ApiFailure(
					409,
					"RESTORE_STATE_CHANGED",
					"安全备份后数据已变化，请重新执行恢复",
				);
			safeToRestore(state);
			const replacement = Object.fromEntries(
				backupNames.map((name) => [name, structuredClone(backup.collections[name])]),
			);
			// Permissions are operational state and can never be restored from an
			// older snapshot, including a snapshot created by another version.
			for (const [key, row] of Object.entries(replacement.entities))
				if (row.kind === "service_settings") delete replacement.entities[key];
			for (const row of Object.values(replacement.release_tasks)) {
				row.details = {
					...(row.details as Row),
					restored: true,
					...(!terminal.has(String(row.state))
						? {
								restoreRequiresReconciliation: true,
								restorePreviousState: row.state,
							}
						: {}),
				};
				if (!terminal.has(String(row.state)))
					Object.assign(row, {
						state: "blocked",
						workflow_id: null,
						fence: null,
					});
			}
			for (const [id, current] of Object.entries(
				collection(state, "release_tasks"),
			))
				if (current.kind !== "publish")
					replacement.release_tasks[id] = structuredClone(current);
			for (const [key, current] of Object.entries(
				collection(state, "entities"),
			))
				if (current.kind === "service_settings")
					replacement.entities[key] = structuredClone(current);
			for (const name of backupNames)
				state.collections[name] = replacement[name];
			state.collections.sessions = {};
			state.collections.oauth_states = {};
			for (const lock of Object.values(collection(state, "release_locks")))
				Object.assign(lock, {
					task_id: null,
					lease_until: new Date().toISOString(),
					fencing_token: Number(lock.fencing_token || 0) + 1,
				});
		});
	} finally {
		if (!suppliedLease) await releaseLease(store, site, lease);
	}
}
export async function createMaintenanceTask(
	kind: "backup" | "restore" | "daily",
	details: Row = {},
	idempotencyKey = `${kind}:${randomUUID()}`,
): Promise<Row> {
	const store = getStore(),
		site = getSiteId(),
		id = randomUUID(),
		now = new Date().toISOString();
	const task = await store.update((state) => {
		assertSite(state, site);
		if (activeRestore(state)) throw busy();
		const rows = collection(state, "release_tasks");
		const existing = Object.values(rows).find(
			(row) => row.idempotency_key === idempotencyKey,
		);
		if (existing) return existing;
		return (rows[id] = {
			id,
			kind,
			idempotency_key: idempotencyKey,
			state: "queued",
			details,
			workflow_id: null,
			created_at: now,
			updated_at: now,
		});
	});
	if (terminal.has(String(task.state))) return task;
	const dispatch = `dispatching:${randomUUID()}`;
	const claimed = await store.update((state) => {
		assertSite(state, site);
		const current = collection(state, "release_tasks")[String(task.id)];
		if (
			!current ||
			(current.workflow_id &&
				!(
					String(current.workflow_id).startsWith("dispatching:") &&
					Date.parse(String(current.updated_at)) < Date.now() - 300000
				))
		)
			return false;
		Object.assign(current, {
			workflow_id: dispatch,
			updated_at: new Date().toISOString(),
		});
		return true;
	});
	if (!claimed) return task;
	let runId: string | null = null;
	try {
		runId = (await start(maintenanceWorkflow, [String(task.id)])).runId;
	} catch {}
	await store.update((state) => {
		const current = collection(state, "release_tasks")[String(task.id)];
		if (current?.workflow_id === dispatch) current.workflow_id = runId;
	});
	return task;
}
export async function processMaintenanceTask(
	id: string,
	dependencies: MaintenanceDependencies = {},
): Promise<{ done: boolean; state: string }> {
	const store = dependencies.store || getStore(),
		site = dependencies.site || getSiteId();
	if (!dependencies.skipCapabilityCheck) await assertMaintenance(store, site);
	const state = await store.read();
	assertSite(state, site);
	const task = collection(state, "release_tasks")[id];
	if (!task) throw new ApiFailure(404, "TASK_NOT_FOUND", "维护任务不存在");
	if (!["backup", "restore", "daily"].includes(String(task.kind)))
		throw new ApiFailure(400, "INVALID_MAINTENANCE_TASK", "此任务不是维护任务");
	if (terminal.has(String(task.state)))
		return { done: true, state: String(task.state) };
	const lease = await claimMaintenanceTask(store, site, id);
	if (!lease) return { done: false, state: "queued" };
	try {
		await heartbeat(store, site, lease);
		if (task.kind === "backup")
			await createBackup(id, store, site, { blob: dependencies.blob });
		if (task.kind === "restore")
			await restoreBackup(
				String((task.details as Row).backupId),
				id,
				dependencies,
				lease,
			);
		if (task.kind === "daily") {
			const failures: unknown[] = [];
			try {
				await createBackup(id, store, site, { blob: dependencies.blob });
			} catch (error) {
				failures.push(error);
			}
			try {
				await heartbeat(store, site, lease);
				await (
					dependencies.reconcileFinalization ||
					(() => reconcileVerifiedReleaseFinalization(store, site))
				)();
			} catch (error) {
				failures.push(error);
			}
			if (failures.length) throw failures[0];
			if (await serviceEnabled("publish", store, site)) {
				const pending = Object.values(
					collection(await store.read(), "release_tasks"),
				).filter(
					(row) =>
						row.kind === "publish" &&
						!terminal.has(String(row.state)) &&
						!(row.details as Row)?.restoreRequiresReconciliation,
				);
				for (const row of pending) {
					await heartbeat(store, site, lease);
					await (dependencies.processPublish || processReleaseTask)(
						String(row.id),
					);
				}
			}
		}
		return await store.update((state) => {
			owned(state, site, lease);
			const current = collection(state, "release_tasks")[id];
			if (current?.fence !== lease.fence) throw new LeaseLost();
			Object.assign(current, {
				state: "verified",
				message: "维护及完整性核验已完成",
				updated_at: new Date().toISOString(),
			});
			return { done: true, state: "verified" };
		});
	} catch (error) {
		if (
			error instanceof LeaseLost ||
			(error instanceof ApiFailure && error.code === "MAINTENANCE_BUSY")
		)
			return { done: false, state: "queued" };
		try {
			return await store.update((state) => {
				owned(state, site, lease);
				const current = collection(state, "release_tasks")[id];
				if (current?.fence !== lease.fence) throw new LeaseLost();
				Object.assign(current, {
					state: "failed",
					message:
						error instanceof ApiFailure
							? error.message
							: "维护未完成，请检查私有文件与任务状态后重试",
					updated_at: new Date().toISOString(),
				});
				return { done: true, state: "failed" };
			});
		} catch {
			return { done: false, state: "queued" };
		}
	} finally {
		await releaseLease(store, site, lease);
	}
}
export function registerMaintenanceRoutes(app: AdminApp): void {
	app.post("/api/maintenance/backup", requireAdmin, async (c) => {
		await assertMaintenance();
		return c.json(
			{ data: taskRecord(await createMaintenanceTask("backup")) },
			202,
		);
	});
	app.get("/api/maintenance/backups", requireAdmin, async (c) => {
		const rows = Object.values(
			collection(await getStore().read(), "maintenance_backups"),
		)
			.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
			.slice(0, 100);
		return c.json({
			data: rows.map((row) => ({
				id: row.id,
				state: row.state,
				sha256: row.sha256,
				createdAt: row.created_at,
				...(row.data as Row),
			})),
		});
	});
	app.post("/api/maintenance/restore", requireAdmin, async (c) => {
		await assertMaintenance();
		const parsed = z
			.object({
				backupId: z.string().min(1).max(200),
				confirm: z.literal(true),
			})
			.strict()
			.safeParse(await readJson(c.req.raw));
		if (!parsed.success)
			throw new ApiFailure(
				400,
				"RESTORE_CONFIRMATION_REQUIRED",
				"提供 backupId 和 confirm:true；恢复会清除当前登录会话",
			);
		return c.json(
			{
				data: taskRecord(
					await createMaintenanceTask("restore", {
						backupId: parsed.data.backupId,
					}),
				),
			},
			202,
		);
	});
	app.post("/api/maintenance/check", requireAdmin, async (c) => {
		const counts = new Map<string, number>();
		for (const row of Object.values(
			collection(await getStore().read(), "release_tasks"),
		))
			counts.set(String(row.state), (counts.get(String(row.state)) || 0) + 1);
		return c.json({
			data: {
				environment: productionEnvironment(true) ? "production" : "isolated",
				tasks: [...counts].map(([state, count]) => ({ state, count })),
				...(await checkUpdates()),
				note: "更新前必须先创建私有备份；代码升级通过独立审核的 Git 改动执行",
			},
		});
	});
	app.get("/api/maintenance/cron", async (c) => {
		const secret = process.env.CRON_SECRET;
		if (
			!secret ||
			!constantTimeEqual(
				c.req.header("Authorization") || "",
				`Bearer ${secret}`,
			)
		)
			throw new ApiFailure(401, "CRON_AUTH_REQUIRED", "Cron 鉴权失败");
		if (!productionEnvironment(true))
			throw new ApiFailure(403, "PRODUCTION_PERMISSION_REQUIRED", "Cron 仅能在生产环境执行");
		const store = getStore();
		const site = getSiteId();
		const cleanup = await cleanupExpiredData(store, site);
		if (!(await serviceEnabled("maintenance", store, site)))
			return c.json({ data: { state: "cleanup_only", cleanup } });
		await assertMaintenance();
		const dateKey = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Shanghai",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(new Date());
		const task = await createMaintenanceTask(
			"daily",
			{ dateKey },
			`daily:${dateKey}`,
		);
		await getStore().update((state) => {
			collection(state, "maintenance_outbox")[dateKey] = {
				date_key: dateKey,
				task_id: task.id,
			};
		});
		return c.json({ data: taskRecord(task) }, 202);
	});
}
