export interface FooterRuntime {
	days: number;
	hours: number;
	minutes: number;
	seconds: number;
}

export function getFooterRuntime(
	startDate: string | undefined,
	now: number = Date.now(),
): FooterRuntime | null {
	if (!startDate?.trim() || !Number.isFinite(now)) return null;
	const value = startDate.trim();
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
	const timestamp = Date.parse(dateOnly ? `${value}T00:00:00+08:00` : value);
	if (!Number.isFinite(timestamp)) return null;
	// Date.parse normalizes impossible dates such as February 30; reject those.
	if (dateOnly) {
		const beijingDate = new Date(timestamp + 8 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
		if (beijingDate !== value) return null;
	}
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	return {
		days: Math.floor(seconds / 86400),
		hours: Math.floor((seconds % 86400) / 3600),
		minutes: Math.floor((seconds % 3600) / 60),
		seconds: seconds % 60,
	};
}
