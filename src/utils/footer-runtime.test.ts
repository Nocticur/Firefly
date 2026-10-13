import assert from "node:assert/strict";
import test from "node:test";
import { getFooterRuntime } from "./footer-runtime.ts";

test("uses an ISO start date with its existing Beijing offset", () => {
	assert.deepEqual(
		getFooterRuntime(
			"2026-07-26T00:00:00+08:00",
			Date.parse("2026-07-27T02:03:04+08:00"),
		),
		{ days: 1, hours: 2, minutes: 3, seconds: 4 },
	);
});

test("interprets a legacy date-only start date at midnight in Beijing", () => {
	assert.deepEqual(
		getFooterRuntime("2026-07-26", Date.parse("2026-07-26T01:02:03+08:00")),
		{ days: 0, hours: 1, minutes: 2, seconds: 3 },
	);
});

test("does not publish NaN values for a missing or invalid start date", () => {
	for (const startDate of [undefined, "", "invalid", "2026-02-30"]) {
		assert.equal(getFooterRuntime(startDate), null);
	}
});

test("clamps a future start date to zero elapsed time", () => {
	assert.deepEqual(
		getFooterRuntime("2026-07-26T00:00:00+08:00", Date.parse("2026-07-25")),
		{ days: 0, hours: 0, minutes: 0, seconds: 0 },
	);
});
