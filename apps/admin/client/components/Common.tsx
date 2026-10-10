import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { message } from "../lib/api";
export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) { return <div className={`notice ${success ? "success" : "error"}`} role={success ? "status" : "alert"}>{success ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<div>{children}</div></div>; }
export function Loading() { return <div className="loading" role="status"><LoaderCircle size={18} className="spin"/> 正在读取服务器数据…</div>; }
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) { return <div className="page-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{action && <div className="actions">{action}</div>}</div>; }
export function Reload({ onClick }: { onClick: () => void }) { return <button className="button secondary" onClick={onClick}><RefreshCw size={16}/>刷新</button>; }
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) { return <div className="modal-backdrop" onClick={onClose}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}><div className="modal-title"><h2>{title}</h2><button aria-label="关闭" className="icon-button" onClick={onClose}><X size={20}/></button></div>{children}</section></div>; }
export function useAction() {
	const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState("");
	async function run(action: () => Promise<unknown>, done?: string) { setBusy(true); setError(""); setSuccess(""); try { await action(); if (done) setSuccess(done); return true; } catch (error) { setError(message(error)); return false; } finally { setBusy(false); } }
	return { busy, error, success, run, clear: () => { setError(""); setSuccess(""); } };
}
export function ActionStatus({ action }: { action: { error: string; success: string } }) { return <>{action.error && <Notice>{action.error}</Notice>}{action.success && <Notice success>{action.success}</Notice>}</>; }

export function useUnsavedChanges(dirty: boolean) {
	useEffect(() => {
		if (!dirty) return;
		const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		const navigate = (event: Event) => { if (!window.confirm("当前修改尚未保存。离开将丢弃这些修改，是否继续？")) event.preventDefault(); };
		window.addEventListener("beforeunload", unload); window.addEventListener("admin:before-navigate", navigate);
		return () => { window.removeEventListener("beforeunload", unload); window.removeEventListener("admin:before-navigate", navigate); };
	}, [dirty]);
}
