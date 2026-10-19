import test from "node:test";
import assert from "node:assert/strict";
import {
	createKvBackupProvider,
	createKvDocumentBackend,
	decodeState,
	encodeState,
	kvCommand,
	normalizeKvConfig,
	stateKeys,
	type KvConfig,
} from "../server/kv.js";
import { createFileStore } from "../server/file-store.js";
import {
	createCloudflareKvBackupProvider,
	createCloudflareKvDocumentBackend,
	type CloudflareKvConfig,
} from "../server/cloudflare-kv.js";
import { storageConfig } from "../server/storage-config.js";
import { ApiFailure } from "../server/security.js";

const config: KvConfig = {
	url: "https://kv.example.invalid",
	token: "test-only-token",
};

const cloudflareConfig: CloudflareKvConfig = {
	provider: "cloudflare",
	accountId: "a".repeat(32),
	namespaceId: "b".repeat(32),
	token: "test-only-cloudflare-token",
};

function failure(code: string, status?: number) {
	return (error: unknown) =>
		error instanceof ApiFailure &&
		error.code === code &&
		(status === undefined || error.status === status);
}

async function withEnv(
	values: Record<string, string | undefined>,
	run: () => Promise<void> | void,
): Promise<void> {
	const previous = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	for (const [key, value] of Object.entries(values))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries(previous))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
}

async function withFetch<T>(
	handler: (command: unknown[]) => Promise<Response> | Response,
	run: () => Promise<T> | T,
): Promise<T> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls++;
		const command = JSON.parse(String(init?.body ?? "[]")) as unknown[];
		return handler(command);
	}) as typeof fetch;
	let result!: T;
	try {
		result = await run();
	} finally {
		globalThis.fetch = original;
	}
	assert.ok(calls > 0, "the test must exercise the KV client");
	return result;
}

function json(result: unknown): Response {
	return Response.json({ result });
}

async function withRawFetch<T>(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
	run: () => Promise<T> | T,
): Promise<T> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls++;
		return handler(String(input), init);
	}) as typeof fetch;
	let result!: T;
	try {
		result = await run();
	} finally {
		globalThis.fetch = original;
	}
	assert.ok(calls > 0, "the test must exercise the Cloudflare KV client");
	return result;
}

test("KV URL accepts copied trailing path, quotes and default port but rejects console/redis URLs", () => {
	assert.equal(normalizeKvConfig("https://kv.example.invalid/", "token").url, "https://kv.example.invalid");
	assert.equal(normalizeKvConfig(" 'https://kv.example.invalid/redis' ", "token").url, "https://kv.example.invalid");
	assert.equal(normalizeKvConfig("https://kv.example.invalid:443/set/foo/bar", "token").url, "https://kv.example.invalid");
	assert.throws(() => normalizeKvConfig("redis://default:secret@kv.example.invalid:6379", "token"), failure("KV_CONFIGURATION_REQUIRED", 503));
	assert.throws(() => normalizeKvConfig("https://console.upstash.com/redis/abc", "token"), failure("KV_CONFIGURATION_REQUIRED", 503));
	assert.throws(() => normalizeKvConfig("https://user:pass@kv.example.invalid", "token"), failure("KV_CONFIGURATION_REQUIRED", 503));
});

test("state encoding round-trips and keys are stable per site", () => {
	const jsonText = JSON.stringify({ hello: "world", n: 1 });
	assert.equal(decodeState(encodeState(jsonText)), jsonText);
	assert.match(stateKeys("Nocticur/Firefly:production").meta, /^admin-state:[a-f0-9]{64}:meta$/);
	assert.notEqual(stateKeys("a").data, stateKeys("b").data);
});

