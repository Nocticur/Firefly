import type { MediaRecord } from "../../shared/contracts";
import { sessionToken } from "./api";

type UploadPayload = { data?: MediaRecord; error?: { message?: string } };

/**
 * Uploads one file through XMLHttpRequest so the media page can show real progress.
 * The server forwards the bytes to the image host and returns the stored media record.
 */
export function uploadMedia(file: File, onProgress?: (percentage: number) => void): Promise<MediaRecord> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", "/api/media/upload", true);
		request.setRequestHeader("X-CSRF-Token", sessionToken());
		request.upload.onprogress = (event) => {
			if (!event.lengthComputable || event.total <= 0) return;
			onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
		};
		request.onload = () => {
			let body: UploadPayload | null = null;
			try { body = JSON.parse(request.responseText) as UploadPayload; } catch { body = null; }
			if (request.status >= 200 && request.status < 300 && body?.data?.id) { onProgress?.(100); resolve(body.data); return; }
			reject(new Error(body?.error?.message || `上传失败 (HTTP ${request.status})`));
		};
		request.onerror = () => reject(new Error("上传失败，请检查网络后重试"));
		request.onabort = () => reject(new Error("上传已取消"));
		const form = new FormData();
		form.append("file", file, file.name);
		form.append("alt", "");
		form.append("caption", "");
		request.send(form);
	});
}
