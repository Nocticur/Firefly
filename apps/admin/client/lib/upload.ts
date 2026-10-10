import { upload } from "@vercel/blob/client";
import type { MediaRecord } from "../../shared/contracts";
import { request, sessionToken, write } from "./api";
export async function uploadMedia(file: File, onProgress?: (percentage: number) => void) {
	const result = await write<{ id: string; pathname: string }>("/media/intents", { name: file.name, contentType: file.type || "application/octet-stream", size: file.size });
	const blob = await upload(result.data.pathname, file, { access: "private", handleUploadUrl: "/api/media/upload", clientPayload: JSON.stringify({ intentId: result.data.id, csrfToken: sessionToken() }), multipart: file.size > 5 * 1024 * 1024, onUploadProgress: event => onProgress?.(event.percentage) });
	for (let attempt = 0; attempt < 12; attempt++) {
		const media = await request<MediaRecord[]>("/media");
		if (media.data.some(item => item.id === result.data.id)) return { id: result.data.id, blob };
		if (attempt < 11) await new Promise(resolve => window.setTimeout(resolve, 1000));
	}
	throw new Error("文件已直传，但服务器核验尚未完成。请刷新媒体库检查上传回调后再使用资源。");
}
