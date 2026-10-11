import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// Preserve the original files while distinguishing these exact template bytes from personal updates.
const ORIGINAL_EXAMPLES: Readonly<Record<string, string>> = {
	"src/content/dynamic/2026-07-15-010756.md": "5876a38c67c277f11c840c419f8df6a335d42be859f5e8f59446fde61ce7f87e",
	"src/content/dynamic/2026-07-15-020613.md": "2d2d9625dfc94d437bfce715865b3b7565edc0123ebf1e5b532a5498b9864d4f",
	"src/content/dynamic/2026-07-15-021127.md": "50f0cc7430a01647e62f81803f9388cbcd1a0aaf19eed20f28c8417233adaf1f",
	"src/content/dynamic/2026-07-15-161529.md": "df218a365eebed93bd14d2f88774576535685486a28312faeb33c718b3f97427",
};

export function isOriginalDynamicExample(filePath: string | undefined): boolean {
	if (!filePath) return false;
	const normalized = relative(process.cwd(), resolve(filePath)).replaceAll("\\", "/");
	const expected = ORIGINAL_EXAMPLES[normalized];
	if (!expected) return false;
	try {
		return createHash("sha256").update(readFileSync(normalized)).digest("hex") === expected;
	} catch {
		return false;
	}
}
