import { sleep } from "workflow";

async function reconcilePublish(taskId: string): Promise<{ done: boolean; state: string }> {
	"use step";
	const { processReleaseTask } = await import("../server/releases.js");
	return processReleaseTask(taskId);
}
export async function publishWorkflow(taskId: string): Promise<{ done: boolean; state: string }> {
	"use workflow";
	for (let attempt = 0; attempt < 1440; attempt++) {
		const result = await reconcilePublish(taskId);
		if (result.done || result.state === "blocked") return result;
		await sleep("1m");
	}
	// An unresolved task stays durable and blocked; manual/cron reconciliation may resume it.
	return { done: false, state: "unknown" };
}
