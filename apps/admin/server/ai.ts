import type { AdminApp } from "./types.js";
import { requireAdmin } from "./auth.js";
import { ApiFailure, readJson } from "./security.js";

/**
 * Provider-agnostic summary helper. It speaks the OpenAI chat-completions shape, so any
 * compatible endpoint works: only the three env vars below change, no code edits.
 */
export type AiConfig = { apiKey: string; baseUrl: string; model: string };

export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
	const apiKey = env.AI_API_KEY?.trim();
	if (!apiKey) return null;
	const baseUrl = (env.AI_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "");
	const model = env.AI_MODEL?.trim() || "deepseek-chat";
	return { apiKey, baseUrl, model };
}

/** Strips front matter, code blocks and link/image syntax so the model sees prose only. */
export function summaryInput(source: string): string {
	const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	return body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, 12_000);
}

const instruction = "你是中文技术博客的编辑。用一段 80 到 120 个汉字的纯文本概括下面文章，说清主题和结论；不要 Markdown、不要标题、不要引号、不要用「本文」开头。只输出摘要本身。";

type ChatResponse = { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: unknown } };

export async function summarize(input: string, config: AiConfig, fetcher: typeof fetch = fetch): Promise<string> {
	const response = await fetcher(`${config.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
		body: JSON.stringify({ model: config.model, temperature: 0.3, max_tokens: 400, messages: [
			{ role: "system", content: instruction },
			{ role: "user", content: input },
		] }),
		signal: AbortSignal.timeout(30_000),
	}).catch((error: unknown) => {
		throw new ApiFailure(502, "AI_UPSTREAM_UNREACHABLE", `无法连接 AI 服务：${error instanceof Error ? error.message : "网络错误"}`);
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		// Never echo the upstream body verbatim into logs or the UI; it can contain provider hints.
		throw new ApiFailure(502, "AI_UPSTREAM_FAILED", `AI 服务返回 ${response.status}`, { status: response.status, excerpt: detail.slice(0, 200) });
	}
	const payload = (await response.json().catch(() => null)) as ChatResponse | null;
	const content = payload?.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) throw new ApiFailure(502, "AI_EMPTY_RESPONSE", "AI 没有返回摘要，请重试");
	return content.trim().replace(/^["'「]+|["'」]+$/g, "").trim();
}

export function registerAiRoutes(app: AdminApp) {
	app.post("/api/ai/summary", requireAdmin, async (context) => {
		const body = await readJson(context.req.raw, 512 * 1024);
		if (typeof body.source !== "string" || !body.source.trim()) throw new ApiFailure(422, "SOURCE_REQUIRED", "必须提供文章源码");
		const config = aiConfig();
		if (!config) throw new ApiFailure(503, "AI_CONFIGURATION_REQUIRED", "未配置 AI_API_KEY，无法生成摘要");
		const input = summaryInput(body.source);
		if (!input) throw new ApiFailure(422, "SOURCE_EMPTY", "文章正文为空，无法生成摘要");
		return context.json({ data: { summary: await summarize(input, config), model: config.model } });
	});
}
