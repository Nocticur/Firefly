import { useState } from "react";
import { Save } from "lucide-react";
import type { ServiceSettings } from "../../shared/service-settings";
import { write } from "../lib/api";
import { useData } from "../lib/use-data";
import {
	ActionStatus,
	Loading,
	Notice,
	PageHeader,
	Reload,
	useAction,
	useUnsavedChanges,
} from "../components/Common";

const services = [
	{
		key: "publish",
		label: "生产发布",
		description:
			"允许发布已保存的内容到正式博客。开启后，仍需在发布任务中手动发布。",
	},
	{
		key: "maintenance",
		label: "生产维护",
		description:
			"允许创建备份、执行恢复和定时维护。恢复仍需单独确认；定时维护需要配置 Cron 密钥。",
	},
] as const;

export function Services({
	production,
	onSaved,
}: {
	production: boolean;
	onSaved: () => Promise<void>;
}) {
	const settings = useData<ServiceSettings>("/service-settings");
	const [draft, setDraft] = useState<ServiceSettings | null>(null);
	const action = useAction();
	const data = draft ?? settings.data;
	const dirty = Boolean(
		draft && JSON.stringify(draft) !== JSON.stringify(settings.data),
	);
	useUnsavedChanges(dirty);
	async function save() {
		await write(
			"/service-settings",
			{ data, expectedRevision: settings.revision },
			"PUT",
		);
		setDraft(null);
		await settings.reload();
		await onSaved();
	}
	return (
		<>
			<PageHeader
				title="服务设置"
				subtitle="生产发布和维护默认关闭。保存后立即生效，无需重新部署。"
				action={
					<button
						className="button"
						disabled={action.busy || settings.loading || !data || !dirty}
						onClick={() =>
							void action.run(
								save,
								"服务设置已生效。关闭开关不会撤回已经完成的操作。",
							)
						}
					>
						<Save size={16} />
						保存服务设置
					</button>
				}
			/>
			<ActionStatus action={action} />
			{settings.error && (
				<>
					<Notice>{settings.error}</Notice>
					<Reload
						onClick={() => {
							setDraft(null);
							void settings.reload();
						}}
					/>
				</>
			)}
			{!production && (
				<div className="environment-notice">
					开发和预览环境无法开启生产服务。
				</div>
			)}
			{settings.loading ? (
				<Loading />
			) : (
				data && (
					<div className="settings-grid">
						{services.map(({ key, label, description }) => (
							<section className="panel form-panel" key={key}>
								<h2>{label}</h2>
								<label className="check-field">
									<input
										type="checkbox"
										aria-describedby={`service-${key}-description`}
										checked={data[key]}
										disabled={action.busy || (!production && !data[key])}
										onChange={(event) =>
											setDraft({ ...data, [key]: event.target.checked })
										}
									/>
									{data[key] ? "已开启" : "已关闭"} · {label}
								</label>
								<p className="panel-note" id={`service-${key}-description`}>
									{description}
								</p>
							</section>
						))}
					</div>
				)
			)}
		</>
	);
}
