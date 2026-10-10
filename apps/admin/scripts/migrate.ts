import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getDatabase } from "../server/db.js";

const database = getDatabase();
try {
	await database.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
	const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
	for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
		const source = await readFile(`${directory}/${name}`, "utf8");
		await database.transaction(async (tx) => {
			await tx.query("SELECT pg_advisory_xact_lock(hashtext('firefly-admin-schema-migrations'))");
			if ((await tx.query("SELECT id FROM schema_migrations WHERE id = $1", [name])).length) return;
			await tx.query(source);
			await tx.query("INSERT INTO schema_migrations(id) VALUES($1)", [name]);
			console.log(`Applied ${name}`);
		});
	}
} finally { await database.close(); }
