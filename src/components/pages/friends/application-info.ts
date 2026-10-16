class FriendsApplicationInfo extends HTMLElement {
	private controller: AbortController | null = null;

	connectedCallback(): void {
		this.controller?.abort();
		this.controller = new AbortController();
		this.addEventListener("click", this.copy, {
			signal: this.controller.signal,
		});
	}

	disconnectedCallback(): void {
		this.controller?.abort();
		this.controller = null;
	}

	private copy = async (event: Event): Promise<void> => {
		if (!(event.target instanceof Element)) return;
		const button = event.target.closest<HTMLButtonElement>("[data-copy-value]");
		if (!button || !this.contains(button)) return;
		const value = button.dataset.copyValue || "";
		const status = this.querySelector<HTMLElement>("[data-copy-status]");
		const manual = this.querySelector<HTMLElement>("[data-manual-copy]");
		const signal = this.controller?.signal;
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(value);
			if (signal?.aborted) return;
			if (status) status.textContent = "已复制，可直接粘贴使用。";
			if (manual) manual.hidden = true;
		} catch {
			if (signal?.aborted) return;
			if (status)
				status.textContent = "自动复制未成功，请在下方选中内容后手动复制。";
			if (manual) {
				manual.hidden = false;
				const textarea = manual.querySelector("textarea");
				if (textarea) {
					textarea.value = value;
					textarea.focus();
					textarea.select();
				}
			}
		}
	};
}

if (!customElements.get("friends-application-info"))
	customElements.define("friends-application-info", FriendsApplicationInfo);
