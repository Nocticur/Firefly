import { useStorage } from "nitro/storage";

export default async function ui(request: Request): Promise<Response> {
	if (!["GET", "HEAD"].includes(request.method) || new URL(request.url).pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
	const html = await useStorage("assets:ui").getItem<string>("index.html");
	if (!html) return new Response("管理界面构建缺失", { status: 503 });
	return new Response(request.method === "HEAD" ? null : html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob: data:; font-src 'self' data:; connect-src 'self' https://*.blob.vercel-storage.com https://*.public.blob.vercel-storage.com https://*.private.blob.vercel-storage.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" } });
}
