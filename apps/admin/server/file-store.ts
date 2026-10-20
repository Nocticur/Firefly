import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ApiFailure, runtimeEnvironment } from "./security.js";
import { storageConfig } from "./storage-config.js";
import { createCloudflareKvDocumentBackend } from "./cloudflare-kv.js";
export type Row = Record<string, unknown>;
export type StoreState = {
	version: 1;
	siteId: string;
	revision: number;
	updatedAt: string;
	collections: Record<string, Record<string, Row>>;
	lastMutationIds?: string[];
};
export interface FileStore {
	read(): Promise<StoreState>;
	update<T>(fn: (state: StoreState) => T): Promise<T>;
}
export interface DocumentBackend {
	read(): Promise<{ json: string; etag: string } | null>;
	write(json: string, expectedEtag: string | null): Promise<boolean>;
}
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
function record(value: unknown): value is Row {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function empty(siteId: string): StoreState {
	return {
		version: 1,
		siteId,
		revision: 0,
		updatedAt: new Date().toISOString(),
		collections: {},
	};
}
export function assertSite(state: StoreState, site: string): void {
	if (state.siteId !== site)
		throw new ApiFailure(
			409,
			"STORE_SITE_MISMATCH",
			"文件存储不属于当前站点或环境",
		);
}
export function collection(
	state: StoreState,
	name: string,
): Record<string, Row> {
	if (
		!/^[a-z][a-z0-9_]*$/.test(name) ||
		["constructor", "prototype", "__proto__"].includes(name)
	)
		throw new TypeError("Invalid collection name");
	if (!Object.hasOwn(state.collections, name))
		state.collections[name] = Object.create(null);
	return state.collections[name];
}
function parse(json: string, site: string): StoreState {
	if (Buffer.byteLength(json) > MAX_STATE_BYTES)
		throw new ApiFailure(
			503,
			"FILE_STORE_TOO_LARGE",
			"后台状态文件超出大小限制",
		);
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new ApiFailure(
			503,
			"FILE_STORE_INVALID",
			"后台状态文件格式损坏，已停止写入",
		);
	}
	if (
		!record(value) ||
		value.version !== 1 ||
		value.siteId !== site ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0 ||
		typeof value.updatedAt !== "string" ||
		!record(value.collections)
	)
		throw new ApiFailure(
			503,
			"FILE_STORE_INVALID",
			"后台状态文件版本或站点不匹配，已停止写入",
		);
	if (
		value.lastMutationIds !== undefined &&
		(!Array.isArray(value.lastMutationIds) ||
			value.lastMutationIds.length > 128 ||
			value.lastMutationIds.some((id) => typeof id !== "string"))
	)
		throw new ApiFailure(
			503,
			"FILE_STORE_INVALID",
			"后台状态文件写入记录不合法",
		);
	const collections: StoreState["collections"] = Object.create(null);
	for (const [name, rows] of Object.entries(value.collections)) {
		if (
			!/^[a-z][a-z0-9_]*$/.test(name) ||
			["constructor", "prototype", "__proto__"].includes(name) ||
			!record(rows) ||
			Object.values(rows).some((row) => !record(row)) ||
			Object.keys(rows).some((key) =>
				["constructor", "prototype", "__proto__"].includes(key),
			)
		)
			throw new ApiFailure(
				503,
				"FILE_STORE_INVALID",
				"后台状态文件内容损坏，已停止写入",
			);
		collections[name] = Object.assign(Object.create(null), rows);
	}
	value.collections = collections;
	return value as StoreState;
}
function mutate<T>(
	state: StoreState,
	fn: (state: StoreState) => T,
	operationId = randomUUID(),
): { json: string; result: T } {
	const result = fn(state);
	if (result && typeof (result as { then?: unknown }).then === "function")
		throw new TypeError("FileStore mutations must be synchronous");
	state.revision++;
	state.updatedAt = new Date().toISOString();
	state.lastMutationIds = [...(state.lastMutationIds ?? []), operationId].slice(
		-128,
	);
	const json = JSON.stringify(state);
	if (Buffer.byteLength(json) > MAX_STATE_BYTES)
		throw new ApiFailure(
			507,
			"FILE_STORE_TOO_LARGE",
			"后台状态文件已满，本次修改未保存",
		);
	return { json, result: structuredClone(result) };
}
export function createFileStore(
	backend: DocumentBackend,
	site: string,
): FileStore {
	return {
		async read() {
			const current = await backend.read();
			return current ? parse(current.json, site) : empty(site);
		},
		async update<T>(fn: (state: StoreState) => T): Promise<T> {
			const operationId = randomUUID();
			let priorResult: T | undefined;
			let attempted = false;
			let priorRevision = 0;
			for (let attempt = 0; attempt < 12; attempt++) {
				const current = await backend.read();
				const state = current ? parse(current.json, site) : empty(site);
				// A provider retry may report a conflict after our first write committed.
				if (attempted && state.lastMutationIds?.includes(operationId))
					return structuredClone(priorResult) as T;
				if (attempted && state.revision - priorRevision >= 128)
					throw new ApiFailure(
						409,
						"FILE_STORE_CONFLICT",
						"后台文件变化较多，无法确认上次写入，请重新读取后核查",
					);
				const { json, result } = mutate(state, fn, operationId);
				parse(json, site);
				priorResult = result;
				attempted = true;
				priorRevision = state.revision;
				if (await backend.write(json, current?.etag ?? null)) return result;
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						5 + Math.random() * Math.min(100, 5 * 2 ** attempt),
					),
				);
			}
			throw new ApiFailure(
				409,
				"FILE_STORE_CONFLICT",
				"有其他操作同时修改后台文件，请稍后重试",
			);
		},
	};
}
export function createMemoryStore(
	site = "Nocticur/Firefly:development",
): FileStore {
	let json = JSON.stringify(empty(site));
	let tail = Promise.resolve();
	return {
		async read() {
			await tail;
			return parse(json, site);
		},
		async update<T>(fn: (state: StoreState) => T): Promise<T> {
			const previous = tail;
			let unlock!: () => void;
			tail = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			await previous;
			try {
				const next = mutate(parse(json, site), fn);
				parse(next.json, site);
				json = next.json;
				return next.result;
			} finally {
				unlock();
			}
		},
	};
}
export function getSiteId(): string {
	const repository = process.env.GITHUB_REPOSITORY || "Nocticur/Firefly";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
		throw new ApiFailure(
			503,
			"CONFIGURATION_REQUIRED",
			"GITHUB_REPOSITORY 格式无效",
		);
	return `${repository}:${runtimeEnvironment()}`;
}
const requestStore = new AsyncLocalStorage<FileStore>();
/** Server-side composition only: HTTP clients cannot select or replace the store. */
export function withStore<T>(store: FileStore, operation: () => T): T {
	return requestStore.run(store, operation);
}
export function getStore(): FileStore {
	const supplied = requestStore.getStore();
	if (supplied) return supplied;
	const site = getSiteId();
	const config = storageConfig();
	if (config) {
		const backend = createCloudflareKvDocumentBackend(config, site);
		return createFileStore(backend, site);
	}
	// Development and preview may run without a dedicated KV. Production throws
	// from storageConfig() above, so an unconfigured server never silently loses data.
	return createMemoryStore(site);
}
