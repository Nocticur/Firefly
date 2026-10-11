import { defineConfig } from "nitro";

export default defineConfig({
	// Do not export automatic request/storage traces to a hosting telemetry sink.
	tracingChannel: false,
	modules: ["workflow/nitro"],
	routes: { "/api/**": "./server/index.ts", "/**": "./server/ui.ts" },
	publicAssets: [{ dir: "public", baseURL: "/" }],
	serverAssets: [{ dir: "public", baseName: "ui", pattern: "index.html" }],
});
