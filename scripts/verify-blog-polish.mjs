import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.SITE_TEST_BASE_URL || "http://127.0.0.1:4321";
const screenshots = path.resolve("cache/verify-screenshots");
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
	headless: true,
	...(process.env.PLAYWRIGHT_CHROME_EXECUTABLE
		? { executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE }
		: {}),
});
const checks = [];
try {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		permissions: ["clipboard-read", "clipboard-write"],
	});
	await context.route("**/api/public/friends*", (route) =>
		route.fulfill({ json: { data: [] } }),
	);
	const page = await context.newPage();
	const failures = [];
	page.on("pageerror", (error) => failures.push(error.message));
	const videoRequests = [];
	page.on("request", (request) => {
		if (/\.mp4(?:$|\?)/i.test(request.url())) videoRequests.push(request.url());
	});
	await page.goto(`${base}/friends/`, {
		waitUntil: "networkidle",
		timeout: 90_000,
	});
	await page.waitForFunction(
		() =>
			customElements.get("public-friends") &&
			document.querySelector("public-friends [data-health-status]")
				?.textContent,
	);
	assert.equal(
		await page
			.locator("public-friends [data-health-grid] .friend-card")
			.count(),
		3,
	);
	assert.equal(await page.locator(".friend-card--owner").count(), 1);
	assert.equal(await page.locator(".friend-card--featured").count(), 1);
	assert.equal(
		await page
			.locator(
				"#post-comments, nocticur-comments, friend-application, #back-to-comment",
			)
			.count(),
		0,
	);
	assert.equal(videoRequests.length, 0, "Video must not load before a click");
	checks.push(
		"SSR friend cards, owner/featured states, no comment/application form and no initial video request",
	);
	await page.addStyleTag({
		content: "astro-dev-toolbar { display: none !important; }",
	});
	await page.screenshot({
		path: path.join(screenshots, "blog-friends-desktop.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.locator("[data-copy-value]").first().click();
	await page.waitForFunction(() =>
		document
			.querySelector("[data-copy-status]")
			?.textContent.includes("已复制"),
	);
	assert.equal(
		await page.evaluate(() => navigator.clipboard.readText()),
		"Nocticur的博客",
	);
	await page.evaluate(() => {
		navigator.clipboard.writeText = async () => {
			throw new Error("denied");
		};
	});
	await page.locator("[data-copy-value]").nth(1).click();
	assert.equal(await page.locator("[data-manual-copy]").isVisible(), true);
	checks.push("Copy succeeds and denied clipboard offers manual selection");
	await page.locator("[data-search]").fill("Docs");
	await page.waitForFunction(
		() =>
			document.querySelectorAll("[data-health-grid] .friend-card:not([hidden])")
				.length === 1,
	);
	await page.locator("[data-search]").fill("");
	await page.locator('button[data-tag="Framework"]').click();
	await page.waitForFunction(
		() =>
			document.querySelectorAll("[data-health-grid] .friend-card:not([hidden])")
				.length === 1,
	);
	await page.locator('button[data-tag="all"]').click();
	checks.push("Search and tag filters retain correct counts");
	await page.locator("#announcement-dialog-trigger button").click();
	assert.equal(
		await page.locator("announcement-dialog dialog").isVisible(),
		true,
	);
	await page.keyboard.press("Escape");
	assert.equal(
		await page.locator("announcement-dialog dialog").isVisible(),
		false,
	);
	await page.locator("#music-floating-restore button").click();
	assert.equal(await page.locator("floating-music-player").isVisible(), true);
	await page.locator("[data-floating-music-close]").click();
	assert.equal(await page.locator("floating-music-player").isVisible(), false);
	assert.equal(
		await page.evaluate(() =>
			localStorage.getItem("firefly:music-floating:hidden"),
		),
		"true",
	);
	checks.push(
		"Announcement modal keyboard dismissal and floating music close/restore persistence",
	);
	const source = await (await page.request.get(`${base}/friends.json`)).json();
	assert.equal(source.length, 3);
	assert.ok(
		source.every(
			(friend) => friend.name && friend.link && !Object.hasOwn(friend, "email"),
		),
	);
	const fixture = {
		schemaVersion: 1,
		checkedAt: new Date().toISOString(),
		results: source.map((friend, index) => ({
			url: friend.link,
			name: friend.name,
			status: index ? "timeout" : "success",
			latencyMs: index ? null : 180,
			statusCode: index ? 503 : 200,
			consecutiveFailures: [0, 6, 7][index],
			backlink: "unchecked",
			checkedAt: new Date().toISOString(),
			...(index === 0 ? { screenshot: "/assets/friends/qa.webp" } : {}),
		})),
	};
	await context.route("**/data/friends-health.json", (route) =>
		route.fulfill({ json: fixture }),
	);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		() =>
			document.querySelectorAll('[data-health-grid="pending"] .friend-card')
				.length === 1 &&
			document.querySelectorAll('[data-health-grid="graveyard"] .friend-card')
				.length === 1,
	);
	assert.equal(
		await page.locator('[data-health-grid="active"] .friend-card').count(),
		1,
	);
	await page.locator("[data-friend-preview]:not([hidden])").first().click();
	assert.equal(
		await page.locator("body > dialog.friend-preview-dialog").count(),
		1,
	);
	await page.keyboard.press("Escape");
	await page.waitForFunction(
		() => !document.querySelector("dialog.friend-preview-dialog"),
	);
	checks.push(
		"Injected health fixture partitions 0/6/7 failures and screenshot dialog is portaled to body",
	);
	await context.unroute("**/data/friends-health.json");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload({ waitUntil: "networkidle" });
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth > innerWidth + 1,
		),
		false,
		"No mobile horizontal overflow",
	);
	await page.addStyleTag({
		content: "astro-dev-toolbar { display: none !important; }",
	});
	await page.screenshot({
		path: path.join(screenshots, "blog-friends-mobile.png"),
		fullPage: true,
		animations: "disabled",
	});
	checks.push("390px mobile layout has no horizontal overflow");
	assert.equal(await page.locator('nav a[href="/sponsor/"]').count(), 0);
	for (const retired of ["/sponsor/", "/dynamic/comments/"]) {
		const response = await page.request.get(`${base}${retired}`);
		if (new URL(response.url()).pathname !== "/404/") {
			// Static builds use a meta-refresh shell; the dev server uses an HTTP redirect.
			assert.match(
				await response.text(),
				/http-equiv="refresh"[^>]+url=\/404\//,
			);
		}
		await page.goto(`${base}${retired}`, { waitUntil: "domcontentloaded" });
		await page.waitForURL(`${base}/404/`);
	}
	checks.push("Disabled sponsor and retired dynamic comments resolve to 404");
	const reduced = await browser.newContext({
		viewport: { width: 390, height: 844 },
		reducedMotion: "reduce",
	});
	const reducedPage = await reduced.newPage();
	await reduced.route("**/api/public/friends*", (route) =>
		route.fulfill({ json: { data: [] } }),
	);
	await reducedPage.goto(`${base}/friends/`, { waitUntil: "networkidle" });
	assert.equal(
		await reducedPage.locator("canvas.friend-star-canvas").count(),
		0,
	);
	checks.push(
		"Reduced-motion preference produces no decorative particle canvas",
	);
	assert.deepEqual(failures, [], "No uncaught browser errors");
	await reduced.close();
	await context.close();
	console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
	await browser.close();
}
