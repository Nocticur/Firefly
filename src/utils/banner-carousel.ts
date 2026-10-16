import { waitForBackgroundImage } from "./background-media-utils";

export function initBannerCarousel(): void {
	const element = document.getElementById("banner-images-container");
	if (!element?.querySelector(".slide-item") || element.dataset.carouselInit)
		return;
	const container = element;
	container.dataset.carouselInit = "true";
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

	const WALLPAPER_BANNER = "banner";
	const interval = Number.parseInt(
		container.dataset.carouselInterval || "5000",
		10,
	);
	const switchable = container.dataset.carouselSwitchable === "true";
	const defaultEnabled = container.dataset.carouselEnabled === "true";
	const effect = container.dataset.carouselEffect || "fade";
	let transitioning = false;

	function isCarouselEnabled() {
		if (reducedMotion.matches || document.hidden) return false;
		if (!switchable) return defaultEnabled;
		const stored = localStorage.getItem("bannerCarouselEnabled");
		if (stored === null) return defaultEnabled;
		return stored === "true";
	}

	function isBannerWallpaperMode() {
		const mode = document.documentElement.getAttribute("data-wallpaper-mode");
		return mode === WALLPAPER_BANNER || mode === "fullscreen";
	}

	// 图片淡入：Layout 里的全局 initImageLoadFadeIn 只在解析期扫一次，
	// 之后克隆进来的图片得自己接管，否则会一直停在 opacity-0
	function fadeInWhenLoaded(root: HTMLElement) {
		const ph = root.querySelector(".lqip-placeholder");
		const candidate = root.querySelector("img");
		if (!candidate) return;
		const img = candidate;
		function done() {
			img.style.opacity = "1";
			if (ph) ph.classList.add("loaded");
		}
		if (img.complete && img.naturalWidth > 0) {
			done();
		} else {
			img.addEventListener("load", done, { once: true });
			img.addEventListener(
				"error",
				() => {
					if (ph) ph.classList.add("loaded");
				},
				{ once: true },
			);
		}
	}

	// 把 <template> 里的图片实例化进 DOM —— 插入的那一刻才开始下载
	function materialize(slideEl: HTMLElement | undefined, high: boolean) {
		if (!slideEl) return false;
		const tpl = slideEl.querySelector<HTMLTemplateElement>("template");
		if (!tpl) return false;
		const frag = tpl.content.cloneNode(true) as DocumentFragment;
		if (high) {
			const img = frag.querySelector("img");
			// 必须在插入前写，插入即发起请求
			if (img) {
				img.setAttribute("fetchpriority", "high");
				// 这张是 LCP 元素，不做淡入：图片没下完时 <img> 本来就不画东西，
				// 那 500ms 过渡只是把已经能看的画面又藏半秒，Chrome 会把 LCP 往后记。
				img.classList.remove(
					"opacity-0",
					"transition-opacity",
					"duration-500",
					"ease-out",
				);
				img.style.opacity = "1";
			}
			// LQIP 占位层是 absolute + z-index:0，盖在 img 上面，
			// 它那 0.5s 淡出同样会挡住 LCP
			const ph = frag.querySelector<HTMLElement>(".lqip-placeholder");
			if (ph) ph.style.transition = "none";
		}
		slideEl.appendChild(frag);
		tpl.remove();
		fadeInWhenLoaded(slideEl);
		return true;
	}

	// 预取下一张，避免切换时闪一帧黑
	function materializeAhead(slides: HTMLElement[], index: number) {
		if (slides.length < 2) return;
		materialize(slides[(index + 1) % slides.length], false);
	}

	// 获取当前设备可见的 slide-item
	function getVisibleSlides() {
		const all = container.querySelectorAll<HTMLElement>(".slide-item");
		const isLg = window.innerWidth >= 1024;
		const visible: HTMLElement[] = [];
		for (let i = 0; i < all.length; i++) {
			const el = all[i];
			if (isLg && el.classList.contains("lg:hidden")) continue;
			if (
				!isLg &&
				el.classList.contains("hidden") &&
				!el.classList.contains("lg:hidden")
			)
				continue;
			visible.push(el);
		}
		if (visible.length === 0) {
			for (let j = 0; j < all.length; j++) visible.push(all[j]);
		}
		return visible;
	}

	function getCurrentIndex(slides: HTMLElement[]) {
		for (let i = 0; i < slides.length; i++) {
			if (slides[i].classList.contains("active")) return i;
		}
		return 0;
	}

	function applySlideChange(slides: HTMLElement[], nextIndex: number) {
		// Slide 效果需要 prev-waiting 辅助类
		if (effect === "slide") {
			for (let i = 0; i < slides.length; i++) {
				slides[i].classList.remove("prev-waiting");
				if (i < nextIndex) slides[i].classList.add("prev-waiting");
			}
		}
		if (effect === "kenburns") {
			// Ken Burns: 交叉淡入淡出，先激活新图再隐藏旧图
			slides[nextIndex].classList.add("active");
			requestAnimationFrame(() => {
				for (let j = 0; j < slides.length; j++) {
					if (j !== nextIndex) slides[j].classList.remove("active");
				}
			});
		} else {
			for (let j = 0; j < slides.length; j++) {
				if (j === nextIndex) slides[j].classList.add("active");
				else slides[j].classList.remove("active");
			}
		}
	}

	async function changeToSlide(targetIndex: number, resetProgress = true) {
		const slides = getVisibleSlides();
		if (slides.length <= 1) return;
		if (transitioning) return;

		let nextIndex = targetIndex;
		if (nextIndex >= slides.length) nextIndex = 0;
		else if (nextIndex < 0) nextIndex = slides.length - 1;

		const currentIndex = getCurrentIndex(slides);
		if (nextIndex === currentIndex) return;

		// 目标图可能还躺在 <template> 里，先实例化再切
		materialize(slides[nextIndex], false);
		materializeAhead(slides, nextIndex);
		transitioning = true;
		try {
			const image = slides[nextIndex].querySelector("img");
			if (!image) return;
			await waitForBackgroundImage(image);
			// Do not remove the previous image while the target is downloading/decoding.
			if (
				getVisibleSlides().includes(slides[nextIndex]) &&
				isBannerWallpaperMode()
			) {
				applySlideChange(slides, nextIndex);
			}
		} catch {
			// Leave the last usable background visible after network/decode failure.
		} finally {
			transitioning = false;
		}

		if (resetProgress !== false && appState.isPlaying) {
			startAutoPlay();
		}
	}

	const appState = {
		isPlaying: false,
		autoPlayTimer: null as ReturnType<typeof setTimeout> | null,
		touchStartX: 0,
		touchEndX: 0,
	};

	function startAutoPlay() {
		stopAutoPlay();
		if (!isCarouselEnabled()) return;
		if (!isBannerWallpaperMode()) return;

		appState.isPlaying = true;
		appState.autoPlayTimer = setTimeout(function advance() {
			if (!appState.isPlaying) return;
			const slides = getVisibleSlides();
			const currentIdx = getCurrentIndex(slides);
			changeToSlide(currentIdx + 1, false);
			appState.autoPlayTimer = setTimeout(advance, interval);
		}, interval);
	}

	function stopAutoPlay() {
		appState.isPlaying = false;
		if (appState.autoPlayTimer) {
			clearTimeout(appState.autoPlayTimer);
			appState.autoPlayTimer = null;
		}
	}

	// 键盘控制
	document.addEventListener("keydown", (e) => {
		if (!isBannerWallpaperMode() || !isCarouselEnabled()) return;
		if (
			e.target instanceof Element &&
			e.target.closest(
				'input, textarea, select, button, a, [contenteditable="true"], dialog',
			)
		)
			return;
		if (e.key === "ArrowRight") {
			const slides = getVisibleSlides();
			changeToSlide(getCurrentIndex(slides) + 1);
		} else if (e.key === "ArrowLeft") {
			const slides2 = getVisibleSlides();
			changeToSlide(getCurrentIndex(slides2) - 1);
		} else if (e.key === " ") {
			e.preventDefault();
			appState.isPlaying ? stopAutoPlay() : startAutoPlay();
		}
	});

	// 触屏滑动
	container.addEventListener(
		"touchstart",
		(e) => {
			appState.touchStartX = e.changedTouches[0].screenX;
		},
		{ passive: true },
	);
	container.addEventListener(
		"touchend",
		(e) => {
			if (!isBannerWallpaperMode() || !isCarouselEnabled()) return;
			appState.touchEndX = e.changedTouches[0].screenX;
			const diff = appState.touchEndX - appState.touchStartX;
			if (Math.abs(diff) > 50) {
				const slides = getVisibleSlides();
				if (diff > 0) changeToSlide(getCurrentIndex(slides) - 1);
				else changeToSlide(getCurrentIndex(slides) + 1);
			}
		},
		{ passive: true },
	);

	// 事件监听
	window.addEventListener("bannerCarouselChange", (e) => {
		(e as CustomEvent).detail?.enabled ? startAutoPlay() : stopAutoPlay();
	});
	window.addEventListener("wallpaperModeChange", (e) => {
		const detail = (e as CustomEvent).detail;
		if (detail && (detail.mode === "banner" || detail.mode === "fullscreen")) {
			if (isCarouselEnabled()) startAutoPlay();
		} else {
			stopAutoPlay();
		}
	});
	document.addEventListener("visibilitychange", () =>
		isCarouselEnabled() ? startAutoPlay() : stopAutoPlay(),
	);
	reducedMotion.addEventListener("change", () =>
		isCarouselEnabled() ? startAutoPlay() : stopAutoPlay(),
	);

	// 随机首张：只有被抽中的这一张会真的下载，其余仍留在 <template> 里
	const slides = getVisibleSlides();
	const startIdx =
		slides.length > 1 ? Math.floor(Math.random() * slides.length) : 0;
	const firstSlide = slides[startIdx];
	// .slide-item 自带淡入过渡，首张不该吃它（它是 LCP 元素）。
	// 必须在下面加 active 之前就关掉，否则过渡已经启动了。
	if (firstSlide) firstSlide.style.transition = "none";
	for (let k = 0; k < slides.length; k++) {
		if (k === startIdx) slides[k].classList.add("active");
		else slides[k].classList.remove("active");
	}
	materialize(firstSlide, true);
	if (firstSlide) {
		// 下一帧再放开，后续轮播切换的交叉淡入照旧。双 rAF 是为了确保
		// opacity:1 已经 flush 成新的 before-change style，恢复时不会倒着跑一遍
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				firstSlide.style.transition = "";
			});
		});
	}

	// 断点跨过 1024px 时，另一侧那组还没有实例化过的 active，需要补上
	if (window.matchMedia) {
		const lgQuery = window.matchMedia("(min-width: 1024px)");
		const onBreakpointChange = () => {
			const s = getVisibleSlides();
			if (!s.length) return;
			let hasActive = false;
			for (let i = 0; i < s.length; i++) {
				if (s[i].classList.contains("active")) {
					hasActive = true;
					break;
				}
			}
			if (!hasActive) s[0].classList.add("active");
			const idx = getCurrentIndex(s);
			materialize(s[idx], false);
			if (isCarouselEnabled()) materializeAhead(s, idx);
		};
		if (lgQuery.addEventListener)
			lgQuery.addEventListener("change", onBreakpointChange);
		else if (lgQuery.addListener) lgQuery.addListener(onBreakpointChange);
	}

	// 空闲时预取下一张（轮播关掉时其余图片永远不会显示，一张都不下）
	if (isCarouselEnabled()) {
		const schedulePrefetch = () => {
			const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
			idle(() => {
				materializeAhead(getVisibleSlides(), startIdx);
			});
		};
		if (document.readyState === "complete") schedulePrefetch();
		else window.addEventListener("load", schedulePrefetch, { once: true });
	}

	// 启动
	if (isCarouselEnabled() && isBannerWallpaperMode()) {
		startAutoPlay();
	}
}
