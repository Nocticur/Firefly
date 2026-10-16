import type { SiteConfig } from "../types/siteConfig";

/** The single availability rule used by pages, menus, post actions and sitemap. */
export function isPageAvailable(
	page: keyof SiteConfig["pages"],
	pages: SiteConfig["pages"],
	sponsorEnabled: boolean,
): boolean {
	return pages[page] !== false && (page !== "sponsor" || sponsorEnabled);
}

export function isRouteAvailable(
	pathname: string,
	pages: SiteConfig["pages"],
	sponsorEnabled: boolean,
): boolean {
	const segment = pathname.split("/").filter(Boolean)[0];
	const page = segment === "myanimelist" ? "mal" : segment;
	return page in pages
		? isPageAvailable(page as keyof SiteConfig["pages"], pages, sponsorEnabled)
		: true;
}
