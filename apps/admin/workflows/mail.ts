import { sleep } from "workflow";
import { deliverMail } from "../server/mail.js";

async function deliverStep(id: string) {
	"use step";
	return deliverMail(id);
}

export async function mailWorkflow(notificationId: string): Promise<string> {
	"use workflow";
	for (let attempt = 0; attempt < 8; attempt++) {
		const result = await deliverStep(notificationId);
		if (result.state !== "pending" || !result.retryAfterMs) return result.state;
		await sleep(`${Math.ceil(result.retryAfterMs / 1000)}s`);
	}
	return "pending";
}
