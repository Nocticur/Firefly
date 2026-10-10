import { useEffect, useMemo, useRef, useState } from "react";
import {
	EditorContent, Node, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer,
	mergeAttributes, useEditor, type Editor, type JSONContent, type NodeViewProps,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Mathematics } from "@tiptap/extension-mathematics";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { common, createLowlight } from "lowlight";
import { Bold, Italic, Strikethrough, Code, Link, Unlink, Heading1, Heading2, List, ListOrdered, Quote, Minus, Table2, Sigma, GitBranch, Image, Undo2, Redo2, Check, X, FileCode2, Pilcrow } from "lucide-react";
import type { MediaRecord } from "../../shared/contracts";
import { analyzeSource, combineEditedBody, imageDisplaySource, isSafeImageSource, isSafeLink, preserveSourceLineEndings, serializeSafeTable } from "../lib/source-safety";
import "katex/dist/katex.min.css";
import "./editor.css";

const lowlight = createLowlight(common);
const languages = ["plaintext", ...lowlight.listLanguages()].sort();

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
	const [query, setQuery] = useState(String(node.attrs.language || "plaintext"));
	const [searching, setSearching] = useState(false);
	useEffect(() => { setQuery(String(node.attrs.language || "plaintext")); }, [node.attrs.language]);
	return <NodeViewWrapper className="ff-code-block">
		<div className="ff-code-controls" contentEditable={false}>
			<label>语言 / Language <input aria-label="搜索代码语言" value={query} onFocus={() => setSearching(true)} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearching(false); }} /></label>
			{searching && <div className="ff-language-results" role="listbox" aria-label="代码语言">
				{languages.filter((language) => language.includes(query.toLowerCase())).slice(0, 16).map((language) => <button key={language} type="button" role="option" aria-selected={language === node.attrs.language} onClick={() => { updateAttributes({ language: language === "plaintext" ? null : language }); setQuery(language); setSearching(false); }}>{language}</button>)}
				{!languages.some((language) => language.includes(query.toLowerCase())) && <span>没有匹配语言 / No language found</span>}
			</div>}
		</div>
		<pre><NodeViewContent<"code"> as="code" /></pre>
	</NodeViewWrapper>;
}

function MermaidView({ node, updateAttributes, selected }: NodeViewProps) {
	return <NodeViewWrapper className={`ff-mermaid-block ${selected ? "is-selected" : ""}`}>
		<div className="ff-mermaid-heading" contentEditable={false}><GitBranch size={15} /> Mermaid 图表 <span>发布时渲染 / Rendered on publish</span></div>
		<textarea aria-label="Mermaid 图表源码" value={String(node.attrs.code ?? "")} onChange={(event) => updateAttributes({ code: event.target.value })} contentEditable={false} spellCheck={false} />
	</NodeViewWrapper>;
}

const MermaidBlock = Node.create({
	name: "mermaid", group: "block", atom: true, defining: true, priority: 999,
	addAttributes: () => ({ code: { default: "flowchart LR\n  A[开始] --> B[完成]", parseHTML: (element: HTMLElement) => element.textContent ?? "", renderHTML: () => ({}) } }),
	parseHTML: () => [{ tag: 'pre[data-type="mermaid"]' }],
	renderHTML: ({ node, HTMLAttributes }) => ["pre", mergeAttributes(HTMLAttributes, { "data-type": "mermaid" }), String(node.attrs.code)],
	markdownTokenName: "code",
	parseMarkdown: (token) => token.lang === "mermaid" ? { type: "mermaid", attrs: { code: token.text ?? "" } } : [],
	renderMarkdown: (node) => {
		const code = String(node.attrs?.code ?? "");
		const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)));
		return `${fence}mermaid\n${code}\n${fence}`;
	},
	addNodeView: () => ReactNodeViewRenderer(MermaidView),
});

