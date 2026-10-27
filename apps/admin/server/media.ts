import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { requireAdmin } from "./auth.js";
import { getStore, getSiteId, collection, assertSite, type FileStore } from "./file-store.js";
import { ApiFailure, readJson, runtimeEnvironment } from "./security.js";
import type { AdminApp } from "./types.js";
import { defaultMediaImportHosts } from "./runtime-config.js";
import { uploadToImageBed } from "./image-host.js";

/** External imports are downloaded by the server, so they may exceed the function request limit. */
export const MAX_MEDIA_SIZE = 32 * 1024 * 1024;
/** Direct browser uploads travel through the Vercel function body limit (~4.5 MiB). */
export const MAX_UPLOAD_SIZE = 4 * 1024 * 1024;
const MAX_UPLOAD_BODY = MAX_UPLOAD_SIZE + 256 * 1024;
const MAX_NAME_LENGTH = 255;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
type Media = Record<string, unknown> & { id: string; name: string; contentType: string; size: number; ownerId: string; alt: string; caption: string; digest: string; createdAt: string; publishedUrl?: string; pathname?: string; draftPending?: boolean; deleted?: boolean };

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

function publishedUrlOf(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.href;
	} catch { return undefined; }
}

export function publicMedia(record: Media) {
	const publishedUrl = publishedUrlOf(record.publishedUrl);
	const url = publishedUrl || `/api/media/${encodeURIComponent(record.id)}/content`;
	return { id: record.id, name: record.name, contentType: record.contentType, size: record.size, access: publishedUrl ? "public" as const : "private" as const, alt: record.alt, caption: record.caption, createdAt: record.createdAt, url, contentUrl: url, ...(publishedUrl ? { publishedUrl } : {}) };
}
async function mediaById(id: string): Promise<Media> {
	const media = collection(await getStore().read(), "entities")[`media:${id}`]?.data as Media | undefined;
	if (!media || media.deleted) throw new ApiFailure(404, "MEDIA_NOT_FOUND", "媒体不存在");
	return media;
}
async function persistMedia(media: Media, store = getStore()): Promise<void> {
	await store.update((state) => { const now = new Date().toISOString(); collection(state, "entities")[`media:${media.id}`] ||= { id: media.id, kind: "media", data: media, revision: 1, created_at: now, updated_at: now }; });
}

/** External URL imports go to the image host; local file uploads use saveProjectDraft below. */
async function saveImage(bytes: Buffer, contentType: string, ownerId: string, metadata: { name?: string; alt: string; caption: string }): Promise<Media> {
	const id = randomUUID();
	const name = metadata.name || `${id}.${EXTENSIONS[contentType]}`;
	const publishedUrl = await uploadToImageBed(bytes, name, contentType);
	const media: Media = { id, name, contentType, size: bytes.length, ownerId, alt: metadata.alt, caption: metadata.caption, digest: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), publishedUrl };
	await persistMedia(media);
	return media;
}

