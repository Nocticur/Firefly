import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("music state follows actual playback, buffering, and external pause events", () => {
	const source = readFileSync(
		new URL("../components/features/MusicManager.astro", import.meta.url),
		"utf8",
	);
	const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script);
	const audio = Object.assign(new EventTarget(), {
		style: {},
		paused: true,
		ended: false,
		readyState: 4,
		currentTime: 0,
		duration: 120,
		pause() {
			this.paused = true;
		},
	});
	const browser = Object.assign(new EventTarget(), {
		__fireflyMusic: undefined as
			| { getState: () => { isPlaying: boolean } }
			| undefined,
	});
	class DetailEvent extends Event {
		detail: unknown;
		constructor(type: string, options: { detail: unknown }) {
			super(type);
			this.detail = options.detail;
		}
	}
	runInNewContext(script, {
		window: browser,
		document: { createElement: () => audio, body: { appendChild() {} } },
		localStorage: { getItem: () => null },
		managerConfigStr: JSON.stringify({
			mode: "local",
			localPlaylist: [],
			i18n: {},
		}),
		CustomEvent: DetailEvent,
		setTimeout,
		clearTimeout,
		console,
	});
	audio.paused = false;
	audio.dispatchEvent(new Event("playing"));
	assert.equal(browser.__fireflyMusic?.getState().isPlaying, true);
	audio.dispatchEvent(new Event("waiting"));
	assert.equal(browser.__fireflyMusic?.getState().isPlaying, false);
	audio.dispatchEvent(new Event("playing"));
	assert.equal(browser.__fireflyMusic?.getState().isPlaying, true);
	audio.paused = true;
	audio.dispatchEvent(new Event("pause"));
	assert.equal(browser.__fireflyMusic?.getState().isPlaying, false);
});
