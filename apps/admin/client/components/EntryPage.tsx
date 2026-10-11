import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Github, KeyRound, LockKeyhole, Moon, ShieldCheck, Sparkles, Sun } from "lucide-react";
import avatar from "../assets/nocticur-avatar.webp";
import { message, request, write } from "../lib/api";
import { Loading } from "./Common";
import "./entry.css";

type Props = { loading: boolean; serviceError: string; onRetry: () => Promise<void>; onUnlocked: () => Promise<void> };

export function EntryPage({ loading, serviceError, onRetry, onUnlocked }: Props) {
	const [verified, setVerified] = useState(false);
	const [checking, setChecking] = useState(true);
	const [password, setPassword] = useState("");
	const [visible, setVisible] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [available, setAvailable] = useState(false);
	const [capsLock, setCapsLock] = useState(false);
	const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	const input = useRef<HTMLInputElement>(null);

	async function checkEntry() {
		setChecking(true); setError("");
		try {
			const result = await request<{ verified: boolean }>("/auth/entry");
			setVerified(result.data.verified); setAvailable(true);
		} catch (error) { setError(message(error)); setAvailable(false); }
		finally { setChecking(false); }
	}
	useEffect(() => { void checkEntry(); }, []);
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy || !password) return;
		setBusy(true); setError(""); setCapsLock(false);
		const submitted = password;
		setPassword(""); setVisible(false);
		try {
			await write("/auth/entry", { password: submitted });
			setVerified(true);
			await onUnlocked();
		} catch (error) { setError(message(error)); input.current?.focus(); }
		finally { setBusy(false); }
	}
	async function retry() { await Promise.all([checkEntry(), onRetry()]); }
	const displayedError = error || serviceError;
	const pending = checking || loading;

	return <main className="entry-screen" data-entry-theme={dark ? "dark" : "light"}>
		<div className="entry-glow entry-glow-mint" aria-hidden="true" />
		<div className="entry-glow entry-glow-pink" aria-hidden="true" />
		<header className="entry-topbar">
			<a className="entry-back" href="https://blog.mourn.top/"><ArrowLeft size={16} />返回博客</a>
			<button className="entry-theme" type="button" onClick={() => setDark(!dark)} aria-label={dark ? "切换浅色主题" : "切换深色主题"}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
		</header>
		<section className="entry-card" aria-labelledby="entry-title">
			<div className="entry-story">
				<div className="entry-story-top"><span className="entry-firefly"><Sparkles size={15} /> FIREFLY</span><span className="entry-story-caption">属于夜幕之人</span></div>
				<div className="entry-portrait"><span className="entry-orbit" aria-hidden="true" /><img src={avatar} alt="Nocticur 的头像" width="112" height="112" /><span className="entry-portrait-star" aria-hidden="true"><Sparkles size={21} /></span></div>
				<p className="entry-author">Nocticur<span>的创作空间</span></p>
				<blockquote className="entry-poem"><p>向 夜 驰 行 ， 不 问 喧 嚣</p><p>身 沉 暮 色 ， 心 赴 归 途</p></blockquote>
				<div className="entry-story-bottom"><span aria-hidden="true" /><span>记录 · 思考 · 生长</span></div>
			</div>
			<div className="entry-content">
				<div className="entry-private"><LockKeyhole size={13} /> PRIVATE WORKSPACE</div>
				<h1 id="entry-title">{verified ? "欢迎回到夜幕" : "后台管理"}</h1>
				<p className="entry-description">{verified ? "密码已验证。再确认 GitHub 身份，即可进入你的创作空间。" : "输入管理密码，继续书写属于你的故事。"}</p>
				<ol className="entry-steps" aria-label="登录步骤"><li className={verified ? "complete" : "current"} aria-current={!verified ? "step" : undefined}><span>{verified ? <Check size={12} /> : "1"}</span>管理密码</li><li aria-hidden="true" className="entry-step-line" /><li className={verified ? "current" : ""} aria-current={verified ? "step" : undefined}><span>2</span>GitHub 验证</li></ol>
				<div className="entry-form-area" aria-busy={pending || busy}>
					{pending ? <Loading /> : <>
						{displayedError && <div className="entry-error" role="alert" id="entry-error">{displayedError}</div>}
						{available && !verified && <form onSubmit={(event) => void submit(event)}>
							<label className="entry-label" htmlFor="entry-password">管理密码</label>
							<div className="entry-password-field"><KeyRound size={18} aria-hidden="true" /><input ref={input} id="entry-password" name="password" type={visible ? "text" : "password"} value={password} onChange={(event) => { setPassword(event.target.value); if (error) setError(""); }} onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} placeholder="请输入管理密码" autoComplete="current-password" autoCapitalize="none" spellCheck={false} required maxLength={256} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? "entry-error" : "entry-password-help"} /><button type="button" className="entry-reveal" onClick={() => setVisible(!visible)} aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} disabled={busy}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
							<p className="entry-password-help" id="entry-password-help">{capsLock ? "大写锁定已开启" : "验证通过后，继续确认管理员身份。"}</p>
							<button className="entry-primary" type="submit" disabled={busy || !password}>{busy ? "正在验证…" : "验证密码"}<ArrowRight size={18} /></button>
						</form>}
						{available && verified && <div className="entry-verified"><p className="entry-unlocked"><ShieldCheck size={17} />管理密码已通过验证</p><a className="entry-primary" href="/api/auth/github"><Github size={19} />使用 GitHub 验证身份<ArrowRight size={17} /></a></div>}
						{(!available || serviceError) && <button className="entry-retry" type="button" onClick={() => void retry()}>重新检查服务</button>}
					</>}
				</div>
				<p className="entry-security"><ShieldCheck size={14} />仅供站点管理员使用</p>
			</div>
		</section>
		<footer className="entry-footer">Nocticur 的博客<span>让每一次记录，都有归处。</span></footer>
	</main>;
}