async function saveProjectDraft(bytes: Buffer, contentType: string, ownerId: string, metadata: { name?: string; alt: string; caption: string }, store: FileStore): Promise<Media> {
	if (runtimeEnvironment() !== "development" && !store.durableMediaBlobs) throw new ApiFailure(503, "MEDIA_DRAFT_STORAGE_REQUIRED", "本地图片上传需要先配置当前环境专用的 Cloudflare KV，以便私有草稿跨 Vercel 实例保存");
	const id = randomUUID();
	const name = metadata.name || `${id}.${EXTENSIONS[contentType]}`;
	const pathname = `public/uploads/${id}.${EXTENSIONS[contentType]}`;
	const media: Media = { id, name, contentType, size: bytes.length, ownerId, alt: metadata.alt, caption: metadata.caption, digest: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), pathname, draftPending: true };
	await store.writeMediaBlob(id, bytes);
	try { await persistMedia(media, store); } catch (error) { await store.deleteMediaBlob(id).catch(() => {}); throw error; }
	return media;
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
	const hosts = defaultMediaImportHosts();
	if (!hosts.length) throw new ApiFailure(503, "MEDIA_IMPORT_HOSTS_REQUIRED", "先配置外链导入允许的域名");
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || isIP(url.hostname) || !hosts.includes(url.hostname.toLowerCase())) throw new ApiFailure(400, "MEDIA_IMPORT_HOST_DENIED", "外链须使用允许域名的 HTTPS 地址");
	const addresses = await lookup(url.hostname, { all: true });
	if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new ApiFailure(400, "MEDIA_IMPORT_ADDRESS_DENIED", "媒体地址不能访问内网或保留地址");
	return { url, address: addresses[0]!.address, family: addresses[0]!.family };
}
type ImportOptions = { timeoutMs?: number; validateUrl?: typeof validateImportUrl; request?: typeof httpsRequest };
export async function importBytes(raw: string, options: ImportOptions = {}): Promise<Buffer> {
	// Socket timeouts only detect idle peers. Bound DNS, TLS and the entire body too.
	const timeoutMs = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid media import timeout");
	const controller = new AbortController();
	const failure = new ApiFailure(504, "MEDIA_IMPORT_TIMEOUT", "媒体导入超时");
	let rejectDeadline!: (reason: unknown) => void;
	const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
	const expire = () => rejectDeadline(controller.signal.reason);
	controller.signal.addEventListener("abort", expire, { once: true });
	const timer = setTimeout(() => controller.abort(failure), timeoutMs);
	try {
		const target = await Promise.race([(options.validateUrl || validateImportUrl)(raw), deadline]);
		return await Promise.race([
			new Promise<Buffer>((resolve, reject) => {
				const request = (options.request || httpsRequest)(target.url, { method: "GET", signal: controller.signal, lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: target.address, family: target.family }]) : callback(null, target.address, target.family), headers: { Accept: "image/*", "Accept-Encoding": "identity" }, timeout: 15000 }, (response) => {
					if (response.statusCode !== 200) { response.destroy(); reject(new ApiFailure(400, "MEDIA_IMPORT_FAILED", "外链必须直接返回图片，禁止跳转")); return; }
					if (Number(response.headers["content-length"] || 0) > MAX_MEDIA_SIZE) { response.destroy(); reject(new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过大小限制")); return; }
					const chunks: Buffer[] = []; let size = 0;
					response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_MEDIA_SIZE) { response.destroy(new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过大小限制")); } else chunks.push(chunk); });
					response.on("end", () => resolve(Buffer.concat(chunks))); response.on("error", reject);
				});
				request.on("timeout", () => request.destroy(new ApiFailure(504, "MEDIA_IMPORT_TIMEOUT", "媒体导入超时"))); request.on("error", reject); request.end();
			}),
			deadline,
		]);
	} catch (error) {
		if (controller.signal.aborted) throw failure;
		throw error;
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", expire);
	}
}

