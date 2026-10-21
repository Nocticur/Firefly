import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv } from "../server/types.js";
import {
	collection,
	createMemoryStore,
	getSiteId,
	withStore,
	type FileStore,
} from "../server/file-store.js";
import { issueSession } from "../server/auth.js";
import { entryCookie } from "./entry-fixture.js";
import { ApiFailure } from "../server/security.js";
import { publicContentDigest } from "../server/release-format.js";
import {
	markFriendsPublished,
	registerInteractionRoutes,
} from "../server/interactions.js";
type Row = Record<string, unknown>;
const publicOrigin = "http://localhost:4321";
const source =
	'---\ntitle: "公开文章"\npublished: "2026-09-10"\ndraft: false\ncomment: true\n---\nbody\n';
async function fixture() {
	process.env.APP_ENV = "development";
	delete process.env.VERCEL_ENV;
	delete process.env.VERCEL;
	process.env.ADMIN_DEV_ORIGIN = "http://localhost:3000";
	process.env.PUBLIC_DEV_ORIGIN = publicOrigin;
	process.env.TURNSTILE_SECRET_KEY = "isolated-test-secret";
	process.env.ENABLE_PUBLIC_COMMENTS = "true";
	const site = getSiteId(),
		store = createMemoryStore(site),
		article = randomUUID();
	await store.update((state) => {
		collection(state, "entities")[`post:${article}`] = {
			id: article,
			kind: "post",
			data: { publishedSource: source },
			revision: 1,
		};
		collection(state, "entities")["repository:baseline"] = {
			id: "baseline",
			kind: "repository",
			data: { posts: [{ id: article }] },
			revision: 1,
		};
	});
	let result: Row = {
		success: true,
		hostname: "localhost",
		challenge_ts: new Date().toISOString(),
	};
	let unavailable = false;
	const fetcher: typeof fetch = async (_input, init) => {
		if (unavailable) throw new Error("offline");
		const form = new URLSearchParams(String(init?.body));
		assert.equal(form.get("secret"), "isolated-test-secret");
		return new Response(
			JSON.stringify({
				action:
					form.get("response") === "friend-token"
						? "friend_request"
						: "comments",
				...result,
			}),
		);
	};
	const app = new Hono<AppEnv>();
	app.use("/api/*", async (c, next) =>
		withStore(store, async () => {
			c.set("store", store);
			await next();
		}),
	);
	app.onError((error, c) =>
		error instanceof ApiFailure
			? error.getResponse()
			: c.json({ error: String(error) }, 500),
	);
	registerInteractionRoutes(app, {
		store,
		site,
		fetcher,
	});
	const session = issueSession(),
		cookie = `${entryCookie()}; __Host-admin-session=${session.token}`;
	const moderate = (
		path: string,
		body: Row = {},
		method = "POST",
		csrf = true,
	) =>
		app.request(`http://localhost:3000/api${path}`, {
			method,
			headers: {
				cookie,
				"Content-Type": "application/json",
				...(csrf
					? {
							Origin: "http://localhost:3000",
							"x-csrf-token": session.csrfToken,
						}
					: {}),
			},
			body: JSON.stringify(body),
		});
	const submit = (body: Row = {}, ip = "192.0.2.1") =>
		app.request(`${publicOrigin}/api/public/comments`, {
			method: "POST",
			headers: {
				Origin: publicOrigin,
				"Content-Type": "application/json",
				"x-forwarded-for": ip,
			},
			body: JSON.stringify({
				articleId: article,
				name: "访客",
				body: "评论",
				turnstileToken: "comment-token",
				...body,
			}),
		});
	const friend = (name = "friend", ip = "192.0.2.30") =>
		app.request(`${publicOrigin}/api/public/friends`, {
			method: "POST",
			headers: {
				Origin: publicOrigin,
				"Content-Type": "application/json",
				"x-forwarded-for": ip,
			},
			body: JSON.stringify({
				name,
				url: `https://${name}.example`,
				description: "我的站点",
				email: `${name}@example.com`,
				avatar: "",
				turnstileToken: "friend-token",
			}),
		});
	return {
		store,
		site,
		article,
		app,
		moderate,
		submit,
		friend,
		setResult: (value: Row) => {
			result = value;
		},
		setUnavailable: (value: boolean) => {
			unavailable = value;
		},
	};
}
test("flat JSON comments preserve privacy, reply identity, moderation and authentication", async () => {
	const f = await fixture();
	const first = await f.submit({
		body: "<script>literal</script>",
		email: "private@example.com",
	});
	assert.equal(first.status, 201);
	const record = (await first.json()).data;
	assert.equal(record.body, "<script>literal</script>");
	assert.equal("email" in record, false);
	assert.equal("visitorId" in record, false);
	assert.equal(
		(await f.submit({ parentId: record.id }, "192.0.2.2")).status,
		201,
	);
	assert.equal(
		(await f.app.request("http://localhost:3000/api/comments")).status,
		401,
	);
	assert.equal(
		(await f.moderate(`/comments/${record.id}/delete`, {}, "POST", false))
			.status,
		403,
	);
	assert.equal((await f.moderate(`/comments/${record.id}/delete`)).status, 200);
	const listed = await (
		await f.app.request(
			`${publicOrigin}/api/public/comments?articleId=${f.article}`,
		)
	).json();
	assert.equal(
		listed.data.find((row: Row) => row.id === record.id).body,
		"此评论已删除。",
	);
	assert.equal(
		(await f.submit({ parentId: record.id }, "192.0.2.3")).status,
		400,
	);
	assert.equal(
		collection(await f.store.read(), "comments")[record.id].email,
		null,
	);
});

