import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import { type ClientRequest, type IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Hono } from "hono";
import { BlobNotFoundError, type GetBlobResult, type HeadBlobResult } from "@vercel/blob";
import { createDatabase, getDatabase, getSiteId, type Database } from "../server/db.js";
import { issueSession } from "../server/auth.js";
import { blobToken, isPublicAddress, publishMediaForSnapshot, registerMediaRoutes, safeMediaType, validateImportUrl, type FrozenMedia, type MediaPublicationOptions } from "../server/media.js";
import { ApiFailure } from "../server/security.js";
import type { AppEnv } from "../server/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const site = "tests/media:development";
const testTokens = { APP_ENV: "development", VERCEL_ENV: undefined, ADMIN_DEV_PRIVATE_BLOB_TOKEN: "test-only-private-storage", ADMIN_DEV_PUBLIC_BLOB_TOKEN: "test-only-public-storage", BLOB_PRIVATE_READ_WRITE_TOKEN: undefined, BLOB_PUBLIC_READ_WRITE_TOKEN: undefined };

async function environment<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
	try { return await run(); }
	finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}

function failure(code: string, status?: number) {
	return (error: unknown) => error instanceof ApiFailure && error.code === code && (status === undefined || error.status === status);
}

function frozen(overrides: Partial<FrozenMedia> = {}): FrozenMedia {
	return { id: randomUUID(), pathname: `drafts/${randomUUID()}.png`, digest: hash(png), size: png.length, contentType: "image/png", revision: 1, ...overrides };
}

function publicPath(media: FrozenMedia, selectedSite = site): string {
	return `published/${hash(selectedSite).slice(0, 16)}/${media.id}/${media.digest}.png`;
}

function recordingDatabase(): { db: Database; queries: Array<{ sql: string; params: unknown[] }> } {
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const db: Database = {
		async query(sql, params = []) { queries.push({ sql, params }); return []; },
		async transaction(run) { return run(db); },
		async close() {},
	};
	return { db, queries };
}

type BlobObject = { bytes: Buffer; contentType: string };
function storage(media: FrozenMedia, bytes = png) {
	const privateObjects = new Map<string, BlobObject>([[media.pathname, { bytes, contentType: media.contentType }]]);
	const publicObjects = new Map<string, BlobObject>();
	const reads: Array<{ pathname: string; access: "private" | "public" }> = [];
	const writes: Array<{ pathname: string; bytes: Buffer; options: Record<string, unknown> }> = [];
	let loseNextPutResponse = false;
	const metadata = (pathname: string, object: BlobObject): HeadBlobResult => ({ pathname, size: object.bytes.length, contentType: object.contentType, url: `https://test.public.blob.vercel-storage.com/${pathname}`, downloadUrl: `https://test.public.blob.vercel-storage.com/${pathname}?download=1`, uploadedAt: new Date(0), cacheControl: "public, max-age=31536000", contentDisposition: "inline", etag: hash(object.bytes) });
	const blob: NonNullable<MediaPublicationOptions["blob"]> = {
		async get(pathname, options): Promise<GetBlobResult | null> {
			assert.equal(options.useCache, false, "publication must read origin bytes");
			assert.equal(options.token, options.access === "private" ? testTokens.ADMIN_DEV_PRIVATE_BLOB_TOKEN : testTokens.ADMIN_DEV_PUBLIC_BLOB_TOKEN);
			reads.push({ pathname, access: options.access });
			const object = (options.access === "private" ? privateObjects : publicObjects).get(pathname);
			if (!object) return null;
			return { statusCode: 200, headers: new Headers(), blob: metadata(pathname, object), stream: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(object.bytes)); controller.close(); } }) };
		},
		async head(pathname, options) {
			assert.equal(options?.token, testTokens.ADMIN_DEV_PUBLIC_BLOB_TOKEN);
			const object = publicObjects.get(pathname);
			if (!object) throw new BlobNotFoundError();
			return metadata(pathname, object);
		},
		async put(pathname, body, options) {
			assert.ok(Buffer.isBuffer(body));
			assert.equal(options.access, "public");
			assert.equal(options.token, testTokens.ADMIN_DEV_PUBLIC_BLOB_TOKEN);
			assert.equal(options.addRandomSuffix, false);
			assert.equal(options.allowOverwrite, false);
			assert.equal(options.cacheControlMaxAge, 31536000);
			assert.ok(!publicObjects.has(pathname), "an existing public object must never be overwritten");
			const copied = Buffer.from(body as Buffer);
			writes.push({ pathname, bytes: copied, options: { ...options } });
			publicObjects.set(pathname, { bytes: copied, contentType: options.contentType! });
			if (loseNextPutResponse) { loseNextPutResponse = false; throw new Error("connection lost after Blob stored the bytes"); }
			return metadata(pathname, publicObjects.get(pathname)!);
		},
	};
	return { blob, privateObjects, publicObjects, reads, writes, losePutResponse() { loseNextPutResponse = true; } };
}

