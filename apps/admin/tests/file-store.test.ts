import test from "node:test";
import assert from "node:assert/strict";
import { ApiFailure } from "../server/security.js";
import {
	collection,
	createFileStore,
	createMemoryStore,
	type DocumentBackend,
} from "../server/file-store.js";

test("private JSON updates survive new store instances and retry competing writes", async () => {
	let bytes: string | null = null;
	let etag = 0;
	const backend: DocumentBackend = {
		async read() {
			return bytes === null ? null : { json: bytes, etag: String(etag) };
		},
		async write(json, expected) {
			if (expected !== (bytes === null ? null : String(etag))) return false;
			bytes = json;
			etag++;
			return true;
		},
	};
	const first = createFileStore(backend, "tests/files:production");
	const second = createFileStore(backend, "tests/files:production");
	await Promise.all(
		[first, second].map((store) =>
			store.update((state) => {
				const rows = collection(state, "counters");
				rows.total = { count: Number(rows.total?.count ?? 0) + 1 };
			}),
		),
	);
	assert.equal(
		collection(
			await createFileStore(backend, "tests/files:production").read(),
			"counters",
		).total.count,
		2,
	);
	assert.equal((await first.read()).revision, 2);
});
test("site isolation, corrupt state and unavailable storage fail closed", async () => {
	const state = await createMemoryStore("tests/other:production").read();
	for (const json of [
		"broken json",
		JSON.stringify(state),
		JSON.stringify({ ...state, siteId: "tests/files:production", version: 9 }),
	]) {
		const store = createFileStore(
			{
				async read() {
					return { json, etag: "v1" };
				},
				async write() {
					throw Error("must not overwrite");
				},
			},
			"tests/files:production",
		);
		await assert.rejects(store.read(), ApiFailure);
	}
	const store = createFileStore(
		{
			async read() {
				throw Error("offline");
			},
			async write() {
				throw Error("must not write");
			},
		},
		"tests/files:production",
	);
	await assert.rejects(
		store.update(() => true),
		/offline/,
	);
});
test("a lost write acknowledgement cannot apply the same mutation twice", async () => {
	let bytes: string | null = null;
	let etag = 0;
	let lost = true;
	const store = createFileStore(
		{
			async read() {
				return bytes === null ? null : { json: bytes, etag: String(etag) };
			},
			async write(json, expected) {
				assert.equal(expected, bytes === null ? null : String(etag));
				bytes = json;
				etag++;
				if (lost) {
					lost = false;
					return false;
				}
				return true;
			},
		},
		"tests/ack:production",
	);
	await store.update((state) => {
		const rows = collection(state, "counter");
		rows.item = { count: Number(rows.item?.count ?? 0) + 1 };
	});
	assert.equal(collection(await store.read(), "counter").item.count, 1);
});
test("memory fixtures clone reads and transaction results and reject async mutations", async () => {
	const store = createMemoryStore("tests/files:development");
	const result = await store.update((state) => {
		const rows = collection(state, "examples");
		rows.item = { name: "original" };
		return rows.item;
	});
	result.name = "outside mutation";
	const snapshot = await store.read();
	collection(snapshot, "examples").item.name = "outside snapshot";
	assert.equal(
		collection(await store.read(), "examples").item.name,
		"original",
	);
	await assert.rejects(
		store.update(async () => true),
		/synchronous/,
	);
});
test("persisted collection lookups never resolve inherited prototype properties", async () => {
	const store = createMemoryStore("tests/prototypes:development");
	await store.update((state) => {
		collection(state, "release_tasks").safe = { id: "safe" };
	});
	const rows = collection(await store.read(), "release_tasks");
	assert.equal(rows.constructor, undefined);
	assert.equal(rows.__proto__, undefined);
	assert.equal(Object.getPrototypeOf(rows), null);
});
test("an acknowledgement outside the bounded operation history stops instead of applying again", async () => {
	let bytes: string | null = null;
	const store = createFileStore(
		{
			async read() {
				return bytes === null ? null : { json: bytes, etag: "latest" };
			},
			async write(json) {
				const state = JSON.parse(json);
				state.revision += 128;
				state.lastMutationIds = Array.from(
					{ length: 128 },
					(_, index) => `other-${index}`,
				);
				bytes = JSON.stringify(state);
				return false;
			},
		},
		"tests/late-ack:production",
	);
	await assert.rejects(
		store.update((state) => {
			const rows = collection(state, "counter");
			rows.item = { count: Number(rows.item?.count ?? 0) + 1 };
		}),
		(error: unknown) =>
			error instanceof ApiFailure && error.code === "FILE_STORE_CONFLICT",
	);
	assert.equal(collection(await store.read(), "counter").item.count, 1);
});
