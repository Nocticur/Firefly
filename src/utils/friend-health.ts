import type {
	FriendHealthGroup,
	FriendHealthReport,
	FriendHealthResult,
} from "../types/friendHealth";
import type { FriendLink } from "../types/friendsConfig";

export function normalizeFriendUrl(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length > 2000 ||
		[...value].some(
			(character) => character.charCodeAt(0) <= 32 || character === "\\",
		)
	)
		return null;
	try {
		const url = new URL(value);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return null;
		url.hash = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return null;
	}
}

export function classifyFriendHealth(
	result?: FriendHealthResult,
): FriendHealthGroup {
	if (
		!result ||
		!Number.isSafeInteger(result.consecutiveFailures) ||
		result.consecutiveFailures < 1
	)
		return "active";
	return result.consecutiveFailures >= 7 ? "graveyard" : "pending";
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function date(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 80 &&
		Number.isFinite(Date.parse(value))
	);
}
function shortText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length <= limit;
}

/** Invalid rows are ignored, so a damaged report never hides an unchecked friend. */
export function parseFriendHealth(value: unknown): FriendHealthReport | null {
	const data = record(value);
	if (
		data?.schemaVersion !== 1 ||
		!(data.checkedAt === null || date(data.checkedAt)) ||
		!Array.isArray(data.results) ||
		data.results.length > 10000
	)
		return null;
	const results: FriendHealthResult[] = [];
	for (const entry of data.results) {
		const row = record(entry);
		if (!row) continue;
		const url = normalizeFriendUrl(row.url);
		if (
			!url ||
			!shortText(row.name, 200) ||
			!date(row.checkedAt) ||
			!["success", "slow", "warn", "timeout"].includes(String(row.status)) ||
			!["present", "missing", "unknown", "unchecked"].includes(
				String(row.backlink),
			) ||
			!Number.isSafeInteger(row.consecutiveFailures) ||
			Number(row.consecutiveFailures) < 0 ||
			!(
				row.latencyMs === null ||
				(typeof row.latencyMs === "number" &&
					Number.isFinite(row.latencyMs) &&
					row.latencyMs >= 0)
			) ||
			!(
				row.statusCode === null ||
				(Number.isInteger(row.statusCode) &&
					Number(row.statusCode) >= 100 &&
					Number(row.statusCode) <= 599)
			)
		)
			continue;
		const result: FriendHealthResult = {
			url,
			name: row.name,
			status: row.status as FriendHealthResult["status"],
			latencyMs: row.latencyMs as number | null,
			statusCode: row.statusCode as number | null,
			consecutiveFailures: Number(row.consecutiveFailures),
			backlink: row.backlink as FriendHealthResult["backlink"],
			checkedAt: row.checkedAt,
		};
		if (
			shortText(row.screenshot, 250) &&
			/^\/assets\/friends\/[a-zA-Z0-9_-]+\.(webp|png|jpe?g)$/.test(
				row.screenshot,
			)
		)
			result.screenshot = row.screenshot;
		if (date(row.screenshotAt)) result.screenshotAt = row.screenshotAt;
		if (date(row.lastSuccessAt)) result.lastSuccessAt = row.lastSuccessAt;
		if (shortText(row.error, 500)) result.error = row.error;
		results.push(result);
	}
	return {
		schemaVersion: 1,
		checkedAt: data.checkedAt as string | null,
		results,
	};
}

/** Preserve explicit theme metadata; only published public fields enter the page. */
export function mergePublishedFriends(
	base: FriendLink[],
	published: unknown,
): FriendLink[] {
	const friends = [...base];
	const known = new Set(
		base.map((friend) => normalizeFriendUrl(friend.siteurl)),
	);
	if (!Array.isArray(published)) return friends;
	for (const entry of published.slice(0, 10000)) {
		const row = record(entry);
		if (!row) continue;
		const url = normalizeFriendUrl(row.url);
		if (
			!url ||
			known.has(url) ||
			!shortText(row.name, 120) ||
			!row.name.trim() ||
			!shortText(row.description, 2000) ||
			typeof row.sortOrder !== "number" ||
			!Number.isSafeInteger(row.sortOrder)
		)
			continue;
		known.add(url);
		friends.push({
			title: row.name,
			siteurl: url,
			desc: row.description,
			imgurl: normalizeFriendUrl(row.avatar) || "",
			tags:
				shortText(row.group, 120) && row.group.trim() ? [row.group.trim()] : [],
			weight: -row.sortOrder,
			enabled: true,
		});
	}
	return friends;
}
