import test from "node:test";
import assert from "node:assert/strict";
import { createPasswordHash, verifyPassword } from "../server/password.js";
import { isAdminPassword } from "../shared/password-policy.js";

test("password policy accepts 3–10 Unicode characters and rejects invalid or blank values", () => {
	for (const value of ["a1!", "testOnly42", "暮夜途", "🚀".repeat(10), " Ab1 "]) assert.equal(isAdminPassword(value), true);
	for (const value of [undefined, null, 1, {}, "", "ab", "x".repeat(11), "界".repeat(11), "🚀".repeat(11), " ".repeat(3), "\ud800ab"]) assert.equal(isAdminPassword(value), false);
});

test("automatic scrypt hashing uses independent random salts and retains no plaintext password", () => {
	const first = createPasswordHash("s3!x");
	const second = createPasswordHash("s3!x");
	assert.match(first, /^scrypt-v1\$[A-Za-z0-9_-]{43}\$[A-Za-z0-9_-]{43}$/);
	assert.notEqual(first, second);
	assert.notEqual(first.split("$")[1], second.split("$")[1]);
	assert.equal(first.includes("s3!x"), false);
});

test("hashed verification accepts real passwords at both limits including Unicode", async () => {
	for (const password of ["a1!", "testOnly42", "暮夜途", "🚀".repeat(10)]) {
		const hash = createPasswordHash(password);
		assert.equal(await verifyPassword(password, hash), true);
		assert.equal(await verifyPassword("wrongGuess", hash), false);
		assert.equal(await verifyPassword(hash, hash), false, "A verifier itself never acts as the password");
	}
});

test("hash comparison preserves exact case, whitespace and Unicode without trimming or normalization", async () => {
	const hash = createPasswordHash(" Abc1 ");
	assert.equal(await verifyPassword(" Abc1 ", hash), true);
	for (const value of ["Abc1", " abc1 ", " Abc1", "Abc1 "]) assert.equal(await verifyPassword(value, hash), false);
	const unicode = createPasswordHash("é1!");
	assert.equal(await verifyPassword("é1!", unicode), true);
	assert.equal(await verifyPassword("e\u03011!", unicode), false);
});

test("corrupted, noncanonical and unsupported hash formats fail closed with fixed KDF parameters", async () => {
	const hash = createPasswordHash("a1!");
	const modified = hash.slice(0, -1) + (hash.endsWith("A") ? "B" : "A");
	for (const value of ["", "a1!", hash.slice(0, -1), modified, hash.replace("scrypt-v1", "scrypt-v2"), `${hash}$32768`, "x".repeat(1000)]) assert.equal(await verifyPassword("a1!", value), false);
});

test("unsupported password lengths cannot be hashed or authenticated", async () => {
	const hash = createPasswordHash("a1!");
	for (const value of ["", "ab", "x".repeat(11), " ".repeat(3), "\ud800ab"]) {
		assert.throws(() => createPasswordHash(value), RangeError);
		assert.equal(await verifyPassword(value, hash), false);
	}
});
