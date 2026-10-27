import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import https, { type RequestOptions } from "node:https";
import { type ClientRequest, type IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { Hono } from "hono";
import { createMemoryStore, getSiteId, collection, withStore, type FileStore } from "../server/file-store.js";
import { issueSession } from "../server/auth.js";
import { entryCookie } from "./entry-fixture.js";
import { MAX_UPLOAD_SIZE, isPublicAddress, publishMediaForSnapshot, registerMediaRoutes, safeMediaType, validateImportUrl, type FrozenMedia } from "../server/media.js";
import { ApiFailure } from "../server/security.js";
import type { AppEnv } from "../server/types.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const origin = "http://localhost:3000";
const uploadedUrl = "https://image.example/uploaded.png";

async function environment<T>(values: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
	try { return await run(); }
	finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
}

function baseEnv(overrides: Record<string, string | undefined> = {}) {
	return { APP_ENV: "development", VERCEL_ENV: undefined, ADMIN_DEV_ORIGIN: origin, GITHUB_REPOSITORY: `tests/media-${randomUUID()}`, IMGBED_API_TOKEN: "test-token", IMGBED_BASE_URL: "https://image.example", ...overrides };
}

function failure(code: string, status?: number) {
	return (error: unknown) => error instanceof ApiFailure && error.code === code && (status === undefined || error.status === status);
}

type Session = { token: string; csrfToken: string };
function authHeaders(session: Session, json = true) {
	return { Cookie: `__Host-admin-session=${session.token}; ${entryCookie()}`, Origin: origin, "x-csrf-token": session.csrfToken, ...(json ? { "Content-Type": "application/json" } : {}) };
}

function appFor(store: FileStore): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", (_context, next) => withStore(store, next));
	app.onError((error, context) => error instanceof ApiFailure ? error.getResponse() : context.json({ error: { code: "UNEXPECTED" } }, 500));
	registerMediaRoutes(app);
	return app;
}

async function authenticatedStore(): Promise<{ store: FileStore; site: string; session: Session }> {
	const selectedSite = getSiteId();
	const store = createMemoryStore(selectedSite);
	const session = issueSession();
	return { store, site: selectedSite, session };
}

