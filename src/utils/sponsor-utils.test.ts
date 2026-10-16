import assert from "node:assert/strict";
import test from "node:test";
import type { SponsorMethod } from "../types/sponsorConfig";
import { getEnabledSponsorMethods } from "./sponsor-utils";

test("only enabled methods with usable payment details are rendered", () => {
	const methods = [
		{ type: "qrcode", name: "支付宝", image: "/pay/alipay.png", enabled: true },
		{
			type: "url",
			name: "支持",
			url: "https://support.example/nocticur",
			enabled: true,
		},
		{ type: "qrcode", name: "未配置", image: "  ", enabled: true },
		{
			type: "url",
			name: "未启用",
			url: "https://support.example",
			enabled: false,
		},
	] satisfies SponsorMethod[];
	assert.deepEqual(getEnabledSponsorMethods(methods), methods.slice(0, 2));
});

test("payment links reject executable, relative, and credential-bearing URLs", () => {
	const methods = [
		"javascript:alert(1)",
		"/pay/",
		"//pay.example",
		"https://user:pass@pay.example",
		"not a url",
	].map(
		(url): SponsorMethod => ({
			type: "url",
			name: "无效链接",
			url,
			enabled: true,
		}),
	);
	assert.deepEqual(getEnabledSponsorMethods(methods), []);
});

test("QR images reject remote-protocol shortcuts and empty method names", () => {
	const methods: SponsorMethod[] = [
		{
			type: "qrcode",
			name: "二维码",
			image: "//pay.example/image.png",
			enabled: true,
		},
		{ type: "qrcode", name: " ", image: "/pay/image.png", enabled: true },
		{
			type: "qrcode",
			name: "二维码",
			image: "javascript:alert(1)",
			enabled: true,
		},
	];
	assert.deepEqual(getEnabledSponsorMethods(methods), []);
});

test("QR images accept source assets and inline bitmap data alongside public and remote files", () => {
	const methods = [
		"assets/images/logo/firefly-light.png",
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+n2QAAAAASUVORK5CYII=",
		"/pay/qr.png",
		"https://pay.example/qr.webp",
	].map(
		(image): SponsorMethod => ({
			type: "qrcode",
			name: "二维码",
			image,
			enabled: true,
		}),
	);
	assert.deepEqual(getEnabledSponsorMethods(methods), methods);
});

test("QR source assets reject traversal and inline images reject non-bitmap payloads", () => {
	const methods = [
		"assets/../config/siteConfig.ts",
		"assets/%2e%2e/secret.png",
		"assets/images/../../secret.png",
		"data:image/svg+xml;base64,PHN2Zy8+",
		"data:text/html;base64,PHNjcmlwdD4=",
		"data:image/png;base64,not-an-image!",
	].map(
		(image): SponsorMethod => ({
			type: "qrcode",
			name: "二维码",
			image,
			enabled: true,
		}),
	);
	assert.deepEqual(getEnabledSponsorMethods(methods), []);
});
