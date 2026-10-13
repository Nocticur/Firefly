import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "client",
	base: process.env.FIREFLY_INTEGRATED_BUILD === "1" ? "/admin/" : "/",
	plugins: [react()],
	build: { outDir: "../public", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