const ArticleImage = Node.create({
	name: "image", inline: false, group: "block", atom: true, draggable: true,
	addAttributes: () => ({ src: { default: null }, alt: { default: "" }, title: { default: null } }),
	parseHTML: () => [{ tag: "img[src]", getAttrs: (element) => isSafeImageSource((element as HTMLElement).getAttribute("src") ?? "") ? null : false }],
	renderHTML: ({ HTMLAttributes }) => ["img", { ...HTMLAttributes, src: imageDisplaySource(String(HTMLAttributes.src ?? "")) }],
	markdownTokenName: "image",
	parseMarkdown: (token) => ({ type: "image", attrs: { src: token.href, alt: token.text ?? "", title: token.title ?? null } }),
	renderMarkdown: (node) => `![${String(node.attrs?.alt ?? "").replace(/[\\\[\]]/g, "\\$&")}](${String(node.attrs?.src ?? "").replace(/[()\\]/g, "\\$&")}${node.attrs?.title ? ` "${String(node.attrs.title).replace(/["\\]/g, "\\$&")}"` : ""})`,
});

// Standard Markdown cannot represent spans or multiple blocks in a table cell.
// The allowed table HTML schema keeps those edits reversible across sessions.
const RichTable = Table.extend({ renderMarkdown: (node) => serializeSafeTable(node) });

type Mode = "visual" | "source";
type SlashState = { query: string; from: number; to: number; left: number; top: number };
type Dialog = { kind: "link" | "math" | "image"; value: string; alt?: string; block?: boolean; pos?: number; from: number; to: number };
type Command = { id: string; label: string; english: string; keywords: string; icon: typeof Bold; run: (editor: Editor) => void };

export type ArticleEditorProps = { source: string; onChange: (source: string) => void; media?: MediaRecord[] };

