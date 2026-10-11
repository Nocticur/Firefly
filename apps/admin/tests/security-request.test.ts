import test from "node:test";
import assert from "node:assert/strict";
import { ApiFailure, readJson, readText } from "../server/security.js";

const failure = (code: string, status: number) => (error: unknown) => error instanceof ApiFailure && error.code === code && error.status === status;
function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
	return new Request("https://audit.invalid/api/public/comments", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body, duplex: "half" } as RequestInit);
}

test("chunked JSON stops and cancels before reading an oversized body in full", async () => {
	let pulls = 0; let cancelled = false;
	const request = streamRequest(new ReadableStream({
		pull(controller) { if (pulls === 64) controller.close(); else { pulls++; controller.enqueue(new Uint8Array(1024).fill(32)); } },
		cancel() { cancelled = true; },
	}));
	await assert.rejects(readJson(request, 1024), failure("REQUEST_TOO_LARGE", 413));
	assert.equal(cancelled, true);
	assert.ok(pulls <= 3, `read ${pulls} chunks instead of stopping at the limit`);
});

test("actual bytes reject a forged short length and oversized single chunk", async () => {
	let cancelled = false;
	const request = streamRequest(new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
		cancel() { cancelled = true; },
	}), { "Content-Length": "1" });
	await assert.rejects(readText(request, 1024), failure("REQUEST_TOO_LARGE", 413));
	assert.equal(cancelled, true);
});

test("bounded decoding preserves split UTF-8 bytes and exact webhook payload text", async () => {
	const original = '{ "文字": "夜幕🌙", "spacing": [1,  2] }\r\n';
	const encoded = new TextEncoder().encode(original); let offset = 0;
	const request = streamRequest(new ReadableStream({ pull(controller) { if (offset === encoded.length) controller.close(); else controller.enqueue(encoded.slice(offset, ++offset)); } }), { "Content-Length": String(encoded.length) });
	assert.equal(await readText(request, encoded.length), original);
	const bomPayload = "\uFEFF" + original;
	assert.equal(await readText(new Request("https://audit.invalid/", { method: "POST", body: bomPayload }), 1024), bomPayload);
	const malformed = streamRequest(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])); controller.close(); } }));
	await assert.rejects(readText(malformed, 1024), failure("REQUEST_BODY_INVALID", 400));
});

test("malformed lengths and unsupported JSON media types fail before body parsing", async () => {
	for (const length of ["-1", "not-a-number", "1.5", "9007199254740992"]) {
		await assert.rejects(readJson(new Request("https://audit.invalid/", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": length }, body: "{}" })), failure("CONTENT_LENGTH_INVALID", 400));
	}
	for (const contentType of ["application/jsonp", "application/json-whatever", "text/json"]) {
		await assert.rejects(readJson(new Request("https://audit.invalid/", { method: "POST", headers: { "Content-Type": contentType }, body: "{}" })), failure("JSON_REQUIRED", 415));
	}
	assert.deepEqual(await readJson(new Request("https://audit.invalid/", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{}" })), {});
});

test("declared oversized or incomplete bodies fail without waiting for a sender", async () => {
	let cancelled = false;
	const oversized = streamRequest(new ReadableStream({ cancel() { cancelled = true; } }), { "Content-Length": "2048" });
	await assert.rejects(readText(oversized, 1024), failure("REQUEST_TOO_LARGE", 413));
	assert.equal(cancelled, true);
	await assert.rejects(readText(new Request("https://audit.invalid/", { method: "POST", headers: { "Content-Length": "4" }, body: "{}" }), 1024), failure("CONTENT_LENGTH_INVALID", 400));
});

test("stalled body times out and cancels; transport errors expose no internal message", async () => {
	let cancelled = false;
	const stalled = streamRequest(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}); } }));
	await assert.rejects(readText(stalled, 1024, 20), failure("REQUEST_TIMEOUT", 408));
	assert.equal(cancelled, true);
	const failed = streamRequest(new ReadableStream({ start(controller) { controller.error(new Error("private transport detail")); } }));
	await assert.rejects(readText(failed, 1024), (error: unknown) => failure("REQUEST_BODY_INVALID", 400)(error) && !(error as Error).message.includes("private transport"));
});

test("invalid JSON and non-object JSON retain distinct safe errors", async () => {
	for (const [body, code] of [["{", "INVALID_JSON"], ["[]", "INVALID_BODY"], ["null", "INVALID_BODY"]]) {
		await assert.rejects(readJson(new Request("https://audit.invalid/", { method: "POST", headers: { "Content-Type": "application/json" }, body })), failure(code, 400));
	}
});
