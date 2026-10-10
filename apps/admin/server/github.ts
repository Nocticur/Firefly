import { createSign } from "node:crypto";
import { assertDeploymentConfigRedirects } from "./release-format.js";

export type RepositoryFile = { path: string; source: string };
export class GitHubError extends Error {
	constructor(public status: number, message: string, public uncertain = false, public conflict = false) { super(message); }
}
export type GitHubProvider = {
	readRepositoryFiles(): Promise<{ headSha: string; files: RepositoryFile[]; publishedState?: unknown }>;
	commit(input: { baseSha: string; taskId: string; digest: string; files: RepositoryFile[]; deletions: string[] }): Promise<string>;
	findCommit(taskId: string, digest: string): Promise<string | null>;
};

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing environment configuration: ${name}`);
	return value;
}
function appJwt(): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: required("GITHUB_APP_ID") })).toString("base64url");
	const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n")).toString("base64url");
	return `${header}.${payload}.${signature}`;
}
async function installationToken(write: boolean): Promise<string> {
	let response: Response;
	const authorization = `Bearer ${appJwt()}`;
	try {
		response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(required("GITHUB_INSTALLATION_ID"))}/access_tokens`, {
			method: "POST", headers: { Authorization: authorization, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
			body: JSON.stringify({ repositories: ["Firefly"], permissions: { contents: write ? "write" : "read" } }), signal: AbortSignal.timeout(20_000),
		});
	} catch { throw new GitHubError(0, "GitHub App installation authentication did not return a result"); }
	if (!response.ok) throw new GitHubError(response.status, "GitHub App installation authentication failed");
	let data: { token?: unknown };
	try { data = await response.json() as { token?: unknown }; }
	catch { throw new GitHubError(502, "GitHub App installation authentication returned an invalid result"); }
	if (typeof data?.token !== "string" || !data.token) throw new GitHubError(502, "GitHub App installation authentication returned an invalid result");
	return data.token;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const write = init.method === "POST";
	const token = await installationToken(write);
	let response: Response;
	try {
		response = await fetch(`https://api.github.com${path}`, { ...init, headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
	} catch { throw new GitHubError(0, "GitHub request did not return a result; reconcile before retrying", write); }
	if (!response.ok) throw new GitHubError(response.status, `GitHub operation failed (${response.status})`, write && (response.status >= 500 || response.status === 408));
	try { return await response.json() as T; }
	catch { throw new GitHubError(502, "GitHub returned an invalid result; reconcile before retrying", write); }
}
const repo = "/repos/Nocticur/Firefly";
const validSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
function managedPath(path: string): boolean {
	if (typeof path !== "string" || /[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
	return path === "vercel.json" || /^src\/content\/posts\/.+\.mdx?$/.test(path) || /^src\/data\/(published-state|managed-settings|redirects)\.json$/.test(path) || /^src\/config\/(siteConfig|profileConfig|navBarConfig|friendsConfig)\.ts$/.test(path);
}
const publishPath = (path: string) => managedPath(path) && !path.startsWith("src/config/");
const deletePath = (path: string) => managedPath(path) && path.startsWith("src/content/posts/");
function validateMarkers(taskId: string, digest: string): void {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(digest)) throw new GitHubError(400, "Invalid release task marker or snapshot digest");
}
type CommitResult = { data?: { createCommitOnBranch?: { commit?: { oid?: unknown } } }; errors?: Array<{ type?: string; message?: string; path?: unknown[] }> };
function isHeadConflict(error: NonNullable<CommitResult["errors"]>[number], baseSha: string): boolean {
	if (!error || typeof error !== "object") return false;
	if (error.path && error.path[0] !== "createCommitOnBranch") return false;
	// A generic UNPROCESSABLE/INVALID_ARGUMENT error can concern paths or permissions.
	// Only the explicit expected-head rejection proves that this mutation did not commit.
	return error.message === `Expected branch to point to "${baseSha}" but it did not.` || /^(?:The )?expectedHeadOid (?:must match|does not match) the current head of the branch\.?$/i.test(error.message || "");
}
function hasMarkers(message: string, taskId: string, digest: string): boolean {
	const lines = message.split(/\r?\n/);
	return lines.filter((line) => line.startsWith("Firefly-Task:")).length === 1 && lines.includes(`Firefly-Task: ${taskId}`)
		&& lines.filter((line) => line.startsWith("Firefly-Snapshot-Digest:")).length === 1 && lines.includes(`Firefly-Snapshot-Digest: ${digest}`);
}
export async function branchHead(): Promise<string> {
	const ref = await request<{ object?: { sha?: unknown } }>(`${repo}/git/ref/heads/master`);
	if (!validSha(ref?.object?.sha)) throw new GitHubError(502, "GitHub returned an invalid branch head");
	return ref.object.sha;
}
export async function readRepositoryFiles(): Promise<{ headSha: string; files: RepositoryFile[]; publishedState?: unknown }> {
	const headSha = await branchHead();
	const tree = await request<{ truncated: boolean; tree: Array<{ path: string; type: string; sha: string }> }>(`${repo}/git/trees/${headSha}?recursive=1`);
	if (tree.truncated) throw new Error("Repository tree is truncated; baseline cannot be imported safely");
	const files: RepositoryFile[] = [];
	const items = tree.tree.filter((item) => item.type === "blob" && managedPath(item.path));
	// Bound concurrency and obtain each blob at the frozen commit, never mutable branch URLs.
	for (let offset = 0; offset < items.length; offset += 8) {
		files.push(...await Promise.all(items.slice(offset, offset + 8).map(async (item) => {
			const blob = await request<{ encoding: string; content: string }>(`${repo}/git/blobs/${item.sha}`);
			if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
			return { path: item.path, source: Buffer.from(blob.content, "base64").toString("utf8") };
		})));
	}
	const state = files.find((file) => file.path === "src/data/published-state.json");
	return { headSha, files, ...(state ? { publishedState: JSON.parse(state.source) } : {}) };
}
export const githubProvider: GitHubProvider = {
	readRepositoryFiles,
	async commit({ baseSha, taskId, digest, files, deletions }) {
		validateMarkers(taskId, digest);
		if (!validSha(baseSha)) throw new GitHubError(400, "Invalid expected branch head");
		const additions = new Set<string>(); const removed = new Set<string>();
		for (const file of files) {
			if (!publishPath(file.path) || typeof file.source !== "string" || additions.has(file.path)) throw new GitHubError(400, "Release additions must contain unique managed repository paths");
			additions.add(file.path);
		}
		for (const path of deletions) {
			if (!deletePath(path) || removed.has(path) || additions.has(path)) throw new GitHubError(400, "Release deletions must contain unique managed post paths without overlapping additions");
			removed.add(path);
		}
		const deploymentConfig = files.find((file) => file.path === "vercel.json");
		const redirects = files.find((file) => file.path === "src/data/redirects.json");
		if (redirects && !deploymentConfig) {
			let mappings: unknown;
			try { mappings = JSON.parse(redirects.source); }
			catch { throw new GitHubError(400, "Managed redirects must contain a valid JSON array"); }
			if (!Array.isArray(mappings)) throw new GitHubError(400, "Managed redirects must contain a valid JSON array");
			if (mappings.length) throw new GitHubError(400, "Permanent redirects must be committed with their deployment config");
		}
		if (deploymentConfig) {
			if (!redirects) throw new GitHubError(400, "Deployment config must be committed with its managed redirects");
			try { assertDeploymentConfigRedirects(JSON.parse(deploymentConfig.source), JSON.parse(redirects.source)); }
			catch { throw new GitHubError(400, "Deployment config is invalid or does not match its managed redirects"); }
		}
		if (!additions.size && !removed.size) throw new GitHubError(400, "Release has no repository changes");
		const result = await request<CommitResult>("/graphql", {
			method: "POST", body: JSON.stringify({
				query: "mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}",
				variables: { input: { branch: { repositoryNameWithOwner: "Nocticur/Firefly", branchName: "master" }, expectedHeadOid: baseSha,
					message: { headline: `content: publish ${taskId}`, body: `Firefly-Task: ${taskId}\nFirefly-Snapshot-Digest: ${digest}` },
					fileChanges: { additions: files.map((file) => ({ path: file.path, contents: Buffer.from(file.source).toString("base64") })), deletions: deletions.map((path) => ({ path })) } } },
			}),
		});
		const oid = result?.data?.createCommitOnBranch?.commit?.oid;
		if ((result?.errors === undefined || Array.isArray(result.errors) && !result.errors.length) && validSha(oid)) return oid;
		if (!oid && Array.isArray(result?.errors) && result.errors.length && result.errors.every((error) => isHeadConflict(error, baseSha))) throw new GitHubError(409, "Git branch changed; inspect conflict before publishing", false, true);
		throw new GitHubError(502, "GitHub commit outcome is unknown; reconcile the task marker before retrying", true);
	},
	async findCommit(taskId, digest) {
		validateMarkers(taskId, digest);
		const headSha = await branchHead();
		for (let page = 1; page <= 5; page++) {
			// Freeze pagination to one ancestry; moving/force-pushed master pages can mix histories.
			const commits = await request<Array<{ sha: string; commit: { message: string } }>>(`${repo}/commits?sha=${headSha}&per_page=100&page=${page}`);
			if (!Array.isArray(commits)) throw new GitHubError(502, "GitHub returned invalid commit history");
			for (const commit of commits) {
				if (!validSha(commit?.sha) || typeof commit.commit?.message !== "string" || !hasMarkers(commit.commit.message, taskId, digest)) continue;
				const currentHead = await branchHead();
				if (currentHead === headSha || currentHead === commit.sha) return commit.sha;
				const comparison = await request<{ status?: string; merge_base_commit?: { sha?: string } }>(`${repo}/compare/${commit.sha}...${currentHead}`);
				if ((comparison?.status === "ahead" || comparison?.status === "identical") && comparison.merge_base_commit?.sha === commit.sha) return commit.sha;
			}
			if (commits.length < 100) break;
		}
		return null;
	},
};
