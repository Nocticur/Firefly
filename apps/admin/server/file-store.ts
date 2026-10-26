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
	/**
	 * Version history and release snapshots live in a second document so the hot one stays
	 * small. Backends without a cold document (in-process memory) simply keep them inline.
	 */
	readCold(): Promise<StoreState>;
	updateCold<T>(fn: (state: StoreState) => T): Promise<T>;
	/** One logical change spanning both documents (for example freeze: task + snapshot). */
	updateBoth<T>(fn: (hot: StoreState, cold: StoreState) => T): Promise<T>;
	/** Records an auxiliary failure that must stay visible instead of being swallowed. */
	noteOperation(kind: string, payload: Row, reason: string): Promise<void>;
	/** Finishes cross-document writes left behind by an interrupted request. */
	recoverPendingOperations(): Promise<void>;
	/** Folds history and snapshots left in the hot document into the cold one. */
	migrateLegacyColdRows(): Promise<boolean>;
}
export interface DocumentBackend {
	read(): Promise<{ json: string; etag: string } | null>;
	write(json: string, expectedEtag: string | null): Promise<boolean>;
	readCold?(): Promise<{ json: string; etag: string } | null>;
	writeCold?(json: string, expectedEtag: string | null): Promise<boolean>;
}
/**
 * These two are not the same thing: history is a row *kind* inside `entities`, while release
 * snapshots are a real collection. Keep them apart so every check uses the right axis.
 */
