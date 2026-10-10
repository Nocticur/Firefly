import { isMap, parseDocument } from "yaml";

export type SourceAnalysis = {
	safe: boolean;
	prefix: string;
	body: string;
	reasons: string[];
};

export type DocumentNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	marks?: { type: string; attrs?: Record<string, unknown> }[];
	content?: DocumentNode[];
};

const escapeHTML = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeHTML = (value: string) => value.replace(/&#(x[\da-f]+|\d+);?/gi, (_, code: string) => String.fromCodePoint(code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10))).replace(/&(?:colon|Tab|NewLine);/g, (entity) => ({ "&colon;": ":", "&Tab;": "\t", "&NewLine;": "\n" })[entity] ?? entity).replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** Explicit table HTML preserves merged cells, multi-paragraph cells and column widths. */
export function serializeSafeTable(node: DocumentNode): string {
	const children = () => (node.content ?? []).map(serializeSafeTable).join("");
	const attrs = node.attrs ?? {};
	if (node.type === "text") {
		let value = escapeHTML(node.text);
		for (const mark of [...(node.marks ?? [])].reverse()) {
			const tag = ({ bold: "strong", italic: "em", strike: "s", code: "code" } as Record<string, string>)[mark.type];
			if (tag) value = `<${tag}>${value}</${tag}>`;
			else if (mark.type === "link" && isSafeLink(String(mark.attrs?.href ?? ""))) value = `<a href="${escapeHTML(mark.attrs?.href)}">${value}</a>`;
			else throw new Error(`表格中的 ${mark.type} 标记不受支持，请使用源码模式。`);
		}
		return value;
	}
	if (node.type === "table") return `<table><tbody>${children()}</tbody></table>`;
	if (node.type === "tableRow") return `<tr>${children()}</tr>`;
	if (node.type === "tableCell" || node.type === "tableHeader") {
		const tag = node.type === "tableCell" ? "td" : "th";
		let extra = "";
		for (const key of ["rowspan", "colspan"]) if (Number(attrs[key]) > 1) extra += ` ${key}="${Number(attrs[key])}"`;
		if (Array.isArray(attrs.colwidth) && attrs.colwidth.every((width) => Number.isInteger(width) && width > 0)) extra += ` colwidth="${attrs.colwidth.join(",")}"`;
		if (["left", "center", "right"].includes(String(attrs.align))) extra += ` align="${attrs.align}"`;
		return `<${tag}${extra}>${children()}</${tag}>`;
	}
	if (node.type === "heading") return `<h${Number(attrs.level)}>${children()}</h${Number(attrs.level)}>`;
	if (node.type === "hardBreak") return "<br>";
	if (node.type === "horizontalRule") return "<hr>";
	if (node.type === "image" && isSafeImageSource(String(attrs.src ?? ""))) return `<img src="${escapeHTML(attrs.src)}" alt="${escapeHTML(attrs.alt)}" title="${escapeHTML(attrs.title)}">`;
	if (node.type === "inlineMath" || node.type === "blockMath") {
		const tag = node.type === "inlineMath" ? "span" : "div";
		return `<${tag} data-type="${node.type === "inlineMath" ? "inline-math" : "block-math"}" data-latex="${escapeHTML(attrs.latex)}"></${tag}>`;
	}
	if (node.type === "mermaid") return `<pre data-type="mermaid">${escapeHTML(attrs.code)}</pre>`;
	if (node.type === "codeBlock") return `<pre><code${attrs.language ? ` class="language-${escapeHTML(attrs.language)}"` : ""}>${children()}</code></pre>`;
	const tag = ({ paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote" } as Record<string, string>)[node.type ?? ""];
	if (tag) return `<${tag}${node.type === "orderedList" && Number(attrs.start) > 1 ? ` start="${Number(attrs.start)}"` : ""}>${children()}</${tag}>`;
	throw new Error(`表格中的 ${node.type} 内容不受支持，请使用源码模式。`);
}

/** Only the serializer's known schema is accepted; arbitrary HTML stays as source. */
export function isSafeTableHTML(html: string): boolean {
	if (!/^<table><tbody>[\s\S]*<\/tbody><\/table>$/.test(html)) return false;
	const stack: string[] = [];
	const tags = html.match(/<[^>]*>|[^<]+/g) ?? [];
	const voids = new Set(["br", "hr", "img"]);
	const allowed = new Set(["table", "tbody", "tr", "td", "th", "p", "strong", "em", "s", "code", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "pre", "img", "span", "div"]);
	for (const token of tags) {
		if (!token.startsWith("<")) { if (!stack.some((tag) => tag === "td" || tag === "th") && token.trim()) return false; continue; }
		const close = token.match(/^<\/([a-z][a-z0-9]*)>$/);
		if (close) { if (stack.pop() !== close[1]) return false; continue; }
		const open = token.match(/^<([a-z][a-z0-9]*)([^<>]*)>$/);
		if (!open || !allowed.has(open[1])) return false;
		const [, tag, rawAttrs] = open;
		const parent = stack.at(-1);
		if ((tag === "table" && stack.length) || (tag === "tbody" && parent !== "table") || (tag === "tr" && parent !== "tbody") || (["td", "th"].includes(tag) && parent !== "tr") || (!["table", "tbody", "tr", "td", "th"].includes(tag) && !stack.some((entry) => entry === "td" || entry === "th"))) return false;
		const attrs: Record<string, string> = {};
		let remaining = rawAttrs;
		while (remaining) {
			const attr = remaining.match(/^\s+([a-z-]+)="([^"<>]*)"/);
			if (!attr || attr[1] in attrs) return false;
			attrs[attr[1]] = unescapeHTML(attr[2]);
			remaining = remaining.slice(attr[0].length);
		}
		for (const [name, value] of Object.entries(attrs)) {
			if (["td", "th"].includes(tag) && ["colspan", "rowspan"].includes(name) && /^[1-9]\d{0,3}$/.test(value)) continue;
			if (["td", "th"].includes(tag) && name === "colwidth" && /^[1-9]\d*(?:,[1-9]\d*)*$/.test(value)) continue;
			if (["td", "th"].includes(tag) && name === "align" && /^(left|center|right)$/.test(value)) continue;
			if (tag === "a" && name === "href" && isSafeLink(value)) continue;
			if (tag === "img" && ((name === "src" && isSafeImageSource(value)) || name === "alt" || name === "title")) continue;
			if (tag === "ol" && name === "start" && /^[1-9]\d*$/.test(value)) continue;
			if (tag === "code" && name === "class" && /^language-[\w+#.-]+$/.test(value)) continue;
			if ((tag === "span" || tag === "div") && ((name === "data-type" && value === (tag === "span" ? "inline-math" : "block-math")) || name === "data-latex")) continue;
			if (tag === "pre" && name === "data-type" && value === "mermaid") continue;
			return false;
		}
		if ((tag === "span" || tag === "div") && (!attrs["data-latex"] || !attrs["data-type"])) return false;
		if (tag === "img" && !attrs.src) return false;
		if (tag === "a" && !attrs.href) return false;
		if (!voids.has(tag)) stack.push(tag);
	}
	return stack.length === 0;
}

/** Keep the original frontmatter, BOM and line endings outside the rich editor. */
export function analyzeSource(source: string): SourceAnalysis {
	const reasons: string[] = [];
	let prefix = source.startsWith("\uFEFF") ? "\uFEFF" : "";
	let body = source.slice(prefix.length);
	if (/^---(?:\r?\n|$)/.test(body)) {
		const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		if (!match) {
			return { safe: false, prefix: "", body: source, reasons: ["Frontmatter 缺少结束分隔符，请在源码模式处理。"] };
		}
		const yaml = parseDocument(match[1], { schema: "core", uniqueKeys: true });
		if (yaml.errors.length || yaml.warnings.length || !isMap(yaml.contents)) {
			reasons.push("Frontmatter 包含无效或不受支持的 YAML；源码会保持原样。");
		}
		prefix += match[0];
		body = body.slice(match[0].length);
	}

	// Mask code and math before inspecting prose: examples must remain ordinary data.
	const inspectBody = body.replace(/<table>[\s\S]*?<\/table>/g, (table) => isSafeTableHTML(table) ? "" : table);
	let prose = "";
	let fence: { marker: string; length: number } | null = null;
	let math = false;
	for (const line of inspectBody.split(/\r?\n/)) {
		const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			if (opening && opening[1][0] === fence.marker && opening[1].length >= fence.length && !opening[2].trim()) fence = null;
			continue;
		}
		if (opening) {
			const info = opening[2].trim();
			if (info && !/^[\w+#.-]+$/.test(info)) reasons.push("代码块包含语言名之外的属性，需要源码模式。");
			fence = { marker: opening[1][0], length: opening[1].length };
			continue;
		}
		if (/^\s*\$\$\s*$/.test(line)) { math = !math; continue; }
		if (math || /^(?: {4}|\t)/.test(line)) continue;
		prose += `${line}\n`;
	}
	if (fence) reasons.push("代码块尚未关闭，请在源码模式完成。");
	if (math) reasons.push("数学公式块尚未关闭，请在源码模式完成。");
	prose = prose
		.replace(/(`+)([\s\S]*?)\1/g, "")
		.replace(/(?<!\\)\$(?!\$)([^$\n]+)(?<!\\)\$/g, "")
		.replace(/\\[{}<>]/g, "")
		.replace(/<(?:https?:\/\/|mailto:)[^<>\s]+>/gi, "");
	if (/<[^\n>]*(?:>|$)/.test(prose)) reasons.push("包含 HTML 或 JSX，使用源码模式可保留原始内容。");
	if (/^\s*(?:import|export)\s/m.test(prose) || /[{}]/.test(prose)) reasons.push("包含 MDX 表达式或模块语法，不能安全转换为视觉内容。");
	if (/^\s*:{2,}|(?<!:)\:[A-Za-z][\w-]*\[/m.test(prose)) reasons.push("包含扩展指令，使用源码模式编辑。");
	if (/\[\[|\[\^|^ {0,3}\[[^\]]+\]:|^\s*[-*+]\s+\[[ xX]\]/m.test(prose)) reasons.push("包含 Wiki 链接、引用定义、脚注或任务列表，使用源码模式编辑。");
	if (/!\[[^\]]*\]\([^\n]*\)\s*\{/.test(prose) || /^\s*\|.*\{[^}]*\}/m.test(prose)) reasons.push("包含不受支持的 Markdown 属性。");
	if (/\]\(\s*(?:javascript|data|vbscript|file):/i.test(prose)) reasons.push("包含不允许的链接或图片地址。");
	if (/^\s*\$\$.+\$\$\s*$/m.test(prose)) reasons.push("单行块公式请使用源码模式，或改为独立的 $$ 分隔行。");
	return { safe: reasons.length === 0, prefix, body, reasons: [...new Set(reasons)] };
}

export function isSafeLink(value: string): boolean {
	const url = value.trim();
	return !!url && !/[\u0000-\u0020\u007f]/.test(url) && /^(?:https?:\/\/|mailto:|\/[^/]|#)/i.test(url);
}

/** Stable private references remain in Markdown; authenticated URLs are display-only. */
export function isSafeImageSource(value: string): boolean {
	if (isSafeLink(value)) return true;
	if (/^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
	return !/[\u0000-\u0020\\]/.test(value) && /^(?:\.{1,2}\/|[^\s:/\\?#]+\/)[^:]*$/u.test(value);
}

export function imageDisplaySource(value: string): string {
	const reference = value.match(/^media:([0-9a-f-]{36})$/i);
	return reference ? `/api/media/${reference[1]}/content` : value;
}

export function combineEditedBody(analysis: Pick<SourceAnalysis, "prefix">, body: string): string {
	return analysis.prefix + body;
}

export function preserveSourceLineEndings(original: string, edited: string): string {
	return original.includes("\r\n") && !/(?<!\r)\n/.test(original) ? edited.replace(/\r?\n/g, "\r\n") : edited;
}
