import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { get, head, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { authenticateRequest, requireAdmin } from "./auth.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, readJson, runtimeEnvironment } from "./security.js";
import type { AdminApp } from "./types.js";

export const MAX_MEDIA_SIZE = 32 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
type Media = Record<string, unknown> & { id: string; pathname: string; name: string; contentType: string; size: number; ownerId: string; alt: string; caption: string; digest: string; createdAt: string; deleted?: boolean; publishedUrl?: string };
type Intent = Record<string, unknown> & { id: string; owner_id: string; pathname: string; name: string; content_type: string; size: number; state: string; expires_at: Date };

export function blobToken(access: "private" | "public"): string {
	const environment = runtimeEnvironment();
	const key = environment === "production" ? `BLOB_${access.toUpperCase()}_READ_WRITE_TOKEN` : `ADMIN_${environment === "preview" ? "PREVIEW" : "DEV"}_${access.toUpperCase()}_BLOB_TOKEN`;
	const token = process.env[key];
	if (!token) throw new ApiFailure(503, "BLOB_CONFIGURATION_REQUIRED", `缺少隔离存储配置 ${key}`);
	const storeId = (value?: string) => value?.startsWith("vercel_blob_rw_") ? value.split("_")[3] : undefined;
	if (environment !== "production" && [process.env.BLOB_PRIVATE_READ_WRITE_TOKEN, process.env.BLOB_PUBLIC_READ_WRITE_TOKEN].some((production) => production === token || Boolean(storeId(token) && storeId(production) === storeId(token)))) throw new ApiFailure(503, "BLOB_ENVIRONMENT_NOT_ISOLATED", "开发及预览存储必须与生产隔离");
	const peerKey = key.replace(access.toUpperCase(), access === "private" ? "PUBLIC" : "PRIVATE");
	const peer = process.env[peerKey];
	if (peer === token || Boolean(storeId(token) && storeId(peer) === storeId(token))) throw new ApiFailure(503, "BLOB_STORES_NOT_SEPARATE", "私有与公开媒体必须使用不同存储");
	return token;
}

export function safeMediaType(bytes: Uint8Array): string {
	const b = Buffer.from(bytes);
	if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
	if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (b.subarray(0,4).toString() === "RIFF" && b.subarray(8,12).toString() === "WEBP") return "image/webp";
	if (b.subarray(4,8).toString() === "ftyp" && /avif|avis/.test(b.subarray(8,32).toString())) return "image/avif";
	if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b.readUInt16LE(4) > 0) return "image/x-icon";
	const svg = b.toString("utf8").replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^?]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
	if (/^\s*<svg[\s>]/.test(svg) && /<\/svg>\s*$/.test(svg)) {
		// Conservative static SVG subset: no active elements, external references, entities or CSS.
		if (/<!|<\?|&|\\|\b(?:on\w+|style|href|xlink:href)\s*=|url\s*\(/i.test(svg)) throw new ApiFailure(415, "UNSAFE_SVG", "SVG 必须为无脚本、CSS 与外部引用的静态图形");
		const allowed = new Set(["svg","g","path","rect","circle","ellipse","line","polyline","polygon","defs","linearGradient","radialGradient","stop","clipPath","mask","title","desc"]);
		for (const match of svg.matchAll(/<\/?([\w:-]+)\b/g)) if (!allowed.has(match[1]!)) throw new ApiFailure(415, "UNSAFE_SVG", "SVG 含不支持的元素");
		return "image/svg+xml";
	}
	throw new ApiFailure(415, "UNSUPPORTED_MEDIA", "文件内容不是支持的图片或图标");
}

