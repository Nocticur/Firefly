import { ApiFailure, runtimeEnvironment } from "./security.js";
export function blobToken(access: "private" | "public"): string {
	const environment = runtimeEnvironment();
	const key =
		environment === "production"
			? `BLOB_${access.toUpperCase()}_READ_WRITE_TOKEN`
			: `ADMIN_${environment === "preview" ? "PREVIEW" : "DEV"}_${access.toUpperCase()}_BLOB_TOKEN`;
	const token = process.env[key];
	if (!token)
		throw new ApiFailure(
			503,
			"BLOB_CONFIGURATION_REQUIRED",
			`缺少隔离文件存储配置 ${key}`,
		);
	const storeId = (value?: string) =>
		value?.startsWith("vercel_blob_rw_") ? value.split("_")[3] : undefined;
	if (
		environment !== "production" &&
		[
			process.env.BLOB_PRIVATE_READ_WRITE_TOKEN,
			process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
		].some(
			(production) =>
				production === token ||
				Boolean(storeId(token) && storeId(production) === storeId(token)),
		)
	)
		throw new ApiFailure(
			503,
			"BLOB_ENVIRONMENT_NOT_ISOLATED",
			"开发及预览文件存储必须与生产隔离",
		);
	const peer =
		process.env[
			key.replace(
				access.toUpperCase(),
				access === "private" ? "PUBLIC" : "PRIVATE",
			)
		];
	if (
		peer === token ||
		Boolean(storeId(token) && storeId(peer) === storeId(token))
	)
		throw new ApiFailure(
			503,
			"BLOB_STORES_NOT_SEPARATE",
			"私有与公开文件必须使用不同存储",
		);
	return token;
}
