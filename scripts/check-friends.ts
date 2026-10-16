import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { getEnabledFriends } from "../src/config/friendsConfig";
import { siteConfig } from "../src/config/siteConfig";
import type {
	FriendHealthReport,
	FriendHealthResult,
} from "../src/types/friendHealth";
import {
	normalizeFriendUrl,
	parseFriendHealth,
} from "../src/utils/friend-health";
import {
	createHealthResult,
	hasBacklink,
	isPublicIp,
	type MonitoredFriend,
	mergeHealthResults,
	normalizeTargetUrl,
	type ProbeResult,
	shouldTakeScreenshot,
} from "./friend-monitor-core";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPORT = path.join(ROOT, "public/data/friends-health.json");
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT = 12_000;
const USER_AGENT = "FireflyFriendCheck/1.0 (+https://blog.mourn.top/friends/)";

type HttpPage = { statusCode: number; body: string; url: string };
type HttpResource = {
	statusCode: number;
	body: Buffer;
	url: string;
	headers: Record<string, string>;
};

/** Resolve and pin a public address; do not let DNS change between validation and the HTTP request. */
async function publicAddress(
	value: string,
): Promise<{ address: string; family: number }> {
	const url = new URL(normalizeTargetUrl(value));
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const addresses = isIP(hostname)
		? [{ address: hostname, family: isIP(hostname) }]
		: await Promise.race([
				lookup(hostname, { all: true }),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("DNS lookup timed out")),
						TIMEOUT,
					);
				}),
			]).finally(() => clearTimeout(timer));
	if (!addresses.length || addresses.some((item) => !isPublicIp(item.address)))
		throw new Error("Target resolves to a private or reserved network");
	const selected = addresses.find((item) => item.family === 4) ?? addresses[0];
	if (!selected) throw new Error("Target has no public address");
	return selected;
}

