import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  Check,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  TriangleAlert,
  X,
  ChevronDown,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attachment, Message } from "../shared/types";
import { api } from "./api";

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m16 3 12 7v12l-12 7-12-7V10l12-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m4 10 12 7 12-7M16 17v12M10 6.5l12 7v12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function Spinner() {
  return <LoaderCircle size={16} className="spin" aria-hidden="true" />;
}
export function ErrorNotice({
  message,
  onClose,
}: {
  message: string;
  onClose?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <TriangleAlert size={16} />
      <span>{message}</span>
      {onClose && (
        <IconButton label="关闭提示" onClick={onClose}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
export function FileView({ file }: { file: Attachment }) {
  const download = `${file.url}?download=1`;
  if (file.mime.startsWith("image/"))
    return (
      <figure className="media-image">
        <a href={file.url} target="_blank" rel="noreferrer">
          <img src={file.url} alt={file.name} loading="lazy" />
        </a>
        <figcaption>
          {file.name}
          <a href={download} download aria-label={`下载 ${file.name}`}>
            <Download size={14} />
          </a>
        </figcaption>
      </figure>
    );
  if (file.mime.startsWith("video/"))
    return (
      <figure className="media-player">
        <video src={file.url} controls preload="metadata" />
        <figcaption>
          <a href={download} download>
            {file.name} <Download size={13} />
          </a>
        </figcaption>
      </figure>
    );
  if (file.mime.startsWith("audio/"))
    return (
      <figure className="media-player">
        <audio src={file.url} controls preload="metadata" />
        <figcaption>
          <a href={download} download>
            {file.name} <Download size={13} />
          </a>
        </figcaption>
      </figure>
    );
  return (
    <a className="file-item" href={download} download>
      <FileText size={20} />
      <span>
        <strong>{file.name}</strong>
        <small>
          {file.size < 1024
            ? `${file.size} B`
            : `${(file.size / 1024).toFixed(1)} KB`}
        </small>
      </span>
      <Download size={15} />
    </a>
  );
}
function CodeBlock({ className, children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  if (!className && !String(children).includes("\n"))
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    );
  const code = String(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div>
        <span>{className?.replace("language-", "") || "代码"}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}
export function MessageView({ message: m }: { message: Message }) {
  const [copied, setCopied] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState<Message["confirmation"]>();
  const [answerError, setAnswerError] = useState("");
  const confirmation = answer || m.confirmation;
  async function confirm(accept: boolean) {
    if (answering || confirmation?.state !== "pending") return;
    setAnswering(true);
    setAnswerError("");
    try {
      const updated = await api<Message>(
        `/tasks/${m.taskId}/confirmations/${m.id}`,
        "POST",
        { accept },
      );
      setAnswer(updated.confirmation);
    } catch (e) {
      setAnswerError((e as Error).message);
    } finally {
      setAnswering(false);
    }
  }
  const copy = () => {
    void navigator.clipboard.writeText(m.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  if (m.role === "activity")
    return (
      <details className="activity-item">
        <summary>
          <span className="activity-dot" />
          {m.model ? <strong>{m.model}</strong> : <span>协作记录</span>}
          <span className="activity-preview">{m.content}</span>
          <ChevronDown size={13} />
        </summary>
        <p>{m.content}</p>
      </details>
    );
  if (m.role === "error") return <ErrorNotice message={m.content} />;
  return (
    <article
      className={`message message-${m.role} ${m.status === "running" ? "streaming" : ""}`}
    >
      {m.role === "assistant" && (
        <div className="message-heading">
          <span className="model-avatar">
            <BrandMark size={17} />
          </span>
          <strong>{m.model || "模型"}</strong>
          {m.stage && <span>{m.stage}</span>}
          {m.status === "running" && <Spinner />}
          {m.status === "error" && (
            <span className="danger-text">调用失败</span>
          )}
          {m.status === "cancelled" && <span>已停止</span>}
        </div>
      )}
      <div className="message-content">
        {m.content ? (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              code: CodeBlock,
              pre: ({ children }) => <>{children}</>,
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {m.content}
          </Markdown>
        ) : m.status === "running" ? (
          <div className="waiting-text">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            等待模型响应
          </div>
        ) : null}
      </div>
      {confirmation && (
        <div className="input-confirmation" aria-live="polite">
          {confirmation.state === "pending" ? (
            <div
              className="input-confirmation-actions"
              role="group"
              aria-label="是否仅使用支持的输入开始任务"
            >
              <button
                type="button"
                className="primary-button"
                disabled={answering}
                onClick={() => void confirm(true)}
              >
                {answering && <Spinner />}
                {confirmation.acceptLabel}
              </button>
              <button
                type="button"
                className="outline-button"
                disabled={answering}
                onClick={() => void confirm(false)}
              >
                否，暂不开始
              </button>
            </div>
          ) : (
            <p className="small-note">
              {confirmation.state === "accepted"
                ? "已确认，仅使用支持的输入。"
                : confirmation.state === "rejected"
                  ? "已取消本次调用。"
                  : confirmation.state === "expired"
                    ? "确认已超时，请重新发送任务。"
                    : "本次确认已取消，请重新发送任务。"}
            </p>
          )}
          {answerError && (
            <ErrorNotice
              message={answerError}
              onClose={() => setAnswerError("")}
            />
          )}
        </div>
      )}
      {!!m.attachments.length && (
        <div className="message-files">
          {m.attachments.map((a) => (
            <FileView key={a.id} file={a} />
          ))}
        </div>
      )}
      {m.role === "assistant" && m.status !== "running" && (
        <div className="message-actions">
          <IconButton label={copied ? "已复制" : "复制消息"} onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
          {m.usage && (
            <span title="服务返回的 Token 用量">
              {m.usage.inputTokens ?? "—"} 输入 · {m.usage.outputTokens ?? "—"}{" "}
              输出
            </span>
          )}
        </div>
      )}
    </article>
  );
}
