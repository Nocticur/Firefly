import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("astro/package.json");
const { bin } = JSON.parse(readFileSync(packagePath, "utf8"));
const cli = resolve(dirname(packagePath), bin.astro);

// Use the installed, locked CLI and disable its anonymous telemetry everywhere,
// including deployment builds that do not load the cloud workspace activation.
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
	env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
	stdio: "inherit",
});
child.on("error", () => {
	console.error("Unable to start the installed Astro CLI.");
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
