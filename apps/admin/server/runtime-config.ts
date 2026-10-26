import managed from "../../../src/data/managed-settings.json";
import { commentConfig } from "../../../src/config/commentConfig.js";

// Defaults come from published configuration, never unreviewed private drafts.
export const siteOrigin: string = new URL(managed.settings.siteUrl).origin;
export function hostedProduction(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		env.VERCEL_ENV === "production" &&
		(!env.APP_ENV || env.APP_ENV === "production")
	);
}

function normalizeHttpsOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value.includes("://") ? value : "https://" + value);
		if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function projectProductionOrigin(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return normalizeHttpsOrigin(env.VERCEL_PROJECT_PRODUCTION_URL) || normalizeHttpsOrigin(env.VERCEL_URL);
}

export function previewOrigin(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const host = env.VERCEL_URL;
	if (
		!host ||
		!/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
		host.includes("..")
	)
		return undefined;
	return `https://${host}`;
}
export function vercelProjectId(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.VERCEL_PROJECT_ID || env.VERCEL_BLOG_PROJECT_ID;
}
export function publicCommentsEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.ENABLE_PUBLIC_COMMENTS
		? env.ENABLE_PUBLIC_COMMENTS === "true"
		: commentConfig.type === "nocticur";
}
export function defaultMediaImportHosts(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (env.MEDIA_IMPORT_HOSTS)
		return env.MEDIA_IMPORT_HOSTS.split(",")
			.map((host) => host.trim().toLowerCase())
			.filter(Boolean);
	const hosts = new Set([new URL(siteOrigin).hostname]);
	function visit(value: unknown): void {
		if (typeof value === "string" && value.startsWith("https://")) {
			try {
				const url = new URL(value);
				if (!url.username && !url.password && !url.port)
					hosts.add(url.hostname);
			} catch {
				/* Ignore malformed published image references. */
			}
		} else if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object")
			Object.values(value).forEach(visit);
	}
	for (const key of [
		"avatar",
		"defaultCover",
		"homeCover",
		"background",
	] as const)
		visit(managed.settings[key]);
	return [...hosts];
}
