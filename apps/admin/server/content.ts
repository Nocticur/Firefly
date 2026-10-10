import { randomUUID } from "node:crypto";
import type { PostRecord } from "../shared/contracts.js";
import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, expectedRevision, readJson } from "./security.js";
import { patchMetadata, validatePostSource } from "./source-document.js";
import { importRepository } from "./repository.js";

type PostRow = Record<string, unknown> & { id: string; data: PostRecord; revision: string | number; updated_at: Date | string };
export type PostVersion = { id: string; postId: string; source: string; revision: number; createdAt: string; reason: string };
function postFromRow(row: PostRow): PostRecord { return { ...row.data, id: row.id, revision: Number(row.revision), updatedAt: new Date(row.updated_at).toISOString() }; }
export function normalizeSlug(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 240 || /[:*+?(){}\[\]\\%\u0000-\u0020#]/.test(value) || value.startsWith("/") || value.endsWith("/") || value.split("/").some((part) => part === "." || part === ".." || !part)) throw new ApiFailure(422, "SLUG_INVALID", "必须填写固定、无首尾斜杠的 slug；支持中文与分级路径，不接受路由通配符或百分号编码");
	return value;
}
export async function getPost(database: Database, siteId: string, id: string, lock = false): Promise<PostRecord> {
	const [row] = await database.query<PostRow>(`SELECT id,data,revision,updated_at FROM entities WHERE site_id=$1 AND kind='post' AND id=$2${lock ? " FOR UPDATE" : ""}`, [siteId, id]);
	if (!row) throw new ApiFailure(404, "POST_NOT_FOUND", "文章不存在");
	return postFromRow(row);
}
async function appendHistory(database: Database, siteId: string, post: PostRecord, reason: string): Promise<void> {
	const id = randomUUID();
	const version: PostVersion = { id, postId: post.id, source: post.source, revision: post.revision, createdAt: new Date().toISOString(), reason };
	await database.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'post_version',$2,$3::jsonb)", [siteId, id, JSON.stringify(version)]);
}
export async function savePost(database: Database, siteId: string, id: string, source: string, expected: number, reason = "save"): Promise<PostRecord> {
	const metadata = validatePostSource(source);
	return database.transaction(async (tx) => {
		const current = await getPost(tx, siteId, id, true);
		if (current.revision !== expected) throw new ApiFailure(409, "REVISION_CONFLICT", "草稿已被另一次保存修改，请比较后重新保存", { currentRevision: current.revision, currentSource: current.source });
		if (source === current.source) return current;
		const slug = metadata.slug !== undefined ? normalizeSlug(metadata.slug) : current.slug;
		if (slug !== current.slug) {
			await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${siteId}:post-slugs`]);
			if ((await tx.query("SELECT id FROM entities WHERE site_id=$1 AND kind='post' AND data->>'slug'=$2 AND id<>$3", [siteId, slug, id])).length) throw new ApiFailure(409, "SLUG_EXISTS", "该网址已被另一篇文章使用");
		}
		await appendHistory(tx, siteId, current, reason);
		const updated: PostRecord = { ...current, slug, title: String(metadata.title), published: String(metadata.published), draft: metadata.draft === true, source, metadata, revision: current.revision + 1, updatedAt: new Date().toISOString() };
		await tx.query("UPDATE entities SET data=$3::jsonb,revision=revision+1,updated_at=now() WHERE site_id=$1 AND kind='post' AND id=$2", [siteId, id, JSON.stringify(updated)]);
		return updated;
	});
}
export async function createPost(database: Database, siteId: string, source: string, slugValue: unknown, format: "md" | "mdx" = "md"): Promise<PostRecord> {
	const slug = normalizeSlug(slugValue);
	const metadata = validatePostSource(source);
	if (metadata.slug !== undefined && metadata.slug !== slug) throw new ApiFailure(422, "SLUG_MISMATCH", "源码 slug 与固定网址不一致");
	const id = randomUUID();
	const record: PostRecord = { id, filePath: `src/content/posts/managed/${id}.${format}`, slug, title: String(metadata.title), published: String(metadata.published), draft: metadata.draft === true, format, source, metadata, revision: 1, publishedRevision: null, publishedSource: null, updatedAt: new Date().toISOString() };
	return database.transaction(async (tx) => {
		await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${siteId}:post-slugs`]);
		if ((await tx.query("SELECT id FROM entities WHERE site_id=$1 AND kind='post' AND data->>'slug'=$2", [siteId, slug])).length) throw new ApiFailure(409, "SLUG_EXISTS", "该固定网址已被另一篇文章使用");
		await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'post',$2,$3::jsonb)", [siteId, id, JSON.stringify(record)]);
		return record;
	});
}

