import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtemp,
	mkdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import {
	canonicalJson as serverCanonicalJson,
	publicContentDigest as serverDigest,
} from "../apps/admin/server/release-format";
import {
	canonicalJson,
	generateReleaseManifest,
	publicContentDigest,
	resolveGitSha,
	type PublishedPost,
} from "./generate-release-manifest";

const sha = "a".repeat(40);
const taskId = "177a03d7-6cff-57c7-84b4-ff2a926c7f72";
const snapshotId = "6bce6fca-3b83-56eb-84bf-82959e61519d";
const hash = (source: string): string =>
	createHash("sha256").update(source).digest("hex");

type Fixture = {
	repoRoot: string;
	siteRoot: string;
	posts: PublishedPost[];
	settings: Record<string, unknown>;
	state: {
		schemaVersion: number;
		posts: PublishedPost[];
		taskId: string | null;
		snapshotId: string | null;
		publicContentDigest: string | null;
	};
	saveState(): Promise<void>;
	generate(): ReturnType<typeof generateReleaseManifest>;
	cleanup(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
	const repoRoot = await mkdtemp(
		path.join(os.tmpdir(), "firefly-manifest-test-"),
	);
	const siteRoot = path.join(repoRoot, "dist");
	const sources = [
		{
			id: taskId,
			filePath: "src/content/posts/uuid-file.md",
			slug: "固定中文",
			source:
				"---\r\ntitle: First\r\n# Keep this comment\r\ndraft: false\r\ncustom: [a, b]\r\n---\r\nExact source body visitor@example.invalid\r\n",
		},
		{
			id: snapshotId,
			filePath: "src/content/posts/series/index.mdx",
			slug: "series/fixed",
			source:
				'---\ntitle: Second\nslug: series/fixed\ndraft: false\n---\nimport Widget from "./Widget.astro";\n<Widget value={{ nested: true }} />\n',
		},
	];
	const posts = sources.map(({ id, filePath, slug, source }) => ({
		id,
		filePath,
		slug,
		sourceSha256: hash(source),
	}));
	const settings = {
		schemaVersion: 1,
		settings: {
			title: "博客",
			"😀": { b: 2, a: 1 },
			"\ue000": "private value must never be copied into the manifest",
		},
		navigation: null,
		icons: {},
		friends: [],
	};
	const state: Fixture["state"] = {
		schemaVersion: 1,
		posts,
		taskId: null,
		snapshotId: null,
		publicContentDigest: null,
	};
	const write = async (relative: string, contents: string): Promise<void> => {
		const file = path.join(repoRoot, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	};
	for (const source of sources) {
		await write(source.filePath, source.source);
		await write(
			`dist/posts/${source.slug}/index.html`,
			`<html><body>${source.slug}</body></html>`,
		);
	}
	await write(
		"src/content/posts/draft.md",
		"---\ntitle: Private\ndraft: true\n---\nprivate draft body\n",
	);
	await write("src/data/managed-settings.json", JSON.stringify(settings));
	await write("src/data/redirects.json", "[]");
	await write("dist/index.html", "<html>home</html>");
	await write("dist/pagefind/pagefind.js", "export const index = true;");
	await write(
		"dist/pagefind/pagefind-entry.json",
		'{"languages":{"zh-cn":{"hash":"one"}}}',
	);
	const saveState = async (): Promise<void> => {
		await write("src/data/published-state.json", JSON.stringify(state));
	};
	await saveState();
	return {
		repoRoot,
		siteRoot,
		posts,
		settings,
		state,
		saveState,
		generate: () =>
			generateReleaseManifest({
				repoRoot,
				siteRoot,
				env: { VERCEL_GIT_COMMIT_SHA: sha },
			}),
		cleanup: () => rm(repoRoot, { recursive: true, force: true }),
	};
}

test("manifest digest exactly matches the backend Unicode code point contract", () => {
	const value = {
		"😀": { z: null, "\ue000": 1, "😀": 2 },
		"\ue000": [false, 2],
		A: "a",
	};
	assert.equal(canonicalJson(value), serverCanonicalJson(value));
	const posts = [
		{
			id: "z",
			filePath: "src/content/posts/z.md",
			slug: "z",
			sourceSha256: "2",
		},
		{
			id: "A",
			filePath: "src/content/posts/A.md",
			slug: "A",
			sourceSha256: "1",
		},
	];
	const redirects = [
		{ from: "/😀/", to: "/new/", permanent: true as const },
		{ from: "/\ue000/", to: "/new/", permanent: true as const },
	];
	assert.equal(
		publicContentDigest(posts, value, redirects),
		serverDigest([...posts].reverse(), value, [...redirects].reverse()),
	);
});

test("a frozen Chinese slug redirect requires a matching permanent Vercel route", async () => {
	const f = await fixture();
	try {
		const redirects = [{ from: "/posts/旧中文/", to: "/posts/固定中文/", permanent: true as const }];
		await writeFile(path.join(f.repoRoot, "src/data/redirects.json"), JSON.stringify(redirects));
		await assert.rejects(f.generate(), /Cannot read valid JSON.*vercel\.json/);
		const config = {
			buildCommand: "pnpm build",
			headers: [{ source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }],
			redirects: [{ source: redirects[0]!.from, destination: redirects[0]!.to, permanent: false }],
		};
		await writeFile(path.join(f.repoRoot, "vercel.json"), JSON.stringify(config));
		await assert.rejects(f.generate(), /Vercel permanent redirects do not match/);
		config.redirects[0]!.permanent = true;
		await writeFile(path.join(f.repoRoot, "vercel.json"), JSON.stringify({ ...config, redirects: [{ source: "/posts/:path*", destination: "/archive/", permanent: true }, ...config.redirects] }));
		await assert.rejects(f.generate(), /must precede unmanaged rules/);
		await writeFile(path.join(f.repoRoot, "vercel.json"), JSON.stringify(config));
		const manifest = await f.generate();
		assert.equal(manifest.publicContentDigest, publicContentDigest(f.posts, f.settings, redirects));
		assert.deepEqual(JSON.parse(await readFile(path.join(f.repoRoot, "vercel.json"), "utf8")), config);
	} finally { await f.cleanup(); }
});

test("the migration baseline contains 16 article records and exactly 15 public UUIDs", async () => {
	const repoRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
	);
	const state = JSON.parse(
		await readFile(
			path.join(repoRoot, "src/data/published-state.json"),
			"utf8",
		),
	);
	const { glob } = await import("glob");
	const files = await glob("src/content/posts/**/*.{md,mdx}", {
		cwd: repoRoot,
		nodir: true,
	});
	let publicCount = 0;
	for (const file of files) {
		const bytes = await readFile(path.join(repoRoot, file), "utf8");
		if (matter(bytes).data.draft === true) {
			assert.equal(
				state.posts.some((post: PublishedPost) => post.filePath === file),
				false,
			);
		} else {
			publicCount++;
			assert.equal(
				state.posts.find((post: PublishedPost) => post.filePath === file)
					?.sourceSha256,
				hash(bytes),
			);
		}
	}
	assert.equal(files.length, 16);
	assert.equal(publicCount, 15);
	assert.equal(state.posts.length, 15);
});

test("final manifests preserve IDs and source hashes, match both public paths and exclude their own digests", async () => {
	const f = await fixture();
	try {
		const first = await f.generate();
		assert.equal(first.gitSha, sha);
		assert.equal(first.taskId, null);
		assert.equal(first.snapshotId, null);
		assert.equal(
			first.publicContentDigest,
			serverDigest(f.posts, f.settings, []),
		);
		assert.equal(first.posts.length, 2);
		assert.deepEqual(
			first.posts.map((post) => post.sourceSha256),
			f.posts.map((post) => post.sourceSha256),
		);
		assert.equal(first.posts[0].url, "/posts/固定中文/");
		assert.equal(
			first.posts[1].renderedSha256,
			hash("<html><body>series/fixed</body></html>"),
		);
		const paths = first.artifacts.files.map((entry) => entry.filePath);
		assert.equal(
			paths.some(
				(file) => file.includes("manifest.json") || file.includes("draft"),
			),
			false,
		);
		const release = await readFile(
			path.join(f.siteRoot, "release-manifest.json"),
			"utf8",
		);
		assert.equal(
			release,
			await readFile(path.join(f.siteRoot, "deployment-manifest.json"), "utf8"),
		);
		assert.equal(
			/visitor@example|private draft body|private value/.test(release),
			false,
		);
		await writeFile(
			path.join(f.siteRoot, "deployment-manifest.json"),
			"stale manifest",
		);
		await writeFile(
			path.join(f.siteRoot, "release-manifest.json"),
			"stale manifest",
		);
		assert.deepEqual(await f.generate(), first);
		f.state.taskId = taskId;
		f.state.snapshotId = snapshotId;
		f.state.publicContentDigest = first.publicContentDigest;
		await f.saveState();
		const frozen = await f.generate();
		assert.equal(frozen.taskId, taskId);
		assert.equal(frozen.snapshotId, snapshotId);
	} finally {
		await f.cleanup();
	}
});

test("final Pagefind and minified HTML hashes follow the actual bytes after postprocessing", async () => {
	const f = await fixture();
	try {
		const first = await f.generate();
		await writeFile(
			path.join(f.siteRoot, "pagefind/pagefind-entry.json"),
			'{"languages":{"zh-cn":{"hash":"changed"}}}',
		);
		await writeFile(
			path.join(f.siteRoot, "posts/固定中文/index.html"),
			"<html>minified new output</html>",
		);
		const changed = await f.generate();
		assert.equal(changed.publicContentDigest, first.publicContentDigest);
		assert.notEqual(changed.pagefind.sha256, first.pagefind.sha256);
		assert.notEqual(changed.artifacts.sha256, first.artifacts.sha256);
		assert.equal(
			changed.posts[0].renderedSha256,
			hash("<html>minified new output</html>"),
		);
	} finally {
		await f.cleanup();
	}
});

test("missing mappings, altered sources, snapshot mismatch and leaked draft HTML fail explicitly", async (t) => {
	for (const [name, mutation, pattern] of [
		[
			"missing UUID mapping",
			async (f: Fixture) => {
				f.state.posts = f.state.posts.slice(1);
				await f.saveState();
			},
			/missing its stable UUID/,
		],
		[
			"source byte change",
			async (f: Fixture) => {
				await writeFile(
					path.join(f.repoRoot, f.posts[0].filePath),
					"---\ntitle: Changed\ndraft: false\n---\nchanged\n",
				);
			},
			/actual saved source bytes/,
		],
		[
			"snapshot mismatch",
			async (f: Fixture) => {
				f.state.taskId = taskId;
				f.state.snapshotId = snapshotId;
				f.state.publicContentDigest = "0".repeat(64);
				await f.saveState();
			},
			/frozen snapshot/,
		],
		[
			"draft HTML",
			async (f: Fixture) => {
				await mkdir(path.join(f.siteRoot, "posts/draft"), { recursive: true });
				await writeFile(
					path.join(f.siteRoot, "posts/draft/index.html"),
					"private",
				);
			},
			/Private draft HTML/,
		],
		[
			"incomplete Pagefind",
			async (f: Fixture) => {
				await unlink(path.join(f.siteRoot, "pagefind/pagefind-entry.json"));
			},
			/Final Pagefind artifacts/,
		],
		[
			"explicit slug conflict",
			async (f: Fixture) => {
				f.state.posts[1].slug = "different";
				await f.saveState();
			},
			/explicit article slug/,
		],
	] as Array<[string, (f: Fixture) => Promise<void>, RegExp]>) {
		await t.test(name, async () => {
			const f = await fixture();
			try {
				await mutation(f);
				await assert.rejects(f.generate(), pattern);
			} finally {
				await f.cleanup();
			}
		});
	}
});

test("Git identity uses verified build metadata and rejects a different checkout SHA", async () => {
	const f = await fixture();
	try {
		assert.equal(
			resolveGitSha(f.repoRoot, { VERCEL_GIT_COMMIT_SHA: sha }),
			sha,
		);
		assert.throws(() => resolveGitSha(f.repoRoot, {}), /Cannot identify/);
		assert.throws(
			() => resolveGitSha(f.repoRoot, { VERCEL_GIT_COMMIT_SHA: "invented" }),
			/40-character/,
		);
		for (const args of [
			["init", "--quiet"],
			[
				"-c",
				"user.name=Manifest test",
				"-c",
				"user.email=manifest-test@example.invalid",
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"fixture",
			],
		]) {
			assert.equal(
				spawnSync("git", args, { cwd: f.repoRoot, encoding: "utf8" }).status,
				0,
			);
		}
		const actual = resolveGitSha(f.repoRoot, {});
		assert.match(actual, /^[a-f0-9]{40}$/);
		assert.equal(
			resolveGitSha(f.repoRoot, { VERCEL_GIT_COMMIT_SHA: actual }),
			actual,
		);
		assert.throws(
			() => resolveGitSha(f.repoRoot, { VERCEL_GIT_COMMIT_SHA: sha }),
			/actual checked-out Git HEAD/,
		);
	} finally {
		await f.cleanup();
	}
});
