import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./types.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAiRoutes } from "./ai.js";
import { registerContentRoutes } from "./content.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerMediaRoutes } from "./media.js";
import { registerInteractionRoutes } from "./interactions.js";
import { registerReleaseRoutes } from "./releases.js";
import { registerMaintenanceRoutes } from "./maintenance.js";
import { ApiFailure, runtimeEnvironment } from "./security.js";
import { openApiDocument } from "./openapi.js";
import { withStore, type FileStore } from "./file-store.js";

export function createApp(store?: FileStore) {
	const app = new Hono<AppEnv>();
	if (store) app.use("/api/*", (c, next) => withStore(store, next));
	app.use("/api/*", async (c, next) => {
		c.set("requestId", randomUUID());
		await next();
		c.header("Cache-Control", "no-store");
		c.header("CDN-Cache-Control", "no-store");
		c.header("Vercel-CDN-Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Request-ID", c.get("requestId"));
	});
	app.onError((error, c) => {
		if (error instanceof HTTPException) return error.getResponse();
		// Log identifiers without SQL, request bodies, access tokens or provider payloads.
		console.error(
			JSON.stringify({ requestId: c.get("requestId"), code: "INTERNAL_ERROR" }),
		);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "操作失败，请根据请求编号检查后台日志",
					requestId: c.get("requestId"),
				},
			},
			500,
		);
	});
	app.get("/api/health", (c) =>
		c.json({ data: { status: "running", environment: runtimeEnvironment() } }),
	);
	app.get("/api/openapi.json", (c) => c.json(openApiDocument));
	registerAuthRoutes(app);
	registerAiRoutes(app);
	registerContentRoutes(app);
	registerSettingsRoutes(app);
	registerMediaRoutes(app);
	registerInteractionRoutes(app);
	registerReleaseRoutes(app);
	registerMaintenanceRoutes(app);
	app.notFound((c) =>
		c.json({ error: { code: "NOT_FOUND", message: "接口不存在" } }, 404),
	);
	return app;
}
export const app = createApp();
export default app;