async function httpResource(
	value: string,
	followRedirects = true,
	redirects = 0,
): Promise<HttpResource> {
	if (redirects > 5) throw new Error("Too many redirects");
	const url = new URL(normalizeTargetUrl(value));
	const address = await publicAddress(url.href);
	const response = await new Promise<{
		statusCode: number;
		location?: string;
		body: Buffer;
		encoding?: string;
		headers: Record<string, string>;
	}>((resolve, reject) => {
		const send = url.protocol === "https:" ? requestHttps : requestHttp;
		const req = send(
			url,
			{
				signal: AbortSignal.timeout(TIMEOUT),
				agent: false,
				family: address.family,
				lookup: (_hostname, _options, callback) =>
					callback(null, address.address, address.family),
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Encoding": "identity",
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BYTES)
						res.destroy(new Error("HTML exceeds 2 MiB limit"));
					else chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () =>
					resolve({
						statusCode: res.statusCode ?? 0,
						location: res.headers.location,
						body: Buffer.concat(chunks),
						encoding: res.headers["content-encoding"],
						headers: Object.fromEntries(
							Object.entries(res.headers).filter(
								(entry): entry is [string, string] =>
									typeof entry[1] === "string" &&
									![
										"content-encoding",
										"content-length",
										"transfer-encoding",
										"set-cookie",
									].includes(entry[0]),
							),
						),
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
	if (
		followRedirects &&
		[301, 302, 303, 307, 308].includes(response.statusCode) &&
		response.location
	)
		return httpResource(
			new URL(response.location, url).href,
			true,
			redirects + 1,
		);
	const options = { maxOutputLength: MAX_BYTES };
	const bytes =
		response.encoding === "gzip"
			? gunzipSync(response.body, options)
			: response.encoding === "br"
				? brotliDecompressSync(response.body, options)
				: response.encoding === "deflate"
					? inflateSync(response.body, options)
					: response.body;
	return {
		statusCode: response.statusCode,
		body: bytes,
		url: url.href,
		headers: response.headers,
	};
}

async function httpPage(value: string): Promise<HttpPage> {
	const response = await httpResource(value);
	return { ...response, body: response.body.toString("utf8") };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 400) : "检测失败";
}

async function probe(friend: MonitoredFriend): Promise<ProbeResult> {
	let result: ProbeResult = {
		ok: false,
		statusCode: null,
		latencyMs: null,
		backlink: "unknown",
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const started = performance.now();
		try {
			const page = await httpPage(friend.url);
			const ok = page.statusCode >= 200 && page.statusCode < 400;
			result = {
				ok,
				statusCode: page.statusCode,
				latencyMs: Math.round(performance.now() - started),
				backlink: "unchecked",
			};
			if (!ok) {
				result.error = `HTTP ${page.statusCode}`;
				continue;
			}
			if (hasBacklink(page.body, page.url, siteConfig.site_url))
				result.backlink = "present";
			else if (friend.linkpage) {
				try {
					const links = await httpPage(friend.linkpage);
					result.backlink =
						links.statusCode < 400
							? hasBacklink(links.body, links.url, siteConfig.site_url)
								? "present"
								: "missing"
							: "unknown";
				} catch {
					result.backlink = "unknown";
				}
			}
			// Sites without a configured link page are not expected to exchange links.
			return result;
		} catch (error) {
			result = {
				ok: false,
				statusCode: null,
				latencyMs: null,
				backlink: "unknown",
				error: errorMessage(error),
			};
		}
	}
	return result;
}

async function readReport(): Promise<FriendHealthReport> {
	try {
		const contents = await readFile(REPORT, "utf8");
		const report = parseFriendHealth(JSON.parse(contents));
		if (!report) throw new Error("Invalid friend health report");
		return report;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { schemaVersion: 1, checkedAt: null, results: [] };
	}
}

async function writeReport(report: FriendHealthReport): Promise<void> {
	await mkdir(path.dirname(REPORT), { recursive: true });
	const temporary = `${REPORT}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	await rename(temporary, REPORT);
}

async function captureScreenshots(
	results: FriendHealthResult[],
	force: boolean,
): Promise<void> {
	const due = results.filter((result) =>
		shouldTakeScreenshot(result, Date.now(), force),
	);
	if (!due.length) return;
	const { chromium } = await import("playwright");
	const { default: sharp } = await import("sharp");
	const browser = await chromium.launch({
		headless: true,
		...(process.env.FRIENDS_CHROME_PATH
			? { executablePath: process.env.FRIENDS_CHROME_PATH }
			: {}),
		// The pages being captured never inherit GitHub credentials or the caller's environment.
		env: Object.fromEntries(
			[
				"PATH",
				"HOME",
				"USERPROFILE",
				"SystemRoot",
				"TEMP",
				"TMP",
				"DISPLAY",
			].flatMap((key) => {
				const value = process.env[key];
				return value ? [[key, value]] : [];
			}),
		),
	});
	try {
		for (const result of due) {
			const context = await browser.newContext({
				viewport: { width: 1365, height: 860 },
				deviceScaleFactor: 1,
				reducedMotion: "reduce",
				serviceWorkers: "block",
				acceptDownloads: false,
			});
			try {
				await context.route("**/*", async (route) => {
					try {
						if (
							route.request().method() !== "GET" ||
							["media", "eventsource"].includes(route.request().resourceType())
						) {
							await route.abort();
							return;
						}
						// Fulfill through the same pinned-address transport. Chromium never performs a second DNS resolution.
						const resource = await httpResource(route.request().url(), false);
						await route.fulfill({
							status: resource.statusCode,
							headers: resource.headers,
							body: resource.body,
						});
					} catch {
						await route.abort().catch(() => {});
					}
				});
				await context.routeWebSocket(/.*/, (socket) => socket.close());
				const page = await context.newPage();
				const response = await page.goto(result.url, {
					waitUntil: "domcontentloaded",
					timeout: 25_000,
				});
				if (!response || response.status() >= 400)
					throw new Error("Screenshot navigation failed");
				await page.locator("body").waitFor({ state: "visible", timeout: 5000 });
				await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
				await page.evaluate(async () => {
					await Promise.race([
						Promise.all([
							document.fonts.ready,
							...Array.from(document.images)
								.filter((img) => img.getBoundingClientRect().top < innerHeight)
								.map((img) => img.decode().catch(() => {})),
						]),
						new Promise((resolve) => setTimeout(resolve, 3000)),
					]);
				});
				const png = await page.screenshot({
					animations: "disabled",
					timeout: 10_000,
				});
				const screenshotKey = normalizeFriendUrl(result.url);
				if (!screenshotKey) throw new Error("Invalid screenshot URL");
				const filename = `${createHash("sha256").update(screenshotKey).digest("hex").slice(0, 24)}.webp`;
				const directory = path.join(ROOT, "public/assets/friends");
				await mkdir(directory, { recursive: true });
				const target = path.join(directory, filename);
				const image = await sharp(png)
					.resize({ width: 960, withoutEnlargement: true })
					.webp({ quality: 74 })
					.toBuffer();
				await writeFile(`${target}.tmp`, image);
				await rename(`${target}.tmp`, target);
				result.screenshot = `/assets/friends/${filename}`;
				result.screenshotAt = new Date().toISOString();
				console.log(`截图已更新：${result.name}`);
			} catch (error) {
				console.warn(
					`截图未更新，保留旧图：${result.name} (${errorMessage(error)})`,
				);
			} finally {
				await context.close();
			}
		}
	} finally {
		await browser.close();
	}
}

async function main(): Promise<void> {
	function argument(name: string): string | undefined {
		const args = process.argv.slice(2);
		const index = args.indexOf(`--${name}`);
		return index < 0 ? undefined : args[index + 1];
	}
	const task = argument("task") ?? "status_only";
	if (!["status_only", "screenshots_only", "both"].includes(task))
		throw new Error("task must be status_only, screenshots_only or both");
	const keyword = (argument("target") ?? "").trim().toLowerCase();
	const dueOnly = process.argv.includes("--due-only");
	const friends: MonitoredFriend[] = getEnabledFriends()
		.map((friend) => ({
			url: normalizeTargetUrl(friend.siteurl),
			name: friend.title,
			...(friend.linkpage
				? { linkpage: normalizeTargetUrl(friend.linkpage) }
				: {}),
		}))
		.sort((a, b) => a.url.localeCompare(b.url));
	const selected = friends.filter(
		(friend) =>
			!keyword ||
			`${friend.name} ${friend.url}`.toLowerCase().includes(keyword),
	);
	if (keyword && selected.length === 0)
		throw new Error(
			"No friend matches target; existing results were not changed",
		);
	const old = await readReport();
	const previous = new Map(
		old.results.map((result) => [normalizeFriendUrl(result.url), result]),
	);
	if (process.argv.includes("--plan") || process.argv.includes("--dry-run")) {
		const needed =
			task !== "status_only" &&
			selected.some((friend) => {
				const result = previous.get(normalizeFriendUrl(friend.url));
				return result
					? shouldTakeScreenshot(result, Date.now(), !dueOnly)
					: true;
			});
		console.log(
			JSON.stringify(
				{
					task,
					targets: selected.map(({ name, url }) => ({ name, url })),
					needsScreenshots: needed,
				},
				null,
				2,
			),
		);
		if (process.env.GITHUB_OUTPUT)
			await appendFile(
				process.env.GITHUB_OUTPUT,
				`needs_screenshots=${needed}\n`,
			);
		return;
	}
	const updates: FriendHealthResult[] = [];
	// A newly added site needs one reachability result even for screenshots_only.
	const toProbe =
		task === "screenshots_only"
			? selected.filter(
					(friend) => !previous.has(normalizeFriendUrl(friend.url)),
				)
			: selected;
	if (toProbe.length) {
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, toProbe.length) }, async () => {
				while (cursor < toProbe.length) {
					const friend = toProbe[cursor++];
					if (!friend) break;
					const result = createHealthResult(
						friend,
						await probe(friend),
						previous.get(normalizeFriendUrl(friend.url)),
						new Date().toISOString(),
					);
					updates.push(result);
					console.log(
						`${result.name}：${result.status}，连续失败 ${result.consecutiveFailures} 次`,
					);
				}
			}),
		);
	}
	const merged = mergeHealthResults(
		old.results,
		updates,
		friends.map((friend) => friend.url),
	);
	if (updates.length)
		await writeReport({
			schemaVersion: 1,
			checkedAt: new Date().toISOString(),
			results: merged,
		});
	if (task !== "status_only") {
		const targets = new Set(
			selected.map((friend) => normalizeFriendUrl(friend.url)),
		);
		await captureScreenshots(
			merged.filter((result) => targets.has(normalizeFriendUrl(result.url))),
			!dueOnly,
		);
		await writeReport({
			schemaVersion: 1,
			checkedAt: updates.length ? new Date().toISOString() : old.checkedAt,
			results: merged,
		});
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(errorMessage(error));
		process.exitCode = 1;
	});
}