/** Reads the bounded multipart body; the JSON reader cannot decode binary uploads. */
async function readUploadBody(request: Request, limit: number, timeoutMs = 15_000): Promise<Buffer> {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid media body limit");
	const lengthHeader = request.headers.get("content-length");
	let declared: number | undefined;
	if (lengthHeader !== null) {
		if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader))) throw new ApiFailure(400, "CONTENT_LENGTH_INVALID", "请求长度不合法");
		declared = Number(lengthHeader);
		if (declared > limit) { void request.body?.cancel().catch(() => {}); throw new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过 4 MiB 直接上传限制"); }
	}
	if (!request.body) throw new ApiFailure(400, "REQUEST_BODY_INVALID", "请求内容不合法");
	const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiFailure(408, "REQUEST_TIMEOUT", "读取请求超时")), timeoutMs); });
	try {
		while (true) {
			const { done, value } = await Promise.race([reader.read(), timeout]);
			if (done) break;
			if (!(value instanceof Uint8Array)) throw new ApiFailure(400, "REQUEST_BODY_INVALID", "请求内容不合法");
			size += value.byteLength;
			if (size > limit) throw new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过 4 MiB 直接上传限制");
			chunks.push(value);
		}
		if (declared !== undefined && size !== declared) throw new ApiFailure(400, "CONTENT_LENGTH_INVALID", "请求长度与实际内容不一致");
		return Buffer.concat(chunks);
	} catch (error) {
		void reader.cancel().catch(() => {});
		if (error instanceof ApiFailure) throw error;
		throw new ApiFailure(400, "REQUEST_BODY_INVALID", "请求内容无法读取");
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

function formText(value: FormDataEntryValue | null, limit: number): string {
	if (value === null) return "";
	if (typeof value !== "string" || value.length > limit) throw new ApiFailure(400, "INVALID_MEDIA_METADATA", "替代文本或图注过长");
	return value;
}

function uploadedFilename(raw: string): string | undefined {
	const name = raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
	return name || undefined;
}

function assertDeclaredType(detected: string, declared: string): void {
	if (!declared || detected === declared) return;
	if (detected === "image/x-icon" && declared === "image/vnd.microsoft.icon") return;
	throw new ApiFailure(415, "UPLOAD_CONTENT_MISMATCH", "文件实际内容与声明类型不符");
}

export type FrozenMedia = Record<string, unknown> & { id: string; digest: string; size: number; contentType: string; revision: number; pathname?: string; publishedUrl?: string; draftPending?: boolean };
export type MediaPublicationOptions = {
	store?: FileStore;
	site?: string;
	frozenMedia?: Record<string, FrozenMedia>;
};

function validFrozenMedia(media: FrozenMedia | undefined, id: string): media is FrozenMedia {
	return Boolean(media && media.id === id && Object.hasOwn(EXTENSIONS, media.contentType) && /^[a-f0-9]{64}$/.test(media.digest) && Number.isSafeInteger(media.size) && media.size >= 1 && media.size <= MAX_MEDIA_SIZE && Number.isSafeInteger(media.revision) && media.revision >= 1);
}

/** Image bytes are byte-stable per media id, so digest/size/type identify a frozen draft. */
function sameMediaBytes(media: Media | undefined, frozen: FrozenMedia): boolean {
	return Boolean(media && !media.deleted && media.digest === frozen.digest && media.size === frozen.size && media.contentType === frozen.contentType);
}

/** Resolves image-host URLs for a frozen snapshot; never uploads and never reads legacy blob paths. */
export async function publishMediaForSnapshot(ids: string[], _taskId: string, options: MediaPublicationOptions = {}): Promise<Record<string, string>> {
	if (ids.length && !options.frozenMedia) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "发布必须使用已冻结的媒体清单");
	const store = options.store || getStore(); const site = options.site || getSiteId();
	const urls: Record<string, string> = {};
	for (const id of [...new Set(ids)]) {
		const frozen = options.frozenMedia?.[id];
		if (!validFrozenMedia(frozen, id)) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "冻结媒体记录不完整");
		const state = await store.read(); assertSite(state, site);
		const row = collection(state, "entities")[`media:${id}`]; const current = row?.data as Media | undefined;
		const matchesCurrent = sameMediaBytes(current, frozen);
		const url = publishedUrlOf(frozen.publishedUrl) ?? (matchesCurrent ? publishedUrlOf(current!.publishedUrl) : undefined);
		if (!url) throw new ApiFailure(409, "MEDIA_MIGRATION_REQUIRED", "媒体缺少图床地址，请在媒体库重新上传或导入");
		if (matchesCurrent) await store.update((next) => {
			assertSite(next, site);
			const nextRow = collection(next, "entities")[`media:${id}`]; const nextMedia = nextRow?.data as Media | undefined;
			if (!nextRow || !nextMedia || !sameMediaBytes(nextMedia, frozen) || nextMedia.publishedUrl === url) return;
			nextMedia.publishedUrl = url; nextRow.updated_at = new Date().toISOString();
		});
		urls[id] = url;
	}
	return urls;
}

