type BackgroundMedia = Pick<
	HTMLVideoElement,
	"src" | "muted" | "play" | "pause"
>;
type PlaybackOptions = {
	mode?: "order" | "random";
	random?: () => number;
	onState?: (playing: boolean) => void;
	onError?: () => void;
};

/** Empty and duplicate sources must not create a player or trigger a request. */
export function normalizeVideoSources(value: string | string[]): string[] {
	return [
		...new Set(
			(Array.isArray(value) ? value : [value])
				.map((source) => source.trim())
				.filter(
					(source) => source && /^(https?:\/\/|\/(?!\/)|\.\.?\/)/i.test(source),
				),
		),
	];
}

/** Keeps user intent separate from confirmed playback, including late promises. */
export class BackgroundPlayback {
	private index = 0;
	private loadedIndex = -1;
	private generation = 0;
	private requested = false;
	private failed = new Set<number>();
	private readonly sources: string[];

	constructor(
		private readonly media: BackgroundMedia,
		sources: string[],
		private readonly options: PlaybackOptions = {},
	) {
		this.sources = normalizeVideoSources(sources);
	}

	get active(): boolean {
		return this.requested;
	}

	async play(userInitiated = false): Promise<void> {
		this.requested = true;
		this.failed.clear();
		if (userInitiated) this.media.muted = false;
		await this.attempt(++this.generation);
	}

	pause(): void {
		this.requested = false;
		this.generation++;
		this.media.pause();
		this.options.onState?.(false);
	}

	async toggle(): Promise<void> {
		if (this.requested) this.pause();
		else await this.play(true);
	}

	next(): void {
		this.select(1);
	}
	previous(): void {
		this.select(-1);
	}

	async ended(): Promise<void> {
		if (!this.requested) return;
		// Reaching a normal end confirms that this playback cycle was usable.
		this.failed.clear();
		if (this.sources.length > 1) this.index = this.pick(1);
		await this.attempt(++this.generation);
	}

	/** A decode/network failure after play() resolved follows the same bounded fallback. */
	async mediaError(): Promise<void> {
		if (!this.requested) return;
		this.failed.add(this.index);
		const next = this.pick(1, this.failed);
		if (next === -1) {
			this.fail();
			return;
		}
		this.index = next;
		await this.attempt(++this.generation);
	}

	private select(direction: number): void {
		const next = this.pick(direction);
		if (next === -1) return;
		this.index = next;
		// Selecting a paused source must remain a purely local operation.
		if (this.requested) {
			this.failed.clear();
			void this.attempt(++this.generation);
		}
	}

	private pick(direction: number, excluded = new Set<number>()): number {
		const available = this.sources
			.map((_, index) => index)
			.filter(
				(index) =>
					!excluded.has(index) &&
					(this.sources.length === 1 || index !== this.index),
			);
		if (!available.length) return -1;
		if (this.options.mode === "random")
			return (
				available[
					Math.floor(
						(this.options.random?.() ?? Math.random()) * available.length,
					)
				] ?? available[0]
			);
		for (let step = 1; step <= this.sources.length; step++) {
			const index =
				(this.index + direction * step + this.sources.length) %
				this.sources.length;
			if (available.includes(index)) return index;
		}
		return -1;
	}

	private async attempt(generation: number): Promise<void> {
		this.options.onState?.(false);
		while (this.requested && generation === this.generation) {
			if (!this.sources.length) {
				this.fail();
				return;
			}
			if (this.loadedIndex !== this.index) {
				this.media.src = this.sources[this.index];
				this.loadedIndex = this.index;
			}
			try {
				try {
					await this.media.play();
				} catch (error) {
					if (generation !== this.generation) return;
					if (
						!(error instanceof Error) ||
						error.name !== "NotAllowedError" ||
						this.media.muted
					)
						throw error;
					this.media.muted = true;
					await this.media.play();
				}
				if (generation !== this.generation || !this.requested) return;
				this.options.onState?.(true);
				return;
			} catch {
				if (generation !== this.generation) return;
				this.failed.add(this.index);
				const next = this.pick(1, this.failed);
				if (next === -1) {
					this.fail();
					return;
				}
				this.index = next;
			}
		}
	}

	private fail(): void {
		this.pause();
		this.loadedIndex = -1;
		this.options.onError?.();
	}
}

type BackgroundImage = Pick<
	HTMLImageElement,
	| "complete"
	| "naturalWidth"
	| "decode"
	| "addEventListener"
	| "removeEventListener"
>;

/** Resolve only once pixels can replace the previous background safely. */
export async function waitForBackgroundImage(
	image: BackgroundImage,
): Promise<void> {
	if (!image.complete) {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				image.removeEventListener("load", loaded);
				image.removeEventListener("error", failed);
			};
			const loaded = () => {
				cleanup();
				resolve();
			};
			const failed = () => {
				cleanup();
				reject(new Error("Background image failed to load"));
			};
			image.addEventListener("load", loaded, { once: true });
			image.addEventListener("error", failed, { once: true });
		});
	}
	if (!image.naturalWidth)
		throw new Error("Background image has no decoded pixels");
	if (typeof image.decode === "function") await image.decode();
}
