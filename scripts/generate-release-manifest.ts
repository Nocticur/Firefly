import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slug as githubSlug } from "github-slugger";
import matter from "gray-matter";
import { assertDeploymentConfigRedirects } from "../apps/admin/server/release-format";

export type PublishedPost = {
	id: string;
	filePath: string;
	slug: string;
	sourceSha256: string;
};
export type Redirect = { from: string; to: string; permanent: true };
export type Artifact = { filePath: string; sha256: string; size: number };
export type ReleaseManifest = {
	schemaVersion: 1;
	gitSha: string;
	taskId: string | null;
	snapshotId: string | null;
	publicContentDigest: string;
	posts: Array<PublishedPost & { url: string; renderedSha256: string }>;
	pagefind: { sha256: string; files: Artifact[] };
	artifacts: { sha256: string; files: Artifact[] };
};
export type ManifestOptions = {
	repoRoot?: string;
	siteRoot?: string;
	env?: Record<string, string | undefined>;
};

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/i;
const MANIFEST_FILES = new Set([
	"release-manifest.json",
	"deployment-manifest.json",
]);

// Keep this wire contract identical to apps/admin/server/release-format.ts.
export function compareCodePoints(left: string, right: string): number {
	const a = Array.from(left, (character) => character.codePointAt(0)!);
	const b = Array.from(right, (character) => character.codePointAt(0)!);
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	}
	return a.length - b.length;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort(compareCodePoints)
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined)
		throw new Error("Public digest requires JSON values");
	return encoded;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function publicContentDigest(
	posts: PublishedPost[],
	settings: Record<string, unknown>,
	redirects: Redirect[],
): string {
	return sha256(
		canonicalJson({
			posts: [...posts].sort((a, b) => compareCodePoints(a.id, b.id)),
			settings,
			redirects: [...redirects].sort((a, b) =>
				compareCodePoints(a.from, b.from),
			),
		}),
	);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be a JSON object`);
	return value as Record<string, unknown>;
}

function safePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\\") &&
		!path.posix.isAbsolute(value) &&
		!value
			.split("/")
			.some(
				(segment) => segment === ".." || segment === "." || segment === "",
			) &&
		![...value].some((character) => character.charCodeAt(0) < 32)
	);
}

function safeSlug(value: unknown): value is string {
	return safePath(value) && !/[?#%]/.test(value);
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		throw new Error(`Cannot read valid JSON from ${file}`);
	}
}

export function resolveGitSha(
	repoRoot: string,
	env: Record<string, string | undefined>,
): string {
	const configured = env.VERCEL_GIT_COMMIT_SHA?.trim();
	if (configured !== undefined && !SHA.test(configured))
		throw new Error(
			"VERCEL_GIT_COMMIT_SHA must be a full 40-character Git SHA",
		);
	const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const local = result.status === 0 ? result.stdout.trim() : undefined;
	if (local !== undefined && !SHA.test(local))
		throw new Error("Local Git HEAD is not a supported full Git SHA");
	if (configured && local && configured.toLowerCase() !== local.toLowerCase())
		throw new Error(
			"VERCEL_GIT_COMMIT_SHA differs from the actual checked-out Git HEAD",
		);
	const gitSha = configured || local;
	if (!gitSha)
		throw new Error(
			"Cannot identify the build Git SHA: supply VERCEL_GIT_COMMIT_SHA or build from a Git checkout",
		);
	return gitSha.toLowerCase();
}

async function walkFiles(directory: string, prefix = ""): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink())
			throw new Error(`Cannot hash a symlink in the build inputs: ${relative}`);
		if (entry.isDirectory())
			files.push(
				...(await walkFiles(path.join(directory, entry.name), relative)),
			);
		else if (entry.isFile()) files.push(relative);
	}
	return files.sort(compareCodePoints);
}

async function artifact(
	directory: string,
	filePath: string,
): Promise<Artifact> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path.join(directory, filePath))) {
		hash.update(chunk);
		size += chunk.length;
	}
	return { filePath, sha256: hash.digest("hex"), size };
}

function sourceMetadata(
	bytes: Buffer,
	filePath: string,
): { slug: string; draft: boolean; explicitSlug: boolean } {
	const source = bytes.toString("utf8");
	if (!Buffer.from(source, "utf8").equals(bytes))
		throw new Error(`Article source must be valid UTF-8: ${filePath}`);
	if (!/^(?:\uFEFF)?---\r?\n/.test(source))
		throw new Error(`Article requires YAML front matter: ${filePath}`);
	const metadata = record(matter(source).data, `Article metadata ${filePath}`);
	if (metadata.draft !== undefined && typeof metadata.draft !== "boolean")
		throw new Error(`Article draft flag must be boolean: ${filePath}`);
	if (metadata.slug !== undefined && typeof metadata.slug !== "string")
		throw new Error(`Article slug must be a string: ${filePath}`);
	const relative = filePath
		.replace(/^src\/content\/posts\//, "")
		.replace(/\.(md|mdx)$/i, "");
	const slug = (metadata.slug ||
		relative
			.split("/")
			.map((part) => githubSlug(part))
			.join("/")
			.replace(/\/index$/, "")) as string;
	return {
		slug: slug.replace(/\.(md|mdx|markdown)$/i, ""),
		draft: metadata.draft === true,
		explicitSlug: metadata.slug !== undefined,
	};
}

/** Run only after HTML minification and Pagefind have finished. Never changes article sources. */
export async function generateReleaseManifest(
	options: ManifestOptions = {},
): Promise<ReleaseManifest> {
	const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
	const siteRoot = path.resolve(
		options.siteRoot ??
			path.join(
				repoRoot,
				existsSync(path.join(repoRoot, "dist/client")) ? "dist/client" : "dist",
			),
	);
	const gitSha = resolveGitSha(repoRoot, options.env ?? process.env);
	const state = record(
		await readJson(path.join(repoRoot, "src/data/published-state.json")),
		"Published state",
	);
	const settings = record(
		await readJson(path.join(repoRoot, "src/data/managed-settings.json")),
		"Managed settings wrapper",
	);
	if (
		state.schemaVersion !== 1 ||
		settings.schemaVersion !== 1 ||
		!Array.isArray(state.posts)
	)
		throw new Error(
			"Published state and managed settings must use schemaVersion 1",
		);
	record(settings.settings, "Managed settings");
	const taskId = state.taskId == null ? null : String(state.taskId);
	const snapshotId = state.snapshotId == null ? null : String(state.snapshotId);
	if (
		(taskId === null) !== (snapshotId === null) ||
		(taskId !== null && !UUID.test(taskId)) ||
		(snapshotId !== null && !UUID.test(snapshotId))
	)
		throw new Error(
			"Published taskId and snapshotId must both be stable UUIDs or both null for the initial baseline",
		);
	if ((state.publicContentDigest == null) !== (taskId === null))
		throw new Error(
			"A frozen release requires its expected publicContentDigest; the initial baseline has null release identifiers",
		);
	if (
		state.publicContentDigest != null &&
		(typeof state.publicContentDigest !== "string" ||
			!HASH.test(state.publicContentDigest))
	)
		throw new Error(
			"Published state publicContentDigest must be a SHA256 hash",
		);
	const posts = state.posts
		.map((value): PublishedPost => {
			const post = record(value, "Published post");
			if (
				typeof post.id !== "string" ||
				!UUID.test(post.id) ||
				!safePath(post.filePath) ||
				!/^src\/content\/posts\/.+\.(md|mdx)$/.test(post.filePath) ||
				!safeSlug(post.slug) ||
				typeof post.sourceSha256 !== "string" ||
				!HASH.test(post.sourceSha256)
			)
				throw new Error(
					"Each published post requires a stable UUID, safe source path, fixed slug and exact sourceSha256",
				);
			return {
				id: post.id,
				filePath: post.filePath,
				slug: post.slug,
				sourceSha256: post.sourceSha256,
			};
		})
		.sort((a, b) => compareCodePoints(a.id, b.id));
	for (const key of ["id", "filePath", "slug"] as const)
		if (new Set(posts.map((post) => post[key])).size !== posts.length)
			throw new Error(`Duplicate published post ${key}`);
	const redirectsInput = await readJson(
		path.join(repoRoot, "src/data/redirects.json"),
	);
	if (!Array.isArray(redirectsInput))
		throw new Error("Redirects must be a JSON array");
	const redirects = redirectsInput.map((value): Redirect => {
		const entry = record(value, "Redirect");
		if (
			typeof entry.from !== "string" ||
			typeof entry.to !== "string" ||
			!entry.from.startsWith("/") ||
			!entry.to.startsWith("/") ||
			entry.from.startsWith("//") ||
			entry.to.startsWith("//") ||
			entry.permanent !== true
		)
			throw new Error(
				"Each redirect requires site-relative from/to paths and permanent: true",
			);
		return { from: entry.from, to: entry.to, permanent: true };
	});
	if (new Set(redirects.map((entry) => entry.from)).size !== redirects.length)
		throw new Error("Duplicate redirect source");
	if (redirects.length) {
		const deploymentConfig = await readJson(path.join(repoRoot, "vercel.json"));
		assertDeploymentConfigRedirects(deploymentConfig, redirects);
	}
	const byPath = new Map(posts.map((post) => [post.filePath, post]));
	const found = new Set<string>();
	const draftOutputs = new Set<string>();
	const contentRoot = path.join(repoRoot, "src/content/posts");
	for (const relative of (await walkFiles(contentRoot)).filter((file) =>
		/\.(md|mdx)$/i.test(file),
	)) {
		const filePath = `src/content/posts/${relative}`;
		const bytes = await readFile(path.join(contentRoot, relative));
		const metadata = sourceMetadata(bytes, filePath);
		const mapped = byPath.get(filePath);
		if (metadata.draft) {
			if (mapped)
				throw new Error(
					`A draft cannot appear in the public ID mapping: ${filePath}`,
				);
			draftOutputs.add(`posts/${metadata.slug}/index.html`);
			continue;
		}
		if (!mapped)
			throw new Error(
				`Public article is missing its stable UUID mapping: ${filePath}`,
			);
		if (metadata.explicitSlug && mapped.slug !== metadata.slug)
			throw new Error(
				`Published slug differs from the explicit article slug: ${filePath}`,
			);
		if (mapped.sourceSha256 !== sha256(bytes))
			throw new Error(
				`Published sourceSha256 differs from the actual saved source bytes: ${filePath}`,
			);
		found.add(filePath);
	}
	for (const post of posts)
		if (!found.has(post.filePath))
			throw new Error(`Mapped public source is missing: ${post.filePath}`);
	const digest = publicContentDigest(posts, settings, redirects);
	if (state.publicContentDigest != null && digest !== state.publicContentDigest)
		throw new Error(
			"Public content digest differs from the frozen snapshot; review article bytes, managed settings and redirects before publishing",
		);
	const files = (await walkFiles(siteRoot)).filter(
		(file) => !MANIFEST_FILES.has(file),
	);
	for (const draftOutput of draftOutputs)
		if (files.includes(draftOutput))
			throw new Error(
				`Private draft HTML is present in the production output: ${draftOutput}`,
			);
	const artifacts: Artifact[] = [];
	for (const file of files) artifacts.push(await artifact(siteRoot, file));
	const rendered = new Map(
		artifacts.map((entry) => [entry.filePath, entry.sha256]),
	);
	const renderedPosts = posts.map((post) => {
		const renderedSha256 = rendered.get(`posts/${post.slug}/index.html`);
		if (!renderedSha256)
			throw new Error(
				`Rendered public article is missing; run the complete Astro build first: ${post.slug}`,
			);
		return { ...post, url: `/posts/${post.slug}/`, renderedSha256 };
	});
	const pagefind = artifacts.filter((entry) =>
		entry.filePath.startsWith("pagefind/"),
	);
	if (
		!pagefind.some((entry) => entry.filePath === "pagefind/pagefind.js") ||
		!pagefind.some((entry) => entry.filePath === "pagefind/pagefind-entry.json")
	)
		throw new Error(
			"Final Pagefind artifacts are missing; run this script after scripts/run-pagefind.ts",
		);
	const manifest: ReleaseManifest = {
		schemaVersion: 1,
		gitSha,
		taskId,
		snapshotId,
		publicContentDigest: digest,
		posts: renderedPosts,
		pagefind: { sha256: sha256(canonicalJson(pagefind)), files: pagefind },
		artifacts: { sha256: sha256(canonicalJson(artifacts)), files: artifacts },
	};
	const output = `${JSON.stringify(manifest, null, 2)}\n`;
	for (const file of MANIFEST_FILES)
		await writeFile(path.join(siteRoot, file), output, "utf8");
	return manifest;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	generateReleaseManifest()
		.then((manifest) => {
			console.log(
				`Release manifests written for ${manifest.posts.length} public articles, ${manifest.pagefind.files.length} Pagefind artifacts and Git ${manifest.gitSha}`,
			);
		})
		.catch((error: unknown) => {
			console.error(
				`Release manifest generation failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
			process.exitCode = 1;
		});
}
