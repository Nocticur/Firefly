import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".vercel/output");
const staticRoot = path.join(output, "static");

test("one Vercel output contains the unchanged static blog and release files", async () => {
	assert.ok(
		await stat(path.join(output, "config.json")).catch(() => null),
		"Run pnpm build:vercel: the shared Build Output API artifact is missing",
	);
	const config = JSON.parse(
		await readFile(path.join(output, "config.json"), "utf8"),
	);
	assert.equal(config.version, 3);
	const files = await readdir(path.join(root, "dist"), {
		recursive: true,
		withFileTypes: true,
	});
	for (const file of files.filter((entry) => entry.isFile())) {
		const source = path.join(file.parentPath, file.name);
		const relative = path.relative(path.join(root, "dist"), source);
		assert.deepEqual(
			await readFile(path.join(staticRoot, relative)),
			await readFile(source),
			`${relative} must be part of the same deployment`,
		);
	}
	const blogRoutes = config.routes.filter((route) =>
		route.dest?.endsWith("/index.html"),
	);
	assert.ok(blogRoutes.some((route) => new RegExp(route.src).test("/")));
	assert.ok(
		blogRoutes.some((route) => new RegExp(route.src).test("/archive/")),
	);
});

test("admin shell remains server protected and its built assets share /admin", async () => {
	const html = await readFile(
		path.join(root, "apps/admin/public/index.html"),
		"utf8",
	);
	const assets = [
		...html.matchAll(/(?:src|href)="(\/admin\/assets\/[^"?]+)(?:\?[^"]*)?"/g),
	].map((match) => match[1]);
	assert.ok(
		assets.length >= 2,
		"Admin scripts and styles must use /admin/assets/",
	);
	for (const asset of assets)
		assert.ok(
			(await stat(path.join(staticRoot, asset.slice(1)))).isFile(),
			asset,
		);
	assert.equal(
		await stat(path.join(staticRoot, "admin/index.html")).catch(() => null),
		null,
		"Admin HTML must pass through the CSP/no-store UI handler",
	);
	const functionConfig = JSON.parse(
		await readFile(
			path.join(output, "functions/__server.func/.vc-config.json"),
			"utf8",
		),
	);
	assert.match(functionConfig.runtime, /^nodejs/);
	assert.ok(
		(
			await stat(
				path.join(output, "functions/__server.func", functionConfig.handler),
			)
		).isFile(),
	);
	const deployed = JSON.parse(
		await readFile(path.join(output, "config.json"), "utf8"),
	);
	assert.ok(
		deployed.routes.some(
			(route) =>
				/\/admin\/assets/.test(route.src || "") &&
				route.headers?.["cache-control"]?.includes("immutable"),
		),
	);
	const functions = await readdir(path.join(output, "functions"), {
		recursive: true,
	});
	assert.ok(
		functions.some((file) => /workflow/i.test(file)),
		"The same deployment must include durable Workflow functions",
	);
});

test("shared output preserves response protections and never caches public release manifests", async () => {
	const config = JSON.parse(
		await readFile(path.join(output, "config.json"), "utf8"),
	);
	const routesFor = (pathname) =>
		config.routes.filter(
			(route) => route.src && new RegExp(route.src).test(pathname),
		);
	const headersFor = (pathname) =>
		Object.assign(
			{},
			...routesFor(pathname).map((route) =>
				Object.fromEntries(
					Object.entries(route.headers || {}).map(([key, value]) => [
						key.toLowerCase(),
						value,
					]),
				),
			),
		);
	assert.equal(headersFor("/")["x-content-type-options"], "nosniff");
	assert.equal(
		headersFor("/release-manifest.json")["cache-control"],
		"no-store",
	);
	assert.equal(
		headersFor("/deployment-manifest.json")["vercel-cdn-cache-control"],
		"no-store",
	);
	assert.equal(headersFor("/api/auth/entry")["cdn-cache-control"], "no-store");
	const filesystem = config.routes.findIndex(
		(route) => route.handle === "filesystem",
	);
	const assetHeaders = config.routes
		.slice(0, filesystem)
		.find(
			(route) =>
				route.src &&
				new RegExp(route.src).test("/admin/assets/index.js") &&
				route.headers?.["cache-control"]?.includes("immutable"),
		);
	assert.equal(
		assetHeaders.continue,
		true,
		"Cache headers must continue to the filesystem asset handler",
	);
});
