import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase, type Database } from "../server/db.js";
import { ApiFailure } from "../server/security.js";
import { createBackup, processMaintenanceTask, type BackupBlobProvider, type MaintenanceDependencies } from "../server/maintenance.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const tables = ["entities", "sessions", "oauth_states", "comments", "visitor_bans", "friends", "media_upload_intents", "mail_outbox", "release_snapshots", "release_tasks", "release_locks", "maintenance_backups", "maintenance_outbox", "maintenance_locks", "maintenance_backup_claims", "interaction_rate_limits"];
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
class MemoryBlob implements BackupBlobProvider {
	objects = new Map<string, Buffer>();
	puts: string[] = [];
	onPut?: (pathname: string, bytes: Buffer) => Promise<void>;
	async put(pathname: string, bytes: Buffer) {
		this.puts.push(pathname);
		if (this.objects.has(pathname)) throw new Error("Immutable object already exists");
		this.objects.set(pathname, Buffer.from(bytes));
		await this.onPut?.(pathname, bytes);
	}
	async get(pathname: string) { return this.objects.get(pathname) || null; }
}
async function migrate(db: Database) {
	for (const name of ["001-core.sql", "002-release.sql", "003-interactions.sql", "004-maintenance-guards.sql"]) await db.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}
async function task(db: Database, site: string, kind: string, state = "queued", details: Row = {}) {
	const id = randomUUID();
	await db.query("INSERT INTO release_tasks(site_id,id,kind,idempotency_key,state,details) VALUES($1,$2,$3,$2,$4,$5::jsonb)", [site, id, kind, state, JSON.stringify(details)]);
	return id;
}
async function post(db: Database, site: string, source: string, id = randomUUID()) {
	await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'post',$2,$3::jsonb)", [site, id, JSON.stringify({ source, draft: true })]);
	return id;
}