export const COLD_ROW_KINDS = ["post_version"] as const;
export const COLD_COLLECTIONS = ["release_snapshots"] as const;
function isColdRow(row: Row): boolean {
	return (COLD_ROW_KINDS as readonly string[]).includes(String(row.kind));
}
function withoutCold(state: StoreState): StoreState {
	const entities = state.collections.entities;
	if (entities) for (const [key, row] of Object.entries(entities)) if (isColdRow(row)) delete entities[key];
	delete state.collections.release_snapshots;
	return state;
}
function coldOnly(state: StoreState, site: string): StoreState {
	const cold = empty(site);
	cold.updatedAt = state.updatedAt;
	const versions = Object.entries(state.collections.entities ?? {}).filter(([, row]) => isColdRow(row));
	if (versions.length) cold.collections.entities = Object.assign(Object.create(null), Object.fromEntries(versions));
	const snapshots = state.collections.release_snapshots;
	if (snapshots) cold.collections.release_snapshots = Object.assign(Object.create(null), snapshots);
	return cold;
}
function hasColdRows(state: StoreState): boolean {
	return Object.values(state.collections.entities ?? {}).some((row) => isColdRow(row))
		|| Object.keys(state.collections.release_snapshots ?? {}).length > 0;
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
	// One admin page fires several parallel API calls and each used to re-download and
	// re-parse the whole state document. A very short cache collapses them into a single
	// read; every write invalidates it so a save is never followed by stale data.
	const readCacheMs = 1500;
	let cached: { json: string; etag: string; at: number } | null = null;
	const split = typeof backend.readCold === "function" && typeof backend.writeCold === "function";

	async function readHot(): Promise<StoreState> {
		if (cached && Date.now() - cached.at < readCacheMs)
			return parse(cached.json, site);
		const current = await backend.read();
		if (!current) { cached = null; return empty(site); }
		cached = { json: current.json, etag: current.etag, at: Date.now() };
		return parse(current.json, site);
	}
	async function updateHot<T>(fn: (state: StoreState) => T): Promise<T> {
		const operationId = randomUUID();
		let priorResult: T | undefined;
		let attempted = false;
		let priorRevision = 0;
		// Writes must always see the authoritative document, never the short-lived cache.
		cached = null;
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
	}
	async function stripColdFromHot(): Promise<void> {
		const hot = await readHot();
		if (!hasColdRows(hot)) return;
		await updateHot((state) => withoutCold(state));
	}
	/**
	 * Moves history rows and snapshots that older deployments left in the hot document into the
	 * cold one. Cold is written first and the hot rows only removed afterwards, so an interrupted
	 * run leaves duplicates that the next run overwrites with the same keys.
	 */
	async function migrateLegacyColdRows(): Promise<boolean> {
		if (!split) return false;
		const hot = await readHot();
		if (!hasColdRows(hot)) return false;
		const moving = coldOnly(hot, site);
		await updateCold((cold) => {
			const entities = collection(cold, "entities");
			for (const [key, row] of Object.entries(moving.collections.entities ?? {})) entities[key] = row;
			const snapshots = collection(cold, "release_snapshots");
			for (const [key, row] of Object.entries(moving.collections.release_snapshots ?? {})) snapshots[key] = row;
		});
		await stripColdFromHot();
		return true;
	}
	async function readCold(): Promise<StoreState> {
		// Backends without a cold document (in-process memory) keep everything inline.
		if (!split) return readHot();
		await maybeRecover();
		const current = await backend.readCold!();
		if (await migrateLegacyColdRows()) {
			const refreshed = await backend.readCold!();
			return refreshed ? parse(refreshed.json, site) : empty(site);
		}
		return current ? parse(current.json, site) : empty(site);
	}
	async function updateCold<T>(fn: (state: StoreState) => T): Promise<T> {
		if (!split) return updateHot(fn);
		const operationId = randomUUID();
		let priorResult: T | undefined;
		let attempted = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			const current = await backend.readCold!();
			const state = current ? parse(current.json, site) : empty(site);
			if (attempted && state.lastMutationIds?.includes(operationId))
				return structuredClone(priorResult) as T;
			const { json, result } = mutate(state, fn, operationId);
			parse(json, site);
			priorResult = result;
			attempted = true;
			if (await backend.writeCold!(json, current?.etag ?? null)) return result;
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
			"后台历史文件被同时修改，请稍后重试",
		);
	}
	/**
	 * Cross-document writes are journalled in the hot document so an interrupted request can be
	 * finished by the next one. The journal only stores a compact row patch, never cold payloads.
	 */
	type RowPatch = { collection: string; key: string; row: Row | null };
	const OPERATIONS = "storage_operations";
	const OPERATION_STALE_MS = 10_000;
	function operationsOf(state: StoreState): Record<string, Row> {
		return collection(state, OPERATIONS);
	}
	function diffCollections(before: StoreState, after: StoreState): RowPatch[] {
		const patches: RowPatch[] = [];
		for (const name of new Set([...Object.keys(before.collections), ...Object.keys(after.collections)])) {
			if (name === OPERATIONS) continue;
			const beforeRows = before.collections[name] ?? {};
			const afterRows = after.collections[name] ?? {};
			for (const key of new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)])) {
				const beforeRow = beforeRows[key];
				const afterRow = afterRows[key];
				if (afterRow === undefined) { if (beforeRow) patches.push({ collection: name, key, row: null }); continue; }
				if (!beforeRow || JSON.stringify(beforeRow) !== JSON.stringify(afterRow)) patches.push({ collection: name, key, row: afterRow });
			}
		}
		return patches;
	}
	function applyPatches(state: StoreState, patches: RowPatch[]): void {
		for (const patch of patches) {
			const rows = collection(state, patch.collection);
			if (patch.row === null) delete rows[patch.key];
			else rows[patch.key] = patch.row;
		}
	}
	async function recoverPendingOperations(): Promise<void> {
		if (!split) return;
		const hot = await readHot();
		const pending = Object.values(operationsOf(hot)).filter((row) => ["prepared", "cold-written"].includes(String(row.state)));
		if (!pending.length) return;
		const coldDoc = await backend.readCold!();
		const cold = coldDoc ? parse(coldDoc.json, site) : empty(site);
		for (const row of pending) {
			const id = String(row.id);
			const patches = Array.isArray(row.payload) ? row.payload as RowPatch[] : [];
			const now = new Date().toISOString();
			if (!(cold.lastMutationIds ?? []).includes(id)) {
				// Nothing reached the cold document, so the business change never happened.
				// A fresh record may still belong to a request that is about to write it.
				if (Date.now() - new Date(String(row.updated_at)).getTime() < OPERATION_STALE_MS) continue;
				await updateHot((state) => {
					const current = operationsOf(state)[id];
					if (!current || current.state === "completed") return;
					operationsOf(state)[id] = { ...current, state: "failed", reason: "冷文档未写入，业务变更未生效", updated_at: now };
				});
				continue;
			}
			// The cold side is durable, so re-applying the hot patch is safe and idempotent.
			await updateHot((state) => {
				const current = operationsOf(state)[id];
				if (!current || current.state === "completed") return;
				applyPatches(state, patches);
				operationsOf(state)[id] = { ...current, state: "completed", updated_at: now };
			});
		}
	}
	let recovering = false;
	async function maybeRecover(): Promise<void> {
		if (!split || recovering) return;
		recovering = true;
		try { await recoverPendingOperations(); } finally { recovering = false; }
	}
	async function updateBoth<T>(fn: (hot: StoreState, cold: StoreState) => T): Promise<T> {
		// Inline backends have a single document, so both views are the same object.
		if (!split) return updateHot((state) => fn(state, state));
		cached = null;
		await maybeRecover();
		const operationId = randomUUID();
		for (let attempt = 0; attempt < 12; attempt++) {
			const [hotDoc, coldDoc] = await Promise.all([backend.read(), backend.readCold!()]);
			const hotBase = hotDoc ? parse(hotDoc.json, site) : empty(site);
			const coldBase = coldDoc ? parse(coldDoc.json, site) : empty(site);
			const known = operationsOf(hotBase)[operationId];
			if (known && String(known.state) === "completed") return structuredClone(known.result) as T;
			// Compute the business change on copies so it can be journalled before it is durable.
			const hotNext = structuredClone(hotBase);
			const coldNext = structuredClone(coldBase);
			const result = fn(hotNext, coldNext);
			const patches = diffCollections(hotBase, hotNext);
			const now = new Date().toISOString();
			// Phase 1: record the intent. A crash after this point is recoverable.
			const prepared = mutate(hotBase, (state) => {
				operationsOf(state)[operationId] = { id: operationId, kind: "cross-document", state: "prepared", payload: patches, result, created_at: now, updated_at: now };
			}, operationId).json;
			if (!await attemptWrite(() => backend.write(prepared, hotDoc?.etag ?? null))) { await retryDelay(attempt); continue; }
			// Phase 2: the cold payload, marked with the same operation id.
			const coldJson = mutate(coldNext, () => undefined, operationId).json;
			if (!await attemptWrite(() => backend.writeCold!(coldJson, coldDoc?.etag ?? null))) { await retryDelay(attempt); continue; }
			// Phase 3: apply the hot business change and close the journal entry.
			const committedDoc = await backend.read();
			const committed = committedDoc ? parse(committedDoc.json, site) : empty(site);
			if (operationsOf(committed)[operationId]?.state === "completed") return structuredClone(result) as T;
			const finalJson = mutate(committed, (state) => {
				applyPatches(state, patches);
				const entry = operationsOf(state)[operationId];
				if (entry) operationsOf(state)[operationId] = { ...entry, state: "completed", updated_at: new Date().toISOString() };
			}, operationId).json;
			if (await attemptWrite(() => backend.write(finalJson, committedDoc?.etag ?? null))) return result;
			await retryDelay(attempt);
		}
		throw new ApiFailure(
			409,
			"STORAGE_OPERATION_PENDING",
			"跨文档写入尚未完成，请稍后重试；系统会在下一次请求自动恢复",
		);
	}
	async function retryDelay(attempt: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * Math.min(100, 5 * 2 ** attempt)));
	}
	/** Provider errors count as a failed attempt; the journal keeps the change recoverable. */
	async function attemptWrite(write: () => Promise<boolean>): Promise<boolean> {
		try { return await write(); } catch { return false; }
	}
	async function noteOperation(kind: string, payload: Row, reason: string): Promise<void> {
		const id = randomUUID();
		const now = new Date().toISOString();
		await updateHot((state) => {
			operationsOf(state)[id] = { id, kind, state: "failed", payload: { ...payload, error: reason }, reason, created_at: now, updated_at: now };
		});
	}
	return {
		read: async () => { await maybeRecover(); return readHot(); },
		update: async <T>(fn: (state: StoreState) => T) => { await maybeRecover(); return updateHot(fn); },
		readCold,
		updateCold,
		updateBoth,
		noteOperation,
		recoverPendingOperations,
		migrateLegacyColdRows,
	};
}
export function createMemoryStore(
	site = "Nocticur/Firefly:development",
): FileStore {
	let json = JSON.stringify(empty(site));
	let tail = Promise.resolve();
	async function readState(): Promise<StoreState> {
		await tail;
		return parse(json, site);
	}
	async function updateState<T>(fn: (state: StoreState) => T): Promise<T> {
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
	}
	return {
		read: readState,
		update: updateState,
		// No separate document in memory: history and snapshots stay in the single state.
		readCold: readState,
		updateCold: updateState,
		updateBoth: <T>(fn: (hot: StoreState, cold: StoreState) => T) => updateState((state) => fn(state, state)),
		noteOperation: async (kind: string, payload: Row, reason: string) => {
			const id = randomUUID();
			const now = new Date().toISOString();
			await updateState((state) => {
				collection(state, "storage_operations")[id] = { id, kind, state: "failed", payload: { ...payload, error: reason }, reason, created_at: now, updated_at: now };
			});
		},
		recoverPendingOperations: async () => {},
		migrateLegacyColdRows: async () => false,
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
const memoryStores = new Map<string, FileStore>();
export function getStore(): FileStore {
	const supplied = requestStore.getStore();
	if (supplied) return supplied;
	const site = getSiteId();
	const config = storageConfig();
	if (config) {
		const backend = createCloudflareKvDocumentBackend(config, site);
		return createFileStore(backend, site);
	}
	// Cloudflare KV is optional: content and settings come from the Git repository, so an
	// unconfigured deployment runs on an in-process store. It is cached per site because a
	// fresh store per call would discard every draft as soon as the request ended.
	let memory = memoryStores.get(site);
	if (!memory) {
		memory = createMemoryStore(site);
		memoryStores.set(site, memory);
	}
	return memory;
}
