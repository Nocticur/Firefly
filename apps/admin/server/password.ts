import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { isAdminPassword } from "../shared/password-policy.js";

export const PASSWORD_SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Only the server generates this verifier; neither the salt nor hash is a login credential. */
export function createPasswordHash(password: string): string {
	if (!isAdminPassword(password)) throw new RangeError("Management passwords must contain 3–10 characters");
	const salt = randomBytes(32);
	const hash = scryptSync(password, salt, 32, PASSWORD_SCRYPT_OPTIONS);
	return `scrypt-v1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
	if (!isAdminPassword(password)) return false;
	const match = /^scrypt-v1\$([A-Za-z0-9_-]{43})\$([A-Za-z0-9_-]{43})$/.exec(encoded);
	if (!match) return false;
	const salt = Buffer.from(match[1], "base64url");
	const expected = Buffer.from(match[2], "base64url");
	if (salt.toString("base64url") !== match[1] || expected.toString("base64url") !== match[2]) return false;
	const actual = await new Promise<Buffer>((resolve, reject) => {
		scrypt(password, salt, 32, PASSWORD_SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
	});
	return timingSafeEqual(actual, expected);
}
