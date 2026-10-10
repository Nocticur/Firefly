import { defineConfig } from "nitro";

export default defineConfig({
	modules: ["workflow/nitro"],
	routes: { "/api/**": "./server/index.ts", "/**": "./server/ui.ts" },
	publicAssets: [{ dir: "public", baseURL: "/" }],
	serverAssets: [{ dir: "public", baseName: "ui", pattern: "index.html" }],
});
