import { useState } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Link2,
  Trash2,
  ChevronDown,
  Plus,
  Check,
} from "lucide-react";
import type {
  Provider,
  Protocol,
  Model,
  Capability,
  CustomCapability,
} from "../shared/types";
import { api } from "./api";
import { IconButton, Spinner, ErrorNotice } from "./components";
import Select from "./Select";

export default function ProviderForm({
  provider,
  capabilities,
  onClose,
  onSaved,
  onDeleted,
  admin = false,
}: {
  provider?: Provider;
  capabilities: Capability[];
  onClose: () => void;
  onSaved: (p: Provider) => void;
  onDeleted: () => void;
  admin?: boolean;
}) {
  const endpoint = admin ? "/admin/providers" : "/providers";
  const [url, setUrl] = useState(provider?.url || "");
  const [name, setName] = useState(provider?.name || "");
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [protocol, setProtocol] = useState<Protocol | "">(
    provider?.protocol || "",
  );
  const [ids, setIds] = useState("");
  const [custom, setCustom] = useState(
    provider?.customCapabilities.length
      ? JSON.stringify(provider.customCapabilities, null, 2)
      : "",
  );
  const [models, setModels] = useState<Model[]>(provider?.models || []);
  const [inputRules, setInputRules] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filter, setFilter] = useState("");
  const extra: Capability[] = [];
  try {
    for (const c of JSON.parse(custom || "[]"))
      extra.push({ id: c.id, label: c.label, description: "", input: "any" });
  } catch {}
  const allCapabilities = [...capabilities, ...extra];
  async function save() {
    setBusy(true);
    setError("");
    try {
      const customCapabilities: CustomCapability[] = JSON.parse(custom || "[]");
      if (provider) {
        const savedModels = admin
          ? models.map((m) => {
              if (!(m.id in inputRules)) return m;
              let inputConstraints: Model["inputConstraints"];
              try {
                inputConstraints = inputRules[m.id].trim()
                  ? JSON.parse(inputRules[m.id])
                  : undefined;
              } catch {
                throw new Error(
                  `模型「${m.name}」的输入限制需要填写有效 JSON。`,
                );
              }
              return { ...m, inputConstraints, source: "manual" as const };
            })
          : models;
        const added = ids
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((id) => !models.some((m) => m.id === id))
          .map((id) => ({
            id,
            name: id,
            source: "manual" as const,
            capabilities: ["text"],
          }));
        onSaved(
          await api<Provider>(`${endpoint}/${provider.id}`, "PATCH", {
            name,
            url,
            ...(key ? { key } : {}),
            protocol: protocol || undefined,
            models: admin ? [...savedModels, ...added] : models,
            ...(!admin
              ? {
                  manualIds: ids
                    .split(/[,\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : {}),
            customCapabilities,
          }),
        );
      } else
        onSaved(
          await api<Provider>(endpoint, "POST", {
            url,
            key,
            name: name || undefined,
            protocol: protocol || undefined,
            manualIds: ids
              ? ids
                  .split(/[,\n]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
            customCapabilities,
          }),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!provider) return;
    setBusy(true);
    setError("");
    try {
      const p = await api<Provider>(`${endpoint}/${provider.id}`, "PATCH", {
        refresh: true,
        url,
        protocol: protocol || undefined,
        ...(key ? { key } : {}),
      });
      setModels(p.models);
      setInputRules({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connection-form">
      <div className="drawer-heading">
        <IconButton label="返回模型列表" onClick={onClose}>
          <ArrowLeft size={19} />
        </IconButton>
        <h2>{provider ? (admin ? provider.name : "管理连接") : "添加连接"}</h2>
      </div>
      <form
        className="connection-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="connection-intro">
          {!admin && (
            <span className="connection-icon">
              <Link2 size={23} />
            </span>
          )}
          {!admin && <h3>{provider ? provider.name : "连接你的模型服务"}</h3>}
          <p>
            {provider
              ? admin
                ? "更新凭据、刷新模型或调整能力。"
                : "更新凭据或刷新模型列表。"
              : "填写 API 地址和 Key，自动获取这个服务下可用的模型。"}
          </p>
        </div>
        <label className="field">
          API 地址
          <input
            aria-label="API 地址"
            required
            type="url"
            placeholder="https://api.example.com/v1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="url"
            disabled={busy}
          />
          <small>支持基础地址，也可粘贴完整对话接口地址。</small>
        </label>
        <label className="field">
          API Key {provider && <span className="optional">留空保留原 Key</span>}
          <span className="password-field">
            <input
              aria-label="API Key"
              type={visible ? "text" : "password"}
              placeholder={
                provider?.hasKey ? provider.keyHint : "sk-…（本地服务可留空）"
              }
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
            <IconButton
              label={visible ? "隐藏 Key" : "显示 Key"}
              onClick={() => setVisible(!visible)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
          </span>
        </label>
        <details className="advanced-settings">
          <summary>
            高级设置<span>可选</span>
            <ChevronDown size={14} />
          </summary>
          <div>
            <label className="field">
              连接名称
              <input
                placeholder="自动使用服务域名"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              接口协议
              <Select
                aria-label="接口协议"
                value={protocol}
                onChange={(value) => setProtocol(value as Protocol | "")}
              >
                <option value="">自动识别</option>
                <option value="compatible">
                  OpenAI 兼容 · Chat Completions
                </option>
                <option value="openai">OpenAI · Responses</option>
                <option value="anthropic">Anthropic · Messages</option>
                <option value="google">Google · Gemini</option>
              </Select>
              <small>转发平台默认使用兼容协议；原生私有代理可手动指定。</small>
            </label>
            <label className="field">
              {provider ? "补充模型 ID" : "手动模型 ID"}
              <textarea
                rows={2}
                placeholder="服务不提供模型列表时填写，每行一个"
                value={ids}
                onChange={(e) => setIds(e.target.value)}
              />
            </label>
            {admin && (
              <label className="field">
                扩展能力定义{" "}
                <textarea
                  className="json-field"
                  rows={6}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder={
                    '[{"id":"my-action","label":"自定义能力","path":"/generate","body":{"model":"{{model}}","prompt":"{{prompt}}"},"resultPath":"output","output":"text"}]'
                  }
                />
                <small>
                  使用相对路径。支持 {"{{model}}"}、{"{{prompt}}"}、
                  {"{{files}}"} 与异步轮询。详见项目 README。
                </small>
              </label>
            )}
          </div>
        </details>
        {provider && (
          <section className="model-capability-editor">
            <div className="section-row">
              <h3>
                {admin ? "模型与能力" : "连接模型"} <span>{models.length}</span>
              </h3>
              <button
                type="button"
                className="text-button"
                onClick={() => void refresh()}
                disabled={busy}
              >
                刷新列表
              </button>
            </div>
            <input
              aria-label={admin ? "筛选需要配置的模型" : "搜索连接中的模型"}
              placeholder="搜索模型…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <p className="small-note">
              {admin
                ? "名称推断的能力需要确认。按服务文档调整后保存。"
                : "根据模型信息识别能力，使用时自动匹配。"}
            </p>
            <div className="capability-model-list">
              {models
                .filter((m) =>
                  `${m.id} ${m.name}`
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((m) =>
                  admin ? (
                    <details key={m.id}>
                      <summary>
                        <span title={m.id}>{m.name}</span>
                        <small>
                          {m.source === "manual"
                            ? "已设置"
                            : m.source === "metadata"
                              ? "服务声明"
                              : "名称推断"}
                        </small>
                        <ChevronDown size={13} />
                      </summary>
                      <div className="capability-options">
                        {allCapabilities.map((c) => (
                          <label key={c.id}>
                            <input
                              type="checkbox"
                              checked={m.capabilities.includes(c.id)}
                              onChange={(e) =>
                                setModels((ms) =>
                                  ms.map((x) =>
                                    x.id === m.id
                                      ? {
                                          ...x,
                                          source: "manual",
                                          capabilities: e.target.checked
                                            ? [...x.capabilities, c.id]
                                            : x.capabilities.filter(
                                                (id) => id !== c.id,
                                              ),
                                        }
                                      : x,
                                  ),
                                )
                              }
                            />
                            {c.label}
                          </label>
                        ))}
                        <button
                          type="button"
                          className="text-button danger-text"
                          onClick={() =>
                            setModels((ms) => ms.filter((x) => x.id !== m.id))
                          }
                        >
                          移除模型
                        </button>
                      </div>
                      <details className="model-input-constraints">
                        <summary>输入限制（可选）</summary>
                        <label>
                          输入限制 JSON · {m.name}
                          <textarea
                            value={
                              inputRules[m.id] ??
                              (m.inputConstraints
                                ? JSON.stringify(m.inputConstraints, null, 2)
                                : "")
                            }
                            rows={5}
                            spellCheck={false}
                            placeholder={
                              '{"video":{"accepted":["image"],"required":["image"]}}'
                            }
                            onChange={(e) =>
                              setInputRules((old) => ({
                                ...old,
                                [m.id]: e.target.value,
                              }))
                            }
                          />
                        </label>
                        <p className="small-note">
                          仅在服务明确限制输入时填写。按能力 ID 配置
                          accepted（支持）和 required（必需），可用
                          text、image、audio、video、file。用户输入超出范围时会先确认，不会直接丢弃。留空使用服务声明或适配器规则，不根据模型名称猜测文字支持。
                        </p>
                      </details>
                    </details>
                  ) : (
                    <div className="readonly-provider-model" key={m.id}>
                      <div>
                        <strong>{m.name}</strong>
                        <small>
                          {m.capabilities
                            .map(
                              (id) =>
                                allCapabilities.find((c) => c.id === id)
                                  ?.label || id,
                            )
                            .join(" · ")}
                        </small>
                      </div>
                      <IconButton
                        label={`移除模型 ${m.name}`}
                        disabled={busy}
                        onClick={() =>
                          setModels((ms) => ms.filter((x) => x.id !== m.id))
                        }
                      >
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  ),
                )}
            </div>
          </section>
        )}
        {error && <ErrorNotice message={error} />}
        <button
          className="primary-button full-width"
          disabled={busy || !url.trim()}
          type="submit"
        >
          {busy ? (
            <>
              <Spinner />
              正在连接…
            </>
          ) : provider ? (
            <>
              <Check size={16} />
              保存连接
            </>
          ) : (
            <>
              <Plus size={16} />
              连接并获取模型
            </>
          )}
        </button>
        <p className="privacy-note">
          Key 加密保存在服务端，不会写入浏览器存储。
          {admin && "修改连接后，相关模型需要重新测试和上架。"}
        </p>
        {provider &&
          (confirmDelete ? (
            <div className="delete-confirm">
              <p>删除连接后，任务将移除其模型，历史消息仍会保留。</p>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`${endpoint}/${provider.id}`, "DELETE");
                    onDeleted();
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                确认删除
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="text-button danger-text delete-connection"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} />
              删除连接
            </button>
          ))}
      </form>
    </div>
  );
}