export async function prepareProjectMediaForSnapshot(ids: string[], options: MediaPublicationOptions & { publicOrigin: string }): Promise<{ urls: Record<string, string>; files: Array<{ path: string; source: string; encoding?: "base64" }> }> {
	if (ids.length && !options.frozenMedia) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "发布必须使用已冻结的媒体清单");
	let origin: URL;
	try { origin = new URL(options.publicOrigin); } catch { throw new ApiFailure(409, "SITE_URL_INVALID", "站点公开地址无效，无法生成项目图片地址"); }
	if (origin.protocol !== "https:" || origin.username || origin.password) throw new ApiFailure(409, "SITE_URL_INVALID", "站点公开地址必须使用 HTTPS");
	const store = options.store || getStore(); const site = options.site || getSiteId();
	const urls: Record<string, string> = {}; const files: Array<{ path: string; source: string; encoding?: "base64" }> = [];
	for (const id of [...new Set(ids)]) {
		const frozen = options.frozenMedia?.[id];
		if (!validFrozenMedia(frozen, id)) throw new ApiFailure(409, "FROZEN_MEDIA_INVALID", "冻结媒体记录不完整");
		const remoteUrl = publishedUrlOf(frozen.publishedUrl);
		if (remoteUrl) { urls[id] = remoteUrl; continue; }
		const expectedPath = `public/uploads/${id}.${EXTENSIONS[frozen.contentType]}`;
		if (frozen.draftPending !== true || frozen.pathname !== expectedPath) throw new ApiFailure(409, "MEDIA_DRAFT_MISSING", "图片不是可发布的项目草稿，请在媒体库重新上传");
		const state = await store.read(); assertSite(state, site);
		const row = collection(state, "entities")[`media:${id}`]; const current = row?.data as Media | undefined;
		if (!sameMediaBytes(current, frozen) || current?.draftPending !== true) throw new ApiFailure(409, "MEDIA_REVISION_CONFLICT", "图片草稿已变化，请刷新媒体库后重新发布");
		const bytes = await store.readMediaBlob(id);
		if (!bytes || bytes.length !== frozen.size || createHash("sha256").update(bytes).digest("hex") !== frozen.digest) throw new ApiFailure(409, "MEDIA_DRAFT_INVALID", "私有图片草稿缺失或校验失败，请重新上传");
		files.push({ path: expectedPath, source: bytes.toString("base64"), encoding: "base64" });
		urls[id] = new URL(`/${expectedPath.slice("public/".length)}`, origin).href;
	}
	return { urls, files };
}

export async function finalizeProjectMedia(ids: string[], frozenMedia: Record<string, FrozenMedia> | undefined, publicOrigin: string, store: FileStore, site: string): Promise<void> {
	let origin: URL;
	try { origin = new URL(publicOrigin); } catch { throw new ApiFailure(409, "SITE_URL_INVALID", "站点公开地址无效，无法完成项目图片入库"); }
	if (origin.protocol !== "https:" || origin.username || origin.password) throw new ApiFailure(409, "SITE_URL_INVALID", "站点公开地址必须使用 HTTPS");
	for (const id of [...new Set(ids)]) {
		const frozen = frozenMedia?.[id];
		if (!frozen || frozen.draftPending !== true || !frozen.pathname) continue;
		const url = new URL(`/${frozen.pathname.slice("public/".length)}`, origin).href;
		const updated = await store.update((state) => {
			assertSite(state, site);
			const row = collection(state, "entities")[`media:${id}`]; const media = row?.data as Media | undefined;
			if (!row || !media || !sameMediaBytes(media, frozen)) return Boolean(media?.publishedUrl === url && media.draftPending === false);
			media.publishedUrl = url; media.draftPending = false; row.updated_at = new Date().toISOString();
			return true;
		});
		if (!updated) throw new ApiFailure(409, "MEDIA_REVISION_CONFLICT", "图片记录已变化，私有草稿尚未清理");
		await store.deleteMediaBlob(id);
	}
}

