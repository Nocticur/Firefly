import test from "node:test";
import assert from "node:assert/strict";
import { checkUpdates, newerStableVersion } from "../server/update-check.js";

test("update comparison distinguishes older, newer and unsupported release versions", () => {
	assert.equal(newerStableVersion("6.16.8", "v6.17.0"), true);
	assert.equal(newerStableVersion("6.16.8", "v6.16.8"), false);
	assert.equal(newerStableVersion("6.16.8", "v6.15.99"), false);
	assert.equal(newerStableVersion("6.16.8", "v6.17.0-beta"), null);
});
test("failed providers never imply up-to-date and backend comparison needs actual deployed SHA", async () => {
	const keys = ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY", "VERCEL_GIT_COMMIT_SHA"];
	const saved = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		const unavailable = await checkUpdates(async () => new Response("unavailable", { status: 503 }), async () => { throw new Error("must not request an unconfigured App"); });
		assert.equal(unavailable.updateAvailable, null); assert.equal(unavailable.backendUpdateAvailable, null); assert.equal(unavailable.backendCheckStatus, "configuration-required");
		for (const key of keys.slice(0, 3)) process.env[key] = "test-configured-adapter";
		process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
		const available = await checkUpdates(async () => Response.json({ tag_name: "v6.17.0", html_url: "https://github.com/CuteLeaf/Firefly/releases/tag/v6.17.0" }), async () => "b".repeat(40));
		assert.equal(available.updateAvailable, true); assert.equal(available.backendUpdateAvailable, true); assert.equal(available.backendCheckStatus, "available");
		const same = await checkUpdates(async () => Response.json({ tag_name: "v6.16.8" }), async () => "a".repeat(40));
		assert.equal(same.backendUpdateAvailable, false);
	} finally { keys.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
});
