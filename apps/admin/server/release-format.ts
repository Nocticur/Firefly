import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export type PublishedPost = { id: string; filePath: string; slug: string; sourceSha256: string };
export type Redirect = { from: string; to: string; permanent: true };
export function compareCodePoints(left: string, right: string): number {
	const a = Array.from(left, (character) => character.codePointAt(0)!);
	const b = Array.from(right, (character) => character.codePointAt(0)!);
	for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
	return a.length - b.length;
}
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.keys(value).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Public digest requires JSON values");
	return encoded;
}
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export function publicContentDigest(posts: PublishedPost[], settings: Record<string, unknown>, redirects: Redirect[]): string {
	return sha256(canonicalJson({ posts: [...posts].sort((a, b) => compareCodePoints(a.id, b.id)), settings, redirects: [...redirects].sort((a, b) => compareCodePoints(a.from, b.from)) }));
}
export function publishedSource(source: string, _slug?: string): string {
	const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(source);
	if (!match) throw new Error("Publishing requires valid YAML front matter");
	const document = parseDocument(match[2], { keepSourceTokens: true });
	if (document.errors.length) throw new Error("Invalid YAML front matter must be corrected before publishing");
	if (document.get("draft") === true) throw new Error("请先明确取消草稿标记并保存，然后发布；原有草稿示例不会自动公开");
	// Publication freezes the exact saved bytes, including YAML comments and MDX.
	return source;
}

const publicSettingKeys = new Set(["title", "subtitle", "description", "siteUrl", "siteStartDate", "timezone", "profileName", "bio", "avatar", "contactLinks", "homeCover", "defaultCover", "background"]);
export function publicSettings(data: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(data).filter(([key]) => publicSettingKeys.has(key)));
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function managedRedirects(value: unknown): Redirect[] {
	if (!Array.isArray(value)) throw new Error("Managed redirects must be an array");
	const seen = new Set<string>();
	for (const item of value) {
		if (!object(item) || typeof item.from !== "string" || typeof item.to !== "string" || item.permanent !== true || Object.keys(item).some((key) => !["from", "to", "permanent"].includes(key))) throw new Error("Invalid permanent managed redirect");
		for (const route of [item.from, item.to]) {
			// Vercel sources are route patterns. Refuse pattern syntax rather than
			// letting a saved slug redirect unrelated pages or encoded path segments.
			if (!/^\/posts\/.+\/$/u.test(route) || /[:*+?(){}\[\]\\%\u0000-\u0020#]/u.test(route) || route.slice(1, -1).split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Managed redirect must use a literal safe post URL");
		}
		if (item.from === item.to || seen.has(item.from)) throw new Error("Managed redirect sources must be unique and cannot redirect to themselves");
		seen.add(item.from);
	}
	const redirects = value as Redirect[];
	for (const redirect of redirects) {
		const visited = new Set<string>([redirect.from]); let destination = redirect.to;
		while (redirects.some((item) => item.from === destination)) {
			if (visited.has(destination)) throw new Error("Managed redirects cannot form a cycle");
			visited.add(destination); destination = redirects.find((item) => item.from === destination)!.to;
		}
	}
	return redirects;
}
export function assertDeploymentConfigRedirects(config: unknown, redirects: unknown): void {
	const managed = managedRedirects(redirects);
	if (!object(config) || !Array.isArray(config.redirects) || config.redirects.some((rule) => !object(rule) || typeof rule.source !== "string" || typeof rule.destination !== "string")) throw new Error("Imported Vercel configuration and redirect rules must be valid JSON objects");
	if (config.redirects.slice(0, managed.length).some((rule) => !managed.some((redirect) => redirect.from === (rule as Record<string, unknown>).source))) throw new Error("Vercel permanent redirects must precede unmanaged rules");
	for (const redirect of managed) {
		const matches = config.redirects.filter((rule) => (rule as Record<string, unknown>).source === redirect.from) as Record<string, unknown>[];
		if (matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson({ source: redirect.from, destination: redirect.to, permanent: true })) throw new Error("Vercel permanent redirects do not match the frozen public redirect manifest");
	}
}
export function buildDeploymentConfig(config: unknown, redirects: Redirect[], previous: Redirect[] = []): Record<string, unknown> | undefined {
	const managed = managedRedirects(redirects); const old = managedRedirects(previous);
	if (config === undefined) { if (managed.length) throw new Error("A repository Vercel configuration baseline is required before creating permanent redirects"); return undefined; }
	if (!object(config) || config.redirects !== undefined && !Array.isArray(config.redirects)) throw new Error("The imported Vercel configuration must be an object with valid redirect rules");
	const result = structuredClone(config);
	const current = (result.redirects || []) as unknown[];
	const preserved = current.filter((rule) => {
		if (!object(rule) || typeof rule.source !== "string" || typeof rule.destination !== "string") throw new Error("The imported Vercel redirect rule is invalid");
		const managedBefore = old.find((redirect) => redirect.from === rule.source);
		if (managedBefore) {
			if (canonicalJson(rule) !== canonicalJson({ source: managedBefore.from, destination: managedBefore.to, permanent: true })) throw new Error("The imported managed Vercel redirect conflicts with its baseline");
			return false;
		}
		if (managed.some((redirect) => redirect.from === rule.source)) throw new Error("A permanent post redirect conflicts with an existing unmanaged Vercel rule");
		return true;
	});
	// Exact article redirects must run before existing wildcard rules, which could
	// otherwise shadow them. Keep unmanaged rules and their relative order intact.
	result.redirects = [...managed.map(({ from, to }) => ({ source: from, destination: to, permanent: true })), ...preserved];
	assertDeploymentConfigRedirects(result, managed);
	return result;
}
