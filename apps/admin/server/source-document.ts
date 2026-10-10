import { isMap, isScalar, parseDocument } from "yaml";
import { ApiFailure } from "./security.js";

export type SourceDocument = {
	source: string;
	metadata: Record<string, unknown>;
	body: string;
	frontmatter: string;
	frontmatterStart: number;
	frontmatterEnd: number;
	newline: string;
};

export function parseSourceDocument(source: string): SourceDocument {
	if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) throw new ApiFailure(422, "SOURCE_INVALID", "文章源码必须为不超过 2 MiB 的文本");
	if (source.includes("\u0000")) throw new ApiFailure(422, "SOURCE_INVALID", "文章源码不能包含 NUL");
	const opening = /^(?:\uFEFF)?---(\r?\n)/.exec(source);
	if (!opening) throw new ApiFailure(422, "FRONTMATTER_REQUIRED", "文章必须包含 YAML Front-matter");
	const start = opening[0].length;
	const ending = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/gm;
	ending.lastIndex = start;
	const match = ending.exec(source);
	if (!match) throw new ApiFailure(422, "FRONTMATTER_INVALID", "YAML Front-matter 缺少结束分隔符");
	const frontmatter = source.slice(start, match.index);
	const document = parseDocument(frontmatter, { keepSourceTokens: true, uniqueKeys: true, prettyErrors: false });
	if (document.errors.length) throw new ApiFailure(422, "FRONTMATTER_INVALID", "YAML Front-matter 不合法", document.errors.map((error) => error.code));
	if (document.contents && !isMap(document.contents)) throw new ApiFailure(422, "FRONTMATTER_INVALID", "YAML Front-matter 必须是映射");
	let metadata: unknown;
	try { metadata = document.toJS({ maxAliasCount: 50 }); } catch { throw new ApiFailure(422, "FRONTMATTER_INVALID", "YAML 引用结构不安全"); }
	if (metadata === null) metadata = {};
	return { source, metadata: metadata as Record<string, unknown>, body: source.slice(match.index + match[0].length), frontmatter, frontmatterStart: start, frontmatterEnd: match.index, newline: opening[1] };
}

const metadataFields = new Set(["title", "published", "description", "category", "tags", "draft", "pinned", "comment", "image", "slug"]);
export function patchMetadata(source: string, patch: Record<string, unknown>): string {
	const parsed = parseSourceDocument(source);
	for (const [key, value] of Object.entries(patch)) {
		if (!metadataFields.has(key)) throw new ApiFailure(400, "METADATA_FIELD_UNSUPPORTED", `不支持直接修改元数据字段 ${key}；请使用源码模式`);
		if (["draft", "pinned", "comment"].includes(key) ? typeof value !== "boolean" : key === "tags" ? !Array.isArray(value) || value.some((tag) => typeof tag !== "string") : key === "category" ? value !== null && typeof value !== "string" : typeof value !== "string") throw new ApiFailure(422, "METADATA_VALUE_INVALID", `元数据字段 ${key} 类型不合法`);
		if (typeof value === "string" && value.length > 20_000) throw new ApiFailure(422, "METADATA_VALUE_INVALID", `元数据字段 ${key} 过长`);
	}
	const document = parseDocument(parsed.frontmatter, { keepSourceTokens: true });
	const operations: Array<{ start: number; end: number; value: string }> = [];
	const additions: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		const pair = isMap(document.contents) ? document.contents.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined;
		const serialized = JSON.stringify(value);
		if (!pair) { additions.push(`${key}: ${serialized}${parsed.newline}`); continue; }
		// Complex tagged/anchored nodes must remain in source mode: replacing them may change aliases elsewhere.
		if (pair.value && "anchor" in pair.value && pair.value.anchor || pair.value && "tag" in pair.value && pair.value.tag) throw new ApiFailure(422, "SOURCE_MODE_REQUIRED", `字段 ${key} 使用 YAML 标记或锚点，须在源码模式编辑`);
		if (!pair.value || !("range" in pair.value) || !pair.value.range) throw new ApiFailure(422, "SOURCE_MODE_REQUIRED", `字段 ${key} 无法安全进行局部编辑，请使用源码模式`);
		const [start, end] = pair.value.range;
		operations.push({ start, end, value: serialized });
	}
	let frontmatter = parsed.frontmatter;
	for (const operation of operations.sort((a, b) => b.start - a.start)) frontmatter = frontmatter.slice(0, operation.start) + operation.value + frontmatter.slice(operation.end);
	if (additions.length) frontmatter += `${frontmatter.length && !frontmatter.endsWith("\n") ? parsed.newline : ""}${additions.join("")}`;
	const result = source.slice(0, parsed.frontmatterStart) + frontmatter + source.slice(parsed.frontmatterEnd);
	const updated = parseSourceDocument(result);
	for (const [key, value] of Object.entries(patch)) if (JSON.stringify(updated.metadata[key]) !== JSON.stringify(value)) throw new ApiFailure(422, "SOURCE_MODE_REQUIRED", `字段 ${key} 未通过局部编辑校验，请使用源码模式`);
	return result;
}

export function validatePostSource(source: string): Record<string, unknown> {
	const { metadata } = parseSourceDocument(source);
	if (typeof metadata.title !== "string" || !metadata.title.trim()) throw new ApiFailure(422, "POST_TITLE_REQUIRED", "文章须有非空 title");
	if (metadata.published === undefined || (typeof metadata.published !== "string" && !(metadata.published instanceof Date))) throw new ApiFailure(422, "POST_DATE_REQUIRED", "文章须有 published 日期");
	if (Number.isNaN(Date.parse(String(metadata.published)))) throw new ApiFailure(422, "POST_DATE_INVALID", "published 日期不合法");
	if (metadata.draft !== undefined && typeof metadata.draft !== "boolean") throw new ApiFailure(422, "POST_DRAFT_INVALID", "draft 必须为布尔值");
	return metadata;
}
