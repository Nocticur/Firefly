type Star = {
	x: number;
	y: number;
	size: number;
	speed: number;
	phase: number;
};

/** A small decoration with an explicit lifecycle shared by both special card styles. */
export class StarParticles {
	private canvas: HTMLCanvasElement | null = null;
	private frame = 0;
	private visible = false;
	private width = 0;
	private height = 0;
	private previous = 0;
	private readonly controller = new AbortController();
	private readonly motion = matchMedia("(prefers-reduced-motion: reduce)");
	private readonly intersection: IntersectionObserver;
	private readonly resize: ResizeObserver;
	private readonly stars: Star[] = Array.from({ length: 12 }, () => ({
		x: Math.random(),
		y: Math.random(),
		size: 2 + Math.random() * 3,
		speed: 0.006 + Math.random() * 0.012,
		phase: Math.random() * Math.PI * 2,
	}));

	constructor(
		private readonly host: HTMLElement,
		private readonly kind: "owner" | "featured",
	) {
		this.intersection = new IntersectionObserver(([entry]) => {
			this.visible = entry.isIntersecting;
			this.sync();
		});
		this.resize = new ResizeObserver(() => this.resizeCanvas());
		this.intersection.observe(host);
		this.resize.observe(host);
		document.addEventListener("visibilitychange", () => this.sync(), {
			signal: this.controller.signal,
		});
		this.motion.addEventListener("change", () => this.sync(), {
			signal: this.controller.signal,
		});
		this.sync();
	}

	private sync(): void {
		if (this.motion.matches) {
			this.stop();
			this.canvas?.remove();
			this.canvas = null;
			return;
		}
		if (!this.canvas) {
			this.canvas = document.createElement("canvas");
			this.canvas.className = "friend-star-canvas";
			this.canvas.setAttribute("aria-hidden", "true");
			this.host.append(this.canvas);
			this.resizeCanvas();
		}
		if (!this.visible || document.hidden) {
			this.stop();
			return;
		}
		if (!this.frame) {
			this.previous = 0;
			this.frame = requestAnimationFrame(this.draw);
		}
	}

	private resizeCanvas(): void {
		if (!this.canvas) return;
		const rect = this.host.getBoundingClientRect();
		this.width = rect.width;
		this.height = rect.height;
		const ratio = Math.min(devicePixelRatio || 1, 2);
		this.canvas.width = Math.round(this.width * ratio);
		this.canvas.height = Math.round(this.height * ratio);
		this.canvas.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
	}

	private draw = (timestamp: number): void => {
		this.frame = 0;
		if (!this.canvas || !this.visible || document.hidden || this.motion.matches)
			return;
		const context = this.canvas.getContext("2d");
		if (!context) return;
		const delta = this.previous
			? Math.min((timestamp - this.previous) / 1000, 0.05)
			: 0;
		this.previous = timestamp;
		context.clearRect(0, 0, this.width, this.height);
		context.fillStyle = this.kind === "owner" ? "#b79af2" : "#edc262";
		for (const star of this.stars) {
			star.y = (star.y - delta * star.speed + 1) % 1;
			const x =
				star.x * this.width + Math.sin(timestamp / 2200 + star.phase) * 5;
			const y = star.y * this.height;
			const points = this.kind === "owner" ? 4 : 5;
			context.globalAlpha =
				0.18 + (Math.sin(timestamp / 1300 + star.phase) + 1) * 0.18;
			context.beginPath();
			for (let point = 0; point < points * 2; point++) {
				const angle = (point * Math.PI) / points - Math.PI / 2;
				const radius = point % 2 === 0 ? star.size : star.size * 0.3;
				const px = x + Math.cos(angle) * radius;
				const py = y + Math.sin(angle) * radius;
				if (point === 0) context.moveTo(px, py);
				else context.lineTo(px, py);
			}
			context.closePath();
			context.fill();
		}
		context.globalAlpha = 1;
		this.frame = requestAnimationFrame(this.draw);
	};

	private stop(): void {
		if (this.frame) cancelAnimationFrame(this.frame);
		this.frame = 0;
		this.previous = 0;
	}

	destroy(): void {
		this.stop();
		this.controller.abort();
		this.intersection.disconnect();
		this.resize.disconnect();
		this.canvas?.remove();
		this.canvas = null;
	}
}
