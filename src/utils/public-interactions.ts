export type PublicComment = {
	id: string;
	articleId: string;
	parentId: string | null;
	name: string;
	body: string;
	status: "visible" | "deleted";
	createdAt: string;
};

export type PublicFriend = {
	id: string;
	name: string;
	url: string;
	description: string;
	avatar: string;
	group: string;
	sortOrder: number;
};

type Resource = "comments" | "friends";
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("公开接口返回了无效数据，请稍后重试。");
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
	if (typeof value !== "string" || value.length > limit) {
		throw new Error("公开接口返回了无效数据，请稍后重试。");
	}
	return value;
}

export function safePublicUrl(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length > 2000 ||
		[...value].some(
			(character) => character.charCodeAt(0) < 32 || character === "\\",
		)
	)
		return null;
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) &&
			!url.username &&
			!url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

function readComment(value: unknown, articleId?: string): PublicComment {
	const data = record(value);
	const id = text(data.id, 36);
	const mappedArticleId = text(data.articleId, 36);
	const parentId = data.parentId == null ? null : text(data.parentId, 36);
	const createdAt = text(data.createdAt, 80);
	if (
		!UUID.test(id) ||
		!UUID.test(mappedArticleId) ||
		(parentId !== null && !UUID.test(parentId)) ||
		(articleId !== undefined && mappedArticleId !== articleId) ||
		!Number.isFinite(Date.parse(createdAt)) ||
		!["visible", "deleted"].includes(String(data.status))
	) {
		throw new Error("公开接口返回了无效数据，请稍后重试。");
	}
	const deleted = data.status === "deleted";
	return {
		id,
		articleId: mappedArticleId,
		parentId,
		createdAt,
		status: deleted ? "deleted" : "visible",
		name: deleted ? "已删除的评论" : text(data.name, 120),
		body: deleted ? "此评论已删除。" : text(data.body, 10000),
	};
}

function readFriend(value: unknown): PublicFriend {
	const data = record(value);
	const url = safePublicUrl(data.url);
	const avatar =
		data.avatar == null || data.avatar === "" ? "" : safePublicUrl(data.avatar);
	if (
		!url ||
		avatar === null ||
		typeof data.sortOrder !== "number" ||
		!Number.isFinite(data.sortOrder)
	) {
		throw new Error("公开接口返回了无效数据，请稍后重试。");
	}
	return {
		id: text(data.id, 120),
		name: text(data.name, 120),
		url,
		description: text(data.description, 2000),
		avatar,
		group: data.group == null ? "" : text(data.group, 120),
		sortOrder: data.sortOrder,
	};
}

function responseError(status: number): Error {
	const messages: Record<number, string> = {
		400: "提交内容有误，请检查后重试。",
		403: "人机验证未通过或当前无法提交，请重新验证。",
		404: "公开接口尚未部署或此文章暂未开放互动。",
		409: "已存在相同申请，请勿重复提交。",
		422: "提交内容有误，请检查后重试。",
		429: "操作过于频繁，请稍后重试。",
		503: "互动服务尚未配置完成，请稍后再试。",
	};
	return new Error(messages[status] ?? "互动服务暂时不可用，请稍后重试。");
}

async function request(
	path: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = window.setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetch(path, {
			...init,
			signal: controller.signal,
			cache: "no-store",
			credentials: "omit",
		});
		if (!response.ok) throw responseError(response.status);
		return init.method === "POST"
			? await response.text()
			: await response.json();
	} catch (error) {
		if (signal?.aborted) throw error;
		if (controller.signal.aborted)
			throw new Error("互动服务请求超时，请稍后重试。");
		if (error instanceof TypeError)
			throw new Error("无法连接互动服务，请检查网络或稍后重试。");
		if (error instanceof SyntaxError)
			throw new Error("公开接口返回了无效数据，请稍后重试。");
		throw error;
	} finally {
		window.clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

/** Whitelist public fields here; private email addresses never reach rendered data. */
export async function fetchPublicData<T extends PublicComment | PublicFriend>(
	resource: Resource,
	options: { signal?: AbortSignal; articleId?: string } = {},
): Promise<T[]> {
	const query =
		resource === "comments"
			? `?articleId=${encodeURIComponent(options.articleId ?? "")}`
			: "";
	const payload = record(
		await request(
			`/api/public/${resource}${query}`,
			{ headers: { Accept: "application/json" } },
			options.signal,
		),
	);
	if (!Array.isArray(payload.data) || payload.data.length > 10000) {
		throw new Error("公开接口返回了无效数据，请稍后重试。");
	}
	return payload.data.map((value) =>
		resource === "comments"
			? readComment(value, options.articleId)
			: readFriend(value),
	) as T[];
}

export async function submitPublicInteraction(
	resource: Resource,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<void> {
	if (typeof payload.turnstileToken !== "string" || !payload.turnstileToken) {
		throw new Error("请先完成人机验证。");
	}
	await request(
		`/api/public/${resource}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(payload),
		},
		signal,
	);
}

type TurnstileApi = {
	ready(callback: () => void): void;
	render(container: HTMLElement, options: Record<string, unknown>): string;
	reset(id: string): void;
	remove(id: string): void;
};
declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

let turnstileLoader: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
	if (turnstileLoader) return turnstileLoader;
	if (window.turnstile) return Promise.resolve(window.turnstile);
	turnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src =
			"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		const cleanup = () => {
			window.clearTimeout(timeout);
			script.removeEventListener("load", loaded);
			script.removeEventListener("error", failed);
		};
		const failed = () => {
			cleanup();
			script.remove();
			turnstileLoader = undefined;
			reject(
				new Error("人机验证加载失败，暂时不能提交。请检查网络后重新打开页面。"),
			);
		};
		const loaded = () => {
			const api = window.turnstile;
			if (!api) {
				failed();
				return;
			}
			api.ready(() => {
				cleanup();
				resolve(api);
			});
		};
		const timeout = window.setTimeout(failed, 15000);
		script.addEventListener("load", loaded, { once: true });
		script.addEventListener("error", failed, { once: true });
		document.head.append(script);
	});
	return turnstileLoader;
}

export async function mountTurnstile(
	container: HTMLElement,
	siteKey: string,
	onToken: (token: string, issue?: string) => void,
	signal: AbortSignal,
): Promise<{ reset(): void; remove(): void }> {
	if (!siteKey) throw new Error("本站未配置人机验证，暂时不能提交。");
	if (signal.aborted) throw new DOMException("Aborted", "AbortError");
	const api = await new Promise<TurnstileApi>((resolve, reject) => {
		const abort = () => reject(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		loadTurnstile()
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
	if (signal.aborted) throw new DOMException("Aborted", "AbortError");
	const updateToken = (token: string, issue?: string) => {
		if (!signal.aborted) onToken(token, issue);
	};
	const id = api.render(container, {
		sitekey: siteKey,
		theme: "auto",
		callback: (token: string) => updateToken(token),
		"expired-callback": () => updateToken("", "人机验证已过期，请重新验证。"),
		"error-callback": () =>
			updateToken("", "人机验证失败，暂时不能提交，请重新验证。"),
		"timeout-callback": () => updateToken("", "人机验证超时，请重新验证。"),
	});
	let removed = false;
	const remove = () => {
		if (removed) return;
		removed = true;
		signal.removeEventListener("abort", remove);
		api.remove(id);
	};
	signal.addEventListener("abort", remove, { once: true });
	return {
		remove,
		reset: () => {
			if (!removed) {
				updateToken("");
				api.reset(id);
			}
		},
	};
}
