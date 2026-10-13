import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTransformedRoutes, mergeRoutes } from "@vercel/routing-utils";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function finalizeIntegratedVercel() {
	const output = path.join(root, ".vercel/output");
	const configPath = path.join(output, "config.json");
	const config = JSON.parse(await readFile(configPath, "utf8"));
	const deploymentConfig = JSON.parse(
		await readFile(path.join(root, "vercel.json"), "utf8"),
	);
	const staticRoot = path.join(output, "static");
	const entries = await readdir(staticRoot, {
		recursive: true,
		withFileTypes: true,
	});
	const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	// Astro emits directory index files. Build Output API keeps filenames verbatim,
	// so preserve their canonical trailing-slash URLs before the filesystem handler.
	const indexRoutes = entries
		.filter((entry) => entry.isFile() && entry.name === "index.html")
		.map((entry) => {
			const directory = path
				.relative(staticRoot, entry.parentPath)
				.split(path.sep)
				.join("/");
			const route = directory ? `/${directory}/` : "/";
			const encoded = encodeURI(route);
			return {
				src:
					route === encoded
						? `^${escapeRegex(route)}$`
						: `^(?:${escapeRegex(route)}|${escapeRegex(encoded)})$`,
				dest: `${encoded}index.html`,
			};
		});
	const filesystem = config.routes.findIndex(
		(route) => route.handle === "filesystem",
	);
	if (filesystem < 0) throw new Error("Nitro did not emit a filesystem route.");
	config.routes.splice(filesystem, 0, ...indexRoutes);
	for (const route of config.routes) {
		if (route.headers && !route.dest && !route.status) route.continue = true;
	}
	// Use Vercel's converter so exact article redirects and the existing headers
	// retain the same path-pattern semantics as the root deployment configuration.
	const transformed = getTransformedRoutes(deploymentConfig);
	if (transformed.error)
		throw new Error(`Invalid Vercel routes: ${transformed.error.message}`);
	config.routes = mergeRoutes({
		userRoutes: transformed.routes || [],
		builds: [{ entrypoint: ".", use: "nitro", routes: config.routes }],
	});
	config.crons = deploymentConfig.crons;
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await finalizeIntegratedVercel();
}
