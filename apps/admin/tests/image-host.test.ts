import test from "node:test";
import assert from "node:assert/strict";
import { uploadToImageBed } from "../server/image-host.js";

test("uploads a file to ImgBed with a server-side API token and resolves its public URL", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const result = await uploadToImageBed(
		Buffer.from("image-bytes"),
		"cover.png",
		"image/png",
		{
			baseUrl: "https://image.nocticur.eu.cc",
			token: "test-imgbed-token",
			fetcher: async (input, init) => {
				calls.push({ url: String(input), init: init || {} });
				return new Response(JSON.stringify([{ src: "/file/abc123", publicUrl: "https://image.nocticur.eu.cc/abc123" }]), { status: 200 });
			},
		},
	);

	assert.equal(result, "https://image.nocticur.eu.cc/abc123");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://image.nocticur.eu.cc/upload?returnFormat=full&autoRetry=false");
	assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer test-imgbed-token");
	assert.ok(calls[0].init.body instanceof FormData);
	const file = (calls[0].init.body as FormData).get("file");
	assert.ok(file instanceof File);
	assert.equal(file.name, "cover.png");
	assert.equal(file.type, "image/png");
});

test("fails clearly when ImgBed has no usable public URL", async () => {
	await assert.rejects(
		() => uploadToImageBed(Buffer.from("image-bytes"), "cover.png", "image/png", {
			baseUrl: "https://image.nocticur.eu.cc",
			token: "test-imgbed-token",
			fetcher: async () => new Response(JSON.stringify([{ src: "" }]), { status: 200 }),
		}),
		(error: unknown) => (error as { code?: string }).code === "IMG_BED_RESPONSE_INVALID",
	);
});
