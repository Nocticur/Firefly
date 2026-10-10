import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import { getDatabase, getSiteId, type Database } from "./db.js";
import { ApiFailure, expectedRevision, readJson } from "./security.js";

export const MANAGED_SETTING_KEYS = ["title", "subtitle", "description", "siteUrl", "siteStartDate", "timezone", "profileName", "bio", "avatar", "contactLinks", "homeCover", "defaultCover", "background"] as const;
const keySet = new Set<string>(MANAGED_SETTING_KEYS);
const ICON_FILENAMES = new Set(["favicon.svg", "favicon.ico", "favicon-96x96.png", "apple-touch-icon.png", "web-app-manifest-192x192.png", "web-app-manifest-512x512.png"]);
type SettingsRow = Record<string, unknown> & { data: Record<string, unknown>; revision: string | number };
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function text(value: unknown, key: string, max = 10_000): asserts value is string {
	if (typeof value !== "string" || value.length > max || value.includes("\u0000")) throw new ApiFailure(422, "SETTING_INVALID", `设置 ${key} 必须是不超过 ${max} 字符的文本`);
}
export function validateManagedUrl(value: unknown, key: string, allowAsset = false): asserts value is string {
	text(value, key, 2000);
	if (!value || value === "#") return;
	if (allowAsset && /^media:[0-9a-f-]{36}$/i.test(value)) return;
	if (/[\\\u0000-\u0020]/.test(value) || value.startsWith("//")) throw new ApiFailure(422, "URL_INVALID", `${key} URL 不合法`);
	if (value.startsWith("/")) return;
	if (allowAsset && /^(?:assets|images)\/[\p{L}\p{N}_./% -]+$/u.test(value) && !value.split("/").includes("..")) return;
	let parsed: URL;
	try { parsed = new URL(value); } catch { throw new ApiFailure(422, "URL_INVALID", `${key} URL 不合法`); }
	if (!["https:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new ApiFailure(422, "URL_INVALID", `${key} 仅支持 HTTPS、邮件或本站路径`);
}
function validateCover(value: unknown, key: string) {
	if (typeof value === "string") { validateManagedUrl(value, key, true); return; }
	if (!isRecord(value) || Object.keys(value).some((field) => !["desktop", "mobile"].includes(field))) throw new ApiFailure(422, "SETTING_INVALID", `${key} 必须是图片路径或 desktop/mobile 图片组`);
	for (const [field, images] of Object.entries(value)) {
		if (typeof images === "string") validateManagedUrl(images, `${key}.${field}`, true);
		else if (Array.isArray(images) && images.length <= 100) for (const image of images) validateManagedUrl(image, `${key}.${field}`, true);
		else throw new ApiFailure(422, "SETTING_INVALID", `${key}.${field} 必须是路径或路径数组`);
	}
}
export function validateSettingsPatch(patch: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(patch)) {
		if (!keySet.has(key)) throw new ApiFailure(422, "SETTING_FIELD_UNSUPPORTED", `不支持管理字段 ${key}`);
		if (key === "contactLinks") {
			if (!Array.isArray(value) || value.length > 30) throw new ApiFailure(422, "SETTING_INVALID", "contactLinks 必须是最多 30 项的数组");
			for (const link of value) {
				if (!isRecord(link) || Object.keys(link).some((field) => !["name", "url", "icon", "showName"].includes(field))) throw new ApiFailure(422, "SETTING_INVALID", "contactLinks 项字段不合法");
				text(link.name, "contactLinks.name", 100);
				validateManagedUrl(link.url, "contactLinks.url");
				if (link.icon !== undefined) text(link.icon, "contactLinks.icon", 150);
				if (link.showName !== undefined && typeof link.showName !== "boolean") throw new ApiFailure(422, "SETTING_INVALID", "showName 必须为布尔值");
			}
		} else if (["homeCover", "background"].includes(key)) validateCover(value, key);
		else if (["avatar", "defaultCover"].includes(key)) validateManagedUrl(value, key, true);
		else {
			text(value, key);
			if (key === "siteUrl" && value !== "https://blog.mourn.top/") throw new ApiFailure(422, "SITE_URL_FIXED", "siteUrl 固定为 https://blog.mourn.top/");
			if (key === "timezone" && value !== "Asia/Shanghai") throw new ApiFailure(422, "TIMEZONE_FIXED", "timezone 固定为 Asia/Shanghai");
			if (key === "siteStartDate" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value) || Number.isNaN(Date.parse(value)))) throw new ApiFailure(422, "SETTING_INVALID", "siteStartDate 必须明确包含 +08:00 北京时间偏移");
		}
	}
}
export function validateNavigation(patch: Record<string, unknown>) {
	if (Object.keys(patch).some((key) => key !== "links") || !Array.isArray(patch.links) || patch.links.length > 50) throw new ApiFailure(422, "NAVIGATION_INVALID", "导航必须含最多 50 项的 links 数组");
	const visit = (links: unknown[], depth: number) => {
		if (depth > 2 || links.length > 50) throw new ApiFailure(422, "NAVIGATION_INVALID", "导航最多支持三级及每层 50 项");
		for (const link of links) {
			if (!isRecord(link) || Object.keys(link).some((key) => !["name", "url", "icon", "external", "pageKey", "children"].includes(key))) throw new ApiFailure(422, "NAVIGATION_INVALID", "导航项字段不合法");
			text(link.name, "navigation.name", 100);
			validateManagedUrl(link.url, "navigation.url");
			if (link.icon !== undefined) text(link.icon, "navigation.icon", 150);
			if (link.pageKey !== undefined) text(link.pageKey, "navigation.pageKey", 100);
			if (link.external !== undefined && typeof link.external !== "boolean") throw new ApiFailure(422, "NAVIGATION_INVALID", "external 必须为布尔值");
			if (link.children !== undefined) {
				if (!Array.isArray(link.children)) throw new ApiFailure(422, "NAVIGATION_INVALID", "children 必须为数组");
				visit(link.children, depth + 1);
			}
		}
	};
	visit(patch.links, 0);
}
export async function getManagedEntity(database: Database, siteId: string, kind: "settings" | "navigation" | "icons") {
	const [row] = await database.query<SettingsRow>("SELECT data,revision FROM entities WHERE site_id=$1 AND kind=$2 AND id='default'", [siteId, kind]);
	if (!row) throw new ApiFailure(503, "BASELINE_IMPORT_REQUIRED", "请先从 GitHub 导入现有站点配置基线");
	return { data: row.data, revision: Number(row.revision) };
}
export async function saveManagedEntity(database: Database, siteId: string, kind: "settings" | "navigation" | "icons", patch: Record<string, unknown>, expected: number) {
	if (kind === "settings") validateSettingsPatch(patch);
	else if (kind === "navigation") validateNavigation(patch);
	else for (const [filename, reference] of Object.entries(patch)) {
		if (!ICON_FILENAMES.has(filename)) throw new ApiFailure(422, "ICON_FILENAME_INVALID", `不支持图标位 ${filename}`);
		validateManagedUrl(reference, filename, true);
	}
	return database.transaction(async (tx) => {
		const [row] = await tx.query<SettingsRow>("SELECT data,revision FROM entities WHERE site_id=$1 AND kind=$2 AND id='default' FOR UPDATE", [siteId, kind]);
		if (!row) throw new ApiFailure(503, "BASELINE_IMPORT_REQUIRED", "请先导入站点配置基线");
		if (Number(row.revision) !== expected) throw new ApiFailure(409, "REVISION_CONFLICT", "设置已被另一次保存修改", { currentRevision: Number(row.revision) });
		const data = { ...row.data, ...patch };
		await tx.query("UPDATE entities SET data=$3::jsonb,revision=revision+1,updated_at=now() WHERE site_id=$1 AND kind=$2 AND id='default'", [siteId, kind, JSON.stringify(data)]);
		return { data, revision: expected + 1 };
	});
}
export function registerSettingsRoutes(app: AdminApp) {
	for (const kind of ["settings", "navigation", "icons"] as const) {
		app.get(`/api/${kind}`, requireAdmin, async (context) => context.json(await getManagedEntity(getDatabase(), getSiteId(), kind)));
		app.put(`/api/${kind}`, requireAdmin, async (context) => {
			const body = await readJson(context.req.raw, 128 * 1024);
			if (!isRecord(body.data)) throw new ApiFailure(422, "SETTING_DATA_REQUIRED", "必须提供 data 对象");
			return context.json(await saveManagedEntity(getDatabase(), getSiteId(), kind, body.data, expectedRevision(body.expectedRevision)));
		});
	}
}
