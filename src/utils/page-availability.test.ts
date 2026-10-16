import assert from "node:assert/strict";
import test from "node:test";
import type { SiteConfig } from "../types/siteConfig";
import { isPageAvailable, isRouteAvailable } from "./page-availability";

const pages: SiteConfig["pages"] = {
	booknav: true,
	friends: true,
	sponsor: true,
	bangumi: false,
	vndb: false,
	mal: false,
	gallery: true,
	bilibili: true,
	dynamic: true,
	projects: false,
};

test("sponsor visibility requires both page and payment-feature switches", () => {
	assert.equal(isPageAvailable("sponsor", pages, false), false);
	assert.equal(
		isPageAvailable("sponsor", { ...pages, sponsor: false }, true),
		false,
	);
	assert.equal(isPageAvailable("sponsor", pages, true), true);
});

test("other optional pages retain their configured visibility", () => {
	assert.equal(isPageAvailable("friends", pages, false), true);
	assert.equal(isPageAvailable("bangumi", pages, true), false);
});

test("route availability covers aliases, descendants and trailing slashes", () => {
	assert.equal(isRouteAvailable("/sponsor/", pages, false), false);
	assert.equal(isRouteAvailable("/sponsor", pages, false), false);
	assert.equal(isRouteAvailable("/myanimelist/", pages, true), false);
	assert.equal(isRouteAvailable("/projects/example/", pages, true), false);
	assert.equal(
		isRouteAvailable("/gallery/example/", { ...pages, gallery: false }, true),
		false,
	);
	assert.equal(isRouteAvailable("/about/", pages, false), true);
});
