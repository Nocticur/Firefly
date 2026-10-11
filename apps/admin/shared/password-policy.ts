export const MIN_PASSWORD_LENGTH = 3;
export const MAX_PASSWORD_LENGTH = 10;

/** Count Unicode characters consistently in the form and server. Do not trim passwords. */
export function isAdminPassword(value: unknown): value is string {
	if (typeof value !== "string" || !value.trim() || /[\uD800-\uDFFF]/u.test(value)) return false;
	const length = Array.from(value).length;
	return length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH;
}
