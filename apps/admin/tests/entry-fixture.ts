import { ENTRY_COOKIE, issueEntryToken } from "../server/entry.js";

/** Synthetic password for isolated test processes; never a deployment default. */
export function entryCookie(): string {
	process.env.ADMIN_ENTRY_PASSWORD ||= "testOnly42";
	return `${ENTRY_COOKIE}=${issueEntryToken()}`;
}
