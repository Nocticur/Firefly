import assert from "node:assert/strict";
import test from "node:test";
import {
	createHealthResult,
	hasBacklink,
	isPublicIp,
	mergeHealthResults,
	normalizeTargetUrl,
	shouldTakeScreenshot,
} from "./friend-monitor-core";

test("target URLs normalize without accepting credentials or non-web schemes", () => {
	assert.equal(
		normalizeTargetUrl("https://BLOG.example/#hello"),
		"https://blog.example/",
	);
	assert.throws(() => normalizeTargetUrl("file:///etc/passwd"));
	assert.throws(() => normalizeTargetUrl("https://user:password@example.com/"));
	assert.throws(() => normalizeTargetUrl("http://localhost/"));
});

test("private, mapped and reserved addresses never become monitoring targets", () => {
	for (const ip of [
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.3",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"fc00::1",
		"::ffff:127.0.0.1",
		"2001:db8::1",
	]) {
		assert.equal(isPublicIp(ip), false, ip);
	}
	assert.equal(isPublicIp("1.1.1.1"), true);
	assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("backlinks require a real anchor and the exact normalized host", () => {
	const own = "https://blog.mourn.top/";
	assert.equal(
		hasBacklink(
			'<a href="https://blog.mourn.top/about/">博客</a>',
			"https://friend.example/friends/",
			own,
		),
		true,
	);
	assert.equal(
		hasBacklink(
			'<a href="https://blog.mourn.top.evil.example">假链接</a>',
			"https://friend.example/",
			own,
		),
		false,
	);
	assert.equal(
		hasBacklink(
			'<script>"<a href="https://blog.mourn.top/">"</script><p>https://blog.mourn.top/</p>',
			"https://friend.example/",
			own,
		),
		false,
	);
	assert.equal(
		hasBacklink('<a href="/friends/">友链</a>', "https://blog.mourn.top/", own),
		true,
	);
});

test("one failed run increments once and recovery clears consecutive failures while preserving screenshots", () => {
	const old = {
		url: "https://friend.example/",
		name: "朋友",
		status: "timeout" as const,
		latencyMs: null,
		statusCode: null,
		consecutiveFailures: 6,
		backlink: "unknown" as const,
		checkedAt: "2026-10-14T00:00:00Z",
		screenshot: "/assets/friends/test.webp",
		screenshotAt: "2026-10-01T00:00:00Z",
	};
	const failed = createHealthResult(
		{ url: old.url, name: old.name },
		{ ok: false, statusCode: 503, latencyMs: 200, backlink: "unknown" },
		old,
		"2026-10-16T00:00:00Z",
	);
	assert.equal(failed.consecutiveFailures, 7);
	assert.equal(failed.screenshot, old.screenshot);
	const recovered = createHealthResult(
		{ url: old.url, name: old.name },
		{ ok: true, statusCode: 200, latencyMs: 100, backlink: "missing" },
		failed,
		"2026-10-16T12:00:00Z",
	);
	assert.equal(recovered.consecutiveFailures, 0);
	assert.equal(recovered.status, "warn");
	assert.equal(recovered.screenshot, old.screenshot);
});

test("a targeted run retains unrelated results and does not retain removed targets", () => {
	const a = createHealthResult(
		{ url: "https://a.example/", name: "A" },
		{ ok: true, statusCode: 200, latencyMs: 100, backlink: "unchecked" },
		undefined,
		"2026-10-16T00:00:00Z",
	);
	const b = { ...a, url: "https://b.example/", name: "B" };
	const updated = { ...a, latencyMs: 800 };
	const report = mergeHealthResults([a, b], [updated], [a.url, b.url]);
	assert.deepEqual(report, [updated, b]);
	assert.deepEqual(mergeHealthResults([a, b], [], [a.url]), [a]);
});

test("screenshots use elapsed six days and preserve old successes until a new capture succeeds", () => {
	const result = createHealthResult(
		{ url: "https://a.example/", name: "A" },
		{ ok: true, statusCode: 200, latencyMs: 100, backlink: "unchecked" },
		undefined,
		"2026-10-16T00:00:00Z",
	);
	assert.equal(
		shouldTakeScreenshot(result, Date.parse("2026-10-16T00:00:00Z")),
		true,
	);
	result.screenshotAt = "2026-10-12T00:00:00Z";
	assert.equal(
		shouldTakeScreenshot(result, Date.parse("2026-10-16T00:00:00Z")),
		false,
	);
	assert.equal(
		shouldTakeScreenshot(result, Date.parse("2026-10-18T00:00:00Z")),
		true,
	);
	result.consecutiveFailures = 1;
	assert.equal(
		shouldTakeScreenshot(result, Date.parse("2026-10-20T00:00:00Z")),
		false,
	);
});
