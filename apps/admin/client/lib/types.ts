export type Comment = { id: string; articleId: string; parentId: string | null; name: string; body: string; status: string; createdAt: string; visitorId: string };
export type Ban = { id: string; subject: string; reason?: string; createdAt: string };
export type Friend = { id: string; name: string; url: string; description: string; avatar?: string; email?: string; status: string; group: string; sortOrder: number; rejectionReason?: string; publishedAt?: string };
export type MailRecord = { id: string; kind?: string; state?: string; status?: string; attempts?: number; recipient?: string; lastError?: string; createdAt: string };

export function statusLabel(state: string) {
	return ({ visible: "已显示", published: "已上线", deleted: "已删除", pending: "待审核", approved: "已通过", rejected: "已拒绝", queued: "等待执行", frozen: "快照已冻结", committing: "提交中", deploying: "构建部署中", verifying: "生产核验中", verified: "已核验完成", running: "执行中", failed: "执行失败", conflict: "外部内容冲突", unknown: "结果待核查", waiting: "等待执行", sending: "发送中", sent: "已发送（服务商已接受）", blocked: "已暂停", retry: "等待重试", delivered: "已送达", bounced: "退信", complained: "收到投诉" } as Record<string, string>)[state] ?? state;
}