test("Turnstile and article visibility fail closed before insertion", async () => {
	const f = await fixture();
	assert.equal((await f.submit({ articleId: randomUUID() })).status, 404);
	for (const value of [
		{ success: true, hostname: "attacker.example" },
		{ success: false, hostname: "localhost" },
		{ success: true, hostname: "localhost", action: "friend_request" },
		{
			success: true,
			hostname: "localhost",
			challenge_ts: new Date(Date.now() - 600000).toISOString(),
		},
	]) {
		f.setResult({
			...value,
			challenge_ts: value.challenge_ts || new Date().toISOString(),
		});
		assert.equal(
			(await f.submit({}, `192.0.2.${20 + Object.keys(value).length}`)).status,
			403,
		);
	}
	f.setUnavailable(true);
	assert.equal((await f.submit({}, "192.0.2.28")).status, 503);
	assert.equal(
		Object.keys(collection(await f.store.read(), "comments")).length,
		0,
	);
});

test("rate limits, bans and duplicate friend applications are atomic across requests", async () => {
	const f = await fixture();
	for (let i = 0; i < 5; i++)
		assert.equal((await f.submit({}, "192.0.2.40")).status, 201);
	assert.equal((await f.submit({}, "192.0.2.40")).status, 429);
	const first = await f.submit({}, "192.0.2.41");
	const id = (await first.json()).data.id;
	const subject = collection(await f.store.read(), "comments")[id].visitor_id;
	const ban = await (await f.moderate("/bans", { subject })).json();
	assert.equal((await f.submit({}, "192.0.2.41")).status, 403);
	await f.moderate(`/bans/${ban.data.id}`, {}, "DELETE");
	assert.equal((await f.submit({}, "192.0.2.41")).status, 201);
	const responses = await Promise.all([
		f.friend("same", "192.0.2.50"),
		f.friend("same", "192.0.2.51"),
	]);
	assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
});

test("bounded comment pagination retains exact timestamp/ID order with no duplicates", async () => {
	const f = await fixture();
	const ids = Array.from({ length: 103 }, () => randomUUID()).sort();
	await f.store.update((state) => {
		const rows = collection(state, "comments");
		for (const [index, id] of ids.entries())
			rows[id] = {
				id,
				article_id: f.article,
				parent_id: index ? ids[0] : null,
				name: "访客",
				body: "评论",
				status: "visible",
				created_at: "2026-10-15T00:00:00.123Z",
				cursor_created_at: `2026-10-15T00:00:00.${String(123000 + index).padStart(6, "0")}Z`,
			};
	});
	let cursor: string | null = null;
	const found: string[] = [];
	do {
		const response = await f.app.request(
			`${publicOrigin}/api/public/comments?articleId=${f.article}${cursor ? `&cursor=${cursor}` : ""}`,
		);
		assert.equal(response.status, 200);
		const page = await response.json();
		found.push(...page.data.map((row: Row) => row.id));
		cursor = page.nextCursor;
	} while (cursor);
	assert.deepEqual(found, ids);
	await f.store.update((state) => {
		for (const row of Object.values(collection(state, "comments")))
			row.body = "汉".repeat(10000);
	});
	const bounded = await f.app.request(
		`${publicOrigin}/api/public/comments?articleId=${f.article}&limit=100`,
	);
	const text = await bounded.text();
	assert.ok(Buffer.byteLength(text) <= 512 * 1024);
	assert.ok(JSON.parse(text).nextCursor);
	assert.equal(
		(
			await f.app.request(
				`${publicOrigin}/api/public/comments?articleId=${f.article}&limit=101`,
			)
		).status,
		400,
	);
});

async function publishFixture(
	store: FileStore,
	id: string,
	revision: number,
	stateName = "verified",
	details: Row = {},
) {
	const taskId = randomUUID(),
		snapshotId = randomUUID(),
		sha = "a".repeat(40);
	const friend = {
		id,
		name: "friend",
		url: "https://friend.example/",
		description: "我的站点",
		avatar: "",
		group: "",
		sortOrder: 0,
	};
	const settings = { friends: [friend] },
		posts: never[] = [],
		redirects: never[] = [],
		digest = publicContentDigest(posts, settings, redirects);
	await store.update((state) => {
		collection(state, "release_tasks")[taskId] = {
			id: taskId,
			kind: "publish",
			state: stateName,
			snapshot_id: snapshotId,
			target_sha: sha,
			production_sha: sha,
			deployment_id: "verified-deployment",
			details,
		};
		collection(state, "release_snapshots")[snapshotId] = {
			id: snapshotId,
			digest,
			data: {
				id: snapshotId,
				taskId,
				digest,
				settings,
				posts,
				redirects,
				friendIds: [id],
				friendRevisions: { [id]: revision },
			},
		};
		collection(state, "entities")["repository:baseline"] = {
			id: "baseline",
			kind: "repository",
			data: { taskId, snapshotId, publicContentDigest: digest, headSha: sha },
		};
	});
	return { taskId, friend };
}

