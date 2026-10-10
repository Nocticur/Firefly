import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { githubProvider, GitHubError, type RepositoryFile } from "../server/github.js";

const baseSha = "a".repeat(40);
const commitSha = "b".repeat(40);
const laterSha = "c".repeat(40);
const taskId = "release-task-1";
const digest = "d".repeat(64);
const files: RepositoryFile[] = [{ path: "src/content/posts/nested/测试.mdx", source: "---\ntitle: 测试\n---\n\n# frozen source\n" }];
const input = () => ({ baseSha, taskId, digest, files, deletions: ["src/content/posts/old.md"] });
const message = `content: publish ${taskId}\n\nFirefly-Task: ${taskId}\nFirefly-Snapshot-Digest: ${digest}`;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
type FetchCall = { url: URL; init: RequestInit; body?: Record<string, unknown> };
type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

async function mockGitHub(handler: FetchHandler, run: (calls: FetchCall[]) => Promise<void>): Promise<void> {
	const previousFetch = globalThis.fetch;
	const configuration = { GITHUB_APP_ID: process.env.GITHUB_APP_ID, GITHUB_INSTALLATION_ID: process.env.GITHUB_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY };
	const calls: FetchCall[] = [];
	process.env.GITHUB_APP_ID = "test-app";
	process.env.GITHUB_INSTALLATION_ID = "test-installation";
	process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
	globalThis.fetch = async (url, init = {}) => {
		const call = { url: new URL(String(url)), init, ...(typeof init.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) };
		assert.equal(call.url.origin, "https://api.github.com");
		calls.push(call);
		if (call.url.pathname === "/app/installations/test-installation/access_tokens") {
			assert.equal(init.method, "POST");
			assert.deepEqual(call.body?.repositories, ["Firefly"]);
			assert.ok(["read", "write"].includes((call.body?.permissions as { contents: string }).contents));
			assert.deepEqual(Object.keys(call.body?.permissions as object), ["contents"]);
			return Response.json({ token: "mock-installation-token" });
		}
		assert.equal(new Headers(init.headers).get("Authorization"), "Bearer mock-installation-token");
		return handler(call);
	};
	try { await run(calls); }
	finally {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries(configuration)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
}

function githubError(error: unknown, fields: Partial<Pick<GitHubError, "status" | "uncertain" | "conflict">>): boolean {
	assert.ok(error instanceof GitHubError);
	for (const [key, value] of Object.entries(fields)) assert.equal(error[key as keyof typeof fields], value, key);
	return true;
}

test("GitHub commit uses one expected-head mutation, frozen bytes and repository-scoped contents permission", async () => {
	await mockGitHub((call) => {
		assert.equal(call.url.pathname, "/graphql");
		assert.equal(call.init.method, "POST");
		const variables = call.body?.variables as { input: Record<string, unknown> };
		assert.deepEqual(variables.input.branch, { repositoryNameWithOwner: "Nocticur/Firefly", branchName: "master" });
		assert.equal(variables.input.expectedHeadOid, baseSha);
		assert.deepEqual(variables.input.message, { headline: `content: publish ${taskId}`, body: `Firefly-Task: ${taskId}\nFirefly-Snapshot-Digest: ${digest}` });
		assert.deepEqual(variables.input.fileChanges, { additions: [{ path: files[0].path, contents: Buffer.from(files[0].source).toString("base64") }], deletions: [{ path: "src/content/posts/old.md" }] });
		return Response.json({ data: { createCommitOnBranch: { commit: { oid: commitSha } } } });
	}, async (calls) => {
		assert.equal(await githubProvider.commit(input()), commitSha);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0].body?.permissions, { contents: "write" });
	});
});

test("only a definite expected-head rejection is a CAS conflict", async () => {
	for (const text of [`Expected branch to point to "${baseSha}" but it did not.`, "expectedHeadOid must match the current head of the branch."]) {
		await mockGitHub(() => Response.json({ data: { createCommitOnBranch: null }, errors: [{ type: "UNPROCESSABLE", path: ["createCommitOnBranch"], message: text }] }), async () => {
			await assert.rejects(githubProvider.commit(input()), (error) => githubError(error, { status: 409, uncertain: false, conflict: true }));
		});
	}
});