export function publicMedia(record: Media) {
	return { id: record.id, pathname: record.pathname, name: record.name, contentType: record.contentType, size: record.size, access: "private", alt: record.alt, caption: record.caption, createdAt: record.createdAt, contentUrl: `/api/media/${record.id}/content`, ...(record.publishedUrl ? { publishedUrl: record.publishedUrl } : {}) };
}
async function mediaById(id: string): Promise<Media> {
	const rows = await getDatabase().query<{ data: Media }>("SELECT data FROM entities WHERE site_id=$1 AND kind='media' AND id=$2", [getSiteId(), id]);
	const media = rows[0]?.data;
	if (!media || media.deleted) throw new ApiFailure(404, "MEDIA_NOT_FOUND", "媒体不存在");
	return media;
}
async function readStream(stream: ReadableStream<Uint8Array>, limit = MAX_MEDIA_SIZE): Promise<Buffer> {
	const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过大小限制"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
	return Buffer.concat(chunks);
}
async function persistMedia(media: Media): Promise<void> {
	await getDatabase().query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'media',$2,$3::jsonb) ON CONFLICT(site_id,kind,id) DO NOTHING", [getSiteId(), media.id, JSON.stringify(media)]);
}

export function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a,b,c] = address.split(".").map(Number);
		return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && [0,2].includes(c!)) || (a === 192 && b === 88 && c === 99) || (a === 100 && b! >= 64 && b! <= 127) || (a === 198 && [18,19].includes(b!)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
	}
	if (isIP(address) === 6) {
		const [first, second = "0"] = address.toLowerCase().split(":");
		const prefix = Number.parseInt(first!, 16); const sub = Number.parseInt(second || "0", 16);
		return prefix >= 0x2000 && prefix <= 0x3fff && !(prefix === 0x2001 && (sub <= 0x1ff || sub === 0xdb8)) && prefix !== 0x2002 && !(prefix === 0x3fff && sub <= 0xfff);
	}
	return false;
}
export async function validateImportUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
	let url: URL; try { url = new URL(raw); } catch { throw new ApiFailure(400, "INVALID_MEDIA_URL", "媒体地址无效"); }
	const hosts = (process.env.MEDIA_IMPORT_HOSTS || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
	if (!hosts.length) throw new ApiFailure(503, "MEDIA_IMPORT_HOSTS_REQUIRED", "先配置外链导入允许的域名");
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || isIP(url.hostname) || !hosts.includes(url.hostname.toLowerCase())) throw new ApiFailure(400, "MEDIA_IMPORT_HOST_DENIED", "外链须使用允许域名的 HTTPS 地址");
	const addresses = await lookup(url.hostname, { all: true });
	if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new ApiFailure(400, "MEDIA_IMPORT_ADDRESS_DENIED", "媒体地址不能访问内网或保留地址");
	return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}
