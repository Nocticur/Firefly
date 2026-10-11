// This guard runs before dependencies are installed and never downloads code.
if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
	console.error("Install this workspace with pnpm and the committed lockfile.");
	process.exitCode = 1;
}
