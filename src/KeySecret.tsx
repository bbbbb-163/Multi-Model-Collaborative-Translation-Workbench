import { useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import type { AdminAccessKey } from "../shared/types";
import { api } from "./api";
import { ErrorNotice, Spinner } from "./components";

export default function KeySecret({
  id,
  canReveal,
  initialSecret,
  disabled,
  onChanged,
}: {
  id: string;
  canReveal: boolean;
  initialSecret: string;
  disabled: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [secret, setSecret] = useState(initialSecret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function reveal() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const value = await api<{ secret: string }>(
        `/admin/keys/${id}/secret`,
        "POST",
        {},
      );
      setSecret(value.secret);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rotate() {
    setBusy(true);
    setError("");
    try {
      const value = await api<{ key: AdminAccessKey; secret: string }>(
        `/admin/keys/${id}/rotate`,
        "POST",
        {},
      );
      setSecret(value.secret);
      setConfirm(false);
      setCopied(false);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="key-secret" aria-label="完整分发密钥">
      <h3>完整密钥</h3>
      <p className="small-note">
        {canReveal
          ? "密钥已加密保存，仅管理员可查看。用户遗失时可在这里重新复制。"
          : "此旧密钥未保存可恢复副本。用户再次成功登录可补存；已经遗失时可重新生成。"}
      </p>
      {error && <ErrorNotice message={error} />}
      {secret && <code className="key-secret-value">{secret}</code>}
      <div className="key-inline-actions">
        <button
          type="button"
          className="outline-button"
          disabled={busy || disabled}
          onClick={() => {
            if (secret) {
              setSecret("");
              setCopied(false);
            } else void reveal();
          }}
        >
          {busy ? (
            <Spinner />
          ) : secret ? (
            <EyeOff size={15} />
          ) : (
            <Eye size={15} />
          )}
          {secret ? "隐藏密钥" : "查看完整密钥"}
        </button>
        {secret && (
          <button
            type="button"
            className="outline-button"
            disabled={busy || disabled}
            aria-label="复制完整密钥"
            onClick={() =>
              void navigator.clipboard
                .writeText(secret)
                .then(() => setCopied(true))
                .catch(() => setError("复制失败，请手动选择并复制密钥。"))
            }
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
            {copied ? "已复制" : "复制密钥"}
          </button>
        )}
        {!confirm && (
          <button
            type="button"
            className="text-button"
            disabled={busy || disabled}
            onClick={() => setConfirm(true)}
          >
            <RefreshCw size={14} />
            重新生成密钥
          </button>
        )}
      </div>
      {confirm && (
        <div
          className="key-rotation-confirm"
          role="group"
          aria-label="确认重新生成密钥"
        >
          <p>
            旧密钥将立即失效，已登录用户需重新登录，正在执行的任务会停止。已保存的模型授权、历史记录和用量会保留。
          </p>
          <div className="key-inline-actions">
            <button
              type="button"
              className="outline-button danger-text"
              disabled={busy || disabled}
              onClick={() => void rotate()}
            >
              {busy ? <Spinner /> : <RefreshCw size={14} />}确认重新生成
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || disabled}
              onClick={() => setConfirm(false)}
            >
              取消重新生成
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
