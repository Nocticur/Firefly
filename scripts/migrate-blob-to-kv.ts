/**
 * One-off migration: Vercel Blob private document -> Upstash KV + ImgBed.
 *
 * Run locally with production credentials before deploying the KV build:
 *   BLOB_PRIVATE_READ_WRITE_TOKEN=... \
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... \
 *   IMGBED_API_TOKEN=... IMGBED_BASE_URL=... \
 *   APP_ENV=production GITHUB_REPOSITORY=Nocticur/Firefly \
 *   pnpm exec tsx scripts/migrate-blob-to-kv.ts
 *
 * It reads the current private state, uploads legacy draft media to ImgBed,
 * writes the resulting document to the same KV keys the runtime uses, and
 * verifies the read-back checksum. It refuses to overwrite an existing KV
 * document. Delete this script after the migration is verified.
 */
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_KV_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const DEFAULT_IMAGE_BED = "https://image.nocticur.eu.cc";
const contentTypes: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
};

const sha256 = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing environment variable: ${name}`);
	return value;
}

const repository = process.env.GITHUB_REPOSITORY?.trim() || "Nocticur/Firefly";
const site = `${repository}:production`;
const siteHash = sha256(site);
const keys = {
	meta: `admin-state:${siteHash}:meta`,
	data: `admin-state:${siteHash}:data`,
};

const kvUrl = required("KV_REST_API_URL").replace(/\/+$/, "");
const kvToken = required("KV_REST_API_TOKEN");
if (!/^https:\/\/[^/]+$/.test(kvUrl))
	throw new Error("KV_REST_API_URL must be an HTTPS origin");

async function kv<T>(command: unknown[]): Promise<T> {
	const response = await fetch(kvUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${kvToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(command),
		signal: AbortSignal.timeout(30_000),
	});
	const payload = (await response.json().catch(() => null)) as
		| { result?: unknown; error?: unknown }
		| null;
	if (!response.ok || !payload || payload.error !== undefined)
		throw new Error("KV command failed");
	return payload.result as T;
}

const blobToken = required("BLOB_PRIVATE_READ_WRITE_TOKEN");
const storeId = blobToken.split("_")[3];
if (!storeId) throw new Error("Invalid BLOB_PRIVATE_READ_WRITE_TOKEN");

async function readBlob(pathname: string): Promise<Buffer | null> {
	const url = `https://${storeId}.private.blob.vercel-storage.com/${pathname.replace(/^\/+/, "")}?cache=0`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${blobToken}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) {
		await response.body?.cancel().catch(() => {});
		return null;
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Blob read failed for ${pathname} (${response.status})`);
	}
	const length = Number(response.headers.get("content-length") || 0);
	if (length > MAX_MEDIA_BYTES) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`Blob object is too large: ${pathname}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_MEDIA_BYTES)
		throw new Error(`Blob object is too large: ${pathname}`);
	return bytes;
}

function imageBedBase(): URL {
	const value = process.env.IMGBED_BASE_URL?.trim() || DEFAULT_IMAGE_BED;
	const url = new URL(value);
	if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash)
		throw new Error("IMGBED_BASE_URL must be an HTTPS origin");
	return url;
}

async function uploadToImageBed(
	bytes: Buffer,
	filename: string,
	contentType: string,
): Promise<string> {
	const token = required("IMGBED_API_TOKEN");
	const endpoint = new URL("/upload", imageBedBase());
	endpoint.searchParams.set("returnFormat", "full");
	endpoint.searchParams.set("autoRetry", "false");
	const form = new FormData();
	form.append(
		"file",
		new Blob([new Uint8Array(bytes)], { type: contentType }),
		filename,
	);
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: form,
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`ImgBed upload failed (${response.status})`);
	}
	const text = await response.text();
	const parsed = JSON.parse(text) as unknown;
	const item = Array.isArray(parsed) ? parsed[0] : parsed;
	const record =
		item && typeof item === "object" ? (item as Record<string, unknown>) : {};
	const value = [record.publicUrl, record.url, record.src].find(
		(candidate): candidate is string =>
			typeof candidate === "string" && candidate.startsWith("https://"),
	);
	if (!value) throw new Error("ImgBed did not return a public HTTPS URL");
	return value;
}

type Media = Record<string, unknown> & {
	id?: string;
	kind?: string;
	data?: Record<string, unknown>;
};

async function main(): Promise<void> {
	const existing = await kv<[string | null, string | null]>([
		"MGET",
		keys.meta,
		keys.data,
	]);
	if (existing[1])
		throw new Error(
			"KV already contains an admin state document; refusing to overwrite it. Verify the KV database before retrying.",
		);

	const blobPath = `admin-state/${siteHash}/state.json`;
	const bytes = await readBlob(blobPath);
	if (!bytes) {
		console.log("No Blob admin state found; nothing to migrate.");
		return;
	}
	if (bytes.length > MAX_STATE_BYTES)
		throw new Error("Blob admin state is too large");
	const state = JSON.parse(bytes.toString("utf8")) as {
		siteId?: unknown;
		collections?: Record<string, Record<string, Media>>;
	};
	if (state.siteId !== site || !state.collections)
		throw new Error("Blob admin state does not match this site");
	const entities = state.collections.entities || {};
	let migratedMedia = 0;
	let skippedMedia = 0;
	for (const row of Object.values(entities)) {
		if (row.kind !== "media" || !row.data) continue;
		const data = row.data;
		if (typeof data.publishedUrl === "string") continue;
		const pathname = data.pathname;
		if (typeof pathname !== "string" || !pathname) {
			skippedMedia++;
			continue;
		}
		const contentType =
			typeof data.contentType === "string" ? data.contentType : "image/png";
		const extension = contentTypes[contentType];
		if (!extension) {
			skippedMedia++;
			continue;
		}
		const mediaBytes = await readBlob(pathname);
		if (!mediaBytes) {
			skippedMedia++;
			continue;
		}
		const url = await uploadToImageBed(
			mediaBytes,
			`${String(data.id || row.id || randomUUID())}.${extension}`,
			contentType,
		);
		data.publishedUrl = url;
		data.size = mediaBytes.length;
		data.digest = sha256(mediaBytes);
		migratedMedia++;
	}

	const json = JSON.stringify(state);
	if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES)
		throw new Error("Migrated state is too large");
	const encoded = gzipSync(Buffer.from(json, "utf8"), { level: 9 }).toString(
		"base64",
	);
	if (Buffer.byteLength(encoded, "utf8") > MAX_KV_VALUE_BYTES)
		throw new Error("Migrated state exceeds the KV value limit");
	const etag = randomUUID();
	await kv(["MSET", keys.meta, etag, keys.data, encoded]);
	const check = await kv<[string | null, string | null]>([
		"MGET",
		keys.meta,
		keys.data,
	]);
	if (check[0] !== etag || typeof check[1] !== "string")
		throw new Error("KV read-back verification failed");
	const readBack = gunzipSync(Buffer.from(check[1], "base64")).toString("utf8");
	if (sha256(readBack) !== sha256(json))
		throw new Error("KV read-back checksum mismatch");
	console.log(
		`Migrated ${migratedMedia} media item(s), skipped ${skippedMedia}, state=${Buffer.byteLength(json)} bytes, etag=${etag}.`,
	);
	console.log(
		"Legacy Blob backup objects were not copied. Restore them before cutover if they are still needed.",
	);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
