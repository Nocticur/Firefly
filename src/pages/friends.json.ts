import type { APIRoute } from "astro";
import { getEnabledFriends } from "../config/friendsConfig";
import { siteConfig } from "../config/siteConfig";

export const prerender = true;

/** Public list shared by the directory and external check-flink consumers. */
export const GET: APIRoute = () => {
	if (!siteConfig.pages.friends) {
		return new Response(JSON.stringify({ error: "Not found" }), {
			status: 404,
			headers: { "Content-Type": "application/json; charset=utf-8" },
		});
	}
	return new Response(
		JSON.stringify(
			getEnabledFriends().map((friend) => ({
				name: friend.title,
				link: friend.siteurl,
				avatar: friend.imgurl,
				...(friend.linkpage ? { linkpage: friend.linkpage } : {}),
			})),
		),
		{ headers: { "Content-Type": "application/json; charset=utf-8" } },
	);
};