test("maintenance is fenced, idempotent and restores without replaying providers", { skip: !databaseUrl }, async (t) => {
	const db = createDatabase(databaseUrl!);
	const isolationName = `maintenance_restore_${randomUUID().replaceAll("-", "")}`;
	const isolationUrl = new URL(databaseUrl!); isolationUrl.pathname = `/${isolationName}`;
	const sites = new Set<string>();
	const site = () => { const value = `tests/maintenance-${randomUUID()}:production`; sites.add(value); return value; };
	const saved = { publish: process.env.ENABLE_PRODUCTION_PUBLISH, email: process.env.ENABLE_PRODUCTION_EMAIL };
	let createdIsolation = false;
	try {
		await migrate(db);
		await db.query(`CREATE DATABASE "${isolationName}"`); createdIsolation = true;
		const isolated = createDatabase(isolationUrl.toString());
		try { await migrate(isolated); } finally { await isolated.close(); }
		await t.test("parallel backup calls freeze one snapshot and create one immutable object", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const id = randomUUID();
			await post(db, currentSite, "private source");
			const entered = deferred(); const release = deferred();
			blob.onPut = async () => { entered.resolve(); await release.promise; };
			const first = createBackup(id, db, currentSite, { blob }); await entered.promise;
			try {
				await assert.rejects(createBackup(id, db, currentSite, { blob }), (error: unknown) => error instanceof ApiFailure && error.code === "MAINTENANCE_BUSY");
				assert.equal(blob.puts.length, 1);
			} finally { release.resolve(); }
			const verified = await first; assert.equal(verified.state, "verified");
			assert.equal((await createBackup(id, db, currentSite, { blob })).sha256, verified.sha256);
			assert.equal(blob.puts.length, 1);
		});
		await t.test("expired backup workers cannot overwrite a newer fence or refreeze changed content", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const id = randomUUID();
			const postId = await post(db, currentSite, "original bytes");
			const entered = deferred(); const release = deferred();
			blob.onPut = async () => { entered.resolve(); await release.promise; };
			const first = createBackup(id, db, currentSite, { blob });
			const settledFirst = first.then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
			await entered.promise;
			try {
				await db.query("UPDATE maintenance_backup_claims SET lease_until=now()-interval '1 second' WHERE site_id=$1 AND id=$2", [currentSite, id]);
				await db.query("UPDATE entities SET data=$3::jsonb WHERE site_id=$1 AND id=$2", [currentSite, postId, JSON.stringify({ source: "new live bytes", draft: true })]);
				const second = await createBackup(id, db, currentSite, { blob });
				assert.equal(second.state, "verified"); assert.equal(blob.puts.length, 1);
				const captured = JSON.parse(blob.objects.get(String(second.pathname))!.toString());
				assert.equal(captured.tables.entities[0].data.source, "original bytes");
			} finally { release.resolve(); }
			assert.ok((await settledFirst).error);
			assert.equal((await db.query<Row>("SELECT state FROM maintenance_backups WHERE site_id=$1 AND id=$2", [currentSite, id]))[0].state, "verified");
		});
		await t.test("same-size corrupt readbacks cannot be marked verified", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const id = randomUUID();
			blob.onPut = async (pathname, bytes) => { blob.objects.set(pathname, Buffer.alloc(bytes.length, 120)); };
			await assert.rejects(createBackup(id, db, currentSite, { blob }), /checksum/);
			assert.equal((await db.query<Row>("SELECT state FROM maintenance_backups WHERE site_id=$1 AND id=$2", [currentSite, id]))[0].state, "writing");
		});
		await t.test("parallel maintenance workers claim one task and cannot overwrite newer task status", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const id = await task(db, currentSite, "backup");
			const deps: MaintenanceDependencies = { db, site: currentSite, blob, skipCapabilityCheck: true };
			const entered = deferred(); const release = deferred();
			blob.onPut = async () => { entered.resolve(); await release.promise; };
			const first = processMaintenanceTask(id, deps); await entered.promise;
			try {
				assert.deepEqual(await processMaintenanceTask(id, deps), { done: false, state: "queued" });
				await db.query("UPDATE maintenance_locks SET lease_until=now()-interval '1 second' WHERE site_id=$1", [currentSite]);
				assert.deepEqual(await processMaintenanceTask(id, deps), { done: false, state: "queued" });
			} finally { release.resolve(); }
			assert.deepEqual(await first, { done: false, state: "queued" });
			assert.equal((await db.query<Row>("SELECT state FROM release_tasks WHERE site_id=$1 AND id=$2", [currentSite, id]))[0].state, "running");
			assert.deepEqual(await processMaintenanceTask(id, deps), { done: true, state: "verified" });
			assert.equal(blob.puts.length, 1);
		});
		await t.test("daily maintenance skips blocked restored publishes and disabled email", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const id = await task(db, currentSite, "daily");
			await task(db, currentSite, "publish", "blocked", { restoreRequiresReconciliation: true });
			await task(db, currentSite, "publish", "deploying", { restoreRequiresReconciliation: true });
			const normal = await task(db, currentSite, "publish", "unknown");
			process.env.ENABLE_PRODUCTION_PUBLISH = "true"; process.env.ENABLE_PRODUCTION_EMAIL = "false";
			const publishes: string[] = []; let mail = 0;
			const result = await processMaintenanceTask(id, { db, site: currentSite, blob, skipCapabilityCheck: true, processPublish: async (publishId) => { publishes.push(publishId); }, deliverMail: async () => { mail++; } });
			assert.deepEqual(result, { done: true, state: "verified" }); assert.deepEqual(publishes, [normal]); assert.equal(mail, 0);
		});
		await t.test("restore gates all live writes, retains safety backup and blocks old Git/mail/workflow replay", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const backupId = randomUUID();
			const postId = await post(db, currentSite, "original private draft");
			await db.query("INSERT INTO release_locks(site_id,fencing_token) VALUES($1,8)", [currentSite]);
			const frozen = await task(db, currentSite, "publish", "frozen");
			const unknown = await task(db, currentSite, "publish", "unknown");
			const deploying = await task(db, currentSite, "publish", "deploying");
			const oldDaily = await task(db, currentSite, "daily");
			await db.query("UPDATE release_tasks SET target_sha=$3 WHERE site_id=$1 AND id=$2", [currentSite, deploying, "a".repeat(40)]);
			for (const status of ["pending", "sending", "unknown", "failed", "sent"]) await db.query("INSERT INTO mail_outbox(site_id,id,notification_key,recipient,subject,text_body,status) VALUES($1,$2,$3,'test@example.invalid','test','private',$3)", [currentSite, randomUUID(), status]);
			await createBackup(backupId, db, currentSite, { blob });
			await db.query("UPDATE release_tasks SET state='verified' WHERE site_id=$1", [currentSite]);
			await db.query("UPDATE mail_outbox SET status='pending' WHERE site_id=$1 AND status='sending'", [currentSite]);
			await db.query("UPDATE mail_outbox SET status='sent',provider_id='delivered-after-backup' WHERE site_id=$1 AND notification_key='pending'", [currentSite]);
			await db.query("INSERT INTO mail_outbox(site_id,id,notification_key,recipient,subject,text_body,status,provider_id) VALUES($1,$2,'new-unknown','test@example.invalid','test','private','unknown','unknown-provider-id')", [currentSite, randomUUID()]);
			await db.query("UPDATE entities SET data=$3::jsonb WHERE site_id=$1 AND id=$2", [currentSite, postId, JSON.stringify({ source: "new live private draft", draft: true })]);
			await db.query("INSERT INTO sessions(site_id,token_hash,user_data,csrf_hash,expires_at) VALUES($1,'session','{}','csrf',now()+interval '1 day')", [currentSite]);
			await db.query("INSERT INTO oauth_states(site_id,state_hash,cookie_hash,expires_at) VALUES($1,'oauth','cookie',now()+interval '1 day')", [currentSite]);
			await db.query("INSERT INTO maintenance_outbox(site_id,date_key,task_id) VALUES($1,'new-day',$2)", [currentSite, oldDaily]);
			const restoreId = await task(db, currentSite, "restore", "queued", { backupId });
			const entered = deferred(); const release = deferred();
			blob.onPut = async (_pathname, bytes) => { if (JSON.parse(bytes.toString()).id === `before-restore-${restoreId}`) { entered.resolve(); await release.promise; } };
			let git = 0; let mail = 0;
			const dependencies: MaintenanceDependencies = { db, site: currentSite, blob, skipCapabilityCheck: true, liveDatabaseUrl: databaseUrl, restoreDatabaseUrl: isolationUrl.toString(), processPublish: async () => { git++; }, deliverMail: async () => { mail++; } };
			const restore = processMaintenanceTask(restoreId, dependencies);
			await Promise.race([entered.promise, restore.then((result) => { throw new Error(`Restore finished before reaching the write gate: ${JSON.stringify(result)}`); })]);
			try {
				for (const sql of ["UPDATE entities SET revision=revision+1 WHERE site_id=$1", "UPDATE mail_outbox SET status='pending' WHERE site_id=$1", "DELETE FROM sessions WHERE site_id=$1", "UPDATE release_tasks SET state='queued' WHERE site_id=$1"]) await assert.rejects(db.query(sql, [currentSite]), (error: unknown) => (error as { code: string }).code === "55P03");
				// Another site keeps its normal write permissions.
				await post(db, site(), "isolated site can write");
			} finally { release.resolve(); }
			assert.deepEqual(await restore, { done: true, state: "verified" }); assert.equal(git, 0); assert.equal(mail, 0);
			const [restoredPost] = await db.query<Row>("SELECT data FROM entities WHERE site_id=$1 AND id=$2", [currentSite, postId]);
			assert.equal((restoredPost.data as Row).source, "original private draft");
			for (const id of [frozen, unknown, deploying]) {
				const [row] = await db.query<Row>("SELECT state,details FROM release_tasks WHERE site_id=$1 AND id=$2", [currentSite, id]);
				assert.equal(row.state, "blocked"); assert.equal((row.details as Row).restoreRequiresReconciliation, true);
			}
			assert.equal((await db.query<Row>("SELECT target_sha FROM release_tasks WHERE site_id=$1 AND id=$2", [currentSite, deploying]))[0].target_sha, "a".repeat(40));
			assert.equal((await db.query<Row>("SELECT state FROM release_tasks WHERE site_id=$1 AND id=$2", [currentSite, oldDaily]))[0].state, "verified");
			const mailRows = await db.query<Row>("SELECT notification_key,status,provider_id FROM mail_outbox WHERE site_id=$1", [currentSite]);
			for (const row of mailRows) assert.equal(row.status, ["sent", "pending"].includes(String(row.notification_key)) ? "sent" : "blocked");
			assert.equal(mailRows.find((row) => row.notification_key === "pending")?.provider_id, "delivered-after-backup");
			assert.equal(mailRows.find((row) => row.notification_key === "new-unknown")?.provider_id, "unknown-provider-id");
			assert.equal((await db.query("SELECT token_hash FROM sessions WHERE site_id=$1", [currentSite])).length, 0);
			assert.equal((await db.query("SELECT state_hash FROM oauth_states WHERE site_id=$1", [currentSite])).length, 0);
			assert.equal((await db.query("SELECT id FROM maintenance_backups WHERE site_id=$1 AND state='verified'", [currentSite])).length, 2);
			assert.equal((await db.query("SELECT date_key FROM maintenance_outbox WHERE site_id=$1 AND date_key='new-day'", [currentSite])).length, 1);
			assert.ok(Number((await db.query<Row>("SELECT fencing_token FROM release_locks WHERE site_id=$1", [currentSite]))[0].fencing_token) > 8);
			assert.equal(blob.puts.length, 2);
		});
		await t.test("unknown current Git results block restore without calling Git, mail or safety backup", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const backupId = randomUUID();
			await post(db, currentSite, "backup draft"); await createBackup(backupId, db, currentSite, { blob });
			const unknown = await task(db, currentSite, "publish", "unknown");
			const restoreId = await task(db, currentSite, "restore", "queued", { backupId });
			let providerCalls = 0;
			const result = await processMaintenanceTask(restoreId, { db, site: currentSite, blob, skipCapabilityCheck: true, liveDatabaseUrl: databaseUrl, restoreDatabaseUrl: isolationUrl.toString(), processPublish: async () => { providerCalls++; }, deliverMail: async () => { providerCalls++; } });
			assert.deepEqual(result, { done: true, state: "failed" }); assert.equal(providerCalls, 0); assert.equal(blob.puts.length, 1);
			assert.equal((await db.query<Row>("SELECT state FROM release_tasks WHERE site_id=$1 AND id=$2", [currentSite, unknown]))[0].state, "unknown");
		});
		await t.test("in-flight current email prevents restoring over its delivery claim", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const backupId = randomUUID();
			await post(db, currentSite, "private"); await createBackup(backupId, db, currentSite, { blob });
			const mailId = randomUUID();
			await db.query("INSERT INTO mail_outbox(site_id,id,notification_key,recipient,subject,text_body,status) VALUES($1,$2,'in-flight','test@example.invalid','test','private','sending')", [currentSite, mailId]);
			const restoreId = await task(db, currentSite, "restore", "queued", { backupId });
			assert.deepEqual(await processMaintenanceTask(restoreId, { db, site: currentSite, blob, skipCapabilityCheck: true, liveDatabaseUrl: databaseUrl, restoreDatabaseUrl: isolationUrl.toString() }), { done: true, state: "failed" });
			assert.equal((await db.query<Row>("SELECT status FROM mail_outbox WHERE site_id=$1 AND id=$2", [currentSite, mailId]))[0].status, "sending");
			assert.equal(blob.puts.length, 1);
		});
		await t.test("missing or changed private media stops restore before touching live content", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const backupId = randomUUID(); const mediaId = randomUUID();
			const bytes = Buffer.from("private media bytes"); const pathname = `drafts/${randomUUID()}.png`;
			const postId = await post(db, currentSite, `original source media:${mediaId}`);
			await db.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'media',$2,$3::jsonb)", [currentSite, mediaId, JSON.stringify({ id: mediaId, pathname, digest: createHash("sha256").update(bytes).digest("hex") })]);
			blob.objects.set(pathname, bytes); await createBackup(backupId, db, currentSite, { blob });
			blob.objects.set(pathname, Buffer.from("changed private media bytes"));
			await db.query("UPDATE entities SET data=$3::jsonb WHERE site_id=$1 AND id=$2", [currentSite, postId, JSON.stringify({ source: "current private draft", draft: true })]);
			const restoreId = await task(db, currentSite, "restore", "queued", { backupId });
			assert.deepEqual(await processMaintenanceTask(restoreId, { db, site: currentSite, blob, skipCapabilityCheck: true, liveDatabaseUrl: databaseUrl, restoreDatabaseUrl: isolationUrl.toString() }), { done: true, state: "failed" });
			assert.equal(((await db.query<Row>("SELECT data FROM entities WHERE site_id=$1 AND id=$2", [currentSite, postId]))[0].data as Row).source, "current private draft");
			assert.equal(blob.puts.length, 1);
		});
		await t.test("aliased live database URLs are rejected before live changes", async () => {
			const currentSite = site(); const blob = new MemoryBlob(); const backupId = randomUUID();
			await post(db, currentSite, "private"); await createBackup(backupId, db, currentSite, { blob });
			const restoreId = await task(db, currentSite, "restore", "queued", { backupId });
			const alias = new URL(databaseUrl!); alias.hostname = "localhost";
			assert.deepEqual(await processMaintenanceTask(restoreId, { db, site: currentSite, blob, skipCapabilityCheck: true, liveDatabaseUrl: databaseUrl, restoreDatabaseUrl: alias.toString() }), { done: true, state: "failed" });
			assert.equal(blob.puts.length, 1);
		});
	} finally {
		for (const [name, value] of Object.entries({ ENABLE_PRODUCTION_PUBLISH: saved.publish, ENABLE_PRODUCTION_EMAIL: saved.email })) if (value === undefined) delete process.env[name]; else process.env[name] = value;
		for (const currentSite of sites) for (const table of [...tables].reverse()) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [currentSite]);
		if (createdIsolation) await db.query(`DROP DATABASE "${isolationName}" WITH (FORCE)`);
		await db.close();
	}
});