export function registerContentRoutes(app: AdminApp) {
	app.get("/api/posts", requireAdmin, async (context) => {
		const rows = await getDatabase().query<PostRow>("SELECT id,data,revision,updated_at FROM entities WHERE site_id=$1 AND kind='post' ORDER BY updated_at DESC,id", [getSiteId()]);
		return context.json({ data: rows.map(postFromRow) });
	});
	app.post("/api/posts", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.source !== "string") throw new ApiFailure(422, "SOURCE_REQUIRED", "必须提供文章源码");
		if (body.format !== undefined && !["md", "mdx"].includes(String(body.format))) throw new ApiFailure(422, "FORMAT_INVALID", "format 必须是 md 或 mdx");
		const post = await createPost(getDatabase(), getSiteId(), body.source, body.slug, body.format === "mdx" ? "mdx" : "md");
		return context.json({ data: post }, 201);
	});
	app.get("/api/posts/:id", requireAdmin, async (context) => context.json({ data: await getPost(getDatabase(), getSiteId(), context.req.param("id")) }));
	app.put("/api/posts/:id", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.source !== "string") throw new ApiFailure(422, "SOURCE_REQUIRED", "必须提供文章源码");
		return context.json({ data: await savePost(getDatabase(), getSiteId(), context.req.param("id"), body.source, expectedRevision(body.expectedRevision)) });
	});
	app.patch("/api/posts/:id", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw new ApiFailure(422, "METADATA_REQUIRED", "必须提供 metadata 对象");
		const post = await getPost(getDatabase(), getSiteId(), context.req.param("id"));
		const source = patchMetadata(post.source, body.metadata as Record<string, unknown>);
		return context.json({ data: await savePost(getDatabase(), getSiteId(), post.id, source, expectedRevision(body.expectedRevision), "metadata") });
	});
	app.get("/api/posts/:id/history", requireAdmin, async (context) => {
		await getPost(getDatabase(), getSiteId(), context.req.param("id"));
		const versions = await getDatabase().query<Record<string, unknown> & { data: PostVersion }>("SELECT data FROM entities WHERE site_id=$1 AND kind='post_version' AND data->>'postId'=$2 ORDER BY (data->>'revision')::bigint DESC,created_at DESC", [getSiteId(), context.req.param("id")]);
		return context.json({ data: versions.map((row) => row.data) });
	});
	app.post("/api/posts/:id/restore", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.versionId !== "string") throw new ApiFailure(422, "VERSION_REQUIRED", "必须提供 versionId");
		const [version] = await getDatabase().query<Record<string, unknown> & { data: PostVersion }>("SELECT data FROM entities WHERE site_id=$1 AND kind='post_version' AND id=$2 AND data->>'postId'=$3", [getSiteId(), body.versionId, context.req.param("id")]);
		if (!version) throw new ApiFailure(404, "VERSION_NOT_FOUND", "历史版本不存在");
		return context.json({ data: await savePost(getDatabase(), getSiteId(), context.req.param("id"), version.data.source, expectedRevision(body.expectedRevision), `restore:${body.versionId}`) });
	});
	app.post("/api/import", requireAdmin, async (context) => context.json({ data: await importRepository(getDatabase(), getSiteId()) }));
}