test("KV document backend reads, creates, updates and detects conflicts", async () => {
	const backend = createKvDocumentBackend(config, "site");
	let etag: string | null = null;
	let data: string | null = null;
	await withFetch(
		(command) => {
			assert.equal(command[0], "MGET");
			return json([etag, data]);
		},
		async () => assert.equal(await backend.read(), null),
	);
	await withFetch(
		(command) => {
			assert.equal(command[0], "EVAL");
			const expected = command[5];
			assert.equal(expected, "");
			etag = String(command[6]);
			data = String(command[7]);
			return json(1);
		},
		async () => assert.equal(await backend.write('{"v":1}', null), true),
	);
	const current = await withFetch(
		(command) => {
			assert.equal(command[0], "MGET");
			return json([etag, data]);
		},
		() => backend.read(),
	);
	assert.deepEqual(current, { json: '{"v":1}', etag });
	await withFetch(
		(command) => {
			assert.equal(command[0], "EVAL");
			assert.equal(command[5], "stale-etag");
			return json(0);
		},
		async () => assert.equal(await backend.write('{"v":2}', "stale-etag"), false),
	);
});

test("KV document backend rejects corrupt compressed state", async () => {
	const backend = createKvDocumentBackend(config, "site");
	await withFetch(
		(command) => {
			assert.equal(command[0], "MGET");
			return json(["etag", "not-valid-gzip"]);
		},
		async () => assert.rejects(() => backend.read(), failure("FILE_STORE_INVALID", 503)),
	);
});

test("file store uses KV CAS and retries after a conflicting write", async () => {
	const backend = createKvDocumentBackend(config, "site");
	const store = createFileStore(backend, "site");
	let attempts = 0;
	const current = { json: JSON.stringify({ version: 1, siteId: "site", revision: 0, updatedAt: new Date(0).toISOString(), collections: {} }), etag: "etag" };
	await withFetch(
		(command) => {
			if (command[0] === "MGET") return json([current.etag, encodeState(current.json)]);
			attempts++;
			if (attempts === 1) return json(0);
			current.etag = String(command[6]);
			current.json = decodeState(String(command[7]));
			return json(1);
		},
		async () => {
			await store.update((state) => {
				state.collections.entities = { one: { id: "one" } };
			});
		},
	);
	assert.equal(attempts, 2);
	const read = await withFetch(
		(command) => {
			assert.equal(command[0], "MGET");
			return json([current.etag, encodeState(current.json)]);
		},
		() => store.read(),
	);
	assert.equal(read.revision, 1);
	assert.ok(read.collections.entities.one);
});

test("Cloudflare KV document backend reads, writes and detects a stale ETag", async () => {
	let value: string | null = null;
	let puts = 0;
	await withRawFetch(
		(url, init) => {
			assert.match(
				url,
				/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\/storage\/kv\/namespaces\/b{32}\/values\//,
			);
			if (init?.method === "GET")
				return value === null ? new Response("not found", { status: 404 }) : new Response(value);
			if (init?.method === "PUT") {
				puts++;
				value = String(init.body);
				return Response.json({ success: true });
			}
			throw new Error(`unexpected method ${init?.method}`);
		},
		async () => {
			const backend = createCloudflareKvDocumentBackend(cloudflareConfig, "site");
			assert.equal(await backend.read(), null);
			assert.equal(await backend.write('{"v":1}', null), true);
			const current = await backend.read();
			assert.equal(current?.json, '{"v":1}');
			assert.equal(await backend.write('{"v":2}', "stale-etag"), false);
			assert.equal(puts, 1);
		},
	);
});

test("Cloudflare KV backup provider stores immutable gzip values", async () => {
	const key = `admin-backup:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}`;
	const values = new Map<string, string>();
	const provider = createCloudflareKvBackupProvider(cloudflareConfig);
	await withRawFetch(
		(_url, init) => {
			const path = new URL(_url).pathname;
			const storedKey = decodeURIComponent(path.split("/values/")[1] || "");
			if (init?.method === "GET")
				return values.has(storedKey)
					? new Response(values.get(storedKey))
					: new Response("not found", { status: 404 });
			if (init?.method === "PUT") {
				values.set(storedKey, String(init.body));
				return Response.json({ success: true });
			}
			if (init?.method === "DELETE") {
				values.delete(storedKey);
				return Response.json({ success: true });
			}
			throw new Error(`unexpected method ${init?.method}`);
		},
		async () => {
			await provider.put(key, Buffer.from("backup"));
			assert.equal((await provider.get(key))?.toString(), "backup");
			await provider.put(key, Buffer.from("backup"));
			await assert.rejects(() => provider.put(key, Buffer.from("different")), /different bytes/);
			await provider.delete(key);
			assert.equal(await provider.get(key), null);
		},
	);
});