test("GraphQL errors and incomplete mutation results remain unknown rather than false conflicts", async () => {
	const cas = { type: "UNPROCESSABLE", path: ["createCommitOnBranch"], message: `Expected branch to point to "${baseSha}" but it did not.` };
	const results: unknown[] = [
		{ errors: [{ type: "UNPROCESSABLE", message: "Invalid file path" }] },
		{ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] },
		{ errors: [{ type: "INTERNAL", message: "Internal server error" }] },
		{ errors: [{ type: "STALE_DATA", message: "Cached metadata is stale" }] },
		{ errors: [{ ...cas, path: ["differentMutation"] }] },
		{ errors: [{ ...cas, message: `Expected branch to point to "${laterSha}" but it did not.` }] },
		{ errors: [cas, { type: "INTERNAL", message: "Internal server error" }] },
		{ data: { createCommitOnBranch: { commit: { oid: commitSha } } }, errors: [cas] },
		{ data: { createCommitOnBranch: { commit: { oid: commitSha } } }, errors: { message: "Malformed errors" } },
		{ data: { createCommitOnBranch: { commit: { oid: "invalid" } } } },
		{ data: { createCommitOnBranch: null }, errors: [] },
		{ errors: [null] },
		{}, null,
	];
	for (const result of results) {
		await mockGitHub(() => Response.json(result), async () => {
			await assert.rejects(githubProvider.commit(input()), (error) => githubError(error, { status: 502, uncertain: true, conflict: false }));
		});
	}
});

test("mutation transport failures and malformed JSON preserve unknown outcomes", async () => {
	const responses: FetchHandler[] = [
		() => { throw new TypeError("mock socket disconnected"); },
		() => new Response("unavailable", { status: 503 }),
		() => new Response("timeout", { status: 408 }),
		() => new Response("{incomplete JSON", { status: 200 }),
	];
	for (const response of responses) {
		await mockGitHub(response, async () => {
			await assert.rejects(githubProvider.commit(input()), (error) => githubError(error, { uncertain: true, conflict: false }));
		});
	}
	await mockGitHub(() => new Response("HTTP conflict is not proof of expected-head rejection", { status: 409 }), async () => {
		await assert.rejects(githubProvider.commit(input()), (error) => githubError(error, { status: 409, conflict: false }));
	});
});

test("commit path validation rejects unmanaged writes and noncanonical paths before any external request", async () => {
	const paths = [
		".github/workflows/deploy.yml", "package.json", "src/config/siteConfig.ts", "src/data/private.json",
		"/vercel.json", "./vercel.json", "src/vercel.json", "vercel.json ", "vercel.json/extra.json",
		"src/content/posts/../outside.md", "src/content/posts/a/../../outside.md", "src/content/posts/./post.md",
		"src/content/posts//post.md", "src/content/posts/\\post.md", "src/content/posts/post.md\n",
		"src/content/posts/\0post.md", "/src/content/posts/post.md", "src/content/posts/post.astro",
	];
	await mockGitHub(() => { throw new Error("Preflight must not call GitHub"); }, async (calls) => {
		for (const path of paths) await assert.rejects(githubProvider.commit({ ...input(), files: [{ path, source: "source" }] }), (error) => githubError(error, { status: 400, uncertain: false, conflict: false }));
		for (const path of [...paths, "vercel.json", "src/data/published-state.json", "src/data/managed-settings.json", "src/data/redirects.json"]) await assert.rejects(githubProvider.commit({ ...input(), deletions: [path] }), (error) => githubError(error, { status: 400 }));
		assert.equal(calls.length, 0);
	});
});

test("commit rejects duplicate or overlapping paths and invalid markers before authentication", async () => {
	await mockGitHub(() => { throw new Error("Preflight must not call GitHub"); }, async (calls) => {
		for (const invalid of [
			{ ...input(), files: [files[0], files[0]] },
			{ ...input(), deletions: ["src/content/posts/old.md", "src/content/posts/old.md"] },
			{ ...input(), deletions: [files[0].path] },
			{ ...input(), files: [], deletions: [] },
			{ ...input(), baseSha: "master" },
			{ ...input(), taskId: `${taskId}\nFirefly-Task: other-task` },
			{ ...input(), digest: `${digest}-suffix` },
		]) await assert.rejects(githubProvider.commit(invalid), (error) => githubError(error, { status: 400, uncertain: false, conflict: false }));
		await assert.rejects(githubProvider.findCommit(`${taskId}\n`, digest), (error) => githubError(error, { status: 400 }));
		assert.equal(calls.length, 0);
	});
});

