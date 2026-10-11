import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { request as httpsRequest, RequestOptions } from "node:https";
import { importBytes } from "../server/media.js";
import { ApiFailure } from "../server/security.js";

const target = { url: new URL("https://media.example/image.png"), address: "93.184.216.34", family: 4 };
const timeoutFailure = (error: unknown) => error instanceof ApiFailure && error.code === "MEDIA_IMPORT_TIMEOUT" && error.status === 504;

test("the media deadline includes stalled DNS and never starts the download", async () => {
	let requested = false;
	await assert.rejects(importBytes(target.url.href, {
		timeoutMs: 20,
		validateUrl: () => new Promise(() => {}),
		request: (() => { requested = true; throw new Error("Unexpected request"); }) as typeof httpsRequest,
	}), timeoutFailure);
	assert.equal(requested, false);
});

test("a continuously trickling peer is cancelled by the total deadline", async () => {
	let cancelled = false; let chunks = 0;
	const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: () => { cancelled = true; } });
	const requester = ((_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
		const request = new EventEmitter();
		let interval: ReturnType<typeof setInterval>;
		Object.assign(request, {
			end() { callback(response as unknown as IncomingMessage); interval = setInterval(() => { chunks++; response.emit("data", Buffer.from([137])); }, 2); },
			destroy(error: Error) { clearInterval(interval); response.destroy(); request.emit("error", error); },
		});
		options.signal!.addEventListener("abort", () => (request as unknown as { destroy(error: Error): void }).destroy(options.signal!.reason), { once: true });
		return request;
	}) as unknown as typeof httpsRequest;
	await assert.rejects(importBytes(target.url.href, { timeoutMs: 30, validateUrl: async () => target, request: requester }), timeoutFailure);
	assert.ok(chunks > 0, "The peer must keep returning bytes before the total deadline");
	assert.equal(cancelled, true);
});

test("host validation failures are preserved before any network connection", async () => {
	const denied = new ApiFailure(400, "MEDIA_IMPORT_HOST_DENIED", "外链须使用允许域名的 HTTPS 地址");
	await assert.rejects(importBytes(target.url.href, { validateUrl: async () => { throw denied; } }), (error: unknown) => error === denied);
});