test("frozen verified friends publish without creating mail and stay unchanged by later moderation", async () => {
	const f = await fixture();
	const id = (await (await f.friend()).json()).data.id;
	const approved = await (await f.moderate(`/friends/${id}/approve`)).json(),
		revision = approved.data.revision;
	const unverified = await publishFixture(f.store, id, revision, "deploying");
	await assert.rejects(
		() =>
			markFriendsPublished(
				[id],
				unverified.taskId,
				{ [id]: revision },
				{ store: f.store, site: f.site },
			),
		(error) =>
			error instanceof ApiFailure && error.code === "VERIFIED_RELEASE_REQUIRED",
	);
	const verified = await publishFixture(f.store, id, revision);
	const deps = { store: f.store, site: f.site };
	await Promise.all([
		markFriendsPublished([id], verified.taskId, { [id]: revision }, deps),
		markFriendsPublished([id], verified.taskId, { [id]: revision }, deps),
	]);
	const publishedState = await f.store.read();
	const published = collection(publishedState, "friends")[id];
	assert.equal(published.status, "published");
	assert.ok(published.published_at);
	assert.equal(published.email, "friend@example.com");
	assert.equal(publishedState.collections.mail_outbox, undefined);
	await f.moderate(
		`/friends/${id}`,
		{ group: "edited", sortOrder: 1 },
		"PATCH",
	);
	assert.deepEqual(
		(await (await f.app.request(`${publicOrigin}/api/public/friends`)).json())
			.data,
		[verified.friend],
	);
	const restored = await publishFixture(f.store, id, revision, "verified", {
		restored: true,
	});
	await assert.rejects(() =>
		markFriendsPublished([id], restored.taskId, { [id]: revision }, deps),
	);
});

test("friend rejection keeps contact details and an idempotent reason without creating mail", async () => {
	const f = await fixture();
	const id = (await (await f.friend()).json()).data.id;
	assert.equal(
		(await f.moderate(`/friends/${id}/reject`, { reason: "缺少介绍" })).status,
		200,
	);
	assert.equal(
		(await f.moderate(`/friends/${id}/reject`, { reason: "缺少介绍" })).status,
		200,
	);
	const state = await f.store.read();
	const rejected = collection(state, "friends")[id];
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.rejection_reason, "缺少介绍");
	assert.equal(rejected.email, "friend@example.com");
	assert.equal(rejected.revision, 2);
	assert.equal(state.collections.mail_outbox, undefined);
});

test("friend finalization rejects stale revisions and a mismatched public baseline", async () => {
	const f = await fixture();
	const id = (await (await f.friend()).json()).data.id;
	const approved = await (await f.moderate(`/friends/${id}/approve`)).json();
	const revision = approved.data.revision;
	const verified = await publishFixture(f.store, id, revision);
	const deps = { store: f.store, site: f.site };
	await assert.rejects(
		() => markFriendsPublished([id], verified.taskId, { [id]: revision + 1 }, deps),
		(error) => error instanceof ApiFailure && error.code === "FROZEN_FRIEND_REVISION_REQUIRED",
	);
	await f.store.update((state) => {
		const baseline = collection(state, "entities")["repository:baseline"].data as Row;
		baseline.headSha = "b".repeat(40);
	});
	await assert.rejects(
		() => markFriendsPublished([id], verified.taskId, { [id]: revision }, deps),
		(error) => error instanceof ApiFailure && error.code === "SNAPSHOT_INTEGRITY_FAILED",
	);
	assert.equal(collection(await f.store.read(), "friends")[id].status, "approved");
});

test("friend updates preserve legacy mail records without creating or dispatching new messages", async () => {
	const f = await fixture();
	const id = (await (await f.friend()).json()).data.id;
	const approved = await (await f.moderate(`/friends/${id}/approve`)).json();
	const revision = approved.data.revision;
	const verified = await publishFixture(f.store, id, revision);
	const historical = { id: "historical", status: "pending", recipient: "legacy@example.com" };
	await f.store.update((state) => {
		collection(state, "mail_outbox").historical = historical;
		const task = collection(state, "release_tasks")[verified.taskId];
		const snapshot = collection(state, "release_snapshots")[String(task.snapshot_id)].data as Row;
		snapshot.friendNotifications = { [id]: { name: "old recipient", email: "invalid", revision: -1 } };
	});
	await markFriendsPublished([id], verified.taskId, { [id]: revision }, { store: f.store, site: f.site });
	assert.equal((await f.moderate(`/friends/${id}/reject`, { reason: "已下线" })).status, 200);
	const state = await f.store.read();
	assert.deepEqual(Object.values(state.collections.mail_outbox), [historical]);
	assert.equal(collection(state, "friends")[id].rejection_reason, "已下线");
});
