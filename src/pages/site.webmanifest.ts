import { siteConfig } from "@/config";
import { getManagedIcons } from "@/utils/managed-settings";

export function GET(): Response {
	const configured = getManagedIcons();
	const icons = [192, 512].flatMap((size) => {
		const key = `web-app-manifest-${size}x${size}.png` as "web-app-manifest-192x192.png" | "web-app-manifest-512x512.png";
		return configured[key] ? [{ src: configured[key], sizes: `${size}x${size}`, type: "image/png" }] : [];
	});
	return new Response(JSON.stringify({ name: siteConfig.title, short_name: siteConfig.title, start_url: "/", display: "browser", icons }), {
		headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
	});
}
