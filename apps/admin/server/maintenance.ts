import { createHash, randomUUID } from "node:crypto";
import { get, put } from "@vercel/blob";
import { start } from "workflow/api";
import { z } from "zod";
import type { AdminApp } from "./types.js";
import { getDatabase, getSiteId, createDatabase, type Database } from "./db.js";
import { requireAdmin } from "./auth.js";
import { ApiFailure, constantTimeEqual, productionEnvironment, readJson, runtimeEnvironment } from "./security.js";
import { blobToken } from "./media.js";
import { processReleaseTask, taskRecord } from "./releases.js";
import { maintenanceWorkflow } from "../workflows/maintenance.js";
import { checkUpdates } from "./update-check.js";

type Row = Record<string, unknown>;
// Operational locks, backup indexes and cron keys survive restores. Authentication
// sessions and OAuth state are intentionally invalidated, never backed up.
const backupTables = ["entities", "comments", "visitor_bans", "friends", "media_upload_intents", "mail_outbox", "release_snapshots", "release_tasks", "release_locks", "maintenance_backups", "maintenance_outbox"] as const;
const restoreTables = backupTables.filter((name) => !["release_locks", "maintenance_backups", "maintenance_outbox"].includes(name));
type Backup = { schemaVersion: 1; siteId: string; id: string; createdAt: string; authenticationPolicy: "invalidate-sessions"; tables: Record<string, Row[]>; mediaManifest: Row[] };
const terminal = new Set(["verified", "failed", "conflict", "blocked"]);
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const LEASE_SECONDS = 600;
type Lease = { id: string; owner: string; fence: number };
export interface BackupBlobProvider {
	put(pathname: string, bytes: Buffer): Promise<void>;
	get(pathname: string): Promise<Buffer | null>;
}
const privateBackupBlob: BackupBlobProvider = {
	async put(pathname, bytes) { await put(pathname, bytes, { access: "private", token: blobToken("private"), contentType: "application/json", addRandomSuffix: false, allowOverwrite: false }); },
	async get(pathname) {
		const result = await get(pathname, { access: "private", token: blobToken("private"), useCache: false });
		return result?.statusCode === 200 ? Buffer.from(await new Response(result.stream).arrayBuffer()) : null;
	},
};
export type MaintenanceDependencies = {
	db?: Database; site?: string; blob?: BackupBlobProvider; skipCapabilityCheck?: boolean;
	createIsolation?: (url: string) => Database; liveDatabaseUrl?: string; restoreDatabaseUrl?: string;
	processPublish?: (id: string) => Promise<unknown>; deliverMail?: () => Promise<unknown>;
};
class LeaseLost extends Error {}
function assertMaintenance(): void {
	if (runtimeEnvironment() !== "production" || process.env.APP_ENV !== "production" || process.env.VERCEL_ENV !== "production") throw new ApiFailure(403, "PRODUCTION_PERMISSION_REQUIRED", "开发及预览环境没有生产维护权限");
	if (process.env.ENABLE_PRODUCTION_MAINTENANCE !== "true") throw new ApiFailure(403, "MAINTENANCE_DISABLED", "生产维护开关尚未启用");
}
function busy(): ApiFailure { return new ApiFailure(409, "MAINTENANCE_BUSY", "维护任务正在执行，请稍后核验任务状态"); }
async function restoreWrite(tx: Database, site: string): Promise<void> {
	await tx.query("SELECT set_config('firefly.restore_site',$1,true)", [site]);
}
async function fencedTransaction<T>(db: Database, site: string, restoreOwner: boolean, fn: (tx: Database) => Promise<T>): Promise<T> {
	return db.transaction(async (tx) => { if (restoreOwner) await restoreWrite(tx, site); return fn(tx); });
}

