import postgres from "postgres";
import { createHash } from "node:crypto";
import { ApiFailure, runtimeEnvironment } from "./security.js";

export interface Database {
	query<T extends Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
	transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export function createDatabase(url: string): Database {
	const client = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 10, prepare: false });
	const wrap = (sql: typeof client, close = false): Database => ({
		async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
			// postgres infers a jsonb parameter from the SQL cast and serializes strings
			// again. Bind already serialized strings as text before PostgreSQL casts them.
			const values = params.map((value) => typeof value === "string" ? sql.typed(value, 25) : value);
			return await sql.unsafe(text, values as never[]) as unknown as T[];
		},
		async transaction<T>(fn: (tx: Database) => Promise<T>) {
			return await sql.begin(async (tx) => fn(wrap(tx as unknown as typeof client))) as T;
		},
		async close() { if (close) await client.end({ timeout: 5 }); },
	});
	return wrap(client, true);
}

export function getSiteId(): string {
	const repository = process.env.GITHUB_REPOSITORY || "Nocticur/Firefly";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new ApiFailure(503, "CONFIGURATION_REQUIRED", "GITHUB_REPOSITORY 格式无效");
	return `${repository}:${runtimeEnvironment()}`;
}

let connection: Database | undefined;
let connectionFingerprint: string | undefined;
export function getDatabase(): Database {
	const environment = runtimeEnvironment();
	const url = environment === "production"
		? process.env.ADMIN_PRODUCTION_DATABASE_URL || process.env.DATABASE_URL
		: environment === "preview"
			? process.env.ADMIN_PREVIEW_DATABASE_URL || process.env.PREVIEW_DATABASE_URL
			: process.env.ADMIN_DEVELOPMENT_DATABASE_URL || process.env.ADMIN_DATABASE_URL;
	if (!url) throw new ApiFailure(503, "DATABASE_CONFIGURATION_REQUIRED", `缺少 ${environment} 环境的隔离 PostgreSQL 连接配置`);
	const fingerprint = createHash("sha256").update(`${environment}:${url}`).digest("hex");
	if (!connection || connectionFingerprint !== fingerprint) {
		connection = createDatabase(url);
		connectionFingerprint = fingerprint;
	}
	return connection;
}
