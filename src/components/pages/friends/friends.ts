import {
	fetchPublicData,
	mountTurnstile,
	type PublicFriend,
	safePublicUrl,
	submitPublicInteraction,
} from "@/utils/public-interactions";

type FriendView = {
	id: string;
	name: string;
	url: string;
	description: string;
	avatar: string | null;
	group: string;
	sortOrder: number;
};

function normalizeFriend(friend: PublicFriend): FriendView {
	return {
		...friend,
		avatar: friend.avatar || null,
		group: friend.group.trim(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "服务暂不可用";
}

function friendTags(card: HTMLElement): string[] {
	try {
		const tags: unknown = JSON.parse(card.dataset.friendTags || "[]");
		return Array.isArray(tags)
			? tags.filter((tag): tag is string => typeof tag === "string")
			: [];
	} catch {
		return [];
	}
}

class PublicFriends extends HTMLElement {
	private controller: AbortController | null = null;
	private selectedTag = "all";
	private loading = false;

	connectedCallback(): void {
		this.controller?.abort();
		this.controller = new AbortController();
		const { signal } = this.controller;
		this.loading = false;
		this.addEventListener("click", this.handleClick, { signal });
		this.querySelector<HTMLInputElement>("[data-search]")?.addEventListener(
			"input",
			() => this.applyFilters(),
			{ signal },
		);
		this.applyFilters();
		void this.loadFriends(signal);
	}

	disconnectedCallback(): void {
		this.controller?.abort();
		this.controller = null;
		this.loading = false;
	}

	private handleClick = (event: Event): void => {
		if (!(event.target instanceof Element)) return;
		const retry = event.target.closest("[data-friends-retry]");
		if (retry && this.contains(retry)) {
			if (this.controller) void this.loadFriends(this.controller.signal);
			return;
		}
		const button = event.target.closest<HTMLButtonElement>("button[data-tag]");
		if (!button || !this.contains(button)) return;
		this.selectedTag = button.dataset.tag || "all";
		this.applyFilters();
	};

	private async loadFriends(signal: AbortSignal): Promise<void> {
		if (this.loading || signal.aborted) return;
		this.loading = true;
		const status = this.querySelector<HTMLElement>("[data-friends-status]");
		const retry = this.querySelector<HTMLButtonElement>("[data-friends-retry]");
		if (status) status.textContent = "正在加载已上线友链…";
		if (retry) retry.hidden = true;
		try {
			const data = await fetchPublicData<PublicFriend>("friends", { signal });
			if (signal.aborted) return;
			const friends = data
				.map(normalizeFriend)
				.sort(
					(first, second) =>
						first.group.localeCompare(second.group) ||
						first.sortOrder - second.sortOrder ||
						first.id.localeCompare(second.id),
				);
			const grid = this.querySelector<HTMLElement>("[data-friends-grid]");
			const template = this.querySelector<HTMLTemplateElement>(
				"[data-friend-template]",
			);
			if (!grid || !template) throw new Error("无法显示已上线友链");
			const knownUrls = new Set(
				Array.from(
					grid.querySelectorAll<HTMLAnchorElement>("[data-static-friend]"),
				).map((card) => this.canonicalUrl(card.href)),
			);
			const fragment = document.createDocumentFragment();
			for (const friend of friends) {
				const canonicalUrl = this.canonicalUrl(friend.url);
				if (knownUrls.has(canonicalUrl)) continue;
				knownUrls.add(canonicalUrl);
				fragment.append(this.createCard(friend, template));
			}
			grid.querySelectorAll("[data-public-friend]").forEach((card) => {
				card.remove();
			});
			grid.append(fragment);
			this.updateTags();
			this.applyFilters();
			if (status) {
				status.textContent = friends.length
					? "已加载已上线友链。"
					: "暂无新增的已上线友链，以下保留本站已有友链。";
			}
		} catch (error) {
			if (signal.aborted) return;
			if (status) {
				status.textContent = `已上线友链加载失败：${errorMessage(error)}。页面已有友链仍可浏览。`;
			}
			if (retry) retry.hidden = false;
		} finally {
			if (!signal.aborted) this.loading = false;
		}
	}

	private canonicalUrl(value: string): string {
		const url = new URL(value);
		url.hash = "";
		return url.href.replace(/\/$/, "");
	}

	private createCard(
		friend: FriendView,
		template: HTMLTemplateElement,
	): HTMLAnchorElement {
		const card = template.content.firstElementChild?.cloneNode(true);
		if (!(card instanceof HTMLAnchorElement)) {
			throw new Error("无法显示已上线友链");
		}
		card.href = friend.url;
		card.dataset.publicFriend = friend.id;
		card.dataset.tags = friend.group;
		card.dataset.friendTags = JSON.stringify(
			friend.group ? [friend.group] : [],
		);
		const name = card.querySelector<HTMLElement>("[data-friend-name]");
		const description = card.querySelector<HTMLElement>(
			"[data-friend-description]",
		);
		const avatar = card.querySelector<HTMLImageElement>("[data-friend-avatar]");
		const fallback = card.querySelector<HTMLElement>("[data-avatar-fallback]");
		const tags = card.querySelector<HTMLElement>("[data-friend-tag-list]");
		if (name) name.textContent = friend.name;
		if (description) {
			description.textContent = friend.description;
			description.title = friend.description;
		}
		if (avatar) {
			avatar.alt = friend.name;
			avatar.hidden = !friend.avatar;
			if (friend.avatar) avatar.src = friend.avatar;
			else avatar.removeAttribute("src");
		}
		if (fallback && !friend.avatar) {
			fallback.textContent = Array.from(friend.name)[0] || "友";
			fallback.hidden = false;
			fallback.style.display = "flex";
		}
		if (tags && friend.group) {
			const tag = document.createElement("span");
			tag.className =
				"text-[0.65rem] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 transition-colors duration-300";
			tag.textContent = friend.group;
			tags.append(tag);
		}
		return card;
	}

	private updateTags(): void {
		const container = this.querySelector<HTMLElement>("[data-tag-filters]");
		if (!container) return;
		container.querySelectorAll("[data-public-tag]").forEach((tag) => {
			tag.remove();
		});
		const existingTags = new Set(
			Array.from(container.querySelectorAll<HTMLElement>("[data-tag]")).map(
				(button) => button.dataset.tag,
			),
		);
		const tags = new Set(
			Array.from(
				this.querySelectorAll<HTMLElement>("[data-public-friend]"),
			).flatMap(friendTags),
		);
		for (const tag of [...tags].sort()) {
			if (existingTags.has(tag)) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.tag = tag;
			button.dataset.publicTag = "";
			button.className =
				"category-pill px-3 py-1.5 rounded-full text-sm font-medium transition-colors duration-200";
			button.textContent = tag;
			container.append(button);
			existingTags.add(tag);
		}
		if (!existingTags.has(this.selectedTag)) this.selectedTag = "all";
	}

	private applyFilters(): void {
		const query = (
			this.querySelector<HTMLInputElement>("[data-search]")?.value || ""
		)
			.toLowerCase()
			.trim();
		const cards = this.querySelectorAll<HTMLElement>(".friend-card");
		let hasVisible = false;
		for (const card of cards) {
			const tags = friendTags(card);
			const name = (
				card.querySelector("[data-friend-name]")?.textContent || ""
			).toLowerCase();
			const description = (
				card.querySelector("[data-friend-description]")?.textContent || ""
			).toLowerCase();
			const visible =
				(this.selectedTag === "all" || tags.includes(this.selectedTag)) &&
				(!query ||
					name.includes(query) ||
					description.includes(query) ||
					tags.some((tag) => tag.toLowerCase().includes(query)));
			card.hidden = !visible;
			card.classList.toggle("animate-fade-in-up", visible);
			hasVisible ||= visible;
		}
		for (const button of this.querySelectorAll<HTMLElement>(
			"button[data-tag]",
		)) {
			const active = button.dataset.tag === this.selectedTag;
			button.toggleAttribute("data-active", active);
			button.setAttribute("aria-pressed", String(active));
		}
		const empty = this.querySelector<HTMLElement>("[data-search-empty]");
		if (empty) {
			empty.hidden = hasVisible || cards.length === 0;
			empty.classList.toggle("flex", !hasVisible && cards.length > 0);
		}
		const staticEmpty = this.querySelector<HTMLElement>("[data-static-empty]");
		if (staticEmpty) staticEmpty.hidden = cards.length > 0;
	}
}

class FriendApplication extends HTMLElement {
	private controller: AbortController | null = null;
	private turnstile: { reset(): void; remove(): void } | null = null;
	private token = "";
	private submitting = false;
	private mounting = false;

	connectedCallback(): void {
		this.controller?.abort();
		this.controller = new AbortController();
		this.token = "";
		this.submitting = false;
		this.mounting = false;
		const { signal } = this.controller;
		this.querySelector<HTMLFormElement>("form")?.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				void this.submit(signal);
			},
			{ signal },
		);
		this.querySelector<HTMLButtonElement>(
			"[data-verification-retry]",
		)?.addEventListener("click", () => void this.mountVerification(signal), {
			signal,
		});
		this.updateControls();
		void this.mountVerification(signal);
	}

	disconnectedCallback(): void {
		this.controller?.abort();
		this.controller = null;
		this.turnstile?.remove();
		this.turnstile = null;
		this.token = "";
		this.submitting = false;
		this.mounting = false;
	}

	private async mountVerification(signal: AbortSignal): Promise<void> {
		const siteKey = this.dataset.siteKey?.trim();
		if (!siteKey || signal.aborted || this.mounting || this.submitting) return;
		const container = this.querySelector<HTMLElement>("[data-turnstile]");
		const status = this.querySelector<HTMLElement>(
			"[data-verification-status]",
		);
		const retry = this.querySelector<HTMLButtonElement>(
			"[data-verification-retry]",
		);
		if (!container) return;
		this.mounting = true;
		this.turnstile?.remove();
		this.turnstile = null;
		this.token = "";
		this.updateControls();
		if (status) status.textContent = "正在加载人机验证…";
		if (retry) retry.hidden = true;
		try {
			const widget = await mountTurnstile(
				container,
				siteKey,
				(token, issue) => {
					if (signal.aborted) return;
					this.token = token;
					if (status) {
						status.textContent = token
							? "人机验证已完成。"
							: issue || "请完成人机验证后提交申请。";
					}
					this.updateControls();
				},
				signal,
			);
			if (signal.aborted) {
				widget.remove();
				return;
			}
			this.turnstile = widget;
			if (status && !this.token)
				status.textContent = "请完成人机验证后提交申请。";
		} catch (error) {
			if (signal.aborted) return;
			if (status)
				status.textContent = `人机验证加载失败：${errorMessage(error)}。暂时无法提交申请。`;
			if (retry) retry.hidden = false;
		} finally {
			if (!signal.aborted) {
				this.mounting = false;
				this.updateControls();
			}
		}
	}

	private updateControls(): void {
		const hasSiteKey = Boolean(this.dataset.siteKey?.trim());
		const fieldset = this.querySelector<HTMLFieldSetElement>("fieldset");
		const button = this.querySelector<HTMLButtonElement>("[data-submit]");
		const retry = this.querySelector<HTMLButtonElement>(
			"[data-verification-retry]",
		);
		if (fieldset) fieldset.disabled = this.submitting || !hasSiteKey;
		if (button) {
			button.disabled = this.submitting || !hasSiteKey || !this.token;
			button.textContent = this.submitting ? "正在提交…" : "提交申请";
		}
		if (retry) retry.disabled = this.submitting || this.mounting;
	}

	private async submit(signal: AbortSignal): Promise<void> {
		if (this.submitting || signal.aborted) return;
		const form = this.querySelector<HTMLFormElement>("form");
		const status = this.querySelector<HTMLElement>("[data-submit-status]");
		if (!form || !status) return;
		if (!this.dataset.siteKey?.trim() || !this.token) {
			status.textContent = "请先完成人机验证；验证不可用时无法提交。";
			return;
		}
		if (!form.reportValidity()) return;
		const data = new FormData(form);
		const read = (name: string): string => String(data.get(name) || "").trim();
		const payload = {
			name: read("name"),
			url: read("url"),
			description: read("description"),
			avatar: read("avatar"),
			email: read("email"),
			turnstileToken: this.token,
		};
		if (!payload.name || !payload.description || !payload.email) {
			status.textContent = "请完整填写站点名称、描述和联系邮箱。";
			return;
		}
		if (
			!safePublicUrl(payload.url) ||
			(payload.avatar && !safePublicUrl(payload.avatar))
		) {
			status.textContent = "站点和头像链接请使用有效的 HTTP 或 HTTPS 地址。";
			return;
		}
		this.submitting = true;
		this.updateControls();
		status.textContent = "正在提交申请…";
		try {
			await submitPublicInteraction("friends", payload, signal);
			if (signal.aborted) return;
			form.reset();
			status.textContent =
				"申请已提交，等待审核；通过审核并正式上线后将发送邮件通知。";
		} catch (error) {
			if (signal.aborted) return;
			status.textContent = `申请提交失败：${errorMessage(error)}。填写内容已保留。`;
		} finally {
			if (!signal.aborted) {
				this.submitting = false;
				this.token = "";
				this.turnstile?.reset();
				this.updateControls();
			}
		}
	}
}

if (!customElements.get("public-friends")) {
	customElements.define("public-friends", PublicFriends);
}
if (!customElements.get("friend-application")) {
	customElements.define("friend-application", FriendApplication);
}
