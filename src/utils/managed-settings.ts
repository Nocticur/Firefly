import publishedSettings from "../data/managed-settings.json";
import type { BackgroundWallpaperConfig } from "../types/backgroundWallpaper";
import type { CoverImageConfig } from "../types/coverImageConfig";
import type { NavBarConfig, NavBarLink } from "../types/navBarConfig";
import type { ProfileConfig } from "../types/profileConfig";
import type { SiteConfig } from "../types/siteConfig";

// This list is also the publishing contract. Never spread arbitrary database settings into theme config.
export const MANAGED_SETTING_KEYS = [
	"title", "subtitle", "description", "siteUrl", "siteStartDate", "timezone",
	"profileName", "bio", "avatar", "contactLinks", "homeCover", "defaultCover", "background",
] as const;
export const MANAGED_ICON_FILES = [
	"favicon.svg", "favicon.ico", "favicon-96x96.png", "apple-touch-icon.png",
	"web-app-manifest-192x192.png", "web-app-manifest-512x512.png",
] as const;
export type ManagedIconFile = (typeof MANAGED_ICON_FILES)[number];
export type ManagedImage = string | { desktop?: string | string[]; mobile?: string | string[] };
export type ManagedContactLink = { name: string; url: string; icon?: string; showName?: boolean };
export type ManagedSettings = {
	title?: string;
	subtitle?: string;
	description?: string;
	siteUrl?: string;
	siteStartDate?: string;
	timezone?: string;
	profileName?: string;
	bio?: string;
	avatar?: string;
	contactLinks?: ManagedContactLink[];
	homeCover?: ManagedImage;
	defaultCover?: string;
	background?: ManagedImage;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}
