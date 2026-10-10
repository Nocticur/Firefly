import type { Hono } from "hono";
import type { AdminSession, AdminUser } from "../shared/contracts.js";

export type AppEnv = {
	Variables: {
		user: AdminUser;
		session: AdminSession;
		requestId: string;
	};
};

export type AdminApp = Hono<AppEnv>;