export function ArticleEditor({ source, onChange, media = [] }: ArticleEditorProps) {
	const analysis = useMemo(() => analyzeSource(source), [source]);
	const [mode, setMode] = useState<Mode>(() => analysis.safe ? "visual" : "source");
	const [error, setError] = useState("");
	const [slash, setSlash] = useState<SlashState | null>(null);
	const [slashIndex, setSlashIndex] = useState(0);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [, refresh] = useState(0);
	const analysisRef = useRef(analysis);
	const onChangeRef = useRef(onChange);
	const lastEmitted = useRef<string | null>(null);
	const slashRef = useRef<{ state: SlashState | null; index: number; commands: Command[] }>({ state: null, index: 0, commands: [] });
	const dialogRef = useRef<((kind: Dialog["kind"], editor: Editor, block?: boolean) => void) | null>(null);
	const editorRef = useRef<Editor | null>(null);
	analysisRef.current = analysis;
	onChangeRef.current = onChange;

	const openDialog = (kind: Dialog["kind"], target: Editor, block = false) => {
		const { from, to } = target.state.selection;
		setError("");
		setDialog({ kind, value: kind === "link" ? String(target.getAttributes("link").href ?? "") : "", block, from, to });
	};
	dialogRef.current = openDialog;

	const syncSelection = (target: Editor) => {
		refresh((value) => value + 1);
		const { $from, empty } = target.state.selection;
		const text = $from.parent.textBetween(0, $from.parentOffset, "\0", "\0");
		const match = empty && !target.isActive("codeBlock") ? text.match(/(?:^|\s)\/([\p{L}\p{N} _-]*)$/u) : null;
		if (!match) { setSlash(null); return; }
		const to = target.state.selection.from;
		const from = to - match[1].length - 1;
		const coords = target.view.coordsAtPos(to);
		setSlash({ query: match[1], from, to, left: Math.min(coords.left, Math.max(12, window.innerWidth - 350)), top: Math.min(coords.bottom + 8, Math.max(12, window.innerHeight - 370)) });
	};

	const editor = useEditor({
		extensions: [
			StarterKit.configure({ codeBlock: false, underline: false, trailingNode: { node: "paragraph" }, link: { openOnClick: false, autolink: false, protocols: ["http", "https", "mailto"] } }),
			CodeBlockLowlight.configure({ lowlight, enableTabIndentation: true }).extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }),
			ArticleImage, MermaidBlock,
			Mathematics.configure({
				katexOptions: { throwOnError: false, trust: false, strict: "warn" },
				inlineOptions: { onClick: (node, pos) => setDialog({ kind: "math", value: String(node.attrs.latex), block: false, pos, from: pos, to: pos + node.nodeSize }) },
				blockOptions: { onClick: (node, pos) => setDialog({ kind: "math", value: String(node.attrs.latex), block: true, pos, from: pos, to: pos + node.nodeSize }) },
			}),
			RichTable.configure({ resizable: true }), TableRow, TableCell, TableHeader,
			Markdown,
		],
		content: analysis.safe ? analysis.body : "",
		contentType: "markdown", immediatelyRender: true,
		editorProps: {
			attributes: { class: "ff-article-prose", "aria-label": "文章正文视觉编辑器", role: "textbox", "aria-multiline": "true" },
			handleKeyDown: (_view, event) => {
				const target = editorRef.current;
				if (!target) return false;
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); dialogRef.current?.("link", target); return true; }
				const current = slashRef.current;
				if (!current.state) return false;
				if (event.key === "Escape") { setSlash(null); return true; }
				if (["ArrowDown", "ArrowUp"].includes(event.key) && current.commands.length) {
					event.preventDefault(); setSlashIndex((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + current.commands.length) % current.commands.length); return true;
				}
				if (event.key === "Enter" && current.commands.length) {
					event.preventDefault(); target.chain().focus().deleteRange({ from: current.state.from, to: current.state.to }).run();
					current.commands[current.index % current.commands.length].run(target); setSlash(null); return true;
				}
				return false;
			},
			handlePaste: (_view, event) => {
				const text = event.clipboardData?.getData("text/plain");
				const target = editorRef.current;
				if (!text || !target || target.isActive("codeBlock")) return false;
				const pasted = analyzeSource(text);
				if (!pasted.safe || pasted.prefix) { event.preventDefault(); setError("粘贴内容包含不受支持的源码结构。请切换源码模式粘贴，原文不会被改写。"); return true; }
				event.preventDefault(); target.commands.insertContent(text, { contentType: "markdown" }); return true;
			},
		},
		onUpdate: ({ editor: target }) => {
			try {
				const updated = combineEditedBody(analysisRef.current, target.getMarkdown());
				lastEmitted.current = updated;
				onChangeRef.current(updated);
				setError("");
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "该内容不能安全转换，请使用源码模式。");
				setMode("source");
			}
			syncSelection(target);
		},
		onSelectionUpdate: ({ editor: target }) => syncSelection(target),
	});
	editorRef.current = editor;

	useEffect(() => {
		if (!editor || source === lastEmitted.current) return;
		if (!analysis.safe) { setMode("source"); return; }
		try { editor.commands.setContent(analysis.body, { contentType: "markdown", emitUpdate: false }); }
		catch { setMode("source"); setError("此文档不能安全载入视觉编辑器，原始源码已保留。"); }
	}, [source, analysis, editor]);
	useEffect(() => { setSlashIndex(0); }, [slash?.query]);
	useEffect(() => { if (mode === "source") { setSlash(null); setDialog(null); } }, [mode]);

	const commands: Command[] = [
		{ id: "paragraph", label: "正文", english: "Paragraph", keywords: "text 正文 段落", icon: Pilcrow, run: (target) => target.chain().focus().setParagraph().run() },
		{ id: "h1", label: "一级标题", english: "Heading 1", keywords: "heading 标题 h1", icon: Heading1, run: (target) => target.chain().focus().setHeading({ level: 1 }).run() },
		{ id: "h2", label: "二级标题", english: "Heading 2", keywords: "heading 标题 h2", icon: Heading2, run: (target) => target.chain().focus().setHeading({ level: 2 }).run() },
		{ id: "h3", label: "三级标题", english: "Heading 3", keywords: "heading 标题 h3", icon: Heading2, run: (target) => target.chain().focus().setHeading({ level: 3 }).run() },
		{ id: "bullet", label: "无序列表", english: "Bullet list", keywords: "list 列表 无序", icon: List, run: (target) => target.chain().focus().toggleBulletList().run() },
		{ id: "ordered", label: "有序列表", english: "Numbered list", keywords: "list 列表 有序", icon: ListOrdered, run: (target) => target.chain().focus().toggleOrderedList().run() },
		{ id: "quote", label: "引用", english: "Quote", keywords: "quote 引用", icon: Quote, run: (target) => target.chain().focus().toggleBlockquote().run() },
		{ id: "code", label: "代码块", english: "Code block", keywords: "code 代码", icon: Code, run: (target) => target.chain().focus().toggleCodeBlock().run() },
		{ id: "table", label: "表格", english: "Table", keywords: "table 表格", icon: Table2, run: (target) => target.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
		{ id: "math", label: "行内公式", english: "Inline math", keywords: "math latex 数学 公式", icon: Sigma, run: (target) => openDialog("math", target) },
		{ id: "math-block", label: "块公式", english: "Block math", keywords: "math latex 数学 块公式", icon: Sigma, run: (target) => openDialog("math", target, true) },
		{ id: "mermaid", label: "Mermaid 图表", english: "Mermaid diagram", keywords: "mermaid diagram 图表 流程图", icon: GitBranch, run: (target) => target.chain().focus().insertContent({ type: "mermaid" }).run() },
		{ id: "image", label: "图片", english: "Image", keywords: "image media 图片 媒体", icon: Image, run: (target) => openDialog("image", target) },
		{ id: "rule", label: "分隔线", english: "Divider", keywords: "divider rule 分隔线", icon: Minus, run: (target) => target.chain().focus().setHorizontalRule().run() },
	];
	const filteredCommands = commands.filter((command) => `${command.label} ${command.english} ${command.keywords}`.toLowerCase().includes((slash?.query ?? "").toLowerCase().trim()));
	slashRef.current = { state: slash, index: slashIndex, commands: filteredCommands };

	const changeMode = (next: Mode) => {
		if (next === "visual") {
			if (!analysis.safe || !editor) return;
			try { editor.commands.setContent(analysis.body, { contentType: "markdown", emitUpdate: false }); }
			catch { setError("视觉编辑器无法安全解析原文，请保留源码模式。"); return; }
		}
		setMode(next); setError("");
	};

	const saveDialog = () => {
		if (!dialog || !editor) return;
		const value = dialog.value.trim();
		if (dialog.kind === "link" || dialog.kind === "image") {
			if (!(dialog.kind === "image" ? isSafeImageSource(value) : isSafeLink(value))) { setError(dialog.kind === "image" ? "请输入图片地址、相对图片路径或选择私有媒体。" : "请输入 https://、http://、mailto:、站内路径或锚点地址。"); return; }
		}
		if (!value) { setError("请输入内容。"); return; }
		if (dialog.kind === "link") {
			const chain = editor.chain().focus().setTextSelection({ from: dialog.from, to: dialog.to });
			if (dialog.from === dialog.to && !editor.isActive("link")) chain.insertContent({ type: "text", text: value, marks: [{ type: "link", attrs: { href: value } }] }).run();
			else chain.extendMarkRange("link").setLink({ href: value }).run();
		} else if (dialog.kind === "image") editor.chain().focus().setTextSelection({ from: dialog.from, to: dialog.to }).insertContent({ type: "image", attrs: { src: value, alt: dialog.alt ?? "" } }).run();
		else if (dialog.pos !== undefined) editor.chain().focus().setNodeSelection(dialog.pos).updateAttributes(dialog.block ? "blockMath" : "inlineMath", { latex: value }).run();
		else editor.chain().focus().setTextSelection({ from: dialog.from, to: dialog.to }).insertContent({ type: dialog.block ? "blockMath" : "inlineMath", attrs: { latex: value } }).run();
		setDialog(null); setError("");
	};

	const formatButtons = editor && <>
		<Tool label="粗体 / Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={17} /></Tool>
		<Tool label="斜体 / Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={17} /></Tool>
		<Tool label="删除线 / Strike" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={17} /></Tool>
		<Tool label="行内代码 / Code" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={17} /></Tool>
		<Tool label="链接 / Link (Ctrl+K)" active={editor.isActive("link")} onClick={() => openDialog("link", editor)}><Link size={17} /></Tool>
		{editor.isActive("link") && <Tool label="移除链接 / Unlink" onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}><Unlink size={17} /></Tool>}
	</>;

	return <section className="ff-article-editor" aria-label="文章编辑器">
		<div className="ff-editor-topbar">
			<div className="ff-editor-modes" role="group" aria-label="编辑模式">
				<button type="button" aria-pressed={mode === "visual"} disabled={!analysis.safe} onClick={() => changeMode("visual")}><Pilcrow size={15} /> 视觉 / Visual</button>
				<button type="button" aria-pressed={mode === "source"} onClick={() => changeMode("source")}><FileCode2 size={15} /> 源码 / Source</button>
			</div>
			<span className="ff-editor-caption">{mode === "source" ? "直接保存完整源码" : "输入 / 插入区块 · Ctrl+K 添加链接"}</span>
		</div>
		{!analysis.safe && <div className="ff-editor-notice" role="status">{analysis.reasons.map((reason) => <p key={reason}>{reason}</p>)}</div>}
		{error && <div className="ff-editor-error" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={14} /></button></div>}
		{mode === "source" ? <textarea className="ff-source-editor" aria-label="文章 Markdown / MDX 完整源码" value={source} onChange={(event) => { lastEmitted.current = null; onChange(preserveSourceLineEndings(source, event.target.value)); }} spellCheck={false} /> : <>
			{editor && <div className="ff-editor-toolbar" aria-label="格式工具栏">{formatButtons}
				<span className="ff-tool-separator" />
				<Tool label="二级标题 / Heading" active={editor.isActive("heading")} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={17} /></Tool>
				<Tool label="无序列表 / List" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={17} /></Tool>
				<Tool label="引用 / Quote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={17} /></Tool>
				<Tool label="插入表格 / Table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={17} /></Tool>
				<Tool label="数学公式 / Math" onClick={() => openDialog("math", editor)}><Sigma size={17} /></Tool>
				<Tool label="Mermaid 图表" onClick={() => editor.chain().focus().insertContent({ type: "mermaid" }).run()}><GitBranch size={17} /></Tool>
				<Tool label="插入图片 / Image" onClick={() => openDialog("image", editor)}><Image size={17} /></Tool>
				<span className="ff-tool-separator" />
				<Tool label="撤销 / Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={17} /></Tool>
				<Tool label="重做 / Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={17} /></Tool>
			</div>}
			{editor?.isActive("table") && <div className="ff-table-toolbar" aria-label="高级表格操作">
				<TableAction editor={editor} label="上方加行" command="addRowBefore" /><TableAction editor={editor} label="下方加行" command="addRowAfter" /><TableAction editor={editor} label="左侧加列" command="addColumnBefore" /><TableAction editor={editor} label="右侧加列" command="addColumnAfter" />
				<TableAction editor={editor} label="删除行" command="deleteRow" /><TableAction editor={editor} label="删除列" command="deleteColumn" /><TableAction editor={editor} label="合并单元格" command="mergeCells" /><TableAction editor={editor} label="拆分单元格" command="splitCell" /><TableAction editor={editor} label="切换表头" command="toggleHeaderRow" /><TableAction editor={editor} label="删除表格" command="deleteTable" />
				<span>拖选多个单元格后合并；拖动列边缘调整宽度。</span>
			</div>}
			{editor && <BubbleMenu editor={editor} className="ff-floating-toolbar" options={{ placement: "top", offset: 10 }} shouldShow={({ state }) => !state.selection.empty && !editor.isActive("codeBlock") && !editor.isActive("table")}>{formatButtons}</BubbleMenu>}
			<EditorContent editor={editor} />
			{analysis.prefix && <p className="ff-frontmatter-note">Frontmatter 原片段保留；元数据在文章设置或源码模式中编辑。</p>}
		</>}
		{mode === "visual" && slash && <div className="ff-slash-menu" style={{ left: slash.left, top: slash.top }} role="listbox" aria-label="插入区块 / Insert block">
			<div className="ff-slash-heading">插入区块 / Insert block <kbd>↑ ↓ ↵</kbd></div>
			{filteredCommands.length ? filteredCommands.map((command, index) => <button key={command.id} type="button" role="option" aria-selected={index === slashIndex % filteredCommands.length} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (editor) { editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run(); command.run(editor); setSlash(null); } }}><command.icon size={18} /><span>{command.label}<small>{command.english}</small></span></button>) : <p>没有匹配区块 / No matching blocks</p>}
		</div>}
		{dialog && <div className="ff-editor-modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(null); }}><form className="ff-editor-dialog" role="dialog" aria-modal="true" aria-label={dialog.kind === "link" ? "添加链接" : dialog.kind === "math" ? "编辑公式" : "插入图片"} onSubmit={(event) => { event.preventDefault(); saveDialog(); }} onKeyDown={(event) => { if (event.key === "Escape") setDialog(null); }}>
			<h3>{dialog.kind === "link" ? "添加链接 / Link" : dialog.kind === "math" ? "LaTeX 公式 / Math" : "插入图片 / Image"}</h3>
			<label>{dialog.kind === "math" ? "LaTeX" : "地址 / URL"}{dialog.kind === "math" ? <textarea autoFocus value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} placeholder="\\frac{a}{b}" /> : <input autoFocus value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} placeholder="https://" />}</label>
			{dialog.kind === "math" && dialog.pos === undefined && <label className="ff-dialog-checkbox"><input type="checkbox" checked={dialog.block} onChange={(event) => setDialog({ ...dialog, block: event.target.checked })} /> 块公式 / Block math</label>}
			{dialog.kind === "image" && <><label>替代文本 / Alt text<input value={dialog.alt ?? ""} onChange={(event) => setDialog({ ...dialog, alt: event.target.value })} /></label>
				{media.some((item) => item.contentType.startsWith("image/")) && <div className="ff-editor-media-picker"><p>选择已上传图片 · 私有引用会随显式发布转换</p>{media.filter((item) => item.contentType.startsWith("image/")).map((item) => <button type="button" key={item.id} onClick={() => setDialog({ ...dialog, value: `media:${item.id}`, alt: item.alt })}><img src={item.access === "private" ? `/api/media/${item.id}/content` : item.url} alt={item.alt} loading="lazy" /><span>{item.name}</span></button>)}</div>}</>}
			{error && <p className="ff-dialog-error" role="alert">{error}</p>}
			<div className="ff-dialog-actions"><button type="button" onClick={() => setDialog(null)}>取消</button><button type="submit"><Check size={15} /> 确认</button></div>
		</form></div>}
	</section>;
}

function Tool({ label, active = false, disabled = false, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => unknown; children: React.ReactNode }) {
	return <button className="ff-editor-tool" type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{children}</button>;
}

type TableCommand = "addRowBefore" | "addRowAfter" | "addColumnBefore" | "addColumnAfter" | "deleteRow" | "deleteColumn" | "mergeCells" | "splitCell" | "toggleHeaderRow" | "deleteTable";
function TableAction({ editor, label, command }: { editor: Editor; label: string; command: TableCommand }) {
	return <button type="button" disabled={!editor.can()[command]()} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus()[command]().run()}>{label}</button>;
}
