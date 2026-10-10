export type RuntimeEnvironment = "development" | "preview" | "production";

export type AdminUser = {
	id: string;
	login: string;
	name: string;
	avatarUrl: string;
};

export type AdminSession = {
	user: AdminUser;
	csrfToken: string;
	environment: RuntimeEnvironment;
	productionPublish: boolean;
};

export type ApiResponse<T> = { data: T; revision?: number };
export type ApiError = { error: { code: string; message: string; details?: unknown } };

export type PostRecord = {
	id: string;
	filePath: string;
	slug: string;
	title: string;
	published: string | null;
	draft: boolean;
	format: "md" | "mdx";
	source: string;
	metadata: Record<string, unknown>;
	revision: number;
	publishedRevision: number | null;
	publishedSource: string | null;
	updatedAt: string;
};

export type EntityRecord = {
	id: string;
	kind: string;
	data: Record<string, unknown>;
	revision: number;
	createdAt: string;
	updatedAt: string;
};

export type TaskRecord = {
	id: string;
	kind: string;
	state: string;
	snapshotId?: string;
	targetSha?: string | null;
	productionSha?: string | null;
	deploymentId?: string | null;
	message?: string | null;
	createdAt: string;
	updatedAt: string;
};

export type MediaRecord = {
	id: string;
	pathname: string;
	name: string;
	contentType: string;
	size: number;
	access: "private" | "public";
	alt: string;
	caption: string;
	url?: string;
	createdAt: string;
};
