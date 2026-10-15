import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
	managementOrigin,
	productionEnvironment,
	runtimeEnvironment,
} from "../server/security.js";
import { publicInteractionOrigin } from "../server/interactions.js";
import {
	assertPublishCapability,
	deploymentProvider,
	type FrozenSnapshot,
} from "../server/releases.js";
import { githubProvider, GitHubError } from "../server/github.js";

async function environment(
	values: Record<string, string | undefined>,
	run: () => void | Promise<void>,
) {
	const saved = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	);
	try {
		for (const [key, value] of Object.entries(values))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		await run();
	} finally {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
}

test("Vercel supplies production identity while production actions still require explicit enablement", async () => {
	await environment(
		{
			APP_ENV: undefined,
			VERCEL_ENV: "production",
			ENABLE_PRODUCTION_PUBLISH: undefined,
			GITHUB_APP_ID: "123",
			GITHUB_APP_PRIVATE_KEY: "configured",
			GITHUB_INSTALLATION_ID: undefined,
			VERCEL_TOKEN: "configured",
			VERCEL_PROJECT_ID: "prj_runtime",
			VERCEL_BLOG_PROJECT_ID: undefined,
		},
		async () => {
			assert.equal(runtimeEnvironment(), "production");
			assert.equal(productionEnvironment(), false);
			assert.equal(productionEnvironment(true), true);
			process.env.VERCEL_ENV = "preview";
			assert.equal(productionEnvironment(true), false);
			await assert.rejects(assertPublishCapability);
			process.env.VERCEL_ENV = "production";
			process.env.APP_ENV = "preview";
			assert.throws(runtimeEnvironment, /不一致/);
		},
	);
});

test("preview origins use the exact platform deployment and reject malformed hosts", async () => {
	await environment(
		{
			APP_ENV: undefined,
			VERCEL_ENV: "preview",
			ADMIN_PREVIEW_ORIGIN: undefined,
			PUBLIC_PREVIEW_ORIGIN: undefined,
			VERCEL_URL: "firefly-preview.vercel.app",
		},
		() => {
			assert.equal(managementOrigin(), "https://firefly-preview.vercel.app");
			assert.equal(publicInteractionOrigin(), managementOrigin());
			for (const host of [
				"evil.example/path",
				"user@evil.example",
				"https://evil.example",
				"evil.example?x=y",
			]) {
				process.env.VERCEL_URL = host;
				assert.throws(managementOrigin);
				assert.throws(publicInteractionOrigin);
			}
		},
	);
});

test("publishing verifies the current Vercel project without a second project ID", async () => {
	const original = globalThis.fetch;
	try {
		await environment(
			{ VERCEL_PROJECT_ID: "prj_current", VERCEL_BLOG_PROJECT_ID: undefined },
			async () => {
				globalThis.fetch = async (input) => {
					const url = new URL(String(input));
					assert.equal(url.origin, "https://api.vercel.com");
					assert.equal(url.pathname, "/v6/deployments");
					assert.equal(url.searchParams.get("projectId"), "prj_current");
					return Response.json({ deployments: [] });
				};
				assert.equal(
					(
						await deploymentProvider.verify(
							"a".repeat(40),
							{} as FrozenSnapshot,
						)
					).status,
					"waiting",
				);
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("GitHub discovers only this repository's installation before requesting a scoped token", async () => {
	const original = globalThis.fetch;
	const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString();
	try {
		await environment(
			{
				GITHUB_APP_ID: "123",
				GITHUB_APP_PRIVATE_KEY: privateKey,
				GITHUB_INSTALLATION_ID: undefined,
			},
			async () => {
				let installation: unknown = 456;
				let requestedToken = false;
				globalThis.fetch = async (input, init) => {
					const url = new URL(String(input));
					assert.equal(url.origin, "https://api.github.com");
					if (url.pathname === "/repos/Nocticur/Firefly/installation")
						return Response.json({ id: installation });
					if (url.pathname === "/app/installations/456/access_tokens") {
						requestedToken = true;
						assert.deepEqual(JSON.parse(String(init?.body)), {
							repositories: ["Firefly"],
							permissions: { contents: "read" },
						});
						return Response.json({ token: "test-token" });
					}
					if (url.pathname === "/repos/Nocticur/Firefly/git/ref/heads/master")
						return Response.json({ object: { sha: "a".repeat(40) } });
					if (url.pathname.endsWith("/git/trees/" + "a".repeat(40)))
						return Response.json({ truncated: false, tree: [] });
					throw new Error("Unexpected test request");
				};
				assert.equal(
					(await githubProvider.readRepositoryFiles()).headSha,
					"a".repeat(40),
				);
				assert.equal(requestedToken, true);
				for (const invalid of [undefined, "../bad", 0, -1]) {
					installation = invalid;
					requestedToken = false;
					await assert.rejects(
						githubProvider.readRepositoryFiles(),
						GitHubError,
					);
					assert.equal(requestedToken, false);
				}
			},
		);
	} finally {
		globalThis.fetch = original;
	}
});