async function importBytes(raw: string): Promise<Buffer> {
	const target = await validateImportUrl(raw);
	return await new Promise<Buffer>((resolve, reject) => {
		const request = httpsRequest(target.url, { method: "GET", lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family), headers: { Accept: "image/*", "Accept-Encoding": "identity" }, timeout: 15000 }, (response) => {
			if (response.statusCode !== 200) { response.destroy(); reject(new ApiFailure(400, "MEDIA_IMPORT_FAILED", "外链必须直接返回图片，禁止跳转")); return; }
			if (Number(response.headers["content-length"] || 0) > MAX_MEDIA_SIZE) { response.destroy(); reject(new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过大小限制")); return; }
			const chunks: Buffer[] = []; let size = 0;
			response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_MEDIA_SIZE) { response.destroy(new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过大小限制")); } else chunks.push(chunk); });
			response.on("end", () => resolve(Buffer.concat(chunks))); response.on("error", reject);
		});
		request.on("timeout", () => request.destroy(new ApiFailure(504, "MEDIA_IMPORT_TIMEOUT", "媒体导入超时"))); request.on("error", reject); request.end();
	});
}

export type FrozenMedia = Record<string, unknown> & { id: string; pathname: string; digest: string; size: number; contentType: string; revision: number };
export type MediaPublicationOptions = { db?: Database; site?: string; frozenMedia?: Record<string, FrozenMedia>; blob?: { get: typeof get; head: typeof head; put: typeof put } };

export async function publishMediaForSnapshot(ids: string[], _taskId: string, options: MediaPublicationOptions = {}): Promise<Record<string, string>> {
	if (ids.length && !options.frozenMedia) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "发布必须使用已冻结的媒体清单");
	const db = options.db || getDatabase(); const site = options.site || getSiteId();
	const storage = options.blob || { get, head, put };
	const token = blobToken("public"); const privateToken = blobToken("private"); const urls: Record<string, string> = {};
	for (const id of [...new Set(ids)]) {
		let media = options.frozenMedia?.[id];
		if (!media || media.id !== id || typeof media.pathname !== "string" || !media.pathname || !Object.hasOwn(EXTENSIONS, media.contentType) || !/^[a-f0-9]{64}$/.test(media.digest) || !Number.isSafeInteger(media.size) || media.size < 1 || media.size > MAX_MEDIA_SIZE || !Number.isSafeInteger(media.revision) || media.revision < 1) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "冻结媒体记录不完整");
		// Read the frozen immutable pathname even if the current draft was edited or deleted.
		const source = await storage.get(media.pathname, { access: "private", token: privateToken, useCache: false });
		if (!source || source.statusCode !== 200) throw new ApiFailure(409, "MEDIA_MISSING", "待发布媒体不可读取");
		const bytes = await readStream(source.stream, media.size); const digest = createHash("sha256").update(bytes).digest("hex");
		const detected = safeMediaType(bytes);
		if (digest !== media.digest || bytes.length !== media.size || (detected !== media.contentType && !(detected === "image/x-icon" && media.contentType === "image/vnd.microsoft.icon"))) throw new ApiFailure(409, "MEDIA_CHANGED", "媒体内容与冻结记录不一致");
		const pathname = `published/${createHash("sha256").update(site).digest("hex").slice(0,16)}/${id}/${digest}.${EXTENSIONS[media.contentType]}`;
		const existing = async (): Promise<string | undefined> => {
			let metadata: Awaited<ReturnType<typeof head>>;
			try { metadata = await storage.head(pathname, { token }); } catch (error) { if ((error as Error).constructor.name === "BlobNotFoundError") return; throw error; }
			const result = await storage.get(pathname, { token, access: "public", useCache: false });
			if (!result || result.statusCode !== 200 || metadata.size !== media!.size || metadata.contentType !== media!.contentType) throw new ApiFailure(409, "PUBLISHED_MEDIA_CONFLICT", "已发布媒体校验不一致");
			const published = await readStream(result.stream, media!.size);
			if (published.length !== media!.size || createHash("sha256").update(published).digest("hex") !== digest) throw new ApiFailure(409, "PUBLISHED_MEDIA_CONFLICT", "已发布媒体校验不一致");
			return metadata.url;
		};
		let url = await existing();
		if (!url) {
			try { await storage.put(pathname, bytes, { access: "public", token, addRandomSuffix: false, allowOverwrite: false, contentType: media.contentType, cacheControlMaxAge: 31536000 }); }
			catch (error) { if (!(url = await existing())) throw error; }
			url ||= await existing();
			if (!url) throw new ApiFailure(409, "PUBLISHED_MEDIA_UNVERIFIED", "公开媒体尚未通过读取核验");
		}
		// Publication metadata may only update the matching draft revision.
		await db.query("UPDATE entities SET data=jsonb_set(data,'{publishedUrl}',to_jsonb($3::text)),updated_at=now() WHERE site_id=$1 AND kind='media' AND id=$2 AND revision=$4 AND data->>'pathname'=$5 AND data->>'digest'=$6 AND coalesce((data->>'deleted')::boolean,false)=false", [site, id, url, media.revision, media.pathname, media.digest]);
		urls[id] = url;
	}
	return urls;
}

