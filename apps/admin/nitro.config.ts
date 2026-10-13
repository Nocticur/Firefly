import { defineConfig } from "nitro";

const integratedBuild = process.env.FIREFLY_INTEGRATED_BUILD === "1";

export default defineConfig({
	// Do not export automatic request/storage traces to a hosting telemetry sink.
	tracingChannel: false,
	modules: ["workflow/nitro"],
	routes: integratedBuild
		? {
				"/api/**": "./server/index.ts",
				"/admin": "./server/ui.ts",
				"/admin/**": "./server/ui.ts",
			}
		: { "/api/**": "./server/index.ts", "/**": "./server/ui.ts" },
	publicAssets: integratedBuild
		? [
				{ dir: "../../dist", baseURL: "/" },
				{ dir: "public/assets", baseURL: "/admin/assets", maxAge: 31536000 },
			]
		: [{ dir: "public", baseURL: "/" }],
	serverAssets: [{ dir: "public", baseName: "ui", pattern: "index.html" }],
	...(integratedBuild ? { output: { dir: "../../.vercel/output" } } : {}),
});
