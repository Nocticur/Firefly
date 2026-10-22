#!/usr/bin/env node
// Diagnoses the admin's Git connection without deploying anything.
// It never prints the token: only its length and a short fingerprint.
//
//   node scripts/check-github-access.mjs
//
// Reads GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_BRANCH from the environment, or from a
// local .env file next to the repository root. Exit code 0 means the admin should be able
// to read the repository; 1 means a problem was found; 2 means no token was available.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const API = "https://api.github.com";

function loadDotEnv() {
	let text;
	try { text = readFileSync(join(ROOT, ".env"), "utf8"); }
	catch { return; }
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match || process.env[match[1]] !== undefined) continue;
		process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
	}
}

function hint(status, action) {
	if (status === 401) return "令牌无效、已过期或已被撤销 → 重新生成后更新 GITHUB_TOKEN";
	if (status === 403) return "令牌权限不足或触发限流 → 确认该令牌对目标仓库有 Contents: Read and write";
	if (status === 404) return `仓库/分支不存在，或令牌未被授权访问它 → 核对 GITHUB_REPOSITORY / GITHUB_BRANCH，并确认令牌的“Repository access”包含该仓库（${action}）`;
	if (status === 0) return "无法连接 api.github.com → 检查出网访问与 DNS（Vercel 上还要确认没有自定义防火墙规则）";
	if (status >= 500) return "GitHub 服务端异常 → 稍后重试";
	return `HTTP ${status}`;
}

async function call(path, token) {
	const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "firefly-admin-doctor" };
	if (token) headers.Authorization = `Bearer ${token}`;
	let response;
	try {
		response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
	} catch (error) {
		return { status: 0, body: null, error: error instanceof Error ? error.message : "network error" };
	}
	let body = null;
	try { body = await response.json(); } catch { /* non-JSON error bodies are fine */ }
	return { status: response.status, body };
}

function fingerprint(token) {
	// Enough to tell two tokens apart, useless for reuse.
	let sum = 0;
	for (let index = 0; index < token.length; index++) sum = (sum * 31 + token.charCodeAt(index)) >>> 0;
	return sum.toString(16).padStart(8, "0");
}

loadDotEnv();

const token = (process.env.GITHUB_TOKEN || "").trim();
const repository = (process.env.GITHUB_REPOSITORY || "Nocticur/Firefly").trim();
const branch = (process.env.GITHUB_BRANCH || "master").trim();

console.log(`仓库: ${repository}`);
console.log(`分支: ${branch}`);
console.log(token ? `令牌: 已设置（${token.length} 字符，指纹 ${fingerprint(token)}）` : "令牌: 未设置 GITHUB_TOKEN");

let failed = false;
const fail = (label, message) => { failed = true; console.log(`✗ ${label}: ${message}`); };

if (token && !/^(github_pat_|ghp_|github_pat_[A-Za-z0-9_]+)/.test(token)) {
	console.log("! 令牌格式不像 GitHub PAT；如果它其实是 GitHub App 凭据，请改用 PAT");
}

// 1. Repository metadata, including the caller's permission level.
const repo = await call(`/repos/${repository}`, token);
if (repo.status !== 200) fail("读取仓库", hint(repo.status, "Settings → Developer settings → Personal access tokens → Fine-grained tokens"));
else {
	const push = repo.body?.permissions?.push;
	console.log(`✓ 读取仓库成功（默认分支 ${repo.body?.default_branch}）`);
	if (token && push !== true) fail("写权限", "该令牌没有写权限 → 生成令牌时把 Contents 设为 Read and write");
}

// 2. The configured branch must exist and be the one the admin commits to.
const ref = await call(`/repos/${repository}/git/ref/heads/${branch}`, token);
if (ref.status !== 200) fail("读取分支", hint(ref.status, "确认 GITHUB_BRANCH 拼写"));
else console.log(`✓ 分支存在: ${ref.body?.object?.sha?.slice(0, 7)}`);

// 3. What the admin actually imports: posts and a settings source.
if (ref.status === 200) {
	const tree = await call(`/repos/${repository}/git/trees/${ref.body.object.sha}?recursive=1`, token);
	if (tree.status !== 200) fail("读取文件树", hint(tree.status, ""));
	else if (tree.body?.truncated) fail("读取文件树", "树被截断，后台会拒绝导入");
	else {
		const paths = (tree.body?.tree || []).filter((item) => item.type === "blob").map((item) => item.path);
		const posts = paths.filter((path) => /^src\/content\/posts\/.+\.(md|mdx)$/.test(path));
		console.log(posts.length ? `✓ 文章源码 ${posts.length} 篇` : "✗ 文章源码: 0 篇（后台会报 REPOSITORY_POSTS_MISSING）");
		if (!posts.length) failed = true;
		const settingsSource = ["src/data/managed-settings.json", "src/config/siteConfig.ts"].filter((path) => paths.includes(path));
		console.log(settingsSource.length ? `✓ 设置来源: ${settingsSource.join("、")}` : "✗ 设置来源: 缺少 managed-settings.json 与 siteConfig.ts（后台会报 BASELINE_CONFIGURATION_REQUIRED）");
		if (!settingsSource.length) failed = true;
	}
}

if (!token) {
	console.log("\n结论: 没有 GITHUB_TOKEN。后台需要它才能读写仓库；上面匿名读取的结果只能证明仓库是公开可读的。");
	console.log("生成地址: https://github.com/settings/personal-access-tokens/new");
	process.exit(2);
}

if (!failed) console.log("\n结论: 配置正确，后台应当能正常读取并提交该仓库。");
process.exit(failed ? 1 : 0);
