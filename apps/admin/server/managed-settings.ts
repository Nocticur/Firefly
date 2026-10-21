type SourceFile = { path: string; source: string };

export const MANAGED_SETTINGS_PATH = "src/data/managed-settings.json";
const SITE_CONFIG_PATH = "src/config/siteConfig.ts";

type Settings = Record<string, unknown>;
type Derivation = {
	settings: Settings;
	navigation: Settings;
	icons?: Settings;
	/** "managed" means the repository already stores the admin baseline file. */
	source: "managed" | "derived";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonFile(files: SourceFile[], path: string): unknown {
	const file = files.find((entry) => entry.path === path);
	if (!file) return undefined;
	try {
		return JSON.parse(file.source);
	} catch {
		return undefined;
	}
}

/**
 * Reads a top-level `key: "value"` string literal from a TypeScript config module.
 * Intentionally narrow: only repository-authored literals are accepted, never expressions.
 */
function stringLiteral(source: string, key: string): string | undefined {
	const pattern = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m");
	const match = pattern.exec(source);
	if (!match) return undefined;
	const value = match[1].replace(/\\(["\\])/g, "$1").trim();
	return value ? value : undefined;
}

function booleanLiteral(source: string, key: string): boolean | undefined {
	const pattern = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*(true|false)\\b`, "m");
	const match = pattern.exec(source);
	return match ? match[1] === "true" : undefined;
}

/** `siteConfig.pages.*` toggles decide which navbar entries the blog actually renders. */
function deriveNavigation(site: string): Settings {
	const enabled = (key: string, fallback: boolean) => booleanLiteral(site, key) ?? fallback;
	const links: Settings[] = [{ name: "主页", url: "/", icon: "material-symbols:home" }];
	if (enabled("archive", true)) links.push({ name: "归档", url: "/archive/", icon: "material-symbols:archive" });
	if (enabled("postList", true)) links.push({ name: "文章", url: "/list/", icon: "material-symbols:article" });
	if (enabled("dynamic", true)) links.push({ name: "动态", url: "/dynamic/", icon: "material-symbols:forum-rounded" });
	if (enabled("friends", true)) links.push({ name: "友链", url: "/friends/", icon: "material-symbols:link-2-rounded", pageKey: "friends" });
	if (enabled("about", true)) links.push({ name: "关于我", url: "/about/", icon: "material-symbols:person" });
	return { links };
}

/**
 * Some repositories keep public settings only in `src/config/siteConfig.ts`.
 * Deriving from those literals keeps the admin useful without inventing values,
 * and never overwrites them until an admin explicitly saves.
 */
export function deriveManagedSettings(files: SourceFile[]): Derivation {
	const managed = parseJsonFile(files, MANAGED_SETTINGS_PATH);
	if (isRecord(managed) && isRecord(managed.settings) && isRecord(managed.navigation))
		return {
			settings: managed.settings,
			navigation: managed.navigation,
			...(isRecord(managed.icons) ? { icons: managed.icons } : {}),
			source: "managed",
		};

	const site = files.find((entry) => entry.path === SITE_CONFIG_PATH)?.source;
	if (site === undefined)
		return { settings: {}, navigation: { links: [] }, source: "derived" };

	const settings: Settings = {};
	const title = stringLiteral(site, "title");
	if (title) settings.title = title;
	const subtitle = stringLiteral(site, "subtitle");
	if (subtitle) settings.subtitle = subtitle;
	const description = stringLiteral(site, "description");
	if (description) settings.description = description;
	const siteUrl = stringLiteral(site, "site_url") ?? stringLiteral(site, "siteUrl");
	if (siteUrl) settings.siteUrl = siteUrl;
	const siteStartDate = stringLiteral(site, "siteStartDate");
	if (siteStartDate) settings.siteStartDate = siteStartDate;
	const timezone = stringLiteral(site, "timezone");
	if (timezone) settings.timezone = timezone;
	if (title) settings.profileName = title;
	const logo = stringLiteral(site, "value");
	if (logo) settings.avatar = logo.startsWith("/") ? logo : `/${logo}`;

	return { settings, navigation: deriveNavigation(site), source: "derived" };
}