export async function createBackup(id: string, db = getDatabase(), site = getSiteId(), options: { blob?: BackupBlobProvider; restoreOwner?: boolean } = {}): Promise<Row> {
	const blob = options.blob || privateBackupBlob;
	const owner = randomUUID();
	const restoreOwner = options.restoreOwner === true;
	const claim = await fencedTransaction(db, site, restoreOwner, async (tx) => {
		await tx.query("INSERT INTO maintenance_backup_claims(site_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING", [site, id]);
		const [current] = await tx.query<Row>("SELECT *,lease_until>clock_timestamp() AS leased FROM maintenance_backup_claims WHERE site_id=$1 AND id=$2 FOR UPDATE", [site, id]);
		const [existing] = await tx.query<Row>("SELECT * FROM maintenance_backups WHERE site_id=$1 AND id=$2", [site, id]);
		if (existing?.state === "verified") return { existing };
		if (current.owner_id && current.leased === true) throw busy();
		const [claimed] = await tx.query<Row>("UPDATE maintenance_backup_claims SET owner_id=$3,fencing_token=fencing_token+1,lease_until=clock_timestamp()+($4::int*interval '1 second') WHERE site_id=$1 AND id=$2 RETURNING *", [site, id, owner, LEASE_SECONDS]);
		await tx.query("INSERT INTO maintenance_backups(site_id,id,state) VALUES($1,$2,'writing') ON CONFLICT(site_id,id) DO UPDATE SET state='writing'", [site, id]);
		return { claimed };
	});
	if (claim.existing) return claim.existing;
	const claimed = claim.claimed!; const fence = Number(claimed.fencing_token);
	try {
		let payload = claimed.payload ? String(claimed.payload) : null;
		if (!payload) {
			const backup = await db.transaction(async (tx) => {
				await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
				const tables: Record<string, Row[]> = {};
				for (const name of backupTables) tables[name] = await tx.query(`SELECT * FROM ${name} WHERE site_id=$1 ORDER BY ${name === "entities" ? "kind,id" : name === "release_locks" ? "site_id" : name === "maintenance_outbox" ? "date_key" : "id"}`, [site]);
				const mediaManifest = tables.entities.filter((row) => row.kind === "media").map((row) => ({ ...(row.data as Row), id: row.id }));
				return { schemaVersion: 1 as const, siteId: site, id, createdAt: new Date().toISOString(), authenticationPolicy: "invalidate-sessions" as const, tables, mediaManifest };
			});
			payload = JSON.stringify(backup);
		}
		const bytes = Buffer.from(payload); const checksum = hash(bytes);
		const pathname = `backups/${hash(site)}/${hash(id)}/${checksum}.json`;
		const persisted = await db.query<Row>("UPDATE maintenance_backup_claims SET payload=COALESCE(payload,$5),pathname=$6,sha256=$7,lease_until=clock_timestamp()+($8::int*interval '1 second') WHERE site_id=$1 AND id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp() RETURNING payload", [site, id, owner, fence, payload, pathname, checksum, LEASE_SECONDS]);
		if (!persisted.length || persisted[0].payload !== payload) throw new LeaseLost("Backup lease was superseded");
		// The same task always writes the exact same immutable bytes. A lost response
		// is reconciled by checksum, never by size or a second snapshot.
		const existingBytes = await blob.get(pathname);
		if (existingBytes && hash(existingBytes) !== checksum) throw new Error("Private backup pathname contains different bytes");
		if (!existingBytes) {
			const owned = await db.query("UPDATE maintenance_backup_claims SET lease_until=clock_timestamp()+($5::int*interval '1 second') WHERE site_id=$1 AND id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp() RETURNING id", [site, id, owner, fence, LEASE_SECONDS]);
			if (!owned.length) throw new LeaseLost("Backup lease was superseded");
			try { await blob.put(pathname, bytes); } catch (error) { const found = await blob.get(pathname); if (!found || hash(found) !== checksum) throw error; }
		}
		const downloaded = await blob.get(pathname);
		if (!downloaded || hash(downloaded) !== checksum) throw new Error("Private backup checksum verification failed");
		const backup = JSON.parse(payload) as Backup;
		return await fencedTransaction(db, site, restoreOwner, async (tx) => {
			const [owned] = await tx.query<Row>("SELECT id FROM maintenance_backup_claims WHERE site_id=$1 AND id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp() FOR UPDATE", [site, id, owner, fence]);
			if (!owned) throw new LeaseLost("Backup lease was superseded");
			const [verified] = await tx.query<Row>("UPDATE maintenance_backups SET pathname=$3,sha256=$4,state='verified',data=$5::jsonb WHERE site_id=$1 AND id=$2 RETURNING *", [site, id, pathname, checksum, JSON.stringify({ tableCounts: Object.fromEntries(Object.entries(backup.tables).map(([name, rows]) => [name, rows.length])), mediaCount: backup.mediaManifest.length, authenticationPolicy: backup.authenticationPolicy })]);
			return verified;
		});
	} finally {
		await db.query("UPDATE maintenance_backup_claims SET owner_id=NULL,lease_until=now() WHERE site_id=$1 AND id=$2 AND owner_id=$3 AND fencing_token=$4", [site, id, owner, fence]);
	}
}
function validateBackup(backup: Backup, site: string): void {
	if (backup.schemaVersion !== 1 || backup.siteId !== site || backup.authenticationPolicy !== "invalidate-sessions" || !backup.tables || !Array.isArray(backup.mediaManifest)) throw new Error("Backup does not match this site and schema");
	for (const name of backupTables) if (!Array.isArray(backup.tables[name]) || backup.tables[name].some((row) => !row || row.site_id !== site)) throw new Error(`Invalid backup rows: ${name}`);
	const ids = backup.tables.entities.filter((row) => row.kind === "post").map((row) => String(row.id));
	if (new Set(ids).size !== ids.length) throw new Error("Backup post stable IDs are duplicated");
	const mediaIds = new Set(backup.mediaManifest.map((row) => String(row.id)));
	if (mediaIds.size !== backup.mediaManifest.length || backup.tables.entities.filter((row) => row.kind === "media").some((row) => !mediaIds.has(String(row.id)))) throw new Error("Backup media manifest does not match stable IDs");
	for (const row of backup.tables.entities) for (const match of JSON.stringify(row.data).matchAll(/(?:media:([a-zA-Z0-9-]+)|\/api\/media\/([a-zA-Z0-9-]+)\/content)/g)) if (!mediaIds.has(match[1] || match[2])) throw new Error("Backup contains a missing media reference");
}
async function loadBackup(backupId: string, db: Database, site: string, blob: BackupBlobProvider): Promise<Backup> {
	const [record] = await db.query<Row>("SELECT * FROM maintenance_backups WHERE site_id=$1 AND id=$2 AND state='verified'", [site, backupId]);
	if (!record?.pathname || !record.sha256) throw new ApiFailure(404, "BACKUP_NOT_FOUND", "找不到已验证的私有备份");
	const bytes = await blob.get(String(record.pathname));
	if (!bytes || !constantTimeEqual(hash(bytes), String(record.sha256))) throw new Error("Backup checksum mismatch");
	const backup = JSON.parse(bytes.toString()) as Backup; validateBackup(backup, site);
	if (backup.id !== backupId) throw new Error("Backup ID does not match its verified record");
	for (const media of backup.mediaManifest) {
		if (typeof media.pathname !== "string" || typeof media.digest !== "string") throw new Error("Media manifest is incomplete");
		const bytes = await blob.get(media.pathname);
		if (!bytes || hash(bytes) !== media.digest) throw new Error("Backup media integrity verification failed");
	}
	return backup;
}
async function restoreInto(tx: Database, backup: Backup, site: string, temporary = false): Promise<void> {
	const tables = temporary ? backupTables : restoreTables;
	for (const name of [...tables].reverse()) await tx.query(`DELETE FROM ${temporary ? `restore_${name}` : name} WHERE site_id=$1`, [site]);
	for (const name of tables) {
		const rows = backup.tables[name]; if (!rows.length) continue;
		await tx.query(`INSERT INTO ${temporary ? `restore_${name}` : name} SELECT * FROM jsonb_populate_recordset(NULL::${name},$1::jsonb)`, [JSON.stringify(rows)]);
	}
}
async function heartbeat(db: Database, site: string, lease: Lease): Promise<void> {
	const rows = await db.query("UPDATE maintenance_locks SET lease_until=clock_timestamp()+($5::int*interval '1 second') WHERE site_id=$1 AND task_id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp() RETURNING site_id", [site, lease.id, lease.owner, lease.fence, LEASE_SECONDS]);
	if (!rows.length) throw new LeaseLost("Maintenance lease was superseded");
}
export async function claimMaintenanceTask(db: Database, site: string, id: string): Promise<Lease | null> {
	return db.transaction(async (tx) => {
		await tx.query("INSERT INTO maintenance_locks(site_id) VALUES($1) ON CONFLICT DO NOTHING", [site]);
		const [lock] = await tx.query<Row>("SELECT *,lease_until>clock_timestamp() AS leased FROM maintenance_locks WHERE site_id=$1 FOR UPDATE", [site]);
		if (lock.owner_id && lock.leased === true) return null;
		const [task] = await tx.query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2 FOR UPDATE", [site, id]);
		if (!task || !["backup", "restore", "daily"].includes(String(task.kind)) || terminal.has(String(task.state))) return null;
		const owner = randomUUID();
		const [claimed] = await tx.query<Row>("UPDATE maintenance_locks SET task_id=$2,owner_id=$3,kind=$4,fencing_token=fencing_token+1,lease_until=clock_timestamp()+($5::int*interval '1 second') WHERE site_id=$1 RETURNING fencing_token", [site, id, owner, task.kind, LEASE_SECONDS]);
		const fence = Number(claimed.fencing_token);
		await tx.query("UPDATE release_tasks SET state='running',fence=$3,updated_at=now() WHERE site_id=$1 AND id=$2", [site, id, fence]);
		return { id, owner, fence };
	});
}
async function releaseMaintenanceLease(db: Database, site: string, lease: Lease): Promise<void> {
	await db.query("UPDATE maintenance_locks SET owner_id=NULL,lease_until=now() WHERE site_id=$1 AND task_id=$2 AND owner_id=$3 AND fencing_token=$4", [site, lease.id, lease.owner, lease.fence]);
}
export async function restoreBackup(backupId: string, taskId: string, dependencies: MaintenanceDependencies = {}, suppliedLease?: Lease): Promise<void> {
	if (!dependencies.skipCapabilityCheck) assertMaintenance();
	const db = dependencies.db || getDatabase(); const site = dependencies.site || getSiteId(); const blob = dependencies.blob || privateBackupBlob;
	const validationUrl = dependencies.restoreDatabaseUrl || process.env.RESTORE_DATABASE_URL;
	const liveUrl = dependencies.liveDatabaseUrl || process.env.ADMIN_PRODUCTION_DATABASE_URL || process.env.DATABASE_URL;
	// Different hosts may still alias the same cluster: require a different database
	// name, and compare the server/database identity before restoring any rows.
	if (!validationUrl || !liveUrl || new URL(validationUrl).pathname === new URL(liveUrl).pathname) throw new ApiFailure(503, "ISOLATED_RESTORE_DATABASE_REQUIRED", "恢复须配置独立并已迁移的 RESTORE_DATABASE_URL，不能使用生产数据库");
	const lease = suppliedLease || await claimMaintenanceTask(db, site, taskId); if (!lease) throw busy();
	try {
		await heartbeat(db, site, lease);
		const backup = await loadBackup(backupId, db, site, blob);
		const isolation = (dependencies.createIsolation || createDatabase)(validationUrl);
		try {
			const identity = "SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port";
			const [liveIdentity] = await db.query<Row>(identity); const [restoreIdentity] = await isolation.query<Row>(identity);
			if (JSON.stringify(liveIdentity) === JSON.stringify(restoreIdentity)) throw new ApiFailure(503, "ISOLATED_RESTORE_DATABASE_REQUIRED", "恢复验证库与生产库实际连接相同");
			await isolation.transaction(async (tx) => {
				for (const name of backupTables) await tx.query(`CREATE TEMP TABLE restore_${name} (LIKE ${name} INCLUDING ALL) ON COMMIT DROP`);
				await tx.query("ALTER TABLE restore_comments ADD FOREIGN KEY(site_id,parent_id) REFERENCES restore_comments(site_id,id) DEFERRABLE INITIALLY DEFERRED");
				await restoreInto(tx, backup, site, true);
				for (const name of backupTables) {
					const [count] = await tx.query<Row>(`SELECT count(*)::int AS count FROM restore_${name} WHERE site_id=$1`, [site]);
					if (Number(count.count) !== backup.tables[name].length) throw new Error(`Isolated restore count mismatch: ${name}`);
				}
			});
		} finally { await isolation.close(); }
		await heartbeat(db, site, lease);
		for (const row of backup.tables.mail_outbox) if (row.status !== "sent") { row.status = "blocked"; row.claimed_at = null; row.last_error = "restored: reconcile provider result before sending"; }
		for (const row of backup.tables.release_tasks) {
			row.details = { ...(row.details as Row), restored: true, ...(!terminal.has(String(row.state)) ? { restoreRequiresReconciliation: true, restorePreviousState: row.state } : {}) };
			if (!terminal.has(String(row.state))) { row.state = "blocked"; row.workflow_id = null; row.fence = null; }
		}
		await db.transaction(async (tx) => {
			// Acquire in this order everywhere: write gate, then row locks. The DB
			// trigger also protects public comments, mail workers and direct DB writes.
			await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${site}:production-write`]);
			await restoreWrite(tx, site);
			const [owned] = await tx.query<Row>("SELECT site_id FROM maintenance_locks WHERE site_id=$1 AND task_id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp() FOR UPDATE", [site, lease.id, lease.owner, lease.fence]);
			if (!owned) throw new LeaseLost("Maintenance lease was superseded");
			await tx.query("INSERT INTO release_locks(site_id) VALUES($1) ON CONFLICT DO NOTHING", [site]);
			await tx.query("SELECT site_id FROM release_locks WHERE site_id=$1 FOR UPDATE", [site]);
			const active = await tx.query<Row>("SELECT id FROM release_tasks WHERE site_id=$1 AND kind='publish' AND state NOT IN ('verified','failed','conflict','blocked')", [site]);
			if (active.length) throw new ApiFailure(409, "RESTORE_RECONCILIATION_REQUIRED", "有结果未明确的发布，先完成 Git/生产核验再恢复");
			const currentMail = await tx.query<Row>("SELECT * FROM mail_outbox WHERE site_id=$1", [site]);
			if (currentMail.some((row) => row.status === "sending")) throw new ApiFailure(409, "RESTORE_MAIL_RECONCILIATION_REQUIRED", "有正在发送的邮件，先核验服务商结果再恢复");
			// Delivery receipts are irreversible external facts. Preserve post-backup
			// receipts and unknown provider IDs instead of rewinding the mail ledger.
			for (const current of currentMail) {
				const restored = backup.tables.mail_outbox.find((row) => row.id === current.id);
				if (restored && (restored.notification_key !== current.notification_key || restored.recipient !== current.recipient)) throw new Error("Restored mail identity does not match the live ledger");
				if (restored && current.status === "sent") Object.assign(restored, current);
				else if (!restored) backup.tables.mail_outbox.push({ ...current, ...(current.status === "sent" ? {} : { status: "blocked", claimed_at: null, last_error: "restored: reconcile provider result before sending" }) });
				else if (current.provider_id && !restored.provider_id) restored.provider_id = current.provider_id;
			}
			// A separate transaction durably records the safety backup while this
			// transaction's write gate prevents changes to the captured live rows.
			await createBackup(`before-restore-${taskId}`, db, site, { blob, restoreOwner: true });
			const preservedTasks = await tx.query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND kind<>'publish'", [site]);
			await restoreInto(tx, backup, site);
			await tx.query("DELETE FROM sessions WHERE site_id=$1", [site]); await tx.query("DELETE FROM oauth_states WHERE site_id=$1", [site]);
			if (preservedTasks.length) await tx.query("INSERT INTO release_tasks SELECT * FROM jsonb_populate_recordset(NULL::release_tasks,$1::jsonb) ON CONFLICT(site_id,id) DO UPDATE SET state=EXCLUDED.state,fence=EXCLUDED.fence,workflow_id=EXCLUDED.workflow_id,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at", [JSON.stringify(preservedTasks)]);
			await tx.query("UPDATE release_locks SET task_id=NULL,lease_until=now(),fencing_token=fencing_token+1 WHERE site_id=$1", [site]);
			await heartbeat(tx, site, lease);
		});
	} finally { if (!suppliedLease) await releaseMaintenanceLease(db, site, lease); }
}
export async function createMaintenanceTask(kind: "backup" | "restore" | "daily", details: Row = {}, idempotencyKey = `${kind}:${randomUUID()}`): Promise<Row> {
	const db = getDatabase(); const site = getSiteId(); const id = randomUUID();
	const [task] = await db.query<Row>("INSERT INTO release_tasks(site_id,id,kind,idempotency_key,state,details) VALUES($1,$2,$3,$4,'queued',$5::jsonb) ON CONFLICT(site_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *", [site, id, kind, idempotencyKey, JSON.stringify(details)]);
	if (terminal.has(String(task.state))) return task;
	const dispatch = `dispatching:${randomUUID()}`;
	const scheduled = await db.query("UPDATE release_tasks SET workflow_id=$3,updated_at=now() WHERE site_id=$1 AND id=$2 AND (workflow_id IS NULL OR workflow_id LIKE 'dispatching:%' AND updated_at<now()-interval '5 minutes') RETURNING id", [site, task.id, dispatch]);
	if (!scheduled.length) return task;
	try { const run = await start(maintenanceWorkflow, [String(task.id)]); await db.query("UPDATE release_tasks SET workflow_id=$4 WHERE site_id=$1 AND id=$2 AND workflow_id=$3", [site, task.id, dispatch, run.runId]); }
	catch { await db.query("UPDATE release_tasks SET workflow_id=NULL WHERE site_id=$1 AND id=$2 AND workflow_id=$3", [site, task.id, dispatch]); }
	return task;
}
export async function processMaintenanceTask(id: string, dependencies: MaintenanceDependencies = {}): Promise<{ done: boolean; state: string }> {
	if (!dependencies.skipCapabilityCheck) assertMaintenance();
	const db = dependencies.db || getDatabase(); const site = dependencies.site || getSiteId();
	const [task] = await db.query<Row>("SELECT * FROM release_tasks WHERE site_id=$1 AND id=$2", [site, id]);
	if (!task) throw new ApiFailure(404, "TASK_NOT_FOUND", "维护任务不存在");
	if (!["backup", "restore", "daily"].includes(String(task.kind))) throw new ApiFailure(400, "INVALID_MAINTENANCE_TASK", "此任务不是维护任务");
	if (terminal.has(String(task.state))) return { done: true, state: String(task.state) };
	const lease = await claimMaintenanceTask(db, site, id); if (!lease) return { done: false, state: "queued" };
	try {
		await heartbeat(db, site, lease);
		if (task.kind === "backup" || task.kind === "daily") await createBackup(id, db, site, { blob: dependencies.blob });
		if (task.kind === "restore") await restoreBackup(String((task.details as Row).backupId), id, dependencies, lease);
		if (task.kind === "daily") {
			if (process.env.ENABLE_PRODUCTION_PUBLISH === "true") {
				const tasks = await db.query<Row>("SELECT id FROM release_tasks WHERE site_id=$1 AND kind='publish' AND state NOT IN ('verified','failed','conflict','blocked') AND NOT COALESCE((details->>'restoreRequiresReconciliation')::boolean,false) ORDER BY created_at", [site]);
				for (const pending of tasks) { await heartbeat(db, site, lease); await (dependencies.processPublish || processReleaseTask)(String(pending.id)); }
			}
			if (process.env.ENABLE_PRODUCTION_EMAIL === "true") {
				await heartbeat(db, site, lease);
				const deliver = dependencies.deliverMail || (await import("./mail.js")).deliverMailBatch; await deliver();
			}
		}
		const rows = await db.query("UPDATE release_tasks SET state='verified',message='维护及完整性核验已完成',updated_at=now() WHERE site_id=$1 AND id=$2 AND fence=$4 AND EXISTS(SELECT 1 FROM maintenance_locks WHERE site_id=$1 AND task_id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp()) RETURNING id", [site, id, lease.owner, lease.fence]);
		return { done: rows.length === 1, state: rows.length ? "verified" : "queued" };
	} catch (error) {
		if (error instanceof LeaseLost || error instanceof ApiFailure && error.code === "MAINTENANCE_BUSY") return { done: false, state: "queued" };
		const rows = await db.query("UPDATE release_tasks SET state='failed',message=$5,updated_at=now() WHERE site_id=$1 AND id=$2 AND fence=$4 AND EXISTS(SELECT 1 FROM maintenance_locks WHERE site_id=$1 AND task_id=$2 AND owner_id=$3 AND fencing_token=$4 AND lease_until>clock_timestamp()) RETURNING id", [site, id, lease.owner, lease.fence, error instanceof ApiFailure ? error.message : "维护未完成，请检查私有存储、隔离恢复库及任务状态后重试"]);
		return { done: rows.length === 1, state: rows.length ? "failed" : "queued" };
	} finally { await releaseMaintenanceLease(db, site, lease); }
}
export function registerMaintenanceRoutes(app: AdminApp): void {
	app.post("/api/maintenance/backup", requireAdmin, async (c) => { assertMaintenance(); return c.json({ data: taskRecord(await createMaintenanceTask("backup")) }, 202); });
	app.get("/api/maintenance/backups", requireAdmin, async (c) => {
		const rows = await getDatabase().query<Row>("SELECT id,state,sha256,data,created_at FROM maintenance_backups WHERE site_id=$1 ORDER BY created_at DESC LIMIT 100", [getSiteId()]);
		return c.json({ data: rows.map((row) => ({ id: row.id, state: row.state, sha256: row.sha256, createdAt: row.created_at, ...(row.data as Row) })) });
	});
	app.post("/api/maintenance/restore", requireAdmin, async (c) => {
		assertMaintenance(); const result = z.object({ backupId: z.string().min(1), confirm: z.literal(true) }).safeParse(await readJson(c.req.raw));
		if (!result.success) throw new ApiFailure(400, "RESTORE_CONFIRMATION_REQUIRED", "提供 backupId 和 confirm:true；恢复会清除当前登录会话");
		return c.json({ data: taskRecord(await createMaintenanceTask("restore", { backupId: result.data.backupId })) }, 202);
	});
	app.post("/api/maintenance/check", requireAdmin, async (c) => {
		const counts = await getDatabase().query<Row>("SELECT state,count(*)::int AS count FROM release_tasks WHERE site_id=$1 GROUP BY state", [getSiteId()]);
		return c.json({ data: { environment: productionEnvironment() ? "production" : "isolated", tasks: counts, ...await checkUpdates(), note: "更新前必须先创建私有备份；代码升级通过独立审核的 Git 改动执行" } });
	});
	app.get("/api/maintenance/cron", async (c) => {
		assertMaintenance(); const secret = process.env.CRON_SECRET;
		if (!secret || !constantTimeEqual(c.req.header("Authorization") || "", `Bearer ${secret}`)) throw new ApiFailure(401, "CRON_AUTH_REQUIRED", "Cron 鉴权失败");
		const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
		const task = await createMaintenanceTask("daily", { dateKey }, `daily:${dateKey}`);
		await getDatabase().query("INSERT INTO maintenance_outbox(site_id,date_key,task_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [getSiteId(), dateKey, task.id]);
		return c.json({ data: taskRecord(task) }, 202);
	});
}
