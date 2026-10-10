import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "client",
	plugins: [react()],
	build: { outDir: "../public", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
