import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { BookOpen, LayoutDashboard, Settings2, ListTree, Image, MessageSquare, Link2, Rocket, LogOut, Menu, Moon, Wrench } from "lucide-react";
import type { AdminSession } from "../shared/contracts";
import { configureSession, RequestError, request, write, message } from "./lib/api";
import { Loading, Notice } from "./components/Common";
import { EntryPage } from "./components/EntryPage";
import { Dashboard } from "./pages/Dashboard";
const Posts = lazy(() => import("./pages/Posts").then(module => ({ default: module.Posts })));
const Settings = lazy(() => import("./pages/Settings").then(module => ({ default: module.Settings })));
const Services = lazy(() => import("./pages/Services").then(module => ({ default: module.Services })));
const Navigation = lazy(() => import("./pages/Navigation").then(module => ({ default: module.Navigation })));
const Media = lazy(() => import("./pages/Media").then(module => ({ default: module.Media })));
const Moderation = lazy(() => import("./pages/Moderation").then(module => ({ default: module.Moderation })));
const Releases = lazy(() => import("./pages/Operations").then(module => ({ default: module.Releases })));
const Maintenance = lazy(() => import("./pages/Operations").then(module => ({ default: module.Maintenance })));
const items = [
	{ id: "dashboard", label: "仪表盘", icon: LayoutDashboard }, { id: "posts", label: "文章与历史", icon: BookOpen },
	{ id: "settings", label: "站点设置", icon: Settings2 }, { id: "services", label: "服务设置", icon: Wrench }, { id: "navigation", label: "导航与图标", icon: ListTree },
	{ id: "media", label: "媒体库", icon: Image }, { id: "comments", label: "评论管理", icon: MessageSquare },
	{ id: "friends", label: "友链", icon: Link2 }, { id: "releases", label: "发布任务", icon: Rocket }, { id: "maintenance", label: "维护与备份", icon: Wrench },
];
function readPage() { return location.hash.slice(1).split("?")[0] || "dashboard"; }
export function App() {
	const [session, setSession] = useState<AdminSession | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
	const [page, setPage] = useState(readPage); const [open, setOpen] = useState(false);
	const lastHash = useRef(location.hash);
	async function loadSession() { setLoading(true); setError(""); try { const result = await request<AdminSession>("/auth/session"); configureSession(result.data.csrfToken); setSession(result.data); } catch (error) { if (error instanceof RequestError && error.status === 401) { configureSession(""); setSession(null); } else setError(message(error)); } finally { setLoading(false); } }
	useEffect(() => { void loadSession(); const onHash = () => { const permission = new Event("admin:before-navigate", { cancelable: true }); if (!window.dispatchEvent(permission)) { history.replaceState(null, "", lastHash.current || "#dashboard"); return; } lastHash.current = location.hash; setPage(readPage()); setOpen(false); window.dispatchEvent(new Event("admin:navigated")); }; window.addEventListener("hashchange", onHash); return () => window.removeEventListener("hashchange", onHash); }, []);
	async function logout() { if (!window.dispatchEvent(new Event("admin:before-navigate", { cancelable: true }))) return; try { await write("/auth/logout"); configureSession(""); setSession(null); } catch (error) { setError(message(error)); } }
	if (!session) return <EntryPage loading={loading} serviceError={error} onRetry={loadSession} onUnlocked={loadSession} />;
	return <div className="shell"><aside className={`sidebar ${open ? "open" : ""}`}><a className="brand" href="#dashboard"><div className="brand-icon"><Moon size={22}/></div><span>Nocticur<small>FIREFLY · 管理后台</small></span></a><div className="sidebar-label">工作空间</div><nav aria-label="后台导航">{items.map(item => <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined} className={page === item.id ? "active" : ""}><item.icon size={18}/>{item.label}</a>)}</nav><div className="sidebar-bottom"><a href="/" target="_blank" rel="noreferrer">访问博客 ↗</a><div className="environment"><span className="status-dot"/>{session.environment === "production" ? "生产环境" : session.environment === "preview" ? "预览环境" : "开发环境"}</div><small>Asia / Shanghai</small></div></aside>{open && <button className="sidebar-overlay" aria-label="关闭导航" onClick={() => setOpen(false)}/>}<div className="workspace"><header className="topbar"><button className="icon-button menu-button" aria-label="打开导航" onClick={() => setOpen(!open)}><Menu size={22}/></button><span className="breadcrumb">工作空间 <span>/</span> {items.find(item => item.id === page)?.label ?? "仪表盘"}</span><div className="account">{session.user.avatarUrl && <img src={session.user.avatarUrl} alt=""/>}<span>{session.user.name || session.user.login}</span><button className="icon-button" onClick={() => void logout()} aria-label="退出登录"><LogOut size={18}/></button></div></header><main className="main">{error && <Notice>{error}</Notice>}{!session.productionPublish && <div className="environment-notice">生产发布尚未开启；可在生产环境的服务设置中启用。</div>}<Suspense fallback={<Loading/>}>{page === "dashboard" ? <Dashboard/> : page === "posts" ? <Posts/> : page === "settings" ? <Settings/> : page === "services" ? <Services production={session.environment === "production"} onSaved={loadSession}/> : page === "navigation" ? <Navigation/> : page === "media" ? <Media/> : page === "comments" || page === "friends" ? <Moderation kind={page}/> : page === "releases" ? <Releases canPublish={session.productionPublish}/> : page === "maintenance" ? <Maintenance/> : <Dashboard/>}</Suspense></main><footer className="workspace-footer">Nocticur · 向 夜 驰 行 ， 不 问 喧 嚣<span>站点内容需显式发布；服务设置保存后立即生效。</span></footer></div></div>;
}
