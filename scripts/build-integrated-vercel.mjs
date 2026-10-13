import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { finalizeIntegratedVercel } from "./finalize-integrated-vercel.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("Run this build with pnpm build:vercel.");

const environment = {
	...process.env,
	FIREFLY_INTEGRATED_BUILD: "1",
	NITRO_PRESET: "vercel",
};
// This command targets Vercel Node functions; the ordinary build keeps Cloudflare support.
delete environment.CF_WORKERS;

function runPnpm(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [pnpmCli, ...args], {
			cwd: root,
			env: environment,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(new Error(`pnpm ${args.join(" ")} failed (${signal || code}).`));
		});
	});
}

await runPnpm(["build"]);
await runPnpm(["--filter", "@nocticur/admin", "build"]);

await finalizeIntegratedVercel();

await new Promise((resolve, reject) => {
	const acceptance = spawn(
		process.execPath,
		[
			"--test",
			"scripts/integrated-vercel.test.mjs",
			"scripts/integrated-runtime.test.mjs",
		],
		{ cwd: root, stdio: "inherit" },
	);
	acceptance.once("error", reject);
	acceptance.once("exit", (code) =>
		code === 0
			? resolve()
			: reject(new Error("Integrated Vercel artifact validation failed.")),
	);
});
console.log("Blog, /admin/, API and Workflow built into .vercel/output.");