test("Blob tokens use the runtime namespace and reject production token reuse", async () => {
	await environment({ ...testTokens, BLOB_PRIVATE_READ_WRITE_TOKEN: "test-only-production-private", BLOB_PUBLIC_READ_WRITE_TOKEN: "test-only-production-public", ADMIN_PREVIEW_PRIVATE_BLOB_TOKEN: "test-only-preview-private", ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN: "test-only-preview-public" }, async () => {
		assert.equal(blobToken("private"), testTokens.ADMIN_DEV_PRIVATE_BLOB_TOKEN);
		assert.equal(blobToken("public"), testTokens.ADMIN_DEV_PUBLIC_BLOB_TOKEN);
		await environment({ APP_ENV: "preview", VERCEL_ENV: "preview" }, () => {
			assert.equal(blobToken("private"), "test-only-preview-private");
			assert.equal(blobToken("public"), "test-only-preview-public");
		});
		await environment({ ADMIN_DEV_PRIVATE_BLOB_TOKEN: undefined }, () => assert.throws(() => blobToken("private"), failure("BLOB_CONFIGURATION_REQUIRED", 503)));
		for (const token of ["test-only-production-private", "test-only-production-public"]) {
			await environment({ ADMIN_DEV_PRIVATE_BLOB_TOKEN: token }, () => assert.throws(() => blobToken("private"), failure("BLOB_ENVIRONMENT_NOT_ISOLATED", 503)));
			await environment({ APP_ENV: "preview", VERCEL_ENV: "preview", ADMIN_PREVIEW_PUBLIC_BLOB_TOKEN: token }, () => assert.throws(() => blobToken("public"), failure("BLOB_ENVIRONMENT_NOT_ISOLATED", 503)));
		}
		await environment({ BLOB_PRIVATE_READ_WRITE_TOKEN: "vercel_blob_rw_prodstore_oldsecret", ADMIN_DEV_PRIVATE_BLOB_TOKEN: "vercel_blob_rw_prodstore_rotatedsecret" }, () => assert.throws(() => blobToken("private"), failure("BLOB_ENVIRONMENT_NOT_ISOLATED", 503)));
		await environment({ BLOB_PUBLIC_READ_WRITE_TOKEN: "vercel_blob_rw_publicprod_oldsecret", ADMIN_DEV_PUBLIC_BLOB_TOKEN: "vercel_blob_rw_publicprod_rotatedsecret" }, () => assert.throws(() => blobToken("public"), failure("BLOB_ENVIRONMENT_NOT_ISOLATED", 503)));
		for (const [privateToken, publicToken] of [["test-only-shared-store", "test-only-shared-store"], ["vercel_blob_rw_devshared_private", "vercel_blob_rw_devshared_public"]]) await environment({ ADMIN_DEV_PRIVATE_BLOB_TOKEN: privateToken, ADMIN_DEV_PUBLIC_BLOB_TOKEN: publicToken }, () => {
			assert.throws(() => blobToken("private"), failure("BLOB_STORES_NOT_SEPARATE", 503));
			assert.throws(() => blobToken("public"), failure("BLOB_STORES_NOT_SEPARATE", 503));
		});
	});
});

