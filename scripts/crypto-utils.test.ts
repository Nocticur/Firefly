import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import test from "node:test";
import { encryptContent } from "../src/utils/crypto-utils.js";

function decrypt(encoded: string, password: string): string {
	const data = Buffer.from(encoded, "base64");
	const key = pbkdf2Sync(password, data.subarray(0, 16), 100000, 32, "sha256");
	const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(16, 28));
	cipher.setAuthTag(data.subarray(28, 44));
	return Buffer.concat([
		cipher.update(data.subarray(44)),
		cipher.final(),
	]).toString("utf8");
}

test("article encryption retains exact Unicode HTML and the existing browser-compatible format", () => {
	const source = "<h2>夜幕 🚀</h2>\r\n<p>私人正文与公式。</p>";
	const password = "synthetic article password";
	assert.equal(decrypt(encryptContent(source, password), password), source);
});

test("repeated encryption and edits generate independent salts and GCM IVs", () => {
	const password = "synthetic article password";
	const values = [
		encryptContent("original", password),
		encryptContent("original", password),
		encryptContent("edited", password),
	];
	assert.equal(new Set(values).size, 3);
	assert.equal(
		new Set(
			values.map((value) =>
				Buffer.from(value, "base64").subarray(0, 16).toString("hex"),
			),
		).size,
		3,
	);
	assert.equal(
		new Set(
			values.map((value) =>
				Buffer.from(value, "base64").subarray(16, 28).toString("hex"),
			),
		).size,
		3,
	);
	for (const [index, value] of values.entries())
		assert.equal(decrypt(value, password), index === 2 ? "edited" : "original");
});

test("wrong passwords and modified article ciphertext or authentication tags are rejected", () => {
	const password = "synthetic article password";
	const encrypted = encryptContent("private text", password);
	assert.throws(() => decrypt(encrypted, "wrong article password"));
	for (const index of [0, 16, 28, 44]) {
		const bytes = Buffer.from(encrypted, "base64");
		bytes[index] ^= 1;
		assert.throws(() => decrypt(bytes.toString("base64"), password));
	}
});
