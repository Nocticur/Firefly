import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../server/db.js";
import { getPost, savePost } from "../server/content.js";
import { importRepository, synchronizeRepository, compareRepositoryFiles } from "../server/repository.js";
import { ApiFailure, digest } from "../server/security.js";

const firstSha = "a".repeat(40); const nextSha = "b".repeat(40);
const source = "---\ntitle: Original\npublished: 2026-09-10\ndraft: false\n---\nPublic bytes\n";
function repository(id: string) {
	const post = { id, filePath: "src/content/posts/original.md", slug: "original", sourceSha256: digest(source) };
	const publishedState = { schemaVersion: 1, posts: [post], taskId: null, snapshotId: null, publicContentDigest: null };
	return { headSha: firstSha, publishedState, files: [
		{ path: post.filePath, source },
		{ path: "src/data/published-state.json", source: JSON.stringify(publishedState) },
		{ path: "src/data/managed-settings.json", source: JSON.stringify({ schemaVersion: 1, settings: { title: "Original" }, navigation: { links: [] }, icons: {}, friends: [] }) },
		{ path: "src/data/redirects.json", source: "[]" },
		{ path: "src/config/siteConfig.ts", source: "export const original = true;\n" },
		{ path: "vercel.json", source: JSON.stringify({ headers: [], redirects: [] }) },
	] };
}

test("managed file comparison detects additions, removals and exact byte changes", () => {
	const differences = compareRepositoryFiles([{ path: "kept", source: "same" }, { path: "deleted", source: "old" }, { path: "changed", source: "CRLF\r\n" }], [{ path: "kept", source: "same" }, { path: "added", source: "new" }, { path: "changed", source: "CRLF\n" }]);
	assert.deepEqual(differences.map((item) => item.path), ["added", "changed", "deleted"]);
	assert.equal(differences[0].expectedSource, null); assert.equal(differences[2].remoteSource, null);
	assert.notEqual(differences[1].expectedSha256, differences[1].remoteSha256);
});

test("PostgreSQL baseline synchronization preserves drafts and rejects changed managed bytes", { skip: !process.env.ADMIN_TEST_DATABASE_URL }, async (t) => {
	const db = createDatabase(process.env.ADMIN_TEST_DATABASE_URL!); const sites: string[] = [];
	const setup = async () => {
		const site = `tests/repository-sync-${randomUUID()}:development`; sites.push(site); const id = randomUUID(); const original = repository(id);
		await importRepository(db, site, async () => original);
		await savePost(db, site, id, source.replace("Public bytes", "Private editing after import"), 1);
		return { site, id, original };
	};
	try {
		for (const file of ["001-core.sql", "002-release.sql", "003-interactions.sql", "004-maintenance-guards.sql"]) await db.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
		await t.test("code-only commits advance SHA without touching any draft or history", async () => {
			const { site, id, original } = await setup(); const before = await getPost(db, site, id);
			const history = await db.query("SELECT id,data FROM entities WHERE site_id=$1 AND kind='post_version' ORDER BY id", [site]);
			const result = await synchronizeRepository(db, site, firstSha, async () => ({ ...original, headSha: nextSha }));
			assert.equal(result.headSha, nextSha); assert.deepEqual(await getPost(db, site, id), before);
			assert.deepEqual(await db.query("SELECT id,data FROM entities WHERE site_id=$1 AND kind='post_version' ORDER BY id", [site]), history);
			await assert.rejects(() => synchronizeRepository(db, site, firstSha, async () => original), (error: unknown) => error instanceof ApiFailure && error.code === "BASELINE_REVISION_CONFLICT");
		});
		await t.test("changed public source, config, additions and deletions expose differences and do not advance", async () => {
			const { site, id, original } = await setup(); const before = await getPost(db, site, id);
			const remote = { ...original, headSha: nextSha, files: original.files.filter((file) => file.path !== "vercel.json").map((file) => file.path === "src/content/posts/original.md" ? { ...file, source: source + "External content\n" } : file.path === "src/config/siteConfig.ts" ? { ...file, source: "export const changed = true;\n" } : file).concat({ path: "src/content/posts/external.md", source }) };
			await assert.rejects(() => synchronizeRepository(db, site, firstSha, async () => remote), (error: unknown) => {
				assert.ok(error instanceof ApiFailure); assert.equal(error.code, "MANAGED_REPOSITORY_CONFLICT");
				const details = error.details as { diff: Array<{ path: string }> };
				assert.deepEqual(details.diff.map((file) => file.path), ["src/config/siteConfig.ts", "src/content/posts/external.md", "src/content/posts/original.md", "vercel.json"]); return true;
			});
			const [baseline] = await db.query<{ data: { headSha: string } }>("SELECT data FROM entities WHERE site_id=$1 AND kind='repository'", [site]);
			assert.equal(baseline.data.headSha, firstSha); assert.deepEqual(await getPost(db, site, id), before);
		});
		await t.test("older baselines read the recorded immutable SHA and reject mismatching evidence", async () => {
			const { site, original } = await setup(); await db.query("UPDATE entities SET data=data - 'repositoryFiles' WHERE site_id=$1 AND kind='repository'", [site]);
			const reads: Array<string | undefined> = [];
			await synchronizeRepository(db, site, firstSha, async (sha) => { reads.push(sha); return sha === firstSha ? original : { ...original, headSha: nextSha }; });
			assert.deepEqual(reads, [undefined, firstSha]);
			await db.query("UPDATE entities SET data=(data - 'repositoryFiles') || $2::jsonb WHERE site_id=$1 AND kind='repository'", [site, JSON.stringify({ headSha: firstSha })]);
			await assert.rejects(() => synchronizeRepository(db, site, firstSha, async () => ({ ...original, headSha: nextSha })), (error: unknown) => error instanceof ApiFailure && error.code === "BASELINE_EVIDENCE_INVALID");
		});
		await t.test("a live or restored publish blocks SHA synchronization", async () => {
			const { site, original } = await setup(); const id = randomUUID();
			await db.query("INSERT INTO release_tasks(site_id,id,idempotency_key,state) VALUES($1,$2,$2,'unknown')", [site, id]);
			await assert.rejects(() => synchronizeRepository(db, site, firstSha, async () => ({ ...original, headSha: nextSha })), (error: unknown) => error instanceof ApiFailure && error.code === "PUBLISH_RECONCILIATION_REQUIRED");
			await db.query("UPDATE release_tasks SET state='failed',details=$3::jsonb WHERE site_id=$1 AND id=$2", [site, id, JSON.stringify({ restoreRequiresReconciliation: true })]);
			await assert.rejects(() => synchronizeRepository(db, site, firstSha, async () => ({ ...original, headSha: nextSha })), (error: unknown) => error instanceof ApiFailure && error.code === "PUBLISH_RECONCILIATION_REQUIRED");
		});
	} finally {
		for (const site of sites) for (const table of ["entities", "release_tasks", "release_locks"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [site]);
		await db.close();
	}
});
