import { sleep } from "workflow";

async function maintain(taskId: string): Promise<{ done: boolean; state: string }> {
	"use step";
	const { processMaintenanceTask } = await import("../server/maintenance.js");
	return processMaintenanceTask(taskId);
}
export async function maintenanceWorkflow(taskId: string): Promise<{ done: boolean; state: string }> {
	"use workflow";
	for (let attempt = 0; attempt < 120; attempt++) {
		const result = await maintain(taskId);
		if (result.done) return result;
		await sleep("30s");
	}
	return { done: false, state: "queued" };
}