test("repository import reads managed blobs at a frozen commit using read-only contents tokens", async () => {
	const publishedState = { schemaVersion: 1, taskId, publicContentDigest: digest };
	await mockGitHub((call) => {
		switch (call.url.pathname) {
			case "/repos/Nocticur/Firefly/git/ref/heads/master": return Response.json({ object: { sha: baseSha } });
			case `/repos/Nocticur/Firefly/git/trees/${baseSha}`:
				assert.equal(call.url.searchParams.get("recursive"), "1");
				return Response.json({ truncated: false, tree: [
					{ path: files[0].path, type: "blob", sha: commitSha },
					{ path: "src/data/published-state.json", type: "blob", sha: laterSha },
					{ path: "src/config/siteConfig.ts", type: "blob", sha: "e".repeat(40) },
					{ path: ".github/workflows/deploy.yml", type: "blob", sha: "f".repeat(40) },
					{ path: "src/content/posts/../outside.md", type: "blob", sha: "f".repeat(40) },
				] });
			case `/repos/Nocticur/Firefly/git/blobs/${commitSha}`: return Response.json({ encoding: "base64", content: Buffer.from(files[0].source).toString("base64") });
			case `/repos/Nocticur/Firefly/git/blobs/${laterSha}`: return Response.json({ encoding: "base64", content: Buffer.from(JSON.stringify(publishedState)).toString("base64") });
			case `/repos/Nocticur/Firefly/git/blobs/${"e".repeat(40)}`: return Response.json({ encoding: "base64", content: Buffer.from("export const siteConfig = {};").toString("base64") });
			default: throw new Error(`Unexpected mock request ${call.url.pathname}`);
		}
	}, async (calls) => {
		const repository = await githubProvider.readRepositoryFiles();
		assert.equal(repository.headSha, baseSha);
		assert.equal(repository.files.length, 3);
		assert.equal(repository.files.find((file) => file.path === files[0].path)?.source, files[0].source);
		assert.deepEqual(repository.publishedState, publishedState);
		for (const call of calls.filter((entry) => entry.body)) assert.deepEqual(call.body?.permissions, { contents: "read" });
	});
});

test("repository import includes only the exact root deployment config at the frozen branch commit", async () => {
	const source = JSON.stringify({ framework: "astro", buildCommand: "pnpm build", redirects: [], headers: [{ source: "/(.*)", headers: [{ key: "X-Test", value: "keep" }] }] }, null, 2);
	await mockGitHub((call) => {
		if (call.url.pathname.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: baseSha } });
		if (call.url.pathname === `/repos/Nocticur/Firefly/git/trees/${baseSha}`) return Response.json({ truncated: false, tree: [
			{ path: "vercel.json", type: "blob", sha: commitSha },
			{ path: "nested/vercel.json", type: "blob", sha: laterSha },
			{ path: "src/vercel.json", type: "blob", sha: laterSha },
			{ path: "vercel.json/extra.json", type: "blob", sha: laterSha },
			{ path: "vercel.json.", type: "blob", sha: laterSha },
		] });
		assert.equal(call.url.pathname, `/repos/Nocticur/Firefly/git/blobs/${commitSha}`);
		return Response.json({ encoding: "base64", content: Buffer.from(source).toString("base64") });
	}, async (calls) => {
		assert.deepEqual(await githubProvider.readRepositoryFiles(), { headSha: baseSha, files: [{ path: "vercel.json", source }] });
		for (const call of calls.filter((entry) => entry.body)) assert.deepEqual(call.body?.permissions, { contents: "read" });
	});
});

test("deployment config and matching managed redirects are committed atomically while preserving other frozen fields", async () => {
	const redirects = [{ from: "/posts/old/", to: "/posts/new/", permanent: true }];
	const config = {
		$schema: "https://openapi.vercel.sh/vercel.json", framework: "astro", buildCommand: "pnpm build", outputDirectory: "dist",
		rewrites: [{ source: "/api/public/:path*", destination: "https://admin.mourn.top/api/public/:path*" }],
		headers: [{ source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }],
		redirects: [{ source: redirects[0].from, destination: redirects[0].to, permanent: true }, { source: "/legacy/:path*", destination: "https://legacy.example/:path*", permanent: false }],
	};
	const configFile = { path: "vercel.json", source: `${JSON.stringify(config, null, 2)}\n` };
	const redirectsFile = { path: "src/data/redirects.json", source: `${JSON.stringify(redirects, null, 2)}\n` };
	await mockGitHub((call) => {
		assert.equal(call.url.pathname, "/graphql");
		const variables = call.body?.variables as { input: { expectedHeadOid: string; fileChanges: { additions: Array<{ path: string; contents: string }> } } };
		assert.equal(variables.input.expectedHeadOid, baseSha);
		for (const file of [configFile, redirectsFile]) assert.equal(Buffer.from(variables.input.fileChanges.additions.find((entry) => entry.path === file.path)!.contents, "base64").toString(), file.source);
		return Response.json({ data: { createCommitOnBranch: { commit: { oid: commitSha } } } });
	}, async (calls) => {
		assert.equal(await githubProvider.commit({ ...input(), files: [...files, configFile, redirectsFile] }), commitSha);
		assert.equal(calls.filter((call) => call.url.pathname === "/graphql").length, 1);
		assert.deepEqual(calls[0].body?.permissions, { contents: "write" });
	});
});

