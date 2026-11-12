import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  AdminAccessKey,
  CatalogModel,
  Capability,
  Provider,
  Attachment,
} from "../shared/types";
import { api } from "./api";
import { notifyAuthChange } from "./auth-events";
import { BrandMark, ErrorNotice, IconButton, Spinner } from "./components";
import ProviderForm from "./ProviderForm";
import Select from "./Select";
import KeySecret from "./KeySecret";
import KeyUsage from "./KeyUsage";

type Boot = {
  providers: Provider[];
  models: CatalogModel[];
  keys: AdminAccessKey[];
  capabilities: Capability[];
};
type ModelDraft = Pick<
  CatalogModel,
  "providerId" | "modelId" | "name" | "capabilities"
> &
  Partial<CatalogModel>;
type KeyDraft = {
  id?: string;
  label: string;
  modelIds: string[];
  enabled: boolean;
  expiresAt?: string;
};
export default function Admin({
  onLogout,
  onPasswordChanged,
}: {
  onLogout: () => Promise<void>;
  onPasswordChanged: () => void;
}) {
  const [data, setData] = useState<Boot>({
    providers: [],
    models: [],
    keys: [],
    capabilities: [],
  });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"models" | "keys" | "providers" | "security">(
    "models",
  );
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [provider, setProvider] = useState<Provider | "new" | null>(null);
  const [model, setModel] = useState<ModelDraft | null>(null);
  const [keyDraft, setKeyDraft] = useState<KeyDraft | null>(null);
  const [secret, setSecret] = useState("");
  const [keyView, setKeyView] = useState<"settings" | "usage">("settings");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    text: string;
    attachments: Attachment[];
  } | null>(null);
  const [testPrompt, setTestPrompt] = useState("");
  const [testFiles, setTestFiles] = useState<Attachment[]>([]);
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function refresh() {
    const b = await api<Boot>("/admin/bootstrap");
    setData(b);
    return b;
  }
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  function reset() {
    setError("");
    setNotice("");
    setConfirmDelete(false);
    setSearch("");
    setSecret("");
    setKeyView("settings");
    setTestResult(null);
    setTestFiles([]);
    setTestPrompt("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowPasswords(false);
  }
  function changeTab(next: typeof tab) {
    reset();
    setTab(next);
    setProvider(null);
    setModel(null);
    setKeyDraft(null);
  }
  function openModel(m?: CatalogModel, p = data.providers[0]) {
    reset();
    setProvider(null);
    setKeyDraft(null);
    setTab("models");
    setModel(
      m || {
        providerId: p?.id || "",
        modelId: p?.models[0]?.id || "",
        name: "",
        capabilities: p?.models[0]?.capabilities || [],
      },
    );
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveModel(e: FormEvent) {
    e.preventDefault();
    if (!model) return;
    await action(async () => {
      const m = await api<CatalogModel>(
        `/admin/models${model.id ? `/${model.id}` : ""}`,
        model.id ? "PATCH" : "POST",
        {
          name: model.name,
          providerId: model.providerId,
          modelId: model.modelId,
          capabilities: model.capabilities,
        },
      );
      setModel(m);
      setTestResult(null);
      await refresh();
      setNotice("草稿已保存。测试全部能力通过后即可上架。");
    });
  }
  const selectedProvider = data.providers.find(
    (p) => p.id === model?.providerId,
  );
  const selectedModel = selectedProvider?.models.find(
    (m) => m.id === model?.modelId,
  );
  const labels = Object.fromEntries(
    [
      ...data.capabilities,
      ...data.providers.flatMap((p) => p.customCapabilities),
    ].map((c) => [c.id, c.label]),
  );
  const savedModel = data.models.find((m) => m.id === model?.id);
  const dirty =
    !!model &&
    (!savedModel ||
      ["providerId", "modelId", "name", "capabilities"].some(
        (k) =>
          JSON.stringify(model[k as keyof ModelDraft]) !==
          JSON.stringify(savedModel[k as keyof CatalogModel]),
      ));
  const canPublish =
    !!model?.id &&
    !dirty &&
    !!model.capabilities.length &&
    model.capabilities.every((c) => model.testedCapabilities?.includes(c));
  async function test(capability: string) {
    if (!model?.id) return;
    await action(async () => {
      const result = await api<{
        model: CatalogModel;
        text: string;
        attachments: Attachment[];
      }>(`/admin/models/${model.id}/test`, "POST", {
        capability,
        prompt:
          testPrompt ||
          (capability === "text"
            ? "请用一句话确认连接成功。"
            : capability === "image" || capability === "video"
              ? "一棵阳光下的树，微风轻拂。"
              : "这是一次模型连通测试。"),
        attachments: testFiles.map((f) => f.id),
      });
      setModel(result.model);
      setTestResult(result);
      await refresh();
      setNotice(`${labels[capability] || capability}测试通过。`);
    });
  }
  async function saveKey(e: FormEvent) {
    e.preventDefault();
    if (!keyDraft) return;
    await action(async () => {
      if (keyDraft.id) {
        const k = await api<AdminAccessKey>(
          `/admin/keys/${keyDraft.id}`,
          "PATCH",
          {
            label: keyDraft.label,
            modelIds: keyDraft.modelIds,
            enabled: keyDraft.enabled,
            expiresAt: keyDraft.expiresAt || null,
          },
        );
        setKeyDraft(k);
        setNotice("授权已更新，相关运行已停止，新权限立即生效。");
      } else {
        const result = await api<{ key: AdminAccessKey; secret: string }>(
          "/admin/keys",
          "POST",
          { ...keyDraft, expiresAt: keyDraft.expiresAt || undefined },
        );
        setKeyDraft(result.key);
        setSecret(result.secret);
      }
      await refresh();
    });
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致，请重新确认。");
      return;
    }
    if (newPassword === currentPassword) {
      setError("新密码不能与当前密码相同。");
      return;
    }
    await action(async () => {
      await api("/auth/admin/password", "POST", {
        currentPassword,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onPasswordChanged();
    });
  }
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-brand">
          <BrandMark size={25} />
          <strong>Mstar</strong>
          <span>管理员后台</span>
        </div>
        <div>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api("/auth/admin-workspace", "POST", {});
                notifyAuthChange("user");
                location.assign("/");
              })
            }
          >
            管理员工作空间
          </button>
          <IconButton
            label="退出管理员登录"
            onClick={() => void action(onLogout)}
          >
            <LogOut size={17} />
          </IconButton>
        </div>
      </header>
      <nav className="admin-nav" aria-label="后台导航">
        {(
          [
            { id: "models", label: "模型上架", icon: ShieldCheck },
            { id: "keys", label: "分发密钥", icon: KeyRound },
            { id: "providers", label: "模型连接", icon: Link2 },
            { id: "security", label: "账号安全", icon: LockKeyhole },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            aria-current={tab === t.id ? "page" : undefined}
            disabled={busy}
            onClick={() => changeTab(t.id)}
          >
            <t.icon size={17} />
            {t.label}
          </button>
        ))}
      </nav>
      <main className="admin-main">
        <div className="admin-page-heading">
          <div>
            <h1>
              {tab === "models"
                ? "模型上架"
                : tab === "keys"
                  ? "分发密钥"
                  : tab === "providers"
                    ? "模型连接"
                    : "修改登录密码"}
            </h1>
            <p>
              {tab === "models"
                ? "选择模型并命名，测试通过后上架到 Mstar。"
                : tab === "keys"
                  ? "为每个密钥分配可用模型，用户凭密钥登录工作台。"
                  : tab === "providers"
                    ? "填写 URL 和 API Key，自动发现模型；特殊接口按需使用高级设置。"
                    : "验证当前密码后，设置新的管理员登录密码。"}
            </p>
          </div>
          {tab !== "security" && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                if (tab === "models") {
                  if (!data.providers.length) {
                    changeTab("providers");
                    setProvider("new");
                  } else openModel();
                } else if (tab === "keys") {
                  reset();
                  setKeyDraft({ label: "", modelIds: [], enabled: true });
                } else {
                  reset();
                  setProvider("new");
                }
              }}
            >
              <Plus size={16} />
              {tab === "models"
                ? "添加模型"
                : tab === "keys"
                  ? "生成密钥"
                  : "添加连接"}
            </button>
          )}
        </div>
        {error && <ErrorNotice message={error} />}
        {notice && (
          <p className="admin-notice" role="status">
            <Check size={15} />
            {notice}
          </p>
        )}
        {loading ? (
          <div className="admin-empty">
            <Spinner />
            正在加载后台…
          </div>
        ) : tab === "security" ? (
          <section className="admin-password" aria-label="修改登录密码">
            <form onSubmit={(e) => void changePassword(e)} aria-busy={busy}>
              <label className="field">
                当前密码
                <input
                  type={showPasswords ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  maxLength={200}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="field">
                新密码
                <input
                  type={showPasswords ? "text" : "password"}
                  autoComplete="new-password"
                  aria-label="新密码"
                  required
                  minLength={12}
                  maxLength={200}
                  aria-describedby="admin-password-hint"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={busy}
                />
                <small id="admin-password-hint">
                  12–200 位，建议使用独立的长密码。
                </small>
              </label>
              <label className="field">
                确认新密码
                <input
                  type={showPasswords ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={200}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="admin-check">
                <input
                  type="checkbox"
                  checked={showPasswords}
                  onChange={(e) => setShowPasswords(e.target.checked)}
                  disabled={busy}
                />
                显示密码
              </label>
              <p className="admin-password-note">
                修改后，所有管理员后台和管理员工作空间会话将退出，请使用新密码重新登录。
              </p>
              <button className="primary-button" disabled={busy}>
                {busy ? <Spinner /> : <LockKeyhole size={16} />}
                {busy ? "正在修改…" : "修改密码并重新登录"}
              </button>
            </form>
          </section>
        ) : (
          <div
            className={`admin-content ${provider || model || keyDraft ? "has-editor" : ""}`}
          >
            <section
              className="admin-list"
              aria-label={
                tab === "models"
                  ? "模型列表"
                  : tab === "keys"
                    ? "密钥列表"
                    : "连接列表"
              }
            >
              <label className="search-field">
                <Search size={15} />
                <input
                  aria-label="搜索后台列表"
                  placeholder={
                    tab === "keys" ? "搜索名称或密钥尾号" : "搜索名称"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              {tab === "models" &&
                data.models
                  .filter((m) =>
                    m.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((m) => (
                    <button
                      className={`admin-row ${model?.id === m.id ? "selected" : ""}`}
                      key={m.id}
                      disabled={busy}
                      onClick={() => openModel(m)}
                    >
                      <span>
                        <strong>{m.name}</strong>
                        <small>
                          {m.capabilities
                            .map((c) => labels[c] || c)
                            .join(" · ")}
                        </small>
                      </span>
                      <span
                        className={`admin-status ${m.published ? "active" : ""}`}
                      >
                        {m.published ? "已上架" : "草稿"}
                      </span>
                    </button>
                  ))}
              {tab === "keys" &&
                data.keys
                  .filter((k) =>
                    `${k.label} ${k.hint}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((k) => (
                    <button
                      className={`admin-row ${keyDraft?.id === k.id ? "selected" : ""}`}
                      key={k.id}
                      disabled={busy}
                      onClick={() => {
                        reset();
                        setKeyDraft(k);
                      }}
                    >
                      <span>
                        <strong>{k.label}</strong>
                        <small>
                          {k.hint} · {k.modelIds.length} 个模型
                        </small>
                      </span>
                      <span
                        className={`admin-status ${k.enabled ? "active" : ""}`}
                      >
                        {!k.enabled
                          ? "已停用"
                          : k.expiresAt && Date.parse(k.expiresAt) <= Date.now()
                            ? "已过期"
                            : "可使用"}
                      </span>
                    </button>
                  ))}
              {tab === "providers" &&
                data.providers
                  .filter((p) =>
                    p.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((p) => (
                    <button
                      className={`admin-row ${typeof provider !== "string" && provider?.id === p.id ? "selected" : ""}`}
                      key={p.id}
                      disabled={busy}
                      onClick={() => {
                        reset();
                        setProvider(p);
                      }}
                    >
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {p.models.length} 个模型 · {p.keyHint}
                        </small>
                      </span>
                    </button>
                  ))}
              {!(tab === "models"
                ? data.models.length
                : tab === "keys"
                  ? data.keys.length
                  : data.providers.length) && (
                <div className="admin-empty">
                  <h2>
                    {tab === "models"
                      ? "还没有上架模型"
                      : tab === "keys"
                        ? "还没有分发密钥"
                        : "接入第一个模型服务"}
                  </h2>
                  <p>
                    {tab === "models"
                      ? "先接入模型服务，再选择要提供给用户的模型。"
                      : tab === "keys"
                        ? "生成密钥后，勾选这个密钥可以使用的模型。"
                        : "从 URL 和 API Key 开始。"}
                  </p>
                </div>
              )}
            </section>
            {provider && (
              <section className="admin-editor provider-editor">
                <ProviderForm
                  key={typeof provider === "string" ? "new" : provider.id}
                  admin
                  provider={typeof provider === "string" ? undefined : provider}
                  capabilities={data.capabilities}
                  onClose={() => setProvider(null)}
                  onSaved={(p) => {
                    void action(async () => {
                      await refresh();
                      setProvider(null);
                      setTab("models");
                      setModel({
                        providerId: p.id,
                        modelId: p.models[0]?.id || "",
                        name: "",
                        capabilities: p.models[0]?.capabilities || [],
                      });
                    });
                  }}
                  onDeleted={() => {
                    setProvider(null);
                    void action(async () => {
                      await refresh();
                    });
                  }}
                />
              </section>
            )}
            {model && (
              <section className="admin-editor" aria-label="模型配置">
                <div className="admin-editor-heading">
                  <div className="admin-detail-title">
                    <h2>{model.id ? model.name || "管理模型" : "添加模型"}</h2>
                    {model.id && (
                      <span
                        className={`admin-status ${model.published ? "active" : ""}`}
                      >
                        {model.published ? "已上架" : "草稿"}
                      </span>
                    )}
                  </div>
                  <IconButton
                    label="关闭模型配置"
                    disabled={busy}
                    onClick={() => setModel(null)}
                  >
                    <ArrowLeft size={17} />
                  </IconButton>
                </div>
                <form onSubmit={(e) => void saveModel(e)}>
                  <label className="field">
                    展示名称
                    <input
                      required
                      aria-label="展示名称"
                      placeholder="例如：视频生成"
                      maxLength={100}
                      value={model.name}
                      disabled={busy}
                      onChange={(e) =>
                        setModel({ ...model, name: e.target.value })
                      }
                    />
                    <small>用户端仅展示名称和模型能力。</small>
                  </label>
                  <div className="admin-field-row">
                    <label className="field">
                      上游连接
                      <Select
                        aria-label="上游连接"
                        value={model.providerId}
                        disabled={busy}
                        onChange={(value) => {
                          const p = data.providers.find((p) => p.id === value);
                          setModel({
                            ...model,
                            providerId: value,
                            modelId: p?.models[0]?.id || "",
                            capabilities: p?.models[0]?.capabilities || [],
                          });
                        }}
                      >
                        <option value="" disabled>
                          选择连接
                        </option>
                        {data.providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <label className="field">
                      上游模型
                      <Select
                        aria-label="上游模型"
                        value={model.modelId}
                        disabled={busy}
                        onChange={(value) =>
                          setModel({
                            ...model,
                            modelId: value,
                            capabilities:
                              selectedProvider?.models.find(
                                (m) => m.id === value,
                              )?.capabilities || [],
                          })
                        }
                      >
                        <option value="" disabled>
                          选择模型
                        </option>
                        {selectedProvider?.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  </div>
                  <fieldset className="admin-capabilities" disabled={busy}>
                    <legend>开放的模型能力</legend>
                    {selectedModel?.capabilities.map((c) => (
                      <label key={c}>
                        <input
                          type="checkbox"
                          checked={model.capabilities.includes(c)}
                          onChange={(e) =>
                            setModel({
                              ...model,
                              capabilities: e.target.checked
                                ? [...model.capabilities, c]
                                : model.capabilities.filter((v) => v !== c),
                            })
                          }
                        />
                        {labels[c] || c}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    className="outline-button"
                    disabled={
                      busy ||
                      !model.name.trim() ||
                      !model.modelId ||
                      !model.capabilities.length ||
                      !dirty
                    }
                  >
                    {busy ? <Spinner /> : <Check size={15} />}保存草稿
                  </button>
                </form>
                <section className="admin-test">
                  <h3>测试连通</h3>
                  <p>
                    会真实调用上游并可能产生费用。每项开放能力都需测试通过。
                  </p>
                  <details className="admin-test-options">
                    <summary>
                      自定义测试内容
                      <ChevronDown size={14} />
                    </summary>
                    <label className="field">
                      测试内容
                      <input
                        aria-label="测试内容"
                        value={testPrompt}
                        placeholder="留空使用默认测试内容"
                        disabled={busy}
                        onChange={(e) => setTestPrompt(e.target.value)}
                      />
                    </label>
                    <div className="field">
                      <span>测试附件（可选）</span>
                      <button
                        type="button"
                        className="outline-button admin-file-button"
                        disabled={busy}
                        onClick={() => fileInput.current?.click()}
                      >
                        选择测试附件
                      </button>
                      <input
                        ref={fileInput}
                        aria-label="测试附件"
                        type="file"
                        hidden
                        multiple
                        disabled={busy}
                        onChange={(e) => {
                          const list = e.target.files;
                          if (!list?.length) return;
                          const body = new FormData();
                          for (const file of Array.from(list))
                            body.append("files", file);
                          void action(async () => {
                            const files = await api<Attachment[]>(
                              "/admin/files",
                              "POST",
                              body,
                            );
                            setTestFiles(files);
                          });
                        }}
                      />
                      {testFiles.length > 0 && (
                        <small>{testFiles.map((f) => f.name).join("、")}</small>
                      )}
                    </div>
                  </details>
                  <div className="admin-test-buttons">
                    {model.capabilities.map((c) => (
                      <button
                        key={c}
                        className="outline-button"
                        disabled={busy || dirty || !model.id}
                        onClick={() => void test(c)}
                      >
                        {busy ? (
                          <Spinner />
                        ) : (
                          model.testedCapabilities?.includes(c) && (
                            <Check size={14} />
                          )
                        )}
                        {labels[c] || c}测试
                        {model.testedCapabilities?.includes(c) ? " · 通过" : ""}
                      </button>
                    ))}
                  </div>
                  {dirty && (
                    <p className="small-note">先保存草稿，再测试当前配置。</p>
                  )}
                  {testResult && (
                    <div className="test-result" role="status">
                      {testResult.text && <p>{testResult.text}</p>}
                      {testResult.attachments.map((a) => (
                        <a
                          key={a.id}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看测试产出：{a.name}
                        </a>
                      ))}
                    </div>
                  )}
                </section>
                <div className="admin-editor-actions">
                  <button
                    className={
                      model.published ? "outline-button" : "primary-button"
                    }
                    disabled={busy || (!model.published && !canPublish)}
                    onClick={() =>
                      void action(async () => {
                        const m = await api<CatalogModel>(
                          `/admin/models/${model.id}`,
                          "PATCH",
                          { published: !model.published },
                        );
                        setModel(m);
                        await refresh();
                        setNotice(
                          m.published
                            ? "已上架，获得授权的用户现在可以使用。"
                            : "已下架，用户无法继续调用。 ",
                        );
                      })
                    }
                  >
                    {model.published ? "下架模型" : "上架到 Mstar"}
                  </button>
                  {model.id && (
                    <button
                      className="text-button danger-text"
                      disabled={busy}
                      onClick={() => {
                        if (!confirmDelete) {
                          setConfirmDelete(true);
                          return;
                        }
                        void action(async () => {
                          await api(`/admin/models/${model.id}`, "DELETE");
                          setModel(null);
                          await refresh();
                        });
                      }}
                    >
                      <Trash2 size={14} />
                      {confirmDelete ? "确认移除模型" : "移除模型"}
                    </button>
                  )}
                </div>
              </section>
            )}
            {keyDraft && (
              <section className="admin-editor" aria-label="密钥授权">
                <div className="admin-editor-heading">
                  <div className="admin-detail-title">
                    <h2>
                      {keyDraft.id ? keyDraft.label || "管理密钥" : "生成密钥"}
                    </h2>
                    {keyDraft.id && (
                      <span
                        className={`admin-status ${keyDraft.enabled ? "active" : ""}`}
                      >
                        {!keyDraft.enabled
                          ? "已停用"
                          : keyDraft.expiresAt &&
                              Date.parse(keyDraft.expiresAt) <= Date.now()
                            ? "已过期"
                            : "可使用"}
                      </span>
                    )}
                  </div>
                  <IconButton
                    label="关闭密钥配置"
                    disabled={busy}
                    onClick={() => {
                      setKeyDraft(null);
                      setSecret("");
                    }}
                  >
                    <ArrowLeft size={17} />
                  </IconButton>
                </div>
                {keyDraft.id && (
                  <>
                    <div
                      className="key-detail-tabs"
                      role="group"
                      aria-label="密钥详情视图"
                    >
                      <button
                        type="button"
                        aria-pressed={keyView === "settings"}
                        disabled={busy}
                        onClick={() => setKeyView("settings")}
                      >
                        授权设置
                      </button>
                      <button
                        type="button"
                        aria-pressed={keyView === "usage"}
                        disabled={busy}
                        onClick={() => {
                          setKeyView("usage");
                          setSecret("");
                        }}
                      >
                        请求与用量
                      </button>
                    </div>
                  </>
                )}
                {keyDraft.id && keyView === "usage" ? (
                  <KeyUsage
                    key={keyDraft.id}
                    id={keyDraft.id}
                    models={data.models.map((m) => ({
                      id: m.id,
                      name: m.name,
                    }))}
                    labels={labels}
                  />
                ) : (
                  <>
                    {keyDraft.id && (
                      <KeySecret
                        key={keyDraft.id}
                        id={keyDraft.id}
                        canReveal={
                          data.keys.find((k) => k.id === keyDraft.id)
                            ?.canReveal ?? true
                        }
                        initialSecret={secret}
                        disabled={busy}
                        onChanged={refresh}
                      />
                    )}
                    <form onSubmit={(e) => void saveKey(e)}>
                      <div className="admin-field-row key-identity-fields">
                        <label className="field">
                          名称或备注
                          <input
                            aria-label="密钥名称"
                            required
                            maxLength={100}
                            placeholder="例如：客户 A"
                            value={keyDraft.label}
                            disabled={busy}
                            onChange={(e) =>
                              setKeyDraft({
                                ...keyDraft,
                                label: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>
                            有效期 <span className="optional">可选</span>
                          </span>
                          <input
                            type="datetime-local"
                            aria-label="密钥有效期"
                            value={
                              keyDraft.expiresAt
                                ? new Date(
                                    Date.parse(keyDraft.expiresAt) -
                                      new Date(
                                        keyDraft.expiresAt,
                                      ).getTimezoneOffset() *
                                        60000,
                                  )
                                    .toISOString()
                                    .slice(0, 16)
                                : ""
                            }
                            disabled={busy}
                            onChange={(e) =>
                              setKeyDraft({
                                ...keyDraft,
                                expiresAt: e.target.value
                                  ? new Date(e.target.value).toISOString()
                                  : undefined,
                              })
                            }
                          />
                          <small>留空为长期有效。</small>
                        </label>
                      </div>
                      {keyDraft.id && (
                        <label className="admin-check">
                          <input
                            type="checkbox"
                            checked={keyDraft.enabled}
                            disabled={busy}
                            onChange={(e) =>
                              setKeyDraft({
                                ...keyDraft,
                                enabled: e.target.checked,
                              })
                            }
                          />
                          允许此密钥登录和使用模型
                        </label>
                      )}
                      <fieldset className="grant-list" disabled={busy}>
                        <legend>可使用的 Mstar 模型</legend>
                        {!data.models.length && (
                          <p className="small-note">
                            尚未添加模型，可以先生成密钥，后续再授权。
                          </p>
                        )}
                        {data.models.map((m) => (
                          <label key={m.id}>
                            <input
                              type="checkbox"
                              checked={keyDraft.modelIds.includes(m.id)}
                              onChange={(e) =>
                                setKeyDraft({
                                  ...keyDraft,
                                  modelIds: e.target.checked
                                    ? [...keyDraft.modelIds, m.id]
                                    : keyDraft.modelIds.filter(
                                        (id) => id !== m.id,
                                      ),
                                })
                              }
                            />
                            <span>
                              <strong>{m.name}</strong>
                              <small>
                                {m.capabilities
                                  .map((c) => labels[c] || c)
                                  .join(" · ")}
                                {!m.published && " · 上架后可见"}
                              </small>
                            </span>
                          </label>
                        ))}
                      </fieldset>
                      <button
                        className="primary-button"
                        disabled={busy || !keyDraft.label.trim()}
                      >
                        {busy ? <Spinner /> : <KeyRound size={15} />}
                        {keyDraft.id ? "保存授权" : "生成分发密钥"}
                      </button>
                    </form>
                    {keyDraft.id && (
                      <button
                        className="text-button danger-text"
                        disabled={busy}
                        onClick={() => {
                          if (!confirmDelete) {
                            setConfirmDelete(true);
                            return;
                          }
                          void action(async () => {
                            await api(`/admin/keys/${keyDraft.id}`, "DELETE");
                            setKeyDraft(null);
                            setSecret("");
                            await refresh();
                          });
                        }}
                      >
                        <Trash2 size={14} />
                        {confirmDelete
                          ? "确认撤销并删除密钥"
                          : "撤销并删除密钥"}
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
