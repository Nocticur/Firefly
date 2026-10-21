import test from "node:test";
import assert from "node:assert/strict";
import {
	createCloudflareKvBackupProvider,
	createCloudflareKvDocumentBackend,
	normalizeCloudflareConfig,
	type CloudflareKvConfig,
} from "../server/cloudflare-kv.js";
import { decodeState, encodeState, stateKey } from "../server/storage-codec.js";
import { collection, createFileStore } from "../server/file-store.js";
import { storageConfig } from "../server/storage-config.js";
import { ApiFailure } from "../server/security.js";

const config: CloudflareKvConfig = {
	provider: "cloudflare",
	accountId: "a".repeat(32),
	namespaceId: "b".repeat(32),
	token: "test-only-token",
};

function failure(code: string, status?: number) {
	return (error: unknown) =>
		error instanceof ApiFailure &&
		error.code === code &&
		(status === undefined || error.status === status);
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withRawFetch<T>(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<T> | T): Promise<T> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input, init) => {
		calls++;
		return handler(String(input), init);
	}) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
		assert.ok(calls > 0);
	}
}

test("Cloudflare configuration validates identifiers and token", () => {
	assert.deepEqual(normalizeCloudflareConfig(config.accountId, config.namespaceId, " token "), { ...config, token: "token" });
	assert.throws(() => normalizeCloudflareConfig("bad", config.namespaceId, config.token), failure("KV_CONFIGURATION_REQUIRED", 503));
	assert.throws(() => normalizeCloudflareConfig(config.accountId, "bad", config.token), failure("KV_CONFIGURATION_REQUIRED", 503));
});

test("state encoding round-trips and keys are stable per site", () => {
	const json = JSON.stringify({ hello: "world", n: 1 });
	assert.equal(decodeState(encodeState(json)), json);
	assert.match(stateKey("Nocticur/Firefly:production"), /^admin-state:[a-f0-9]{64}:data$/);
});

test("Cloudflare document backend reads, writes and detects stale etags", async () => {
	const backend = createCloudflareKvDocumentBackend(config, "site");
	const values = new Map<string, string>();
	await withRawFetch(async (url, init) => {
		const key = decodeURIComponent(new URL(url).pathname.split("/values/")[1] || "");
		if (init?.method === "GET") return values.has(key) ? new Response(values.get(key)) : new Response("missing", { status: 404 });
		if (init?.method === "PUT") {
			values.set(key, String(init.body));
			return Response.json({ success: true });
		}
		throw new Error(`unexpected method ${init?.method}`);
	}, async () => {
		assert.equal(await backend.read(), null);
		assert.equal(await backend.write('{"v":1}', null), true);
		const current = await backend.read();
		assert.equal(current?.json, '{"v":1}');
		assert.equal(await backend.write('{"v":2}', "stale"), false);
	});
});

test("file store retries after a Cloudflare etag conflict", async () => {
	const backend = createCloudflareKvDocumentBackend(config, "site");
	const store = createFileStore(backend, "site");
	const values = new Map<string, string>();
	let putCount = 0;
	await withRawFetch(async (url, init) => {
		const key = decodeURIComponent(new URL(url).pathname.split("/values/")[1] || "");
		if (init?.method === "GET") return values.has(key) ? new Response(values.get(key)) : new Response("missing", { status: 404 });
		if (init?.method === "PUT") {
			putCount++;
			if (putCount === 1) return new Response("busy", { status: 429 });
			values.set(key, String(init.body));
			return Response.json({ success: true });
		}
		throw new Error(`unexpected method ${init?.method}`);
	}, async () => {
		await store.update((state) => {
			collection(state, "entities").example = { id: "example", kind: "test", data: {} };
		});
	});
	assert.equal(putCount, 2);
});

test("production treats Cloudflare KV as optional and ignores old Upstash variables", async () => {
	// Git is the source of truth now, so an unconfigured production deployment must still boot.
	await withEnv({ APP_ENV: "production", VERCEL_ENV: undefined, CF_ACCOUNT_ID: undefined, CF_KV_NAMESPACE_ID: undefined, CF_API_TOKEN: undefined, KV_REST_API_URL: "https://legacy.invalid", KV_REST_API_TOKEN: "legacy" }, () => assert.equal(storageConfig(), null));
	await withEnv({ APP_ENV: "production", VERCEL_ENV: undefined, CF_ACCOUNT_ID: config.accountId, CF_KV_NAMESPACE_ID: config.namespaceId, CF_API_TOKEN: config.token, KV_REST_API_URL: "https://legacy.invalid", KV_REST_API_TOKEN: "legacy" }, () => assert.equal(storageConfig()?.provider, "cloudflare"));
});

test("non-production Cloudflare namespaces must not share production", async () => {
	await withEnv({ APP_ENV: "development", VERCEL_ENV: undefined, CF_ACCOUNT_ID: config.accountId, CF_KV_NAMESPACE_ID: config.namespaceId, CF_API_TOKEN: config.token, ADMIN_DEV_CF_ACCOUNT_ID: config.accountId, ADMIN_DEV_CF_KV_NAMESPACE_ID: config.namespaceId, ADMIN_DEV_CF_API_TOKEN: "different-token" }, () => assert.throws(() => storageConfig(), failure("KV_ENVIRONMENT_NOT_ISOLATED", 503)));
});

test("Cloudflare backup provider stores immutable compressed values", async () => {
	const key = `admin-backup:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}`;
	const values = new Map<string, string>();
	const provider = createCloudflareKvBackupProvider(config);
	await withRawFetch(async (url, init) => {
		const storedKey = decodeURIComponent(new URL(url).pathname.split("/values/")[1] || "");
		if (init?.method === "GET") return values.has(storedKey) ? new Response(values.get(storedKey)) : new Response("missing", { status: 404 });
		if (init?.method === "PUT") {
			if (values.has(storedKey)) return Response.json({ success: false }, { status: 409 });
			values.set(storedKey, String(init.body));
			return Response.json({ success: true });
		}
		if (init?.method === "DELETE") {
			values.delete(storedKey);
			return Response.json({ success: true });
		}
		throw new Error(`unexpected method ${init?.method}`);
	}, async () => {
		await provider.put(key, Buffer.from("backup"));
		assert.equal((await provider.get(key))?.toString(), "backup");
		await provider.put(key, Buffer.from("backup"));
		await assert.rejects(() => provider.put(key, Buffer.from("different")), /different bytes/);
		await provider.delete(key);
		assert.equal(await provider.get(key), null);
	});
});
