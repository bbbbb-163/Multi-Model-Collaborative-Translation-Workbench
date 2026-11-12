import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound } from "lucide-react";
import type { Identity } from "../shared/types";
import { api } from "./api";
import { BrandMark, ErrorNotice, IconButton, Spinner } from "./components";
import App from "./App";
import Admin from "./Admin";
import { notifyAuthChange, subscribeAuthChange } from "./auth-events";

type Status = { user: Identity | null; admin: boolean; needsSetup: boolean };
export default function SessionGate() {
  const adminRoute = /^\/admin\/?$/.test(location.pathname);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [credential, setCredential] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const statusVersion = useRef(0);
  const changingAuth = useRef(false);
  const refresh = async () => {
    if (changingAuth.current) return;
    const version = ++statusVersion.current;
    try {
      const next = await api<Status>("/auth/status");
      if (version === statusVersion.current) setStatus(next);
    } catch (e) {
      if (version === statusVersion.current) setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    const expired = () => {
      setStatus(null);
      void refresh();
    };
    const timer = setInterval(() => void refresh(), 15000);
    const unsubscribe = subscribeAuthChange(
      adminRoute ? "admin" : "user",
      expired,
    );
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("mstar:unauthorized", expired);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      statusVersion.current++;
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("mstar:unauthorized", expired);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  async function login(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (adminRoute && status?.needsSetup && credential !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    changingAuth.current = true;
    statusVersion.current++;
    try {
      await api(
        adminRoute
          ? status?.needsSetup
            ? "/auth/setup"
            : "/auth/admin"
          : "/auth/login",
        "POST",
        adminRoute ? { password: credential, code } : { key: credential },
      );
      setCredential("");
      setConfirm("");
      setCode("");
      setNotice("");
      changingAuth.current = false;
      notifyAuthChange(adminRoute ? "admin" : "user");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      changingAuth.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (changingAuth.current) return;
    changingAuth.current = true;
    statusVersion.current++;
    try {
      await api("/auth/logout", "POST", { admin: adminRoute });
      setStatus(null);
      notifyAuthChange(adminRoute ? "admin" : "user");
    } finally {
      changingAuth.current = false;
    }
    await refresh();
  }
  if (status && adminRoute && status.admin)
    return (
      <Admin
        onLogout={logout}
        onPasswordChanged={() => {
          statusVersion.current++;
          setCredential("");
          setConfirm("");
          setError("");
          setVisible(false);
          setNotice("密码已修改，请使用新密码重新登录。");
          setStatus({ ...status, admin: false });
          notifyAuthChange("admin");
        }}
      />
    );
  if (status && !adminRoute && status.user)
    return (
      <App key={status.user.id} identity={status.user} onLogout={logout} />
    );
  return (
    <main className="login-page">
      <div className="login-brand">
        <BrandMark size={26} />
        <strong>Mstar</strong>
      </div>
      <section className="login-content">
        {!status ? (
          <>
            <Spinner />
            <p>{error || "正在连接工作台…"}</p>
            {error && (
              <button className="text-button" onClick={() => void refresh()}>
                重新连接
              </button>
            )}
          </>
        ) : (
          <>
            <h1>
              {adminRoute
                ? status.needsSetup
                  ? "初始化管理员"
                  : "登录管理员后台"
                : "进入你的工作台"}
            </h1>
            <p>
              {adminRoute
                ? status.needsSetup
                  ? "使用启动终端中的初始化码，设置管理员密码。"
                  : "管理模型接入、上架和密钥授权。"
                : "使用管理员分发的 Mstar 密钥登录。"}
            </p>
            <form onSubmit={(e) => void login(e)}>
              {notice && (
                <p className="admin-notice" role="status">
                  {notice}
                </p>
              )}
              {adminRoute && status.needsSetup && (
                <label className="field">
                  初始化码
                  <input
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    autoComplete="off"
                    disabled={busy}
                  />
                </label>
              )}
              <label className="field">
                {adminRoute ? "管理员密码" : "Mstar 密钥"}
                <span className="password-field">
                  <input
                    aria-label={adminRoute ? "管理员密码" : "Mstar 密钥"}
                    required
                    autoFocus
                    type={visible ? "text" : "password"}
                    autoComplete={
                      adminRoute
                        ? status.needsSetup
                          ? "new-password"
                          : "current-password"
                        : "off"
                    }
                    minLength={adminRoute && status.needsSetup ? 12 : 1}
                    maxLength={200}
                    placeholder={adminRoute ? "输入管理员密码" : "mstar_…"}
                    value={credential}
                    onChange={(e) => setCredential(e.target.value)}
                    disabled={busy}
                  />
                  <IconButton
                    label={visible ? "隐藏凭证" : "显示凭证"}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconButton>
                </span>
                {adminRoute && status.needsSetup && (
                  <small>至少 12 位，建议使用独立的长密码。</small>
                )}
              </label>
              {adminRoute && status.needsSetup && (
                <label className="field">
                  确认密码
                  <input
                    required
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {error && <ErrorNotice message={error} />}
              <button className="primary-button full-width" disabled={busy}>
                {busy ? <Spinner /> : <ArrowRight size={16} />}
                {adminRoute && status.needsSetup
                  ? "设置密码并进入后台"
                  : "登录"}
              </button>
            </form>
            {!adminRoute && (
              <small className="login-note">
                <KeyRound size={13} />
                密钥无效或需要调整模型权限，请联系管理员。
              </small>
            )}
            {adminRoute && (
              <a className="login-switch" href="/">
                返回工作台
              </a>
            )}
          </>
        )}
      </section>
    </main>
  );
}
