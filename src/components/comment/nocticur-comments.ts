import {
	fetchPublicData,
	mountTurnstile,
	type PublicComment,
	submitPublicInteraction,
} from "@/utils/public-interactions";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerNocticurComments(): void {
	if (customElements.get("nocticur-comments")) return;

	class NocticurComments extends HTMLElement {
		private lifecycle?: AbortController;
		private verification?: { reset(): void; remove(): void };
		private token = "";
		private busy = false;
		private parentId: string | null = null;
		private comments = new Map<string, PublicComment>();
		private loadVersion = 0;

		connectedCallback(): void {
			this.lifecycle?.abort();
			const lifecycle = new AbortController();
			this.lifecycle = lifecycle;
			this.token = "";
			this.busy = false;
			this.cancelReply();
			this.updateSubmitButton();
			const articleId = this.dataset.articleId ?? "";
			const form = this.querySelector<HTMLFormElement>("[data-comment-form]");
			if (!UUID.test(articleId)) {
				if (form) form.hidden = true;
				this.setStatus(
					"[data-comments-status]",
					"此页面尚未关联已发布的文章，暂未开放评论。",
				);
				return;
			}
			if (form) form.hidden = false;
			this.addEventListener("click", this.handleClick, {
				signal: lifecycle.signal,
			});
			form?.addEventListener("submit", this.handleSubmit, {
				signal: lifecycle.signal,
			});
			void this.loadComments(articleId, lifecycle.signal);
			void this.setupVerification(lifecycle.signal);
		}

		disconnectedCallback(): void {
			this.lifecycle?.abort();
			this.lifecycle = undefined;
			this.verification?.remove();
			this.verification = undefined;
			this.token = "";
			this.loadVersion++;
			this.updateSubmitButton();
		}

		private setStatus(selector: string, message: string): void {
			const element = this.querySelector<HTMLElement>(selector);
			if (element) element.textContent = message;
		}

		private updateSubmitButton(): void {
			const button = this.querySelector<HTMLButtonElement>(
				"button[type='submit']",
			);
			for (const field of this.querySelectorAll<
				HTMLInputElement | HTMLTextAreaElement
			>("input, textarea")) {
				field.disabled = this.busy;
			}
			for (const reply of this.querySelectorAll<HTMLButtonElement>(
				"button[data-reply-id], button[data-cancel-reply]",
			)) {
				reply.disabled = this.busy;
			}
			if (button)
				button.disabled =
					this.busy || !this.token || !UUID.test(this.dataset.articleId ?? "");
		}

		private async setupVerification(signal: AbortSignal): Promise<void> {
			const siteKey = this.dataset.siteKey ?? "";
			const container = this.querySelector<HTMLElement>("[data-turnstile]");
			if (!siteKey || !container) {
				this.setStatus(
					"[data-verification-status]",
					"本站未配置人机验证，暂时不能提交评论。",
				);
				return;
			}
			this.setStatus("[data-verification-status]", "正在加载人机验证…");
			try {
				const verification = await mountTurnstile(
					container,
					siteKey,
					(token, issue) => {
						this.token = token;
						this.setStatus(
							"[data-verification-status]",
							issue ??
								(token ? "人机验证已完成。" : "请完成人机验证后提交评论。"),
						);
						this.updateSubmitButton();
					},
					signal,
				);
				if (signal.aborted) {
					verification.remove();
					return;
				}
				this.verification = verification;
				if (!signal.aborted && !this.token)
					this.setStatus(
						"[data-verification-status]",
						"请完成人机验证后提交评论。",
					);
			} catch (error) {
				if (signal.aborted) return;
				this.setStatus(
					"[data-verification-status]",
					error instanceof Error
						? error.message
						: "人机验证加载失败，暂时不能提交。",
				);
			}
		}

		private async loadComments(
			articleId: string,
			signal: AbortSignal,
		): Promise<void> {
			const version = ++this.loadVersion;
			this.setStatus("[data-comments-status]", "正在加载评论…");
			try {
				const comments = await fetchPublicData<PublicComment>("comments", {
					articleId,
					signal,
				});
				if (signal.aborted || version !== this.loadVersion) return;
				this.comments = new Map(
					comments.map((comment) => [comment.id, comment]),
				);
				this.renderComments(comments);
				this.setStatus(
					"[data-comments-status]",
					comments.length
						? `共 ${comments.length} 条评论`
						: "暂无评论，欢迎留言。",
				);
			} catch (error) {
				if (signal.aborted || version !== this.loadVersion) return;
				this.setStatus(
					"[data-comments-status]",
					error instanceof Error ? error.message : "评论加载失败，请稍后重试。",
				);
			}
		}

		private renderComments(comments: PublicComment[]): void {
			const list = this.querySelector<HTMLOListElement>("[data-comments-list]");
			if (!list) return;
			const fragment = document.createDocumentFragment();
			for (const comment of [...comments].sort(
				(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
			)) {
				const item = document.createElement("li");
				item.id = `comment-${comment.id}`;
				item.className = "nocticur-comment-item";
				const meta = document.createElement("div");
				meta.className = "nocticur-comment-meta";
				const name = document.createElement("strong");
				name.textContent = comment.name;
				const time = document.createElement("time");
				time.dateTime = comment.createdAt;
				time.textContent = new Date(comment.createdAt).toLocaleString("zh-CN", {
					timeZone: "Asia/Shanghai",
				});
				meta.append(name, time);
				item.append(meta);
				if (comment.parentId) {
					item.dataset.reply = "";
					const parent = this.comments.get(comment.parentId);
					const context = document.createElement("p");
					context.className = "nocticur-comment-parent";
					context.textContent = `回复 ${parent?.name ?? "较早的评论"}`;
					item.append(context);
				}
				const body = document.createElement("p");
				body.className = "nocticur-comment-body";
				body.textContent = comment.body;
				item.append(body);
				if (comment.status !== "deleted") {
					const reply = document.createElement("button");
					reply.type = "button";
					reply.dataset.replyId = comment.id;
					reply.textContent = "回复";
					reply.setAttribute("aria-label", `回复 ${comment.name}`);
					item.append(reply);
				}
				fragment.append(item);
			}
			list.replaceChildren(fragment);
		}

		private cancelReply(): void {
			this.parentId = null;
			const panel = this.querySelector<HTMLElement>("[data-reply-panel]");
			if (panel) panel.hidden = true;
			this.setStatus("[data-reply-label]", "");
		}

		private handleClick = (event: Event): void => {
			if (!(event.target instanceof Element)) return;
			const button = event.target.closest<HTMLButtonElement>("button");
			if (!button || !this.contains(button)) return;
			if (button.hasAttribute("data-cancel-reply")) {
				this.cancelReply();
				return;
			}
			const comment = this.comments.get(button.dataset.replyId ?? "");
			if (!comment || comment.status === "deleted") return;
			this.parentId = comment.id;
			const panel = this.querySelector<HTMLElement>("[data-reply-panel]");
			if (panel) panel.hidden = false;
			this.setStatus("[data-reply-label]", `回复 ${comment.name}`);
			this.querySelector<HTMLTextAreaElement>("textarea[name='body']")?.focus();
		};

		private handleSubmit = async (event: Event): Promise<void> => {
			event.preventDefault();
			const form = this.querySelector<HTMLFormElement>("[data-comment-form]");
			const signal = this.lifecycle?.signal;
			if (!form || !signal || signal.aborted || this.busy) return;
			if (!this.token) {
				this.setStatus("[data-submit-status]", "请先完成人机验证。");
				return;
			}
			if (!form.reportValidity()) return;
			const fields = new FormData(form);
			const name = String(fields.get("name") ?? "").trim();
			const body = String(fields.get("body") ?? "").trim();
			if (!name || !body) {
				this.setStatus("[data-submit-status]", "请填写昵称和评论内容。");
				return;
			}
			this.busy = true;
			this.updateSubmitButton();
			this.setStatus("[data-submit-status]", "正在提交评论…");
			try {
				const articleId = this.dataset.articleId ?? "";
				await submitPublicInteraction(
					"comments",
					{
						articleId,
						...(this.parentId ? { parentId: this.parentId } : {}),
						name,
						email: String(fields.get("email") ?? "").trim() || undefined,
						body,
						turnstileToken: this.token,
					},
					signal,
				);
				if (signal.aborted) return;
				const input = form.querySelector<HTMLTextAreaElement>(
					"textarea[name='body']",
				);
				if (input) input.value = "";
				this.cancelReply();
				this.setStatus("[data-submit-status]", "评论已提交。");
				await this.loadComments(articleId, signal);
			} catch (error) {
				if (signal.aborted) return;
				this.setStatus(
					"[data-submit-status]",
					error instanceof Error ? error.message : "评论提交失败，请稍后重试。",
				);
			} finally {
				if (!signal.aborted) {
					this.busy = false;
					this.token = "";
					this.verification?.reset();
					this.updateSubmitButton();
				}
			}
		};
	}

	customElements.define("nocticur-comments", NocticurComments);
}
