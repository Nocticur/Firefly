import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import { createDatabase, getDatabase, getSiteId, type Database } from "../server/db.js";
import { issueSession, registerAuthRoutes, csrfForSession } from "../server/auth.js";
import { createPost, savePost, getPost, registerContentRoutes, type PostVersion } from "../server/content.js";
import { importRepository } from "../server/repository.js";
import { saveManagedEntity } from "../server/settings.js";
import { digest, ApiFailure } from "../server/security.js";

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
const source = '---\n# original YAML comment\ntitle: "旧标题"\npublished: 2026-09-10\ndraft: false\nunknown: { keep: [1, 2] }\n---\n<div>literal HTML</div>\n\nbody\n';
const mdx = '---\ntitle: "MDX"\npublished: 2026-09-11\ndraft: true\n---\nimport Widget from "./Widget.astro";\n\n<Widget value={{ keep: "bytes" }} />\n';

test("real PostgreSQL protects revisions, history, sessions, isolation and initial import", { skip: !databaseUrl }, async (t) => {
	process.env.APP_ENV = "development";
	delete process.env.VERCEL_ENV;
	process.env.ADMIN_DEVELOPMENT_DATABASE_URL = databaseUrl;
	process.env.ADMIN_GITHUB_USER_ID = "285582250";
	process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
	process.env.GITHUB_REPOSITORY = `tests/core-${randomUUID()}`;
	const database = getDatabase();
	const siteId = getSiteId();
	const migration = await readFile(new URL("../migrations/001-core.sql", import.meta.url), "utf8");
	await database.query(migration);
	const cleanupSites = new Set([siteId]);
	try {
		await t.test("concurrent writes allow one revision and preserve losing draft evidence", async () => {
			const created = await createPost(database, siteId, source, "固定中文网址");
			assert.equal(created.publishedSource, null);
			assert.equal(created.publishedRevision, null);
			const results = await Promise.allSettled([
				savePost(database, siteId, created.id, source.replace("旧标题", "修改 A"), 1),
				savePost(database, siteId, created.id, source.replace("旧标题", "修改 B"), 1),
			]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
			assert.equal(rejected.reason.status, 409);
			assert.equal(rejected.reason.code, "REVISION_CONFLICT");
			const current = await getPost(database, siteId, created.id);
			assert.equal(current.revision, 2);
			assert.equal(current.slug, created.slug);
			assert.equal(current.filePath, created.filePath);
			const versions = await database.query<Record<string, unknown> & { data: PostVersion }>("SELECT data FROM entities WHERE site_id=$1 AND kind='post_version' AND data->>'postId'=$2", [siteId, created.id]);
			assert.equal(versions.length, 1);
			assert.equal(versions[0].data.source, source);
			// A new independent DB connection proves data is durable beyond an API instance.
			const reopened = createDatabase(databaseUrl!);
			try { assert.equal((await getPost(reopened, siteId, created.id)).source, current.source); } finally { await reopened.close(); }
		});

		const session = await issueSession(database, siteId, { id: process.env.ADMIN_GITHUB_USER_ID!, login: "Nocticur", name: "Nocticur", avatarUrl: "https://github.com/Nocticur.png" });
		const app = new Hono<AppEnv>();
		app.onError((error, context) => error instanceof ApiFailure ? error.getResponse() : context.json({ error: { code: "INTERNAL", message: "test error" } }, 500));
		registerAuthRoutes(app); registerContentRoutes(app);
		const cookie = `__Host-admin-session=${session.token}`;
		const writeHeaders = { cookie, Origin: "http://localhost:3000", "Content-Type": "application/json", "x-csrf-token": session.csrfToken };
		await t.test("authentication fails closed, binds numeric ID, checks origin/CSRF and returns recoverable CSRF", async () => {
			assert.equal((await app.request("http://localhost:3000/api/posts")).status, 401);
			const current = await app.request("http://localhost:3000/api/auth/session", { headers: { cookie } });
			assert.equal(current.status, 200);
			const body = await current.json();
			assert.equal(body.data.csrfToken, csrfForSession(session.token));
			assert.equal(body.data.productionPublish, false);
			assert.equal((await app.request("http://localhost:3000/api/posts", { method: "POST", headers: { cookie, Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify({ source, slug: "private" }) })).status, 403);
			assert.equal((await app.request("http://localhost:3000/api/posts", { method: "POST", headers: { ...writeHeaders, Origin: "https://evil.example" }, body: JSON.stringify({ source, slug: "private" }) })).status, 403);
			await assert.rejects(() => issueSession(database, siteId, { id: "1", login: "Nocticur", name: "impersonated", avatarUrl: "" }), (error: unknown) => error instanceof ApiFailure && error.status === 403);
			delete process.env.ADMIN_GITHUB_USER_ID;
			assert.equal((await app.request("http://localhost:3000/api/posts", { headers: { cookie } })).status, 503);
			process.env.ADMIN_GITHUB_USER_ID = "285582250";
			process.env.APP_ENV = "preview";
			process.env.ADMIN_PREVIEW_DATABASE_URL = databaseUrl;
			process.env.ADMIN_PREVIEW_ORIGIN = "https://preview.example";
			assert.equal((await app.request("http://localhost:3000/api/posts", { headers: { cookie } })).status, 401);
			process.env.APP_ENV = "development";
		});

		await t.test("history restore checks current revision and preserves the overwritten current draft", async () => {
			const post = await createPost(database, siteId, source, "history");
			const editedSource = source.replace("body", "unsaved-public draft");
			await savePost(database, siteId, post.id, editedSource, 1);
			const [version] = await database.query<Record<string, unknown> & { id: string }>("SELECT id FROM entities WHERE site_id=$1 AND kind='post_version' AND data->>'postId'=$2", [siteId, post.id]);
			const conflict = await app.request(`http://localhost:3000/api/posts/${post.id}/restore`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ versionId: version.id, expectedRevision: 1 }) });
			assert.equal(conflict.status, 409);
			assert.equal((await getPost(database, siteId, post.id)).source, editedSource);
			const restored = await app.request(`http://localhost:3000/api/posts/${post.id}/restore`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ versionId: version.id, expectedRevision: 2 }) });
			assert.equal(restored.status, 200);
			assert.equal((await getPost(database, siteId, post.id)).source, source);
			const versions = await database.query<Record<string, unknown> & { data: PostVersion }>("SELECT data FROM entities WHERE site_id=$1 AND kind='post_version' AND data->>'postId'=$2", [siteId, post.id]);
			assert.ok(versions.some((row) => row.data.source === editedSource));
			assert.equal((await getPost(database, siteId, post.id)).publishedSource, null);
		});

		await t.test("initial import is atomic, preserves stable IDs/raw source/draft baseline and never overwrites later editing", async () => {
			const importSite = `${siteId}-import`; cleanupSites.add(importSite);
			const stableId = randomUUID();
			const files = [
				{ path: "src/content/posts/legacy.md", source },
				{ path: "src/content/posts/example.mdx", source: mdx },
				{ path: "src/data/managed-settings.json", source: JSON.stringify({ schemaVersion: 1, settings: { title: "Nocticur", retained: { unmanaged: true } }, navigation: { links: [] }, icons: {} }) },
			];
			const reader = async () => ({ headSha: "a".repeat(40), files, publishedState: { posts: [{ id: stableId, filePath: files[0].path, slug: "旧文章", sourceSha256: digest(source) }] } });
			const imported = await importRepository(database, importSite, reader);
			assert.equal(imported.records, 2); assert.equal(imported.publicPosts, 1);
			const importedPost = await getPost(database, importSite, stableId);
			assert.equal(importedPost.source, source); assert.equal(importedPost.publishedSource, source); assert.equal(importedPost.slug, "旧文章");
			const [draft] = await database.query<Record<string, unknown> & { data: Record<string, unknown> }>("SELECT data FROM entities WHERE site_id=$1 AND kind='post' AND id<>$2", [importSite, stableId]);
			assert.equal(draft.data.source, mdx); assert.equal(draft.data.publishedSource, null);
			await savePost(database, importSite, stableId, source.replace("旧标题", "私稿改标题"), 1);
			assert.equal((await importRepository(database, importSite, reader)).imported, false);
			assert.equal((await getPost(database, importSite, stableId)).title, "私稿改标题");
			const settings = await saveManagedEntity(database, importSite, "settings", { title: "设置草稿" }, 1);
			assert.deepEqual(settings.data.retained, { unmanaged: true });
			await assert.rejects(() => saveManagedEntity(database, importSite, "settings", { title: "stale" }, 1), (error: unknown) => error instanceof ApiFailure && error.status === 409);
			const badSite = `${siteId}-bad`; cleanupSites.add(badSite);
			await assert.rejects(() => importRepository(database, badSite, async () => ({ ...await reader(), publishedState: { posts: [{ id: stableId, filePath: files[0].path, slug: "旧文章", sourceSha256: "invalid" }] } })), (error: unknown) => error instanceof ApiFailure && error.status === 409);
			assert.equal((await database.query("SELECT id FROM entities WHERE site_id=$1", [badSite])).length, 0);
		});
	} finally {
		process.env.APP_ENV = "development";
		for (const site of cleanupSites) {
			await database.query("DELETE FROM entities WHERE site_id=$1", [site]);
			await database.query("DELETE FROM sessions WHERE site_id=$1", [site]);
			await database.query("DELETE FROM oauth_states WHERE site_id=$1", [site]);
		}
		await database.close();
	}
});
