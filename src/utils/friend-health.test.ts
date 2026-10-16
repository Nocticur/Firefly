import assert from "node:assert/strict";
import test from "node:test";
import type { FriendHealthResult } from "../types/friendHealth";
import {
	classifyFriendHealth,
	mergePublishedFriends,
	normalizeFriendUrl,
	parseFriendHealth,
} from "./friend-health";

const result: FriendHealthResult = {
	url: "https://friend.example/",
	name: "Friend",
	status: "timeout",
	latencyMs: null,
	statusCode: null,
	consecutiveFailures: 1,
	backlink: "unknown",
	checkedAt: "2026-10-16T00:00:00.000Z",
};

test("URL keys ignore fragments and trailing root slash, but retain path and query", () => {
	assert.equal(
		normalizeFriendUrl("https://EXAMPLE.com:443/#about"),
		"https://example.com",
	);
	assert.equal(
		normalizeFriendUrl("https://example.com/blog/?page=2#x"),
		"https://example.com/blog/?page=2",
	);
	for (const url of [
		"javascript:alert(1)",
		"https://user:pass@example.com",
		"//example.com",
		"https://example.com\\evil",
	]) {
		assert.equal(normalizeFriendUrl(url), null);
	}
});

test("failed detections progress to holding area before graveyard and recover", () => {
	assert.equal(classifyFriendHealth(undefined), "active");
	assert.equal(classifyFriendHealth(result), "pending");
	assert.equal(
		classifyFriendHealth({ ...result, consecutiveFailures: 6 }),
		"pending",
	);
	assert.equal(
		classifyFriendHealth({ ...result, consecutiveFailures: 7 }),
		"graveyard",
	);
	assert.equal(
		classifyFriendHealth({
			...result,
			status: "success",
			consecutiveFailures: 0,
		}),
		"active",
	);
});

test("invalid payloads cannot move cards or inject external screenshot URLs", () => {
	assert.equal(parseFriendHealth({ schemaVersion: 2, results: [] }), null);
	const health = parseFriendHealth({
		schemaVersion: 1,
		checkedAt: result.checkedAt,
		results: [
			{ ...result, consecutiveFailures: -1 },
			{ ...result, checkedAt: "not a date" },
			{ ...result, url: "javascript:alert(1)" },
			{
				...result,
				screenshot: "https://tracking.example/a.png",
				privateEmail: "private@example.com",
			},
			{
				...result,
				url: "https://second.example",
				screenshot: "/assets/friends/abc.webp",
			},
		],
	});
	assert.equal(health?.results.length, 2);
	assert.equal(health?.results[0].screenshot, undefined);
	assert.ok(health);
	assert.equal("privateEmail" in health.results[0], false);
	assert.equal(health?.results[1].screenshot, "/assets/friends/abc.webp");
});

test("published friends merge by URL without leaking private fields or overriding explicit kinds", () => {
	const base = [
		{
			title: "Featured",
			siteurl: "https://friend.example/",
			desc: "Original",
			imgurl: "",
			enabled: true,
			weight: 10,
			kind: "featured" as const,
		},
	];
	const merged = mergePublishedFriends(base, [
		{
			id: "1",
			name: "Duplicate",
			url: "https://friend.example/#x",
			description: "Duplicate",
			avatar: "",
			sortOrder: 0,
		},
		{
			id: "2",
			name: "Published",
			url: "https://second.example",
			description: "Hello",
			avatar: "",
			group: "Blog",
			sortOrder: 3,
			email: "secret@example.com",
		},
		{
			name: "Invalid",
			url: "javascript:alert(1)",
			description: "Invalid",
			sortOrder: 1,
		},
	]);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].kind, "featured");
	assert.equal(merged[1].title, "Published");
	assert.deepEqual(merged[1].tags, ["Blog"]);
	assert.equal("email" in merged[1], false);
	assert.equal(mergePublishedFriends(base, {}).length, 1);
});