/** Stands in for the image host; the admin server only depends on the global fetch contract. */
function imageBedMock(publicUrl = uploadedUrl) {
	const calls: Array<{ url: URL; authorization: string | null; form: FormData }> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const form = init?.body as FormData;
		calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), form });
		return new Response(JSON.stringify({ publicUrl }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { calls, restore() { globalThis.fetch = original; } };
}

function frozen(overrides: Partial<FrozenMedia> = {}): FrozenMedia {
	return { id: randomUUID(), digest: hash(png), size: png.length, contentType: "image/png", revision: 1, ...overrides };
}

async function seedMedia(store: FileStore, media: FrozenMedia, overrides: Record<string, unknown> = {}) {
	const record = { id: media.id, name: `${media.id}.png`, contentType: media.contentType, size: media.size, ownerId: "password-admin", alt: "", caption: "", digest: media.digest, createdAt: new Date(0).toISOString(), ...overrides };
	await store.update((state) => { collection(state, "entities")[`media:${media.id}`] = { id: media.id, kind: "media", data: record, revision: media.revision }; });
	return record;
}

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
		await environment(baseEnv({ MEDIA_IMPORT_HOSTS: "allowed.invalid" }), async () => {
			for (const url of ["not a url", "http://allowed.invalid/a.png", "ftp://allowed.invalid/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://denied.invalid/a.png", "https://allowed.invalid.evil.invalid/a.png", "https://user:pass@allowed.invalid/a.png", "https://allowed.invalid:444/a.png", "https://allowed.invalid/a.png#fragment", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://2130706433/a.png"]) {
				await assert.rejects(() => validateImportUrl(url), (error) => error instanceof ApiFailure && error.status === 400, url);
			}
			assert.equal(lookups, 0);
			assert.deepEqual((await validateImportUrl("https://allowed.invalid/a.png")).address, "8.8.8.8");
			addresses = [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
			await assert.rejects(() => validateImportUrl("https://allowed.invalid/a.png"), failure("MEDIA_IMPORT_ADDRESS_DENIED", 400));
		});
		await environment(baseEnv({ MEDIA_IMPORT_HOSTS: undefined }), () => assert.rejects(() => validateImportUrl("https://allowed.invalid/a.png"), failure("MEDIA_IMPORT_HOST_DENIED", 400)));
	} finally { lookupMock.mock.restore(); syncBuiltinESMExports(); }
	for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.88.99.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1", "2001:2::1", "3fff::1"]) assert.equal(isPublicAddress(address), false, address);
	for (const address of ["8.8.8.8", "198.51.0.1", "203.0.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});

test("multipart upload stores a private project draft without calling the image host", async () => {
	await environment(baseEnv(), async () => {
		const { store, session } = await authenticatedStore();
		const bed = imageBedMock();
		try {
			const form = new FormData();
			form.append("file", new File([new Uint8Array(png)], "cover.png", { type: "image/png" }));
			form.append("alt", "封面");
			form.append("caption", "图注");
			const response = await appFor(store).request(`${origin}/api/media/upload`, { method: "POST", headers: authHeaders(session, false), body: form });
			assert.equal(response.status, 201);
			const body = await response.json() as { data: Record<string, unknown> };
			assert.equal(body.data.publishedUrl, undefined);
			assert.equal(body.data.url, `/api/media/${body.data.id}/content`);
			assert.equal(body.data.contentUrl, body.data.url);
			assert.equal(body.data.access, "private");
			assert.equal(body.data.name, "cover.png");
			assert.equal(body.data.contentType, "image/png");
			assert.equal(body.data.size, png.length);
			assert.equal(body.data.alt, "封面");
			assert.equal(body.data.caption, "图注");

			assert.equal(bed.calls.length, 0, "local uploads are never sent to ImgBed");

			const rows = Object.values(collection(await store.read(), "entities")).filter((row) => row.kind === "media");
			assert.equal(rows.length, 1);
			assert.equal((rows[0]!.data as Record<string, unknown>).digest, hash(png));
			assert.equal((rows[0]!.data as Record<string, unknown>).publishedUrl, undefined);
			assert.equal((rows[0]!.data as Record<string, unknown>).pathname, `public/uploads/${body.data.id}.png`);
			assert.equal((rows[0]!.data as Record<string, unknown>).draftPending, true);
			assert.deepEqual(await store.readMediaBlob(String(body.data.id)), png);
		} finally { bed.restore(); }
	});
});

test("multipart upload rejects files over 4 MiB before touching the image host", async () => {
	await environment(baseEnv(), async () => {
		const { store, session } = await authenticatedStore();
		const bed = imageBedMock();
		const oversized = Buffer.concat([png, Buffer.alloc(MAX_UPLOAD_SIZE)]);
		try {
			const form = new FormData();
			form.append("file", new File([new Uint8Array(oversized)], "huge.png", { type: "image/png" }));
			const response = await appFor(store).request(`${origin}/api/media/upload`, { method: "POST", headers: authHeaders(session, false), body: form });
			assert.equal(response.status, 413);
			assert.equal((await response.json() as { error: { code: string } }).error.code, "MEDIA_TOO_LARGE");
			assert.equal(bed.calls.length, 0);
			assert.equal(Object.values(collection(await store.read(), "entities")).filter((row) => row.kind === "media").length, 0);
		} finally { bed.restore(); }
	});
});

test("multipart upload sniffs bytes and rejects active SVG or a mismatched declared type", async () => {
	await environment(baseEnv(), async () => {
		const { store, session } = await authenticatedStore();
		const bed = imageBedMock();
		const app = appFor(store);
		try {
			const cases: Array<[string, string, number, string]> = [
				["<svg><script>alert(1)</script></svg>", "image/svg+xml", 415, "UNSAFE_SVG"],
				["<svg><path/></svg>", "image/svg+xml", 201, ""],
				["not an image", "image/png", 415, "UNSUPPORTED_MEDIA"],
			];
			for (const [source, type, status, code] of cases) {
				const form = new FormData();
				form.append("file", new File([source], "sample", { type }));
				const response = await app.request(`${origin}/api/media/upload`, { method: "POST", headers: authHeaders(session, false), body: form });
				assert.equal(response.status, status, source);
				if (code) assert.equal((await response.json() as { error: { code: string } }).error.code, code);
			}
			const mismatch = new FormData();
			mismatch.append("file", new File([new Uint8Array(png)], "renamed.jpg", { type: "image/jpeg" }));
			const response = await app.request(`${origin}/api/media/upload`, { method: "POST", headers: authHeaders(session, false), body: mismatch });
			assert.equal(response.status, 415);
			assert.equal((await response.json() as { error: { code: string } }).error.code, "UPLOAD_CONTENT_MISMATCH");
			assert.equal(bed.calls.length, 0, "accepted local SVG uploads are not forwarded to the image host");
		} finally { bed.restore(); }
	});
});

test("media content redirects to the published image host URL and 404s for unmigrated records", async () => {
	await environment(baseEnv(), async () => {
		const { store, session } = await authenticatedStore();
		const app = appFor(store);
		const published = frozen(); const publishedUrl = "https://image.example/content.png";
		await seedMedia(store, published, { publishedUrl });
		const redirect = await app.request(`${origin}/api/media/${published.id}/content`, { headers: authHeaders(session, false) });
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.get("location"), publishedUrl);
		const legacy = frozen(); await seedMedia(store, legacy);
		const missing = await app.request(`${origin}/api/media/${legacy.id}/content`, { headers: authHeaders(session, false) });
		assert.equal(missing.status, 404);
		assert.equal((await missing.json() as { error: { code: string } }).error.code, "MEDIA_NOT_FOUND");
	});
});

test("media import downloads the allowlisted image and re-uploads it to the image host", async (t) => {
	await environment(baseEnv({ MEDIA_IMPORT_HOSTS: "allowed.invalid" }), async () => {
		const { store, session } = await authenticatedStore();
		const bed = imageBedMock("https://image.example/imported.png");
		const lookupMock = t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
		const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-length": String(png.length) } });
		const requestMock = t.mock.method(https, "request", (_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
			const request = new EventEmitter();
			Object.assign(request, {
				end() { queueMicrotask(() => { callback(response as unknown as IncomingMessage); queueMicrotask(() => { response.emit("data", png); response.emit("end"); }); }); },
				destroy(error?: Error) { if (error) request.emit("error", error); return request; },
			});
			return request as ClientRequest;
		});
		syncBuiltinESMExports();
		try {
			const result = await appFor(store).request(`${origin}/api/media/import`, { method: "POST", headers: authHeaders(session), body: JSON.stringify({ url: "https://allowed.invalid/a.png", alt: "外链" }) });
			assert.equal(result.status, 201);
			const body = await result.json() as { data: Record<string, unknown> };
			assert.equal(body.data.publishedUrl, "https://image.example/imported.png");
			assert.equal(body.data.url, "https://image.example/imported.png");
			assert.equal(body.data.size, png.length);
			assert.equal(body.data.alt, "外链");
			assert.equal(bed.calls.length, 1);
			const uploaded = bed.calls[0]!.form.get("file");
			assert.ok(uploaded instanceof Blob);
			assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png);
			const rows = Object.values(collection(await store.read(), "entities")).filter((row) => row.kind === "media");
			assert.equal(rows.length, 1);
			assert.equal((rows[0]!.data as Record<string, unknown>).publishedUrl, "https://image.example/imported.png");
		} finally { bed.restore(); lookupMock.mock.restore(); requestMock.mock.restore(); syncBuiltinESMExports(); }
	});
});

test("snapshot publication resolves image host URLs without uploading or reading legacy blobs", async () => {
	await environment(baseEnv(), async () => {
		const { store, site } = await authenticatedStore();
		const fromStore = frozen(); const storeUrl = "https://image.example/from-store.png";
		await seedMedia(store, fromStore, { publishedUrl: storeUrl });
		const options = { store, site, frozenMedia: { [fromStore.id]: fromStore } };
		const urls = await publishMediaForSnapshot([fromStore.id, fromStore.id], "task", options);
		assert.deepEqual(urls, { [fromStore.id]: storeUrl });
		assert.deepEqual(await publishMediaForSnapshot([fromStore.id], "retry", options), urls);

		const fromFrozen = frozen(); const frozenUrl = "https://image.example/from-frozen.png";
		await seedMedia(store, fromFrozen, { publishedUrl: frozenUrl });
		const frozenRecord = { ...fromFrozen, publishedUrl: frozenUrl };
		assert.deepEqual(await publishMediaForSnapshot([fromFrozen.id], "task", { store, site, frozenMedia: { [fromFrozen.id]: frozenRecord } }), { [fromFrozen.id]: frozenUrl });
	});
});

test("snapshot publication writes the frozen image host URL back to a matching record", async () => {
	await environment(baseEnv(), async () => {
		const { store, site } = await authenticatedStore();
		const media = frozen(); await seedMedia(store, media);
		const frozenUrl = "https://image.example/frozen-update.png";
		const urls = await publishMediaForSnapshot([media.id], "task", { store, site, frozenMedia: { [media.id]: { ...media, publishedUrl: frozenUrl } } });
		assert.deepEqual(urls, { [media.id]: frozenUrl });
		const row = collection(await store.read(), "entities")[`media:${media.id}`]!;
		assert.equal((row.data as Record<string, unknown>).publishedUrl, frozenUrl);
	});
});

test("snapshot publication uses the recorded image host URL even when metadata was edited later", async () => {
	await environment(baseEnv(), async () => {
		const { store, site } = await authenticatedStore();
		const migrated = frozen(); const storedUrl = "https://image.example/migrated.png";
		await seedMedia(store, migrated, { publishedUrl: storedUrl });
		await store.update((state) => { collection(state, "entities")[`media:${migrated.id}`]!.revision = 2; });
		assert.deepEqual(await publishMediaForSnapshot([migrated.id], "task", { store, site, frozenMedia: { [migrated.id]: migrated } }), { [migrated.id]: storedUrl });

		const legacy = frozen({ pathname: `drafts/${randomUUID()}.png` });
		await seedMedia(store, legacy);
		await assert.rejects(() => publishMediaForSnapshot([legacy.id], "task", { store, site, frozenMedia: { [legacy.id]: legacy } }), failure("MEDIA_MIGRATION_REQUIRED", 409));
		await assert.rejects(() => publishMediaForSnapshot([legacy.id], "task", { store, site }), failure("FROZEN_MEDIA_INVALID", 409));
	});
});

test("snapshot publication rejects invalid frozen records before any store write", async () => {
	await environment(baseEnv(), async () => {
		const { store, site } = await authenticatedStore();
		for (const invalid of [{ contentType: "text/html" }, { contentType: "toString" }, { contentType: "constructor" }, { digest: "wrong" }, { size: 0 }, { revision: 0 }, { revision: 1.5 }]) {
			const media = frozen(invalid);
			await assert.rejects(() => publishMediaForSnapshot([media.id], "task", { store, site, frozenMedia: { [media.id]: media } }), failure("FROZEN_MEDIA_INVALID", 409));
		}
		assert.equal(Object.values(collection(await store.read(), "entities")).filter((row) => row.kind === "media").length, 0);
	});
});

test("media routes deny anonymous uploads, imports, reads and tombstones", async () => {
	await environment(baseEnv(), async () => {
		const app = appFor(createMemoryStore(getSiteId()));
		for (const [method, path] of [["GET", "/api/media"], ["GET", "/api/media/test/content"], ["POST", "/api/media/upload"], ["POST", "/api/media/import"], ["PATCH", "/api/media/test"], ["DELETE", "/api/media/test"]]) {
			const response = await app.request(`${origin}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify({ url: "https://allowed.invalid/a.png" }) }) });
			assert.equal(response.status, 401, `${method} ${path}`);
			assert.equal((await response.json() as { error: { code: string } }).error.code, "AUTHENTICATION_REQUIRED");
		}
	});
});
