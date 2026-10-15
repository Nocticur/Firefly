import { randomUUID } from "node:crypto";
import type { PostRecord } from "../shared/contracts.js";
import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import { assertSite, collection, getStore, getSiteId, type FileStore, type StoreState } from "./file-store.js";
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
function postInState(state: StoreState, siteId: string, id: string): PostRecord {
	assertSite(state, siteId);
	const row = collection(state, "entities")[`post:${id}`] as PostRow | undefined;
	if (!row) throw new ApiFailure(404, "POST_NOT_FOUND", "文章不存在");
	return postFromRow(row);
}
export async function getPost(store: FileStore, siteId: string, id: string): Promise<PostRecord> {
	return postInState(await store.read(), siteId, id);
}
function appendHistory(state: StoreState, post: PostRecord, reason: string): void {
	const id = randomUUID();
	const version: PostVersion = { id, postId: post.id, source: post.source, revision: post.revision, createdAt: new Date().toISOString(), reason };
	collection(state, "entities")[`post_version:${id}`] = { id, kind: "post_version", data: version, revision: 1, created_at: version.createdAt, updated_at: version.createdAt };
}
export async function savePost(store: FileStore, siteId: string, id: string, source: string, expected: number, reason = "save"): Promise<PostRecord> {
	const metadata = validatePostSource(source);
	return store.update((state) => {
		const current = postInState(state, siteId, id);
		if (current.revision !== expected) throw new ApiFailure(409, "REVISION_CONFLICT", "草稿已被另一次保存修改，请比较后重新保存", { currentRevision: current.revision, currentSource: current.source });
		if (source === current.source) return current;
		const slug = metadata.slug !== undefined ? normalizeSlug(metadata.slug) : current.slug;
		const entities = collection(state, "entities");
		if (Object.values(entities).some(row => row.kind === "post" && row.id !== id && (row.data as PostRecord).slug === slug)) throw new ApiFailure(409, "SLUG_EXISTS", "该网址已被另一篇文章使用");
		appendHistory(state, current, reason);
		const updated: PostRecord = { ...current, slug, title: String(metadata.title), published: String(metadata.published), draft: metadata.draft === true, source, metadata, revision: current.revision + 1, updatedAt: new Date().toISOString() };
		entities[`post:${id}`] = { ...entities[`post:${id}`], data: updated, revision: updated.revision, updated_at: updated.updatedAt };
		return updated;
	});
}
export async function createPost(store: FileStore, siteId: string, source: string, slugValue: unknown, format: "md" | "mdx" = "md"): Promise<PostRecord> {
	const slug = normalizeSlug(slugValue);
	const metadata = validatePostSource(source);
	if (metadata.slug !== undefined && metadata.slug !== slug) throw new ApiFailure(422, "SLUG_MISMATCH", "源码 slug 与固定网址不一致");
	const id = randomUUID();
	const record: PostRecord = { id, filePath: `src/content/posts/managed/${id}.${format}`, slug, title: String(metadata.title), published: String(metadata.published), draft: metadata.draft === true, format, source, metadata, revision: 1, publishedRevision: null, publishedSource: null, updatedAt: new Date().toISOString() };
	return store.update((state) => {
		assertSite(state, siteId);
		const entities = collection(state, "entities");
		if (Object.values(entities).some(row => row.kind === "post" && (row.data as PostRecord).slug === slug)) throw new ApiFailure(409, "SLUG_EXISTS", "该固定网址已被另一篇文章使用");
		entities[`post:${id}`] = { id, kind: "post", data: record, revision: 1, created_at: record.updatedAt, updated_at: record.updatedAt };
		return record;
	});
}

export async function listPostHistory(store: FileStore, siteId: string, id: string): Promise<PostVersion[]> {
	const state = await store.read();
	postInState(state, siteId, id);
	return Object.values(collection(state, "entities")).filter(row => row.kind === "post_version" && (row.data as PostVersion).postId === id).map(row => row.data as PostVersion).sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt));
}
export async function restorePostVersion(store: FileStore, siteId: string, id: string, versionId: string, expected: number): Promise<PostRecord> {
	const state = await store.read();
	assertSite(state, siteId);
	const version = collection(state, "entities")[`post_version:${versionId}`]?.data as PostVersion | undefined;
	if (!version || version.postId !== id) throw new ApiFailure(404, "VERSION_NOT_FOUND", "历史版本不存在");
	return savePost(store, siteId, id, version.source, expected, `restore:${versionId}`);
}

export function registerContentRoutes(app: AdminApp) {
	app.get("/api/posts", requireAdmin, async (context) => {
		const state = await getStore().read(); assertSite(state, getSiteId());
		const rows = Object.values(collection(state, "entities")).filter(row => row.kind === "post").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.id).localeCompare(String(b.id))) as PostRow[];
		return context.json({ data: rows.map(postFromRow) });
	});
	app.post("/api/posts", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.source !== "string") throw new ApiFailure(422, "SOURCE_REQUIRED", "必须提供文章源码");
		if (body.format !== undefined && !["md", "mdx"].includes(String(body.format))) throw new ApiFailure(422, "FORMAT_INVALID", "format 必须是 md 或 mdx");
		const post = await createPost(getStore(), getSiteId(), body.source, body.slug, body.format === "mdx" ? "mdx" : "md");
		return context.json({ data: post }, 201);
	});
	app.get("/api/posts/:id", requireAdmin, async (context) => context.json({ data: await getPost(getStore(), getSiteId(), context.req.param("id")) }));
	app.put("/api/posts/:id", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.source !== "string") throw new ApiFailure(422, "SOURCE_REQUIRED", "必须提供文章源码");
		return context.json({ data: await savePost(getStore(), getSiteId(), context.req.param("id"), body.source, expectedRevision(body.expectedRevision)) });
	});
	app.patch("/api/posts/:id", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) throw new ApiFailure(422, "METADATA_REQUIRED", "必须提供 metadata 对象");
		const post = await getPost(getStore(), getSiteId(), context.req.param("id"));
		const source = patchMetadata(post.source, body.metadata as Record<string, unknown>);
		return context.json({ data: await savePost(getStore(), getSiteId(), post.id, source, expectedRevision(body.expectedRevision), "metadata") });
	});
	app.get("/api/posts/:id/history", requireAdmin, async (context) => {
		return context.json({ data: await listPostHistory(getStore(), getSiteId(), context.req.param("id")) });
	});
	app.post("/api/posts/:id/restore", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw);
		if (typeof body.versionId !== "string") throw new ApiFailure(422, "VERSION_REQUIRED", "必须提供 versionId");
		return context.json({ data: await restorePostVersion(getStore(), getSiteId(), context.req.param("id"), body.versionId, expectedRevision(body.expectedRevision)) });
	});
	app.post("/api/import", requireAdmin, async (context) => context.json({ data: await importRepository(getStore(), getSiteId()) }));
}
