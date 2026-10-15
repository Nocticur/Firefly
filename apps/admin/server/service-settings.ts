import type { ServiceSettings } from "../shared/service-settings.js";
import { assertSite, collection, getStore, getSiteId, type FileStore } from "./file-store.js";
import { ApiFailure, productionEnvironment } from "./security.js";

export function validateServiceSettings(value: unknown): ServiceSettings {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ApiFailure(422, "SERVICE_SETTINGS_INVALID", "服务设置必须为对象");
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).some(
			(key) => !["publish", "maintenance"].includes(key),
		) ||
		["publish", "maintenance"].some(
			(key) => typeof data[key] !== "boolean",
		)
	)
		throw new ApiFailure(
			422,
			"SERVICE_SETTINGS_INVALID",
			"服务开关必须明确为开启或关闭，不支持保存密钥",
		);
	return {
		publish: data.publish as boolean,
		maintenance: data.maintenance as boolean,
	};
}
export async function readServiceSettings(
	store = getStore(),
	site = getSiteId(),
) {
	const state = await store.read(); assertSite(state, site);
	const row = collection(state, "entities")["service_settings:default"];
	let stored = row?.data;
	if (stored && typeof stored === "object" && !Array.isArray(stored)) {
		// Old state may still contain the retired switch. Reading never rewrites it.
		const { email: _retired, ...current } = stored as Record<string, unknown>;
		stored = current;
	}
	return row
		? {
				data: validateServiceSettings(stored),
				revision: Number(row.revision),
			}
		: {
				data: { publish: false, maintenance: false },
				revision: 0,
			};
}
export async function saveServiceSettings(
	store: FileStore,
	site: string,
	value: unknown,
	revision: number,
) {
	const data = validateServiceSettings(value);
	if (Object.values(data).some(Boolean) && !productionEnvironment(true))
		throw new ApiFailure(
			403,
			"PRODUCTION_PERMISSION_REQUIRED",
			"开发及预览环境不能开启生产服务",
		);
	return store.update((state) => {
		assertSite(state, site);
		const entities = collection(state, "entities");
		const current = entities["service_settings:default"];
		if (Number(current?.revision ?? 0) !== revision) throw new ApiFailure(409, "REVISION_CONFLICT", "服务设置已被另一操作修改，请刷新后重试");
		const now = new Date().toISOString();
		entities["service_settings:default"] = { id: "default", kind: "service_settings", data, revision: revision + 1, created_at: current?.created_at ?? now, updated_at: now };
		return { data, revision: revision + 1 };
	});
}
export async function serviceEnabled(
	service: keyof ServiceSettings,
	store?: FileStore,
	site?: string,
): Promise<boolean> {
	// Environment isolation is independent of persisted settings and checked first.
	if (!productionEnvironment(true)) return false;
	return (await readServiceSettings(store, site)).data[service];
}