test("deployment config writes require valid JSON objects and the same commit's redirects manifest", async () => {
	const config = { redirects: [{ source: "/posts/old/", destination: "/posts/new/", permanent: true }] };
	const redirects = [{ from: "/posts/old/", to: "/posts/new/", permanent: true }];
	await mockGitHub(() => { throw new Error("Invalid deployment config must fail before GitHub"); }, async (calls) => {
		const configs = ["{invalid JSON", "null", "[]", '"config"', JSON.stringify({}), JSON.stringify({ redirects: null }), JSON.stringify({ redirects: {} }), JSON.stringify({ redirects: [null] }), JSON.stringify({ redirects: ["redirect"] })];
		for (const source of configs) await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "vercel.json", source }, { path: "src/data/redirects.json", source: JSON.stringify(redirects) }] }), (error) => githubError(error, { status: 400, uncertain: false, conflict: false }));
		await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "vercel.json", source: JSON.stringify(config) }] }), (error) => githubError(error, { status: 400 }));
		for (const source of ["{invalid JSON", "null", "{}", '"redirects"']) await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "vercel.json", source: JSON.stringify(config) }, { path: "src/data/redirects.json", source }] }), (error) => githubError(error, { status: 400 }));
		assert.equal(calls.length, 0);
	});
});

test("nonempty managed redirects cannot be committed without an atomic root deployment config", async () => {
	await mockGitHub(() => { throw new Error("Invalid redirect commit must fail before GitHub"); }, async (calls) => {
		for (const source of [JSON.stringify([{ from: "/posts/旧中文/", to: "/posts/新中文/", permanent: true }]), "null", "{}", "{invalid JSON"]) {
			await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "src/data/redirects.json", source }] }), (error) => githubError(error, { status: 400, uncertain: false, conflict: false }));
		}
		assert.equal(calls.length, 0);
	});
});

test("deployment config rejects missing, inconsistent, misordered or conditional managed redirect mappings", async () => {
	const desired = { from: "/posts/old/", to: "/posts/new/", permanent: true };
	const mapping = { source: desired.from, destination: desired.to, permanent: true };
	const mappings = [
		[], [{ ...mapping, destination: "/posts/different/" }], [{ ...mapping, permanent: false }],
		[{ ...mapping, destination: "https://evil.example" }], [{ ...mapping, has: [{ type: "header", key: "x-preview", value: "yes" }] }],
		[{ ...mapping, statusCode: 302 }], [mapping, mapping],
		[{ source: "/posts/:path*", destination: "/archive/", permanent: true }, mapping],
	];
	await mockGitHub(() => { throw new Error("Invalid redirect mapping must fail before GitHub"); }, async (calls) => {
		for (const redirects of mappings) await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "vercel.json", source: JSON.stringify({ redirects }) }, { path: "src/data/redirects.json", source: JSON.stringify([desired]) }] }), (error) => githubError(error, { status: 400, uncertain: false, conflict: false }));
		assert.equal(calls.length, 0);
	});
});

test("deployment config rejects unsafe managed redirect paths even when both files agree", async () => {
	const paths = ["https://evil.example/", "//evil.example/", "/posts/../private/", "/posts/%2e%2e/private/", "/posts/:path*/", "/posts/a(.*)/", "/posts/a?query/", "/posts/a\\b/", "/posts/a\nb/"];
	await mockGitHub(() => { throw new Error("Unsafe managed redirect must fail before GitHub"); }, async (calls) => {
		for (const path of paths) for (const field of ["from", "to"] as const) {
			const redirect = { from: "/posts/old/", to: "/posts/new/", permanent: true, [field]: path };
			const config = { redirects: [{ source: redirect.from, destination: redirect.to, permanent: true }] };
			await assert.rejects(githubProvider.commit({ ...input(), files: [...files, { path: "vercel.json", source: JSON.stringify(config) }, { path: "src/data/redirects.json", source: JSON.stringify([redirect]) }] }), (error) => githubError(error, { status: 400 }));
		}
		assert.equal(calls.length, 0);
	});
});

