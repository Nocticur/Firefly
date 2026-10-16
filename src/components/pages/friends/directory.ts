import type {
	FriendHealthReport,
	FriendHealthResult,
} from "@/types/friendHealth";
import type { FriendLink } from "@/types/friendsConfig";
import {
	classifyFriendHealth,
	mergePublishedFriends,
	normalizeFriendUrl,
	parseFriendHealth,
} from "@/utils/friend-health";
import {
	fetchPublicData,
	type PublicFriend,
} from "@/utils/public-interactions";
import { StarParticles } from "./StarParticles";

const HEALTH_CACHE = "firefly:friends-health:v1";
const groups = ["active", "pending", "graveyard"] as const;

function tags(card: HTMLElement): string[] {
	try {
		const value: unknown = JSON.parse(card.dataset.friendTags || "[]");
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function time(value: string): string {
	return new Intl.DateTimeFormat("zh-CN", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "Asia/Shanghai",
	}).format(new Date(value));
}

class FriendsDirectory extends HTMLElement {
	private controller: AbortController | null = null;
	private selectedTag = "all";
	private health: FriendHealthReport | null = null;
	private loading = false;
	private dialog: HTMLDialogElement | null = null;
	private particles = new Map<HTMLElement, StarParticles>();
	private order = new Map<HTMLElement, number>();

	connectedCallback(): void {
		this.controller?.abort();
		this.controller = new AbortController();
		const { signal } = this.controller;
		this.addEventListener("click", this.handleClick, { signal });
		this.querySelector<HTMLInputElement>("[data-search]")?.addEventListener(
			"input",
			() => this.applyFilters(),
			{ signal },
		);
		for (const image of this.querySelectorAll<HTMLImageElement>(
			"[data-friend-avatar]",
		)) {
			image.addEventListener("error", () => this.avatarFallback(image), {
				signal,
			});
			if (
				image.complete &&
				image.naturalWidth === 0 &&
				image.getAttribute("src")
			)
				this.avatarFallback(image);
		}
		this.allCards().forEach((card, index) => {
			this.order.set(card, index);
		});
		this.mountParticles();
		try {
			const cached: unknown = JSON.parse(
				localStorage.getItem(HEALTH_CACHE) || "null",
			);
			const report = parseFriendHealth(cached);
			if (report) {
				this.health = report;
				this.applyHealth();
				this.healthMessage("已显示缓存；正在更新检测结果…");
			}
		} catch {
			/* Storage can be unavailable in privacy modes. */
		}
		this.applyFilters();
		void this.loadHealth(signal);
		void this.loadPublishedFriends(signal);
	}

	disconnectedCallback(): void {
		this.controller?.abort();
		this.controller = null;
		this.loading = false;
		for (const particle of this.particles.values()) particle.destroy();
		this.particles.clear();
		this.order.clear();
		this.dialog?.close();
		this.dialog?.remove();
		this.dialog = null;
	}

	private allCards(): HTMLElement[] {
		return Array.from(
			this.querySelectorAll<HTMLElement>("[data-health-grid] .friend-card"),
		);
	}

	private handleClick = (event: Event): void => {
		if (!(event.target instanceof Element)) return;
		const retry = event.target.closest("[data-health-retry]");
		if (retry && this.controller) {
			void this.loadHealth(this.controller.signal);
			return;
		}
		const preview = event.target.closest<HTMLButtonElement>(
			"[data-friend-preview]",
		);
		if (preview && this.contains(preview)) {
			this.openPreview(preview);
			return;
		}
		const button = event.target.closest<HTMLButtonElement>("button[data-tag]");
		if (!button || !this.contains(button)) return;
		this.selectedTag = button.dataset.tag || "all";
		this.applyFilters();
	};

	private healthMessage(message: string): void {
		const status = this.querySelector("[data-health-status]");
		if (status) status.textContent = message;
	}

	private async loadHealth(signal: AbortSignal): Promise<void> {
		if (this.loading || signal.aborted) return;
		this.loading = true;
		const retry = this.querySelector<HTMLButtonElement>("[data-health-retry]");
		if (retry) retry.hidden = true;
		const request = new AbortController();
		const abort = () => request.abort();
		signal.addEventListener("abort", abort, { once: true });
		const timeout = window.setTimeout(abort, 10000);
		try {
			const response = await fetch("/data/friends-health.json", {
				signal: request.signal,
				cache: "no-cache",
				credentials: "omit",
				headers: { Accept: "application/json" },
			});
			if (!response.ok) throw new Error("检测记录暂不可用");
			const text = await response.text();
			if (text.length > 2_000_000) throw new Error("检测记录格式异常");
			const report = parseFriendHealth(JSON.parse(text));
			if (!report) throw new Error("检测记录格式异常");
			if (signal.aborted) return;
			this.health = report;
			this.applyHealth();
			this.healthMessage(
				report.checkedAt
					? `最近检测：${time(report.checkedAt)}（北京时间）`
					: "尚无检测记录，所有友链均可正常浏览。",
			);
			try {
				localStorage.setItem(HEALTH_CACHE, JSON.stringify(report));
			} catch {
				/* Optional cache. */
			}
		} catch {
			if (signal.aborted) return;
			this.healthMessage(
				this.health?.checkedAt
					? "暂时无法更新；保留 " +
							time(this.health.checkedAt) +
							" 的检测结果。"
					: "暂时无法读取检测记录；友链仍可浏览。",
			);
			if (retry) retry.hidden = false;
		} finally {
			window.clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			if (!signal.aborted) this.loading = false;
		}
	}

	private async loadPublishedFriends(signal: AbortSignal): Promise<void> {
		try {
			const published = await fetchPublicData<PublicFriend>("friends", {
				signal,
			});
			if (signal.aborted) return;
			const known = new Set(
				this.allCards().map((card) =>
					normalizeFriendUrl(card.dataset.friendUrl),
				),
			);
			const grid = this.querySelector<HTMLElement>(
				'[data-health-grid="active"]',
			);
			const template = this.querySelector<HTMLTemplateElement>(
				"[data-friend-template]",
			);
			if (!grid || !template) return;
			for (const friend of mergePublishedFriends([], published)) {
				const key = normalizeFriendUrl(friend.siteurl);
				if (known.has(key)) continue;
				known.add(key);
				const card = this.createCard(friend, template);
				if (!card) continue;
				this.order.set(card, this.order.size);
				grid.append(card);
			}
			this.updateTags();
			this.applyHealth();
		} catch {
			// Published snapshots are already rendered into the HTML; API failure is non-blocking.
		}
	}

	private createCard(
		friend: FriendLink,
		template: HTMLTemplateElement,
	): HTMLElement | null {
		const card = template.content.firstElementChild?.cloneNode(true);
		if (!(card instanceof HTMLElement)) return null;
		card.removeAttribute("data-static-friend");
		card.dataset.friendUrl = friend.siteurl;
		card.dataset.friendTags = JSON.stringify(friend.tags || []);
		const anchor = card.querySelector<HTMLAnchorElement>(".friend-card-link");
		const name = card.querySelector("[data-friend-name]");
		const image = card.querySelector<HTMLImageElement>("[data-friend-avatar]");
		const fallback = card.querySelector<HTMLElement>("[data-avatar-fallback]");
		if (!anchor || !name || !image || !fallback) return null;
		anchor.href = friend.siteurl;
		name.textContent = friend.title;
		const description = card.querySelector<HTMLElement>(
			"[data-friend-description]",
		);
		if (!description) return null;
		description.textContent = friend.desc;
		description.title = friend.desc;
		if (friend.imgurl) {
			image.src = friend.imgurl;
			image.hidden = false;
		}
		fallback.textContent = Array.from(friend.title)[0] || "友";
		fallback.hidden = !!friend.imgurl;
		image.addEventListener("error", () => this.avatarFallback(image), {
			signal: this.controller?.signal,
		});
		const tagList = card.querySelector("[data-friend-tag-list]");
		for (const tag of friend.tags || []) {
			const span = document.createElement("span");
			span.textContent = tag;
			tagList?.append(span);
		}
		card
			.querySelector("[data-friend-preview]")
			?.setAttribute("aria-label", `预览${friend.title}的主页截图`);
		return card;
	}

	private avatarFallback(image: HTMLImageElement): void {
		image.hidden = true;
		const fallback = image.parentElement?.querySelector<HTMLElement>(
			"[data-avatar-fallback]",
		);
		if (!fallback) return;
		fallback.textContent = Array.from(
			image.closest(".friend-card")?.querySelector("[data-friend-name]")
				?.textContent || "友",
		)[0];
		fallback.hidden = false;
	}

	private applyHealth(): void {
		const results = new Map(
			this.health?.results.map((result) => [
				normalizeFriendUrl(result.url),
				result,
			]) || [],
		);
		const cards = this.allCards().sort(
			(a, b) => (this.order.get(a) || 0) - (this.order.get(b) || 0),
		);
		for (const card of cards) {
			const result = results.get(normalizeFriendUrl(card.dataset.friendUrl));
			const group = classifyFriendHealth(result);
			card.dataset.healthGroup = group;
			this.querySelector(`[data-health-grid="${group}"]`)?.append(card);
			this.decorateHealth(card, result);
		}
		this.applyFilters();
	}

	private decorateHealth(card: HTMLElement, result?: FriendHealthResult): void {
		const badge = card.querySelector<HTMLElement>("[data-friend-health]");
		if (badge) {
			badge.dataset.state = result?.status || "unchecked";
			const labels = {
				success: "连接正常",
				slow: "响应较慢",
				warn: "访问异常",
				timeout: "暂时失联",
			};
			badge.textContent = result
				? labels[result.status] +
					(result.latencyMs !== null
						? ` · ${Math.round(result.latencyMs)} ms`
						: "")
				: "未检测";
			badge.title = result
				? "检测于 " +
					time(result.checkedAt) +
					(result.consecutiveFailures
						? `；连续失败 ${result.consecutiveFailures} 次`
						: "") +
					(result.error ? `；${result.error}` : "")
				: "尚无自动检测记录";
		}
		const backlink = card.querySelector<HTMLElement>("[data-friend-backlink]");
		if (backlink) {
			backlink.hidden =
				!result || !["present", "missing"].includes(result.backlink);
			backlink.textContent =
				result?.backlink === "present" ? "↔ 已发现本站链接" : "未发现反链";
			backlink.title = "仅检查公开页面中的链接，可能无法识别由脚本生成的内容。";
		}
		const preview = card.querySelector<HTMLButtonElement>(
			"[data-friend-preview]",
		);
		if (preview) {
			preview.hidden = !result?.screenshot;
			if (result?.screenshot) {
				preview.dataset.screenshot = result.screenshot;
				preview.dataset.screenshotAt = result.screenshotAt || "";
			} else {
				delete preview.dataset.screenshot;
				delete preview.dataset.screenshotAt;
			}
		}
	}

	private updateTags(): void {
		const container = this.querySelector("[data-tag-filters]");
		if (!container) return;
		const existing = new Set(
			Array.from(container.querySelectorAll<HTMLElement>("[data-tag]")).map(
				(button) => button.dataset.tag,
			),
		);
		const allTags = new Set(this.allCards().flatMap(tags));
		for (const tag of [...allTags].sort()) {
			if (existing.has(tag)) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "category-pill";
			button.dataset.tag = tag;
			button.textContent = tag;
			button.setAttribute("aria-pressed", "false");
			container.append(button);
		}
	}

	private applyFilters(): void {
		const query = (
			this.querySelector<HTMLInputElement>("[data-search]")?.value || ""
		)
			.trim()
			.toLowerCase();
		const cards = this.allCards();
		let visible = 0;
		for (const card of cards) {
			const cardTags = tags(card);
			const text =
				(card.querySelector("[data-friend-name]")?.textContent || "") +
				" " +
				(card.querySelector("[data-friend-description]")?.textContent || "") +
				" " +
				cardTags.join(" ");
			card.hidden = !(
				(this.selectedTag === "all" || cardTags.includes(this.selectedTag)) &&
				(!query || text.toLowerCase().includes(query))
			);
			if (!card.hidden) visible++;
		}
		for (const group of groups) {
			const section = this.querySelector<HTMLElement>(
				`[data-health-section="${group}"]`,
			);
			const count = this.querySelectorAll(
				`[data-health-grid="${group}"] .friend-card:not([hidden])`,
			).length;
			if (section) section.hidden = count === 0;
			const counter = this.querySelector(`[data-group-count="${group}"]`);
			if (counter) counter.textContent = `(${count})`;
			if (
				group === "graveyard" &&
				section instanceof HTMLDetailsElement &&
				query &&
				count
			)
				section.open = true;
		}
		for (const button of this.querySelectorAll<HTMLElement>(
			"button[data-tag]",
		)) {
			const active = button.dataset.tag === this.selectedTag;
			button.toggleAttribute("data-active", active);
			button.setAttribute("aria-pressed", String(active));
		}
		const empty = this.querySelector<HTMLElement>("[data-search-empty]");
		if (empty) empty.hidden = visible > 0 || cards.length === 0;
		const staticEmpty = this.querySelector<HTMLElement>("[data-static-empty]");
		if (staticEmpty) staticEmpty.hidden = cards.length > 0;
	}

	private mountParticles(): void {
		for (const card of this.querySelectorAll<HTMLElement>(
			".friend-card--owner, .friend-card--featured",
		)) {
			if (!this.particles.has(card))
				this.particles.set(
					card,
					new StarParticles(
						card,
						card.dataset.friendKind === "owner" ? "owner" : "featured",
					),
				);
		}
	}

	private openPreview(button: HTMLButtonElement): void {
		const screenshot = button.dataset.screenshot;
		if (!screenshot || !this.controller) return;
		this.dialog?.close();
		this.dialog?.remove();
		const dialog = document.createElement("dialog");
		dialog.className = "friend-preview-dialog";
		dialog.setAttribute("aria-label", "友链主页截图预览");
		const card = button.closest<HTMLElement>(".friend-card");
		if (!card) return;
		const title =
			card.querySelector("[data-friend-name]")?.textContent || "主页";
		const header = document.createElement("div");
		header.className = "friend-preview-header";
		const heading = document.createElement("strong");
		heading.textContent = `${title} · 主页快照`;
		const close = document.createElement("button");
		close.type = "button";
		close.textContent = "关闭 ×";
		close.setAttribute("aria-label", "关闭截图预览");
		header.append(heading, close);
		const image = document.createElement("img");
		image.src = screenshot;
		image.alt = `${title}的主页截图`;
		const caption = document.createElement("p");
		caption.textContent = button.dataset.screenshotAt
			? "截图于 " +
				time(button.dataset.screenshotAt) +
				"（北京时间），页面内容可能已更新。"
			: "历史页面快照，页面内容可能已更新。";
		image.addEventListener(
			"error",
			() => {
				image.hidden = true;
				caption.textContent = "截图暂时无法加载，请直接访问站点。";
			},
			{ signal: this.controller.signal },
		);
		const link = document.createElement("a");
		link.href = card.dataset.friendUrl || "#";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.textContent = "访问站点 ↗";
		const footer = document.createElement("div");
		footer.className = "friend-preview-footer";
		footer.append(caption, link);
		dialog.append(header, image, footer);
		close.addEventListener("click", () => dialog.close(), {
			signal: this.controller.signal,
		});
		dialog.addEventListener(
			"click",
			(event) => {
				if (event.target === dialog) {
					const rect = dialog.getBoundingClientRect();
					if (
						event.clientX < rect.left ||
						event.clientX > rect.right ||
						event.clientY < rect.top ||
						event.clientY > rect.bottom
					)
						dialog.close();
				}
			},
			{ signal: this.controller.signal },
		);
		dialog.addEventListener(
			"close",
			() => {
				dialog.remove();
				if (button.isConnected) button.focus();
			},
			{ signal: this.controller.signal, once: true },
		);
		document.body.append(dialog);
		this.dialog = dialog;
		dialog.showModal();
	}
}

if (!customElements.get("public-friends"))
	customElements.define("public-friends", FriendsDirectory);
