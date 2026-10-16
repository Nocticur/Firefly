import { isIP } from "node:net";
import { fromHtml } from "hast-util-from-html";
import type {
	FriendBacklinkStatus,
	FriendHealthResult,
} from "../src/types/friendHealth";

export type MonitoredFriend = { url: string; name: string; linkpage?: string };
export type ProbeResult = {
	ok: boolean;
	statusCode: number | null;
	latencyMs: number | null;
	backlink: FriendBacklinkStatus;
	error?: string;
};

export function normalizeTargetUrl(value: string): string {
	if (
		value.length > 2000 ||
		Array.from(value).some(
			(character) => character.charCodeAt(0) <= 32 || character === "\\",
		)
	)
		throw new Error("Invalid target URL");
	const url = new URL(value);
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		(!hostname.includes(".") && !isIP(hostname.replace(/^\[|\]$/g, "")))
	) {
		throw new Error("Only public HTTP(S) targets are supported");
	}
	url.hash = "";
	return url.href;
}

/** Only globally routable addresses are allowed, including after redirects. */
export function isPublicIp(address: string): boolean {
	const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(ip) === 4) {
		const [a, b, c] = ip.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(ip) !== 6) return false;
	// Reject mapped IPv4, link-local, unique-local, loopback and multicast ranges.
	return /^[23][0-9a-f]{3}:/.test(ip) && !/^2001:0?db8:/.test(ip);
}

/** Parse anchors rather than treating text, scripts or suffix lookalikes as backlinks. */
export function hasBacklink(
	html: string,
	pageUrl: string,
	authorUrl: string,
): boolean {
	const ownHost = new URL(authorUrl).hostname.toLowerCase().replace(/\.$/, "");
	const tree = fromHtml(html);
	function visit(node: typeof tree | (typeof tree.children)[number]): boolean {
		if (
			node.type === "element" &&
			node.tagName === "a" &&
			typeof node.properties.href === "string"
		) {
			try {
				const link = new URL(node.properties.href, pageUrl);
				if (
					["https:", "http:"].includes(link.protocol) &&
					link.hostname.toLowerCase().replace(/\.$/, "") === ownHost
				)
					return true;
			} catch {
				/* Ignore invalid hrefs. */
			}
		}
		return "children" in node && node.children.some(visit);
	}
	return visit(tree);
}

export function createHealthResult(
	friend: MonitoredFriend,
	probe: ProbeResult,
	old: FriendHealthResult | undefined,
	checkedAt: string,
): FriendHealthResult {
	return {
		url: normalizeTargetUrl(friend.url),
		name: friend.name,
		status: !probe.ok
			? "timeout"
			: probe.backlink === "missing"
				? "warn"
				: (probe.latencyMs ?? 0) >= 2000
					? "slow"
					: "success",
		latencyMs: probe.latencyMs,
		statusCode: probe.statusCode,
		consecutiveFailures: probe.ok
			? 0
			: Math.min((old?.consecutiveFailures ?? 0) + 1, 1_000_000),
		backlink: probe.backlink,
		checkedAt,
		...(probe.ok
			? { lastSuccessAt: checkedAt }
			: old?.lastSuccessAt
				? { lastSuccessAt: old.lastSuccessAt }
				: {}),
		...(old?.screenshot ? { screenshot: old.screenshot } : {}),
		...(old?.screenshotAt ? { screenshotAt: old.screenshotAt } : {}),
		...(probe.error ? { error: probe.error.slice(0, 500) } : {}),
	};
}

function urlKey(value: string): string {
	return normalizeTargetUrl(value).replace(/\/$/, "");
}

export function mergeHealthResults(
	previous: FriendHealthResult[],
	updates: FriendHealthResult[],
	activeUrls: string[],
): FriendHealthResult[] {
	const merged = new Map(
		previous.map((result) => [urlKey(result.url), result]),
	);
	for (const result of updates) merged.set(urlKey(result.url), result);
	return activeUrls.flatMap((url) => {
		const result = merged.get(urlKey(url));
		return result ? [result] : [];
	});
}

export function shouldTakeScreenshot(
	result: FriendHealthResult,
	now: number,
	force = false,
): boolean {
	if (
		result.consecutiveFailures !== 0 ||
		result.statusCode === null ||
		result.statusCode >= 400
	)
		return false;
	const previous = result.screenshotAt
		? Date.parse(result.screenshotAt)
		: Number.NaN;
	return (
		force ||
		!Number.isFinite(previous) ||
		now - previous >= 6 * 24 * 60 * 60 * 1000
	);
}