export function registerMediaRoutes(app: AdminApp): void {
	app.get("/api/media", requireAdmin, async (c) => {
		const rows = await getDatabase().query<{ data: Media }>("SELECT data FROM entities WHERE site_id=$1 AND kind='media' AND coalesce((data->>'deleted')::boolean,false)=false ORDER BY created_at DESC", [getSiteId()]);
		return c.json({ data: rows.map((row) => publicMedia(row.data)) });
	});
	app.post("/api/media/intents", requireAdmin, async (c) => {
		blobToken("private"); const body = await readJson(c.req.raw); const name = String(body.name || ""); const contentType = String(body.contentType || ""); const size = Number(body.size);
		if (!name || name.length > 255 || !Object.hasOwn(EXTENSIONS, contentType) || !Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_SIZE) throw new ApiFailure(400, "INVALID_UPLOAD", "文件名、类型或大小不合法");
		const id = randomUUID(); const pathname = `drafts/${createHash("sha256").update(getSiteId()).digest("hex").slice(0,16)}/${c.get("user").id}/${id}.${EXTENSIONS[contentType]}`;
		await getDatabase().query("INSERT INTO media_upload_intents(site_id,id,owner_id,pathname,name,content_type,size,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 minutes')", [getSiteId(), id, c.get("user").id, pathname, name, contentType, size]);
		return c.json({ data: { id, pathname } }, 201);
	});
	app.post("/api/media/upload", async (c) => {
		const body = await readJson(c.req.raw, 65536);
		if (!["blob.generate-client-token","blob.upload-completed"].includes(String(body.type))) throw new ApiFailure(400, "INVALID_UPLOAD_EVENT", "上传事件不合法");
		const result = await handleUpload({ body: body as unknown as HandleUploadBody, request: c.req.raw, token: blobToken("private"),
			onBeforeGenerateToken: async (pathname, payload) => {
				let data: Record<string, unknown>; try { data = JSON.parse(payload || "{}"); } catch { throw new ApiFailure(400, "INVALID_UPLOAD_PAYLOAD", "上传参数无效"); }
				const session = await authenticateRequest(c.req.raw, String(data.csrfToken || ""));
				const rows = await getDatabase().query<Intent>("SELECT * FROM media_upload_intents WHERE site_id=$1 AND id=$2", [getSiteId(), String(data.intentId || "")]); const intent = rows[0];
				if (!intent || intent.owner_id !== session.user.id || intent.pathname !== pathname || intent.state !== "pending" || new Date(intent.expires_at).getTime() <= Date.now()) throw new ApiFailure(403, "UPLOAD_INTENT_DENIED", "上传许可失效或不属于当前用户");
				return { allowedContentTypes: [intent.content_type], maximumSizeInBytes: Number(intent.size), validUntil: Date.now()+10*60*1000, addRandomSuffix: false, allowOverwrite: false, tokenPayload: JSON.stringify({ intentId: intent.id, ownerId: session.user.id, siteId: getSiteId() }), callbackUrl: `${new URL(c.req.raw.url).origin}/api/media/upload` };
			},
			onUploadCompleted: async ({ blob, tokenPayload }) => {
				let payload: Record<string, unknown>; try { payload = JSON.parse(tokenPayload || "{}"); } catch { throw new ApiFailure(403, "UPLOAD_CALLBACK_DENIED", "上传回调无效"); }
				if (payload.siteId !== getSiteId()) throw new ApiFailure(403, "UPLOAD_CALLBACK_DENIED", "上传回调不属于此站点");
				const rows = await getDatabase().query<Intent>("SELECT * FROM media_upload_intents WHERE site_id=$1 AND id=$2", [getSiteId(), String(payload.intentId || "")]); const intent = rows[0];
				if (!intent || intent.owner_id !== payload.ownerId || intent.pathname !== blob.pathname) throw new ApiFailure(403, "UPLOAD_CALLBACK_DENIED", "上传归属或路径不一致");
				if (intent.state === "complete") return;
				if (intent.state !== "pending" || new Date(intent.expires_at).getTime() <= Date.now()) throw new ApiFailure(403, "UPLOAD_INTENT_EXPIRED", "上传许可已失效");
				const metadata = await head(intent.pathname, { token: blobToken("private") });
				if (metadata.pathname !== intent.pathname || metadata.url !== blob.url || metadata.size !== Number(intent.size) || metadata.contentType !== intent.content_type) throw new ApiFailure(415, "UPLOAD_METADATA_MISMATCH", "上传文件类型或大小与许可不一致");
				const source = await get(intent.pathname, { access: "private", token: blobToken("private"), useCache: false });
				if (!source || source.statusCode !== 200) throw new ApiFailure(409, "UPLOAD_NOT_FOUND", "上传内容尚不可读取");
				const bytes = await readStream(source.stream, Number(intent.size)); const detected = safeMediaType(bytes);
				if (bytes.length !== Number(intent.size) || (detected !== intent.content_type && !(detected === "image/x-icon" && intent.content_type === "image/vnd.microsoft.icon"))) throw new ApiFailure(415, "UPLOAD_CONTENT_MISMATCH", "文件实际内容与声明类型不符");
				await getDatabase().transaction(async (tx) => {
					const media: Media = { id: intent.id, pathname: intent.pathname, name: intent.name, contentType: intent.content_type, size: bytes.length, ownerId: intent.owner_id, alt: "", caption: "", digest: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() };
					await tx.query("INSERT INTO entities(site_id,kind,id,data) VALUES($1,'media',$2,$3::jsonb) ON CONFLICT(site_id,kind,id) DO NOTHING", [getSiteId(), intent.id, JSON.stringify(media)]);
					await tx.query("UPDATE media_upload_intents SET state='complete' WHERE site_id=$1 AND id=$2 AND state='pending'", [getSiteId(), intent.id]);
				});
			},
		}); return c.json(result);
	});
	app.get("/api/media/:id/content", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id")); const result = await get(media.pathname, { access: "private", token: blobToken("private") });
		if (!result || result.statusCode !== 200) throw new ApiFailure(404, "MEDIA_NOT_FOUND", "媒体内容不存在");
		return new Response(result.stream, { headers: { "Content-Type": media.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" } });
	});
	app.post("/api/media/import", requireAdmin, async (c) => {
		const token = blobToken("private"); const body = await readJson(c.req.raw, 65536); const bytes = await importBytes(String(body.url || "")); const contentType = safeMediaType(bytes); const id = randomUUID();
		const pathname = `drafts/${createHash("sha256").update(getSiteId()).digest("hex").slice(0,16)}/${c.get("user").id}/${id}.${EXTENSIONS[contentType]}`;
		await put(pathname, bytes, { token, access: "private", addRandomSuffix: false, allowOverwrite: false, contentType });
		const media: Media = { id, pathname, name: `${id}.${EXTENSIONS[contentType]}`, contentType, size: bytes.length, ownerId: c.get("user").id, alt: String(body.alt || "").slice(0,1000), caption: String(body.caption || "").slice(0,5000), digest: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() };
		await persistMedia(media); return c.json({ data: publicMedia(media) }, 201);
	});
	app.patch("/api/media/:id", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id")); const body = await readJson(c.req.raw, 65536);
		const patch: Record<string,string> = {};
		for (const [key, limit] of [["alt",1000],["caption",5000]] as const) if (body[key] !== undefined) { if (typeof body[key] !== "string" || body[key].length > limit) throw new ApiFailure(400, "INVALID_MEDIA_METADATA", "替代文本或图注过长"); patch[key] = body[key]; }
		const rows = await getDatabase().query<{data:Media}>("UPDATE entities SET data=data||$3::jsonb,revision=revision+1,updated_at=now() WHERE site_id=$1 AND kind='media' AND id=$2 RETURNING data", [getSiteId(), media.id, JSON.stringify(patch)]);
		return c.json({ data: publicMedia(rows[0]!.data) });
	});
	app.delete("/api/media/:id", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id"));
		// Tombstone only. Historical snapshots and immutable public versions retain their bytes.
		await getDatabase().query("UPDATE entities SET data=jsonb_set(data,'{deleted}','true'::jsonb),revision=revision+1,updated_at=now() WHERE site_id=$1 AND kind='media' AND id=$2", [getSiteId(), media.id]); return c.json({ data: { id: media.id, deleted: true } });
	});
}