function text(value: unknown, limit = 2000): string | undefined {
	return typeof value === "string" && value.length <= limit ? value : undefined;
}
/** Only public HTTPS URLs, safe site paths, and existing source asset paths are accepted. */
export function safeManagedAsset(value: unknown): string | undefined {
	const candidate = text(value)?.trim();
	if (candidate === undefined || /[\x00-\x1f\\]/.test(candidate)) return undefined;
	if (candidate === "") return "";
	if (/^\/(?!\/)/.test(candidate) || /^assets\//.test(candidate)) return candidate;
	try {
		const parsed = new URL(candidate);
		return parsed.protocol === "https:" && !parsed.username && !parsed.password ? candidate : undefined;
	} catch {
		return undefined;
	}
}
export function safeManagedLink(value: unknown): string | undefined {
	const candidate = text(value)?.trim();
	if (candidate === "#") return candidate;
	if (candidate && /^mailto:[^\s@]+@[^\s@]+$/.test(candidate)) return candidate;
	const asset = safeManagedAsset(candidate);
	return asset && !asset.startsWith("assets/") ? asset : undefined;
}
function iconName(value: unknown): string | undefined {
	const candidate = text(value, 120);
	return candidate && /^[a-z0-9-]+:[a-z0-9-]+$/.test(candidate) ? candidate : undefined;
}

const document = asRecord(publishedSettings);
export const managedSettings: Record<string, unknown> = asRecord(document.settings);
export function managedContactLinks(base: ProfileConfig["links"]): ProfileConfig["links"] | undefined {
	if (!Array.isArray(managedSettings.contactLinks)) return undefined;
	return managedSettings.contactLinks.flatMap((value) => {
		const link = asRecord(value);
		const name = text(link.name, 120);
		const url = safeManagedLink(link.url);
		if (!name || !url) return [];
		const original = base.find((item) => item.name === name || item.url === url);
		return [{
			name, url,
			icon: iconName(link.icon) ?? original?.icon ?? "material-symbols:link",
			showName: original?.showName ?? (typeof link.showName === "boolean" ? link.showName : undefined),
		}];
	});
}

export function applyManagedSiteSettings(base: SiteConfig): SiteConfig {
	const result = { ...base };
	for (const key of ["title", "subtitle", "description"] as const) {
		const value = text(managedSettings[key]);
		if (value !== undefined) result[key] = value;
	}
	if (managedSettings.siteUrl === "https://blog.mourn.top/") result.site_url = managedSettings.siteUrl;
	if (managedSettings.timezone === "Asia/Shanghai") result.timezone = managedSettings.timezone;
	const date = text(managedSettings.siteStartDate, 80);
	if (date && Number.isFinite(Date.parse(date))) result.siteStartDate = date;
	if (text(managedSettings.title) !== undefined) result.navbar = { ...base.navbar, title: result.title };
	return result;
}
export function applyManagedProfileSettings(base: ProfileConfig): ProfileConfig {
	return {
		...base,
		name: text(managedSettings.profileName, 120) ?? base.name,
		bio: text(managedSettings.bio) ?? base.bio,
		avatar: safeManagedAsset(managedSettings.avatar) ?? base.avatar,
		links: managedContactLinks(base.links) ?? base.links,
	};
}
function imagePaths(value: unknown): string | string[] | undefined {
	if (Array.isArray(value)) {
		const paths = value.map(safeManagedAsset);
		return paths.every((path) => path !== undefined) ? paths as string[] : undefined;
	}
	return safeManagedAsset(value);
}
function imageSource(value: unknown): ManagedImage | undefined {
	if (typeof value === "string") return safeManagedAsset(value);
	const data = asRecord(value);
	const desktop = imagePaths(data.desktop);
	const mobile = imagePaths(data.mobile);
	return desktop !== undefined || mobile !== undefined ? {
		...(desktop !== undefined ? { desktop } : {}),
		...(mobile !== undefined ? { mobile } : {}),
	} : undefined;
}
export function applyManagedWallpaperSettings(base: BackgroundWallpaperConfig): BackgroundWallpaperConfig {
	const source = imageSource(base.mode === "banner"
		? managedSettings.homeCover ?? managedSettings.background
		: managedSettings.background ?? managedSettings.homeCover);
	const src = source === undefined ? base.src : typeof source === "string"
		? { ...(typeof base.src === "object" && !Array.isArray(base.src) ? base.src : {}), desktop: source, mobile: source }
		: { ...(typeof base.src === "object" && !Array.isArray(base.src) ? base.src : {}), ...source };
	const homeText = base.common?.homeText;
	return {
		...base, src,
		common: {
			...base.common,
			...(homeText ? { homeText: {
				...homeText,
				title: text(managedSettings.title) ?? homeText.title,
				subtitle: text(managedSettings.bio) ?? homeText.subtitle,
				links: managedContactLinks(homeText.links ?? []) ?? homeText.links,
			} } : {}),
		},
	};
}
export function applyManagedCoverSettings(base: CoverImageConfig): CoverImageConfig {
	return { ...base, defaultImage: safeManagedAsset(managedSettings.defaultCover) ?? base.defaultImage };
}

export function applyManagedNavigation(base: NavBarConfig): NavBarConfig {
	const navigation = asRecord(document.navigation);
	if (!Array.isArray(navigation.links)) return base;
	function readLinks(values: unknown[], originals: NavBarLink[], depth: number): NavBarLink[] {
		return values.map((value, index) => ({ value: asRecord(value), index }))
			.sort((a, b) => (typeof a.value.order === "number" ? a.value.order : a.index) - (typeof b.value.order === "number" ? b.value.order : b.index))
			.flatMap(({ value }) => {
				const name = text(value.name, 120);
				const url = safeManagedLink(value.url ?? "#");
				if (!name || !url) return [];
				const original = originals.find((item) => item.url !== "#" && item.url === url)
					?? originals.find((item) => item.name === name);
				return [{
					...original, name, url,
					icon: iconName(value.icon) ?? original?.icon,
					external: /^https:|^mailto:/.test(url),
					children: depth < 1 && Array.isArray(value.children)
						? readLinks(value.children, original?.children ?? [], depth + 1) : original?.children,
				}];
			});
	}
	return { ...base, links: readLinks(navigation.links, base.links, 0) };
}
export function getManagedIcons(): Partial<Record<ManagedIconFile, string>> {
	const values = asRecord(document.icons);
	return Object.fromEntries(MANAGED_ICON_FILES.flatMap((file) => {
		const value = safeManagedAsset(values[file]);
		return value && !value.startsWith("assets/") ? [[file, value]] : [];
	}));
}
