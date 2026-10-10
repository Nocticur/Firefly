import test from "node:test";
import assert from "node:assert/strict";
import { assertPublishCapability, deploymentProvider, type FrozenSnapshot } from "../server/releases.js";
import { ApiFailure } from "../server/security.js";

const sha = "b".repeat(40);
const snapshot: FrozenSnapshot = { id: "snapshot-1", taskId: "task-1", digest: "c".repeat(64), sources: [], posts: [], files: [], deletions: [], settings: {}, redirects: [], entityRevisions: [], friendIds: [], friendRevisions: {}, selectedIds: [] };
const manifest = { schemaVersion: 1, gitSha: sha, publicContentDigest: snapshot.digest, snapshotId: snapshot.id, taskId: snapshot.taskId };
const deployment = { uid: "dpl_expected", state: "READY", url: "expected.vercel.app", meta: { githubCommitSha: sha } };
const detail = { id: "dpl_expected", projectId: "prj_expected", target: "production", readyState: "READY", url: "expected.vercel.app", meta: { githubCommitSha: sha } };
const alias = { projectId: "prj_expected", deployment: { id: "dpl_expected" } };

test("Vercel verification requires target project, actual production alias and both snapshot manifests", async (t) => {
	const originalFetch = globalThis.fetch; const originalProject = process.env.VERCEL_BLOG_PROJECT_ID; process.env.VERCEL_BLOG_PROJECT_ID = "prj_expected";
	type Changes = { listing?: Record<string, unknown>[]; alias?: Record<string, unknown>; detail?: Record<string, unknown>; deploymentManifest?: Record<string, unknown>; productionManifest?: Record<string, unknown>; switchAlias?: boolean };
	const verify = async (changes: Changes = {}) => {
		let aliasesRead = 0; const hosts: string[] = [];
		globalThis.fetch = async (input, init) => {
			const url = new URL(String(input));
			let body: unknown;
			if (url.pathname === "/v6/deployments") body = { deployments: changes.listing || [deployment] };
			else if (url.pathname === "/v4/aliases/blog.mourn.top") { aliasesRead++; body = changes.switchAlias && aliasesRead > 1 ? { ...alias, deployment: { id: "dpl_switched" } } : changes.alias || alias; }
			else if (url.pathname === "/v13/deployments/dpl_expected") body = changes.detail || detail;
			else if (url.pathname === "/release-manifest.json") {
				hosts.push(url.hostname); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
				body = url.hostname === "blog.mourn.top" ? changes.productionManifest || manifest : changes.deploymentManifest || manifest;
			} else throw new Error(`Unexpected outbound test URL: ${url.origin}${url.pathname}`);
			return Response.json(body);
		};
		return { result: await deploymentProvider.verify(sha, snapshot), hosts, aliasesRead };
	};
	try {
		await t.test("READY with exact identities and both manifests is verified", async () => { const checked = await verify(); assert.equal(checked.result.status, "verified"); assert.equal(checked.result.sha, sha); assert.equal(checked.result.deploymentId, "dpl_expected"); assert.deepEqual(checked.hosts.sort(), ["blog.mourn.top", "expected.vercel.app"]); assert.equal(checked.aliasesRead, 2); });
		await t.test("object key order does not change an identical public manifest", async () => { assert.equal((await verify({ productionManifest: Object.fromEntries(Object.entries(manifest).reverse()) })).result.status, "verified"); });
		for (const [name, changes] of [
			["different project", { alias: { ...alias, projectId: "another_project" } }],
			["same project but old alias", { alias: { ...alias, deployment: { id: "dpl_old" } } }],
			["preview target", { detail: { ...detail, target: "preview" } }],
			["wrong Git version", { detail: { ...detail, meta: { githubCommitSha: "wrong" } } }],
			["detail still building", { detail: { ...detail, readyState: "BUILDING" } }],
			["production stale digest", { productionManifest: { ...manifest, publicContentDigest: "stale" } }],
			["deployment stale snapshot", { deploymentManifest: { ...manifest, snapshotId: "stale" } }],
			["wrong task manifest", { productionManifest: { ...manifest, taskId: "another_task" } }],
			["alias switched during requests", { switchAlias: true }],
		] as Array<[string, Changes]>) await t.test(name, async () => { assert.equal((await verify(changes)).result.status, "waiting"); });
		await t.test("missing target stays waiting and build failure never becomes production success", async () => { assert.equal((await verify({ listing: [] })).result.status, "waiting"); assert.equal((await verify({ listing: [{ ...deployment, state: "ERROR" }] })).result.status, "failed"); });
	} finally { globalThis.fetch = originalFetch; if (originalProject === undefined) delete process.env.VERCEL_BLOG_PROJECT_ID; else process.env.VERCEL_BLOG_PROJECT_ID = originalProject; }
});

test("preview publishing is denied before any provider request", () => {
	const environment = process.env.APP_ENV; const vercel = process.env.VERCEL_ENV; const enabled = process.env.ENABLE_PRODUCTION_PUBLISH;
	try { process.env.APP_ENV = "preview"; process.env.VERCEL_ENV = "preview"; process.env.ENABLE_PRODUCTION_PUBLISH = "true"; assert.throws(() => assertPublishCapability(), (error: unknown) => error instanceof ApiFailure && error.status === 403); }
	finally { for (const [name, value] of [["APP_ENV", environment], ["VERCEL_ENV", vercel], ["ENABLE_PRODUCTION_PUBLISH", enabled]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
