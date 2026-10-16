export type FriendHealthStatus = "success" | "slow" | "warn" | "timeout";
export type FriendBacklinkStatus =
	| "present"
	| "missing"
	| "unknown"
	| "unchecked";

export type FriendHealthResult = {
	url: string;
	name: string;
	status: FriendHealthStatus;
	latencyMs: number | null;
	statusCode: number | null;
	consecutiveFailures: number;
	backlink: FriendBacklinkStatus;
	checkedAt: string;
	screenshot?: string;
	screenshotAt?: string;
	error?: string;
	lastSuccessAt?: string;
};

export type FriendHealthReport = {
	schemaVersion: 1;
	checkedAt: string | null;
	results: FriendHealthResult[];
};

export type FriendHealthGroup = "active" | "pending" | "graveyard";
