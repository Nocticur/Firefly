import type { NavBarConfig, NavBarLink } from "../types/navBarConfig";

const RETIRED_PAGES = new Set(["categories", "tags", "series", "guestbook"]);

/** Keep saved navigation compatible with the site's direct links and one flat More menu. */
export function organizeNavigation(
	base: NavBarConfig,
	published: NavBarConfig,
	siteUrl: string,
): NavBarConfig {
	const origin = new URL(siteUrl).origin;
	function localPath(link: NavBarLink): string | undefined {
		if (link.url === "#" || link.url.startsWith("mailto:")) return undefined;
		try {
			const target = new URL(link.url, siteUrl);
			return target.origin === origin
				? decodeURIComponent(target.pathname).replace(/\/+$/, "") || "/"
				: undefined;
		} catch {
			return undefined;
		}
	}
	function leaves(links: NavBarLink[]): NavBarLink[] {
		return links.flatMap((link) => {
			const path = localPath(link);
			const page = path?.split("/")[1];
			if (
				RETIRED_PAGES.has(link.pageKey ?? "") ||
				(page && RETIRED_PAGES.has(page))
			)
				return [];
			const { children, ...leaf } = link;
			return [
				...(link.url !== "#" ? [leaf] : []),
				...(children ? leaves(children) : []),
			];
		});
	}
	const savedLinks = leaves(published.links);
	const primaryLinks = base.links.filter((link) => !link.children);
	const primaryPaths = new Set(primaryLinks.map(localPath));
	const directLinks = primaryLinks.map((preset) => {
		const saved = savedLinks.find(
			(link) => localPath(link) === localPath(preset),
		);
		return { ...preset, ...(saved?.icon ? { icon: saved.icon } : {}) };
	});
	const more = base.links.find((link) => link.children);
	if (!more) return { ...base, links: directLinks };
	const admin = more.children?.find((link) => link.name === "后台管理");
	function normalizeAdminLink(link: NavBarLink): NavBarLink {
		if (!admin) return link;
		const target = new URL(link.url, siteUrl);
		const adminTarget = new URL(admin.url, siteUrl);
		const isAdminRoot =
			target.origin === adminTarget.origin &&
			(target.pathname.replace(/\/+$/, "") || "/") === "/";
		return localPath(link) === "/admin" || isAdminRoot ? admin : link;
	}
	const seen = new Set<string>();
	const additionalLinks = [...savedLinks, ...(admin ? [admin] : [])]
		.map(normalizeAdminLink)
		.filter((link) => {
			const path = localPath(link);
			if (path && primaryPaths.has(path)) return false;
			const key = path ?? link.url;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((link) => {
			const preset = more.children?.find((item) =>
				localPath(link)
					? localPath(item) === localPath(link)
					: item.url === link.url,
			);
			return preset?.pageKey ? { ...link, pageKey: preset.pageKey } : link;
		});
	return {
		...base,
		links: [...directLinks, { ...more, children: additionalLinks }],
	};
}