test("reconciliation matches complete marker lines, including the final line without a newline", async () => {
	await mockGitHub((call) => {
		if (call.url.pathname.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: baseSha } });
		assert.equal(call.url.pathname, "/repos/Nocticur/Firefly/commits");
		assert.equal(call.url.searchParams.get("sha"), baseSha);
		return Response.json([
			{ sha: "1".repeat(40), commit: { message: message.replace(`Firefly-Task: ${taskId}`, `Firefly-Task: prefix-${taskId}`) } },
			{ sha: "2".repeat(40), commit: { message: `${message}-digest-suffix` } },
			{ sha: "3".repeat(40), commit: { message: message.replace("Firefly-Snapshot-Digest:", "quoted Firefly-Snapshot-Digest:") } },
			{ sha: "4".repeat(40), commit: { message: `${message}\nFirefly-Task: other-task` } },
			{ sha: "5".repeat(40), commit: { message: `${message}\nFirefly-Snapshot-Digest: ${digest}` } },
			{ sha: commitSha, commit: { message: message.replaceAll("\n", "\r\n") } },
		]);
	}, async (calls) => {
		assert.equal(await githubProvider.findCommit(taskId, digest), commitSha);
		for (const call of calls.filter((entry) => entry.body)) assert.deepEqual(call.body?.permissions, { contents: "read" });
	});
});

test("reconciliation does not accept task or digest substrings", async () => {
	await mockGitHub((call) => {
		if (call.url.pathname.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: baseSha } });
		return Response.json([{ sha: commitSha, commit: { message: `${message}-suffix` } }]);
	}, async () => assert.equal(await githubProvider.findCommit(taskId, digest), null));
});

test("reconciliation freezes history pagination to the original branch SHA", async () => {
	await mockGitHub((call) => {
		if (call.url.pathname.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: baseSha } });
		assert.equal(call.url.searchParams.get("sha"), baseSha);
		assert.equal(call.url.searchParams.get("per_page"), "100");
		if (call.url.searchParams.get("page") === "1") return Response.json(Array.from({ length: 100 }, () => ({ sha: laterSha, commit: { message: "unrelated change" } })));
		assert.equal(call.url.searchParams.get("page"), "2");
		return Response.json([{ sha: commitSha, commit: { message } }]);
	}, async () => assert.equal(await githubProvider.findCommit(taskId, digest), commitSha));
});

test("reconciliation accepts a matching commit only while it remains in the current branch ancestry", async () => {
	for (const [status, mergeBase, expected] of [
		["ahead", commitSha, commitSha], ["identical", commitSha, commitSha],
		["behind", laterSha, null], ["diverged", "e".repeat(40), null], ["ahead", "e".repeat(40), null],
	] as const) {
		let refs = 0;
		await mockGitHub((call) => {
			if (call.url.pathname.endsWith("/git/ref/heads/master")) return Response.json({ object: { sha: ++refs === 1 ? baseSha : laterSha } });
			if (call.url.pathname.endsWith("/commits")) {
				assert.equal(call.url.searchParams.get("sha"), baseSha);
				return Response.json([{ sha: commitSha, commit: { message } }]);
			}
			assert.equal(call.url.pathname, `/repos/Nocticur/Firefly/compare/${commitSha}...${laterSha}`);
			return Response.json({ status, merge_base_commit: { sha: mergeBase } });
		}, async () => assert.equal(await githubProvider.findCommit(taskId, digest), expected));
	}
});

test("reconciliation read failures never claim an expected-head conflict", async () => {
	await mockGitHub(() => new Response("conflict", { status: 409 }), async () => {
		await assert.rejects(githubProvider.findCommit(taskId, digest), (error) => githubError(error, { status: 409, uncertain: false, conflict: false }));
	});
	await mockGitHub((call) => call.url.pathname.endsWith("/git/ref/heads/master") ? Response.json({ object: { sha: baseSha } }) : new Response("{incomplete JSON"), async () => {
		await assert.rejects(githubProvider.findCommit(taskId, digest), (error) => githubError(error, { status: 502, uncertain: false, conflict: false }));
	});
});