test("KV configuration requires production credentials and rejects shared non-production credentials", async () => {
	await withEnv(
		{
			APP_ENV: "production",
			VERCEL_ENV: undefined,
			KV_REST_API_URL: undefined,
			KV_REST_API_TOKEN: undefined,
			UPSTASH_REDIS_REST_URL: undefined,
			UPSTASH_REDIS_REST_TOKEN: undefined,
			CF_ACCOUNT_ID: undefined,
			CF_KV_NAMESPACE_ID: undefined,
			CF_API_TOKEN: undefined,
			CLOUDFLARE_ACCOUNT_ID: undefined,
			CLOUDFLARE_KV_NAMESPACE_ID: undefined,
			CLOUDFLARE_API_TOKEN: undefined,
			KV_PROVIDER: undefined,
		},
		() => assert.throws(() => storageConfig(), failure("KV_CONFIGURATION_REQUIRED", 503)),
	);
	await withEnv(
		{
			APP_ENV: "development",
			VERCEL_ENV: undefined,
			ADMIN_DEV_KV_REST_API_URL: undefined,
			ADMIN_DEV_KV_REST_API_TOKEN: undefined,
			KV_REST_API_URL: undefined,
			KV_REST_API_TOKEN: undefined,
			CF_ACCOUNT_ID: undefined,
			CF_KV_NAMESPACE_ID: undefined,
			CF_API_TOKEN: undefined,
			KV_PROVIDER: undefined,
		},
		() => assert.equal(storageConfig(), null),
	);
	await withEnv(
		{
			APP_ENV: "development",
			VERCEL_ENV: undefined,
			KV_REST_API_URL: "https://shared.example.invalid",
			KV_REST_API_TOKEN: "shared-token",
			ADMIN_DEV_KV_REST_API_URL: "https://shared.example.invalid",
			ADMIN_DEV_KV_REST_API_TOKEN: "shared-token",
			KV_PROVIDER: undefined,
		},
		() =>
			assert.throws(
				() => storageConfig(),
				failure("KV_ENVIRONMENT_NOT_ISOLATED", 503),
			),
	);
	await withEnv(
		{
			APP_ENV: "production",
			VERCEL_ENV: undefined,
			CF_ACCOUNT_ID: "a".repeat(32),
			CF_KV_NAMESPACE_ID: "b".repeat(32),
			CF_API_TOKEN: "cf-token",
			KV_PROVIDER: undefined,
		},
		() => {
			const config = storageConfig();
			assert.equal(config?.provider, "cloudflare");
			if (config?.provider === "cloudflare") {
				assert.equal(config.accountId, "a".repeat(32));
				assert.equal(config.namespaceId, "b".repeat(32));
			}
		},
	);
});

test("KV backup provider stores immutable gzip values", async () => {
	const key = `admin-backup:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}`;
	const values = new Map<string, string>();
	const provider = createKvBackupProvider(config);
	await withFetch(
		(command) => {
			const [name, arg, value] = command as string[];
			if (name === "SET") {
				if (values.has(arg)) return json(null);
				values.set(arg, value);
				return json("OK");
			}
			if (name === "GET") return json(values.get(arg) ?? null);
			if (name === "DEL") {
				values.delete(arg);
				return json(1);
			}
			throw new Error(`unexpected command ${name}`);
		},
		async () => {
			await provider.put(key, Buffer.from("backup"));
			assert.equal((await provider.get(key))?.toString(), "backup");
			await provider.put(key, Buffer.from("backup"));
			await assert.rejects(() => provider.put(key, Buffer.from("different")), /different bytes/);
			await provider.delete(key);
			assert.equal(await provider.get(key), null);
		},
	);
	await assert.rejects(() => provider.get("not-a-backup-key"), /Invalid backup key/);
});

test("KV command reports unavailable providers without leaking upstream bodies", async () => {
	await withFetch(
		() => new Response("upstream secret body", { status: 500 }),
		async () => assert.rejects(() => kvCommand(config, ["GET", "x"]), failure("KV_UNAVAILABLE", 503)),
	);
});
