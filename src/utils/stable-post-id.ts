import publishedState from "../data/published-state.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A URL is not an identity. Missing mappings remain unpublished and cannot create comment threads. */
export function getStablePostId(slug: string): string | null {
	const normalized = slug.replace(/\.(md|mdx|markdown)$/i, "");
	const post = publishedState.posts.find((entry) => entry.slug === normalized);
	return post && UUID.test(post.id) ? post.id : null;
}