export function registerMediaRoutes(app: AdminApp): void {
	app.get("/api/media", requireAdmin, async (c) => {
		const rows = Object.values(collection(await getStore().read(), "entities")).filter((row) => row.kind === "media" && !(row.data as Media).deleted).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))) as Array<{ data: Media }>;
		return c.json({ data: rows.map((row) => publicMedia(row.data)) });
	});
	app.post("/api/media/upload", requireAdmin, async (c) => {
		const contentType = c.req.raw.headers.get("content-type") || "";
		if (!/^multipart\/form-data\b/i.test(contentType) || !/;\s*boundary=/i.test(contentType)) throw new ApiFailure(415, "MULTIPART_REQUIRED", "上传请求必须使用 multipart/form-data");
		const body = await readUploadBody(c.req.raw, MAX_UPLOAD_BODY);
		let form: FormData;
		try { form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData(); }
		catch { throw new ApiFailure(400, "INVALID_MULTIPART", "上传表单格式无效"); }
		const file = form.get("file");
		if (file === null || typeof file === "string") throw new ApiFailure(400, "FILE_REQUIRED", "上传必须包含 file 文件字段");
		if (file.size < 1) throw new ApiFailure(400, "INVALID_UPLOAD", "上传文件为空");
		if (file.size > MAX_UPLOAD_SIZE) throw new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过 4 MiB 直接上传限制");
		const bytes = Buffer.from(await file.arrayBuffer());
		if (bytes.length < 1 || bytes.length > MAX_UPLOAD_SIZE) throw new ApiFailure(413, "MEDIA_TOO_LARGE", "媒体超过 4 MiB 直接上传限制");
		const detected = safeMediaType(bytes);
		const declared = String(file.type || "").toLowerCase().trim();
		if (declared && !Object.hasOwn(EXTENSIONS, declared)) throw new ApiFailure(415, "UNSUPPORTED_MEDIA", "文件内容不是支持的图片或图标");
		assertDeclaredType(detected, declared);
		const media = await saveProjectDraft(bytes, detected, c.get("user").id, { name: uploadedFilename(String(file.name || "")), alt: formText(form.get("alt"), 1000), caption: formText(form.get("caption"), 5000) }, getStore());
		return c.json({ data: publicMedia(media) }, 201);
	});
	app.get("/api/media/:id/content", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id"));
		const target = publishedUrlOf(media.publishedUrl);
		if (target) return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
		if (!media.draftPending) throw new ApiFailure(404, "MEDIA_NOT_FOUND", "图片尚未发布或私有草稿已清理");
		const bytes = await getStore().readMediaBlob(media.id);
		if (!bytes || bytes.length !== media.size || createHash("sha256").update(bytes).digest("hex") !== media.digest) throw new ApiFailure(503, "MEDIA_DRAFT_INVALID", "私有图片草稿缺失或校验失败");
		return new Response(new Uint8Array(bytes), { headers: { "Content-Type": media.contentType, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
	});
	app.post("/api/media/import", requireAdmin, async (c) => {
		const body = await readJson(c.req.raw, 65536); const bytes = await importBytes(String(body.url || "")); const contentType = safeMediaType(bytes);
		const media = await saveImage(bytes, contentType, c.get("user").id, { alt: String(body.alt || "").slice(0,1000), caption: String(body.caption || "").slice(0,5000) });
		return c.json({ data: publicMedia(media) }, 201);
	});
	app.patch("/api/media/:id", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id")); const body = await readJson(c.req.raw, 65536);
		const patch: Record<string,string> = {};
		for (const [key, limit] of [["alt",1000],["caption",5000]] as const) if (body[key] !== undefined) { if (typeof body[key] !== "string" || body[key].length > limit) throw new ApiFailure(400, "INVALID_MEDIA_METADATA", "替代文本或图注过长"); patch[key] = body[key]; }
		const updated = await getStore().update((state) => { const row = collection(state, "entities")[`media:${media.id}`]; const current = row?.data as Media | undefined; if (!row || !current || current.deleted) throw new ApiFailure(404, "MEDIA_NOT_FOUND", "媒体不存在"); row.data = { ...current, ...patch }; row.revision = Number(row.revision)+1; row.updated_at = new Date().toISOString(); return row.data as Media; });
		return c.json({ data: publicMedia(updated) });
	});
	app.delete("/api/media/:id", requireAdmin, async (c) => {
		const media = await mediaById(c.req.param("id"));
		const store = getStore();
		const draftBytes = media.draftPending ? await store.readMediaBlob(media.id) : null;
		if (media.draftPending && (!draftBytes || draftBytes.length !== media.size || createHash("sha256").update(draftBytes).digest("hex") !== media.digest)) throw new ApiFailure(503, "MEDIA_DRAFT_INVALID", "私有图片草稿缺失或校验失败，未删除媒体记录");
		if (draftBytes) await store.deleteMediaBlob(media.id);
		try {
			await store.update((state) => { const row = collection(state, "entities")[`media:${media.id}`]; if (row) { row.data = { ...(row.data as Media), deleted: true }; row.revision = Number(row.revision)+1; row.updated_at = new Date().toISOString(); } });
		} catch (error) {
			if (draftBytes) await store.writeMediaBlob(media.id, draftBytes).catch(() => {});
			throw error;
		}
		return c.json({ data: { id: media.id, deleted: true } });
	});
}
