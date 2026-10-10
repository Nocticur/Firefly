import themePackage from "../../../package.json";
import adminPackage from "../package.json";
import { branchHead } from "./github.js";

export function newerStableVersion(current: string, latest: string): boolean | null {
	const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
	const left = parse(current); const right = parse(latest);
	if (!left || !right) return null;
	for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return right[index]! > left[index]!;
	return false;
}

export async function checkUpdates(fetcher: typeof fetch = fetch, readHead = branchHead) {
	let latest: Record<string, unknown> | null = null;
	try {
		const response = await fetcher("https://api.github.com/repos/CuteLeaf/Firefly/releases/latest", { headers: { Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (response.ok) latest = await response.json() as Record<string, unknown>;
	} catch { /* A failed upstream request is reported as unavailable, never as up to date. */ }
	const themeLatest = typeof latest?.tag_name === "string" ? latest.tag_name : null;
	const themeReleaseUrl = typeof latest?.html_url === "string" && latest.html_url.startsWith("https://github.com/CuteLeaf/Firefly/releases/") ? latest.html_url : null;
	const currentAdminSha = /^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA || "") ? process.env.VERCEL_GIT_COMMIT_SHA! : null;
	let backendRemoteSha: string | null = null;
	let backendCheckStatus: "available" | "configuration-required" | "unavailable" = "configuration-required";
	if (["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"].every((key) => process.env[key])) {
		try { const head = await readHead(); if (/^[a-f0-9]{40}$/.test(head)) { backendRemoteSha = head; backendCheckStatus = "available"; } else backendCheckStatus = "unavailable"; }
		catch { backendCheckStatus = "unavailable"; }
	}
	return { currentThemeVersion: themePackage.version, themeLatest, themeReleaseUrl, updateAvailable: themeLatest ? newerStableVersion(themePackage.version, themeLatest) : null, currentAdminVersion: adminPackage.version, currentAdminSha, backendRemoteSha, backendCheckStatus, backendUpdateAvailable: currentAdminSha && backendRemoteSha ? currentAdminSha !== backendRemoteSha : null };
}