test("content sniffing accepts static graphics and rejects unsupported or active SVG content", () => {
	assert.equal(safeMediaType(png), "image/png");
	assert.equal(safeMediaType(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path d="M0 0L1 1"/></svg>')), "image/svg+xml");
	for (const source of [
		'<svg><script>alert(1)</script></svg>',
		'<svg><foreignObject><div>HTML</div></foreignObject></svg>',
		'<svg onload="alert(1)"><path/></svg>',
		'<svg><path style="fill: url(https://example.invalid/a)"/></svg>',
		'<svg><use href="https://example.invalid/a"/></svg>',
		'<svg><image xlink:href="data:text/html,active"/></svg>',
		'<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
		'<svg><?processing active?><path/></svg>',
		'<svg><path fill="url(#g)"/></svg>',
		'<svg><rect fill="u\\72l(https://example.invalid/a.svg#x)"/></svg>',
		'<svg><rect filter="u\\72l(https://example.invalid/a.svg#x)"/></svg>',
		'<svg><title>&entity;</title></svg>',
	]) assert.throws(() => safeMediaType(Buffer.from(source)), failure("UNSAFE_SVG", 415), source);
	for (const source of ["plain text", "<!doctype html><html>active</html>", "", '<!DOCTYPE svg [<!ENTITY x "active">]><svg><title>&x;</title></svg>']) assert.throws(() => safeMediaType(Buffer.from(source)), (error) => error instanceof ApiFailure && error.status === 415);
});

test("media import rejects disallowed URLs before DNS and rejects any private DNS answer", async (t) => {
	let lookups = 0; let addresses = [{ address: "8.8.8.8", family: 4 }];
	const lookupMock = t.mock.method(dns, "lookup", async () => { lookups++; return addresses; });
	syncBuiltinESMExports();
	try {
		await environment({ MEDIA_IMPORT_HOSTS: "allowed.invalid" }, async () => {
			for (const url of ["not a url", "http://allowed.invalid/a.png", "ftp://allowed.invalid/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://denied.invalid/a.png", "https://allowed.invalid.evil.invalid/a.png", "https://user:pass@allowed.invalid/a.png", "https://allowed.invalid:444/a.png", "https://allowed.invalid/a.png#fragment", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://2130706433/a.png"]) {
				await assert.rejects(() => validateImportUrl(url), (error) => error instanceof ApiFailure && error.status === 400, url);
			}
			assert.equal(lookups, 0);
			assert.deepEqual((await validateImportUrl("https://allowed.invalid/a.png")).address, "8.8.8.8");
			addresses = [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
			await assert.rejects(() => validateImportUrl("https://allowed.invalid/a.png"), failure("MEDIA_IMPORT_ADDRESS_DENIED", 400));
		});
		await environment({ MEDIA_IMPORT_HOSTS: undefined }, () => assert.rejects(() => validateImportUrl("https://allowed.invalid/a.png"), failure("MEDIA_IMPORT_HOSTS_REQUIRED", 503)));
	} finally { lookupMock.mock.restore(); syncBuiltinESMExports(); }
	for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.88.99.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2001:2::1", "3fff::1"]) assert.equal(isPublicAddress(address), false, address);
	for (const address of ["8.8.8.8", "198.51.0.1", "203.0.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});

test("media routes deny anonymous and Blob-token requests before intent creation or private reads", async () => {
	await environment({ ...testTokens, ADMIN_GITHUB_USER_ID: "12345", ADMIN_DEVELOPMENT_DATABASE_URL: undefined, ADMIN_DATABASE_URL: undefined }, async () => {
		const app = new Hono<AppEnv>();
		app.onError((error, context) => error instanceof ApiFailure ? error.getResponse() : context.json({ error: { code: "UNEXPECTED" } }, 500));
		registerMediaRoutes(app);
		for (const [method, path] of [["GET", "/api/media"], ["GET", "/api/media/test/content"], ["POST", "/api/media/intents"], ["POST", "/api/media/import"], ["PATCH", "/api/media/test"], ["DELETE", "/api/media/test"]]) {
			for (const token of [undefined, testTokens.ADMIN_DEV_PRIVATE_BLOB_TOKEN, testTokens.ADMIN_DEV_PUBLIC_BLOB_TOKEN]) {
				const response = await app.request(`http://localhost:3000${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(method !== "GET" ? { body: JSON.stringify({ name: "safe.png", contentType: "image/png", size: png.length }) } : {}) });
				assert.equal(response.status, 401, `${method} ${path}`);
				assert.equal((await response.json()).error.code, "AUTHENTICATION_REQUIRED");
			}
		}
	});
});

test("snapshot publication copies frozen bytes once and re-verifies private and public bytes on retry", async () => {
	await environment(testTokens, async () => {
		const media = frozen(); const objects = storage(media); const { db, queries } = recordingDatabase();
		const options = { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob };
		const expected = `https://test.public.blob.vercel-storage.com/${publicPath(media)}`;
		assert.deepEqual(await publishMediaForSnapshot([media.id, media.id], "first-task", options), { [media.id]: expected });
		assert.deepEqual(await publishMediaForSnapshot([media.id], "retry-task", options), { [media.id]: expected });
		assert.equal(objects.writes.length, 1);
		assert.equal(objects.writes[0].pathname, publicPath(media));
		assert.deepEqual(objects.writes[0].bytes, png);
		assert.deepEqual(objects.privateObjects.get(media.pathname)?.bytes, png);
		assert.equal(objects.reads.filter((read) => read.access === "private").length, 2);
		assert.equal(objects.reads.filter((read) => read.access === "public").length, 2);
		assert.equal(queries.length, 2, "frozen publication must not re-read mutable draft metadata");
		for (const query of queries) {
			assert.match(query.sql, /^UPDATE entities /);
			assert.match(query.sql, /revision=\$4/);
			assert.deepEqual(query.params, [site, media.id, expected, media.revision, media.pathname, media.digest]);
		}
	});
});

test("lost PUT response reconciles stored bytes without another public write", async () => {
	await environment(testTokens, async () => {
		const media = frozen(); const objects = storage(media); objects.losePutResponse();
		const { db } = recordingDatabase(); const options = { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob };
		const result = await publishMediaForSnapshot([media.id], "task", options);
		assert.equal(result[media.id], `https://test.public.blob.vercel-storage.com/${publicPath(media)}`);
		assert.deepEqual(await publishMediaForSnapshot([media.id], "task", options), result);
		assert.equal(objects.writes.length, 1);
		assert.equal(objects.reads.filter((read) => read.access === "public").length, 2);
	});
});

test("existing public bytes are checked even when an earlier publication already succeeded", async () => {
	await environment(testTokens, async () => {
		const media = frozen(); const objects = storage(media); const { db, queries } = recordingDatabase();
		const options = { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob };
		await publishMediaForSnapshot([media.id], "task", options);
		const tampered = Buffer.from(png); tampered[tampered.length - 1] ^= 1;
		objects.publicObjects.set(publicPath(media), { bytes: tampered, contentType: media.contentType });
		await assert.rejects(() => publishMediaForSnapshot([media.id], "retry", options), failure("PUBLISHED_MEDIA_CONFLICT", 409));
		assert.equal(objects.writes.length, 1);
		assert.equal(queries.length, 1, "a conflict must not update publication metadata");
	});
});

test("a valid existing public copy does not bypass verification of changed private bytes", async () => {
	await environment(testTokens, async () => {
		const media = frozen(); const objects = storage(media); const { db, queries } = recordingDatabase();
		const options = { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob };
		await publishMediaForSnapshot([media.id], "task", options);
		const changed = Buffer.from(png); changed[changed.length - 1] ^= 1;
		objects.privateObjects.set(media.pathname, { bytes: changed, contentType: media.contentType });
		await assert.rejects(() => publishMediaForSnapshot([media.id], "retry", options), failure("MEDIA_CHANGED", 409));
		assert.equal(objects.writes.length, 1); assert.equal(queries.length, 1);
	});
});

test("snapshot publication rejects invalid frozen records and unsafe content before a public write", async () => {
	await environment(testTokens, async () => {
		const missing = frozen(); const missingStorage = storage(missing); const missingDatabase = recordingDatabase();
		await assert.rejects(() => publishMediaForSnapshot([missing.id], "task", { db: missingDatabase.db, site, blob: missingStorage.blob }), failure("FROZEN_MEDIA_INVALID", 409));
		assert.equal(missingDatabase.queries.length, 0); assert.equal(missingStorage.reads.length, 0);
		for (const invalid of [{ pathname: "" }, { contentType: "text/html" }, { contentType: "toString" }, { contentType: "constructor" }, { digest: "wrong" }, { size: 0 }, { revision: 0 }, { revision: 1.5 }]) {
			const media = frozen(invalid); const objects = storage(media); const { db, queries } = recordingDatabase();
			await assert.rejects(() => publishMediaForSnapshot([media.id], "task", { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob }), failure("FROZEN_MEDIA_INVALID", 409));
			assert.equal(objects.reads.length, 0); assert.equal(objects.writes.length, 0); assert.equal(queries.length, 0);
		}
		for (const [bytes, contentType, code] of [[Buffer.from('<svg><script>alert(1)</script></svg>'), "image/svg+xml", "UNSAFE_SVG"], [Buffer.from("<html>not an image</html>"), "image/png", "UNSUPPORTED_MEDIA"]] as const) {
			const media = frozen({ size: bytes.length, digest: hash(bytes), contentType }); const objects = storage(media, bytes); const { db, queries } = recordingDatabase();
			await assert.rejects(() => publishMediaForSnapshot([media.id], "task", { db, site, frozenMedia: { [media.id]: media }, blob: objects.blob }), failure(code, 415));
			assert.equal(objects.writes.length, 0); assert.equal(queries.length, 0);
		}
	});
});

const databaseUrl = process.env.ADMIN_TEST_DATABASE_URL;
test("authenticated media validation rejects inherited MIME names and HTTPS redirects with a pinned address", { skip: !databaseUrl }, async (t) => {
	await environment({ ...testTokens, ADMIN_DEVELOPMENT_DATABASE_URL: databaseUrl, ADMIN_GITHUB_USER_ID: "12345", ADMIN_DEV_ORIGIN: "http://localhost:3000", GITHUB_REPOSITORY: `tests/media-auth-${randomUUID()}`, MEDIA_IMPORT_HOSTS: "allowed.invalid" }, async () => {
		const db = getDatabase(); const selectedSite = getSiteId();
		try {
			const session = await issueSession(db, selectedSite, { id: "12345", login: "test-admin", name: "Test administrator", avatarUrl: "" });
			const headers = { Cookie: `__Host-admin-session=${session.token}`, Origin: "http://localhost:3000", "Content-Type": "application/json", "x-csrf-token": session.csrfToken };
			const app = new Hono<AppEnv>();
			app.onError((error, context) => error instanceof ApiFailure ? error.getResponse() : context.json({ error: { code: "UNEXPECTED" } }, 500));
			registerMediaRoutes(app);
			for (const contentType of ["toString", "constructor", "text/html"]) {
				const response = await app.request("http://localhost:3000/api/media/intents", { method: "POST", headers, body: JSON.stringify({ name: "file.png", contentType, size: png.length }) });
				assert.equal(response.status, 400, contentType); assert.equal((await response.json()).error.code, "INVALID_UPLOAD");
			}
			assert.equal((await db.query("SELECT id FROM media_upload_intents WHERE site_id=$1", [selectedSite])).length, 0);
			let httpsRequests = 0; let redirectDestroyed = false;
			const lookupMock = t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
			const requestMock = t.mock.method(https, "request", (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
				httpsRequests++; assert.equal(url.hostname, "allowed.invalid");
				assert.ok(options.lookup);
				options.lookup(url.hostname, { all: false }, (error, address, family) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
				options.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }], "all-address lookup must still return only the vetted IP"); });
				const request = new EventEmitter();
				Object.assign(request, { end() { queueMicrotask(() => callback({ statusCode: 302, destroy() { redirectDestroyed = true; } } as IncomingMessage)); }, destroy(error?: Error) { if (error) request.emit("error", error); return request; } });
				return request as ClientRequest;
			});
			syncBuiltinESMExports();
			try {
				const response = await app.request("http://localhost:3000/api/media/import", { method: "POST", headers, body: JSON.stringify({ url: "https://allowed.invalid/a.png" }) });
				assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "MEDIA_IMPORT_FAILED");
				assert.equal(httpsRequests, 1); assert.equal(redirectDestroyed, true);
				assert.equal((await db.query("SELECT id FROM entities WHERE site_id=$1 AND kind='media'", [selectedSite])).length, 0);
			} finally { lookupMock.mock.restore(); requestMock.mock.restore(); syncBuiltinESMExports(); }
		} finally {
			for (const table of ["entities", "sessions", "media_upload_intents"]) await db.query(`DELETE FROM ${table} WHERE site_id=$1`, [selectedSite]);
			await db.close();
		}
	});
});

test("PostgreSQL publication preserves edited and deleted drafts while publishing the frozen object", { skip: !databaseUrl }, async (t) => {
	await environment(testTokens, async () => {
		const db = createDatabase(databaseUrl!); const selectedSite = `tests/media-${randomUUID()}:development`;
		try {
			for (const [name, currentPatch, currentRevision] of [["later edit", { alt: "later private edit", pathname: "drafts/new-private.png", digest: hash("new draft"), publishedUrl: "https://existing.invalid/new-draft.png" }, 2], ["deleted tombstone", { deleted: true }, 1], ["matching revision", {}, 1]] as const) await t.test(name, async () => {
				const media = frozen(); const current = { ...media, ...currentPatch }; delete (current as Partial<FrozenMedia>).revision;
				await db.query("INSERT INTO entities(site_id,kind,id,data,revision) VALUES($1,'media',$2,$3::jsonb,$4)", [selectedSite, media.id, JSON.stringify(current), currentRevision]);
				const objects = storage(media);
				const result = await publishMediaForSnapshot([media.id], "task", { db, site: selectedSite, frozenMedia: { [media.id]: media }, blob: objects.blob });
				assert.equal(objects.writes[0].pathname, publicPath(media, selectedSite)); assert.deepEqual(objects.writes[0].bytes, png);
				assert.deepEqual(objects.reads[0], { pathname: media.pathname, access: "private" });
				const [stored] = await db.query<{ data: Record<string, unknown>; revision: number | string }>("SELECT data,revision FROM entities WHERE site_id=$1 AND kind='media' AND id=$2", [selectedSite, media.id]);
				assert.equal(Number(stored.revision), currentRevision);
				assert.deepEqual(stored.data, name === "matching revision" ? { ...current, publishedUrl: result[media.id] } : current);
			});
		} finally { await db.query("DELETE FROM entities WHERE site_id=$1", [selectedSite]); await db.close(); }
	});
});
