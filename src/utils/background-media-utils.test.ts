import assert from "node:assert/strict";
import { test } from "node:test";

const api = await import("./background-media-utils").catch(() => undefined);

class Media {
	src = "";
	muted = false;
	loads = 0;
	pauses = 0;
	attempts: { src: string; muted: boolean }[] = [];
	playResult: () => Promise<void> = async () => {};
	load() {
		this.loads++;
	}
	pause() {
		this.pauses++;
	}
	play() {
		this.attempts.push({ src: this.src, muted: this.muted });
		return this.playResult();
	}
}

test("background sources exclude blank and unsafe entries without changing order", () => {
	assert.ok(api, "background media controller must exist");
	assert.deepEqual(
		api.normalizeVideoSources([
			" ",
			"/one.mp4",
			"/one.mp4",
			"javascript:alert(1)",
			"https://example.com/two.mp4",
		]),
		["/one.mp4", "https://example.com/two.mp4"],
	);
});

test("choosing another video while paused makes no media request", () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	const player = new api.BackgroundPlayback(media, ["/one.mp4", "/two.mp4"]);
	player.next();
	assert.equal(media.src, "");
	assert.equal(media.loads, 0);
	assert.equal(media.attempts.length, 0);
});

test("a user click tries sound before retrying a browser policy rejection muted", async () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	media.playResult = async () => {
		if (!media.muted) throw new DOMException("Blocked", "NotAllowedError");
	};
	const states: boolean[] = [];
	const player = new api.BackgroundPlayback(media, ["/one.mp4"], {
		onState: (playing: boolean) => states.push(playing),
	});
	await player.play(true);
	assert.deepEqual(
		media.attempts.map((attempt) => attempt.muted),
		[false, true],
	);
	assert.equal(states.at(-1), true);
});

test("failed videos are each attempted once and restore the image state", async () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	media.playResult = async () => {
		throw new Error("Bad media");
	};
	const states: boolean[] = [];
	let errors = 0;
	const player = new api.BackgroundPlayback(media, ["/one.mp4", "/two.mp4"], {
		mode: "random",
		random: () => 0,
		onState: (playing: boolean) => states.push(playing),
		onError: () => errors++,
	});
	await player.play(true);
	assert.deepEqual(
		media.attempts.map((attempt) => attempt.src),
		["/one.mp4", "/two.mp4"],
	);
	assert.equal(states.at(-1), false);
	assert.equal(errors, 1);
});

test("pausing during a pending play never publishes a late playing state", async () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	let resolvePlay = () => {};
	media.playResult = () =>
		new Promise<void>((resolve) => {
			resolvePlay = resolve;
		});
	const states: boolean[] = [];
	const player = new api.BackgroundPlayback(media, ["/one.mp4"], {
		onState: (playing: boolean) => states.push(playing),
	});
	const pending = player.play(true);
	player.pause();
	resolvePlay();
	await pending;
	assert.equal(states.at(-1), false);
	assert.equal(states.includes(true), false);
});

test("a single background video loops after reaching its normal end", async () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	const player = new api.BackgroundPlayback(media, ["/one.mp4"]);
	await player.play(true);
	await player.ended();
	assert.equal(player.active, true);
	assert.deepEqual(
		media.attempts.map((attempt) => attempt.src),
		["/one.mp4", "/one.mp4"],
	);
	assert.equal(media.pauses, 0);
});

test("late decoding errors exhaust each source once even when play promises resolved", async () => {
	assert.ok(api, "background media controller must exist");
	const media = new Media();
	let errors = 0;
	const player = new api.BackgroundPlayback(media, ["/one.mp4", "/two.mp4"], {
		onError: () => errors++,
	});
	await player.play(true);
	await player.mediaError();
	await player.mediaError();
	assert.equal(player.active, false);
	assert.deepEqual(
		media.attempts.map((attempt) => attempt.src),
		["/one.mp4", "/two.mp4"],
	);
	assert.equal(errors, 1);
});

test("a cached broken background image is never considered ready", async () => {
	assert.ok(api, "background media controller must exist");
	const image = Object.assign(new EventTarget(), {
		complete: true,
		naturalWidth: 0,
		decode: async () => {},
	});
	await assert.rejects(api.waitForBackgroundImage(image), /image/i);
});

test("background transitions wait for image decoding", async () => {
	assert.ok(api, "background media controller must exist");
	let decoded = false;
	const image = Object.assign(new EventTarget(), {
		complete: true,
		naturalWidth: 100,
		decode: async () => {
			decoded = true;
		},
	});
	await api.waitForBackgroundImage(image);
	assert.equal(decoded, true);
});
