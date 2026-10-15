import type { Hono } from "hono";
import type { AdminSession, AdminUser } from "../shared/contracts.js";
import type { FileStore } from "./file-store.js";

export type AppEnv = {
	Variables: {
		user: AdminUser;
		session: AdminSession;
		requestId: string;
		store?: FileStore;
	};
};

export type AdminApp = Hono<AppEnv>;
