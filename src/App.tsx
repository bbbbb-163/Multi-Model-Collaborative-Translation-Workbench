import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Plus,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Settings2,
  ArrowUp,
  Square,
  Paperclip,
  X,
  Download,
  MessageSquare,
  Users,
  Link2,
  Check,
  ArrowDown,
  SlidersHorizontal,
  Trash2,
  Pencil,
  LogOut,
} from "lucide-react";
import type {
  Provider,
  Task,
  TaskDetail,
  TaskSettings,
  Message,
  Selection,
  Attachment,
  Capability,
  WorkspaceProvider,
  Identity,
} from "../shared/types";
import { refKey, AUTO_CAPABILITY } from "../shared/types";
import { api } from "./api";
import {
  BrandMark,
  IconButton,
  MessageView,
  Spinner,
  ErrorNotice,
} from "./components";
import ProviderForm from "./ProviderForm";
import WorkflowEditor from "./WorkflowEditor";
import Select from "./Select";
import ModelDropdown from "./ModelDropdown";
import WorkspaceHelp from "./WorkspaceHelp";

type Boot = {
  tasks: Task[];
  providers: WorkspaceProvider[];
  capabilities: Capability[];
};
export default function App({
  identity,
  onLogout,
}: {
  identity: Identity;
  onLogout: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<WorkspaceProvider[]>([]);
  const [modelTab, setModelTab] = useState<"mstar" | "personal">("mstar");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(true);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900);
  const [drawer, setDrawer] = useState(() => window.innerWidth > 1100);
  const [providerForm, setProviderForm] = useState<Provider | "new" | null>(
    null,
  );
  const [taskSearch, setTaskSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [editingSettings, setEditingSettings] = useState<TaskSettings | null>(
    null,
  );
  const [taskMenu, setTaskMenu] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [following, setFollowing] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [isCompact, setIsCompact] = useState(() => window.innerWidth <= 900);
  const sidebarRef = useRef<HTMLElement>(null),
    drawerRef = useRef<HTMLElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const chatScroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const currentId = useRef<string | null>(null);
  const drafts = useRef<Record<string, { text: string; files: Attachment[] }>>(
    {},
  );
  function closeTaskMenu() {
    taskMenuRef.current?.hidePopover();
    setTaskMenu(null);
  }
  useEffect(() => {
    if (!taskMenu) return;
    const list = sidebarRef.current?.querySelector(".task-list");
    window.addEventListener("resize", closeTaskMenu);
    list?.addEventListener("scroll", closeTaskMenu);
    return () => {
      window.removeEventListener("resize", closeTaskMenu);
      list?.removeEventListener("scroll", closeTaskMenu);
    };
  }, [taskMenu]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => {
      setIsCompact(media.matches);
      if (media.matches) {
        setSidebar(false);
        setDrawer(false);
      }
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!isCompact || (!sidebar && !drawer)) return;
    const surface = drawer ? drawerRef.current : sidebarRef.current;
    if (!surface) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        surface.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ),
      ).filter(
        (el) =>
          el.getClientRects().length &&
          getComputedStyle(el).visibility !== "hidden",
      );
    const first = focusable()[0];
    first?.focus();
    const contain = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable(),
        first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !surface.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !surface.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", contain);
    return () => {
      document.removeEventListener("keydown", contain);
      if (opener?.isConnected) opener.focus();
    };
  }, [isCompact, sidebar, drawer]);
  useEffect(() => {
    if (isCompact && drawer)
      drawerRef.current
        ?.querySelector<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
        )
        ?.focus();
  }, [isCompact, drawer, providerForm]);
  const updateTaskList = (t: Task) =>
    setTasks((ts) =>
      [t, ...ts.filter((x) => x.id !== t.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
  async function bootstrap() {
    const b = await api<Boot>("/bootstrap");
    setProviders(b.providers);
    setTasks(b.tasks);
    setCapabilities(b.capabilities);
    let id = localStorage.getItem("workbench.activeTask");
    if (!b.tasks.some((t) => t.id === id)) id = b.tasks[0]?.id || null;
    if (!id) {
      const t = await api<Task>("/tasks", "POST", {});
      setTasks([t]);
      id = t.id;
    }
    setActiveId(id);
    setLoading(false);
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void bootstrap().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, []);
  useEffect(() => {
    const refresh = () =>
      void api<Boot>("/bootstrap")
        .then((b) => {
          setProviders(b.providers);
          setCapabilities(b.capabilities);
        })
        .catch(() => {});
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    if (!activeId) return;
    currentId.current = activeId;
    localStorage.setItem("workbench.activeTask", activeId);
    setTask(null);
    setFollowing(true);
    setEditingSettings(null);
    closeTaskMenu();
    const d = drafts.current[activeId];
    setText(d?.text || "");
    setFiles(d?.files || []);
    const stream = new EventSource(`/api/tasks/${activeId}/events`);
    let disposed = false;
    let streaming = false;
    let refreshing = false;
    const refreshTask = async () => {
      if (disposed || streaming || refreshing) return;
      refreshing = true;
      try {
        const t = await api<TaskDetail>(`/tasks/${activeId}`);
        if (!disposed && !streaming) {
          setTask(t);
          updateTaskList(t);
          setConnected(true);
        }
      } catch {
        if (!disposed && !streaming) setConnected(false);
      } finally {
        refreshing = false;
      }
    };
    void refreshTask();
    const refreshTimer = window.setInterval(() => void refreshTask(), 2000);
    stream.onopen = () => {
      streaming = true;
      setConnected(true);
    };
    stream.onerror = () => {
      streaming = false;
      void refreshTask();
    };
    stream.addEventListener("snapshot", (e) => {
      const t: TaskDetail = JSON.parse(e.data);
      setTask(t);
      updateTaskList(t);
    });
    stream.addEventListener("message", (e) => {
      const m: Message = JSON.parse(e.data);
      setTask((t) =>
        !t || t.id !== activeId
          ? t
          : {
              ...t,
              messages: t.messages.some((x) => x.id === m.id)
                ? t.messages.map((x) => (x.id === m.id ? m : x))
                : [...t.messages, m],
            },
      );
    });
    stream.addEventListener("task", (e) => {
      const t: Task = JSON.parse(e.data);
      setTask((old) => (old?.id === t.id ? { ...old, ...t } : old));
      updateTaskList(t);
    });
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      stream.close();
    };
  }, [activeId]);
  useEffect(() => {
    if (currentId.current) drafts.current[currentId.current] = { text, files };
  }, [text, files]);
  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
    }
  }, [text]);
  useEffect(() => {
    if (following && chatScroll.current)
      chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }, [task?.messages, following]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setEditingSettings(null);
        closeTaskMenu();
        setProviderForm(null);
        if (window.innerWidth < 900) {
          setSidebar(false);
          setDrawer(false);
        }
      }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);
  async function newTask() {
    try {
      const t = await api<Task>("/tasks", "POST", {});
      updateTaskList(t);
      setActiveId(t.id);
      if (window.innerWidth < 900) setSidebar(false);
      textarea.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function settings(next: TaskSettings) {
    next = {
      ...next,
      capability: AUTO_CAPABILITY,
      workflow: next.workflow?.map((step) => ({
        ...step,
        capability: AUTO_CAPABILITY,
      })),
    };
    if (
      !task ||
      saving ||
      (task.running && !(task.settings.mode === "team" && next.mode !== "team"))
    )
      return;
    setSaving(true);
    try {
      const t = await api<Task>(`/tasks/${task.id}`, "PATCH", {
        settings: next,
      });
      setTask((old) => (old?.id === t.id ? { ...old, ...t } : old));
      updateTaskList(t);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function toggleModel(
    p: Pick<WorkspaceProvider, "id">,
    modelId: string,
  ) {
    if (!task) return;
    const ref = `${p.id}::${modelId}`,
      selected = task.settings.selections.some((s) => refKey(s) === ref);
    if (!selected && task.settings.selections.length >= 8) {
      setError("每个任务最多选择 8 个模型。");
      return;
    }
    const selections = selected
      ? task.settings.selections.filter((s) => refKey(s) !== ref)
      : [...task.settings.selections, { providerId: p.id, modelId, role: "" }];
    const primary = selections.some((s) => refKey(s) === task.settings.primary)
      ? task.settings.primary
      : selections[0]
        ? refKey(selections[0])
        : undefined;
    await settings({
      ...task.settings,
      selections,
      primary,
      capability: AUTO_CAPABILITY,
    });
  }
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (
      !task ||
      task.running ||
      submitting ||
      saving ||
      uploading ||
      (!text.trim() && !files.length)
    )
      return;
    if (!task.settings.selections.length) {
      setDrawer(true);
      setError("请先展开右侧连接，勾选要加入任务的模型。");
      return;
    }
    const id = task.id;
    setSubmitting(true);
    setError("");
    try {
      await api(`/tasks/${id}/run`, "POST", {
        content: text,
        attachments: files.map((f) => f.id),
        autoCapabilities: true,
      });
      if (currentId.current === id) {
        setText("");
        setFiles([]);
        setFollowing(true);
      }
      drafts.current[id] = { text: "", files: [] };
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function upload(list: FileList | File[]) {
    if (!list.length || !task || task.running) return;
    if (files.length + list.length > 10) {
      setError("每条消息最多 10 个附件。");
      return;
    }
    const id = task.id,
      body = new FormData();
    for (const f of Array.from(list)) body.append("files", f);
    setUploading(true);
    try {
      const added = await api<Attachment[]>("/files", "POST", body);
      if (currentId.current === id) setFiles((fs) => [...fs, ...added]);
      else {
        const d = drafts.current[id] || { text: "", files: [] };
        drafts.current[id] = { ...d, files: [...d.files, ...added] };
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function providerSaved(p: Provider) {
    setProviders((ps) =>
      ps.some((x) => x.id === p.id)
        ? ps.map((x) => (x.id === p.id ? p : x))
        : [...ps, p],
    );
    setProviderForm(null);
  }
  const selections = task?.settings.selections || [];
  const personalProviders = providers.filter(
    (p): p is Provider => !("managed" in p),
  );
  const managedProviders = providers.filter((p) => "managed" in p);
  const modelName = (s: Selection) =>
    providers
      .find((p) => p.id === s.providerId)
      ?.models.find((m) => m.id === s.modelId)?.name ||
    (s.providerId.startsWith("mstar_") ? "模型已不可用" : s.modelId);
  const primary =
    selections.find((s) => refKey(s) === task?.settings.primary) ||
    selections[0];
  const primaryModel = providers
    .find((p) => p.id === primary?.providerId)
    ?.models.find((m) => m.id === primary?.modelId);
  const labels = Object.fromEntries(
    [...capabilities, ...providers.flatMap((p) => p.customCapabilities)].map(
      (c) => [c.id, c.label],
    ),
  );
  const disabled = saving || !!task?.running || submitting;
  const waitingForInput =
    !!task?.running &&
    task.messages.some((m) => m.confirmation?.state === "pending");
  const filteredTasks = tasks.filter((t) =>
    t.title.toLowerCase().includes(taskSearch.toLowerCase()),
  );
  return (
    <div
      className={`app-shell ${sidebar ? "has-sidebar" : ""} ${drawer ? "has-drawer" : ""}`}
    >
      {(sidebar || drawer) && (
        <button
          tabIndex={-1}
          className="mobile-scrim"
          aria-label="关闭侧栏"
          onClick={() => {
            setSidebar(false);
            setDrawer(false);
          }}
        />
      )}
      <aside
        ref={sidebarRef}
        role={isCompact && sidebar ? "dialog" : undefined}
        aria-modal={isCompact && sidebar ? true : undefined}
        inert={isCompact && drawer}
        className={`task-sidebar ${sidebar ? "open" : ""}`}
        aria-label="任务列表"
      >
        <div className="brand">
          <span className="brand-symbol">
            <BrandMark size={25} />
          </span>
          <strong>模型工作台</strong>
          <IconButton label="收起任务列表" onClick={() => setSidebar(false)}>
            <PanelLeftClose size={17} />
          </IconButton>
        </div>
        <button className="new-task" onClick={() => void newTask()}>
          <Plus size={18} />
          新建任务<span>新对话</span>
        </button>
        <label className="search-field task-search">
          <Search size={15} />
          <input
            aria-label="搜索任务"
            placeholder="搜索任务"
            value={taskSearch}
            onChange={(e) => setTaskSearch(e.target.value)}
          />
        </label>
        <div className="task-list-heading">
          任务<span>{tasks.length}</span>
        </div>
        <nav className="task-list">
          {filteredTasks.map((t) => (
            <div
              className={`task-row ${t.id === activeId ? "active" : ""}`}
              key={t.id}
            >
              <button
                className="task-select"
                onClick={() => {
                  setActiveId(t.id);
                  if (window.innerWidth < 900) setSidebar(false);
                }}
              >
                <MessageSquare size={15} />
                <span>{t.title}</span>
                {t.running && (
                  <span className="running-dot" aria-label="正在运行" />
                )}
              </button>
              <IconButton
                label={`管理任务 ${t.title}`}
                className="task-more"
                aria-haspopup="dialog"
                aria-controls={`task-menu-${t.id}`}
                aria-expanded={taskMenu === t.id}
                popoverTarget={`task-menu-${t.id}`}
                onClick={() => {
                  setRename(t.title);
                  setDeleteConfirm(false);
                }}
              >
                <MoreHorizontal size={16} />
              </IconButton>
              <div
                id={`task-menu-${t.id}`}
                className="task-menu"
                popover="auto"
                role="dialog"
                aria-label={`任务操作 ${t.title}`}
                onToggle={(e) => {
                  const menu = e.currentTarget;
                  if (e.newState === "open" && menu.matches(":popover-open")) {
                    taskMenuRef.current = menu;
                    const anchor =
                      menu.previousElementSibling!.getBoundingClientRect();
                    const bounds = menu.getBoundingClientRect();
                    menu.style.left = `${Math.max(8, Math.min(anchor.right + 8, window.innerWidth - bounds.width - 8))}px`;
                    menu.style.top = `${Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8))}px`;
                    setTaskMenu(t.id);
                  } else if (e.newState === "closed") {
                    if (taskMenuRef.current === menu)
                      taskMenuRef.current = null;
                    setTaskMenu((current) =>
                      current === t.id ? null : current,
                    );
                  }
                }}
              >
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const updated = await api<Task>(
                        `/tasks/${t.id}`,
                        "PATCH",
                        { title: rename },
                      );
                      updateTaskList(updated);
                      setTask((old) =>
                        old?.id === t.id ? { ...old, ...updated } : old,
                      );
                      closeTaskMenu();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <label>
                    任务名称
                    <input
                      aria-label="任务名称"
                      value={rename}
                      onChange={(e) => setRename(e.target.value)}
                      maxLength={100}
                      required
                    />
                  </label>
                  <button className="text-button">
                    <Pencil size={13} />
                    保存名称
                  </button>
                </form>
                <a href={`/api/tasks/${t.id}/export`} download>
                  <Download size={14} />
                  导出 Markdown
                </a>
                <button
                  className="text-button danger-text"
                  disabled={t.running}
                  onClick={async () => {
                    if (!deleteConfirm) {
                      setDeleteConfirm(true);
                      return;
                    }
                    try {
                      await api(`/tasks/${t.id}`, "DELETE");
                      const rest = tasks.filter((x) => x.id !== t.id);
                      setTasks(rest);
                      closeTaskMenu();
                      if (activeId === t.id) {
                        if (rest.length) setActiveId(rest[0].id);
                        else await newTask();
                      }
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  {deleteConfirm ? "确认删除此任务" : "删除任务"}
                </button>
              </div>
            </div>
          ))}
          {!filteredTasks.length && <p className="list-empty">没有找到任务</p>}
        </nav>
        <div className="sidebar-footer">
          <span className="local-indicator" />
          <div>
            <strong>{identity.label}</strong>
            <div className="workspace-meta">
              <small>Mstar 工作空间</small>
              <WorkspaceHelp active={sidebar && (!isCompact || !drawer)} />
            </div>
          </div>
          <IconButton
            label="退出登录"
            onClick={() => void onLogout().catch((e) => setError(e.message))}
          >
            <LogOut size={16} />
          </IconButton>
        </div>
      </aside>
      <main
        inert={isCompact && (drawer || sidebar)}
        className="workspace"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="drop-overlay">
            <Paperclip size={32} />
            <strong>松开以上传到此任务</strong>
            <span>单个文件不超过 40 MB</span>
          </div>
        )}
        <header className="workspace-header">
          <div className="workspace-title">
            {!sidebar && (
              <IconButton
                label="展开任务列表"
                onClick={() => {
                  setSidebar(true);
                  if (window.innerWidth < 900) setDrawer(false);
                }}
              >
                <PanelLeftOpen size={19} />
              </IconButton>
            )}
            <div>
              <h1>{task?.title || "模型工作台"}</h1>
              <span>
                {task?.running ? (
                  <>
                    <span className="running-dot" />
                    {waitingForInput ? "等待输入确认" : "模型正在工作"}
                  </>
                ) : selections.length ? (
                  `${selections.length} 个模型已加入任务`
                ) : (
                  "一个任务，连接多种可能"
                )}
              </span>
            </div>
          </div>
          <div className="header-actions">
            {!connected && <span className="reconnecting">正在重连…</span>}
            <IconButton
              label="任务设置"
              onClick={() =>
                setEditingSettings(
                  editingSettings
                    ? null
                    : task
                      ? structuredClone(task.settings)
                      : null,
                )
              }
              disabled={!task}
            >
              <Settings2 size={18} />
            </IconButton>
            {task && (
              <a
                className="icon-button export-button"
                title="导出任务"
                aria-label="导出任务"
                href={`/api/tasks/${task.id}/export`}
                download
              >
                <Download size={18} />
              </a>
            )}
            <button
              className={`drawer-toggle ${drawer ? "selected" : ""}`}
              onClick={() => {
                setDrawer(!drawer);
                if (window.innerWidth < 900) setSidebar(false);
              }}
              aria-expanded={drawer}
            >
              {drawer ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
              <span>模型</span>
              {!!selections.length && <small>{selections.length}</small>}
            </button>
          </div>
        </header>
        {editingSettings && (
          <section className="task-settings-panel" aria-label="任务设置">
            <div className="section-row">
              <h2>任务设置</h2>
              <IconButton
                label="关闭任务设置"
                onClick={() => setEditingSettings(null)}
              >
                <X size={16} />
              </IconButton>
            </div>
            <p>团队成员共用任务上下文，模型的职责和调用过程会保存在对话中。</p>
            <label className="field">
              任务指令
              <textarea
                rows={3}
                placeholder="给所有团队模型的共同要求，例如输出语言、交付格式…"
                value={editingSettings.systemPrompt}
                onChange={(e) =>
                  setEditingSettings({
                    ...editingSettings,
                    systemPrompt: e.target.value,
                  })
                }
              />
            </label>
            {selections.map((s) => (
              <label className="field member-role-field" key={refKey(s)}>
                <span>{modelName(s)}</span>
                <input
                  placeholder="职责（可选）：策划、编码、审阅…"
                  value={
                    editingSettings.selections.find(
                      (x) => refKey(x) === refKey(s),
                    )?.role || ""
                  }
                  onChange={(e) =>
                    setEditingSettings({
                      ...editingSettings,
                      selections: editingSettings.selections.map((x) =>
                        refKey(x) === refKey(s)
                          ? { ...x, role: e.target.value }
                          : x,
                      ),
                    })
                  }
                />
              </label>
            ))}
            <button
              className="primary-button"
              disabled={disabled}
              onClick={async () => {
                await settings(editingSettings);
                setEditingSettings(null);
              }}
            >
              保存设置
            </button>
            {task?.running && <small>运行结束后可修改设置。</small>}
          </section>
        )}
        <div
          ref={chatScroll}
          className={`chat-scroll ${!task?.messages.length ? "is-empty" : ""}`}
          onScroll={() => {
            const el = chatScroll.current!;
            setFollowing(
              el.scrollHeight - el.scrollTop - el.clientHeight < 100,
            );
          }}
        >
          {loading || !task ? (
            <div className="initial-loading">
              <Spinner />
              <span>{error ? "连接工作台失败" : "正在打开工作空间…"}</span>
              {error && (
                <button
                  className="text-button"
                  onClick={() =>
                    void bootstrap().catch((e) => setError(e.message))
                  }
                >
                  重新连接
                </button>
              )}
            </div>
          ) : !task.messages.length ? (
            <div className="welcome">
              <div className="welcome-mark">
                <BrandMark size={38} />
              </div>
              <h2>让想法，在这里完成。</h2>
              <p>
                选好模型，开始一个任务。
                <br />
                从一次对话，到多个模型一起工作。
              </p>
              <div className="welcome-guide">
                <div>
                  <span>
                    <Link2 size={17} />
                  </span>
                  <strong>打开 Mstar</strong>
                  <small>使用已授权的模型</small>
                </div>
                <ChevronRight size={14} />
                <div>
                  <span>
                    <Users size={17} />
                  </span>
                  <strong>选择模型</strong>
                  <small>按任务组成你的团队</small>
                </div>
                <ChevronRight size={14} />
                <div>
                  <span>
                    <MessageSquare size={17} />
                  </span>
                  <strong>开始对话</strong>
                  <small>所有成果汇聚在这里</small>
                </div>
              </div>
            </div>
          ) : (
            <div className="messages">
              {task.messages.map((m) => (
                <MessageView message={m} key={m.id} />
              ))}
              {task.running && (
                <div className="run-status">
                  {waitingForInput ? (
                    "等待你的输入确认，确认后才会调用对应模型"
                  ) : (
                    <>
                      <Spinner />
                      正在处理任务，可以随时停止
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="composer-area">
          {task?.settings.mode === "workflow" && (
            <WorkflowEditor
              steps={task.settings.workflow || []}
              selections={selections}
              providers={providers}
              disabled={disabled}
              onChange={(workflow) =>
                void settings({ ...task.settings, workflow })
              }
            />
          )}
          {!following && (
            <button
              className="jump-to-bottom"
              onClick={() => setFollowing(true)}
              aria-label="跳到最新消息"
            >
              <ArrowDown size={17} />
            </button>
          )}
          {error && (
            <ErrorNotice message={error} onClose={() => setError("")} />
          )}
          <form
            className={`composer ${task?.running ? "is-running" : ""}`}
            onSubmit={(e) => void send(e)}
          >
            {!!files.length && (
              <div className="pending-files">
                {files.map((a) => (
                  <div key={a.id}>
                    {a.mime.startsWith("image/") ? (
                      <img src={a.url} alt="" />
                    ) : (
                      <Paperclip size={14} />
                    )}
                    <span>{a.name}</span>
                    <IconButton
                      label={`移除附件 ${a.name}`}
                      onClick={() =>
                        setFiles((fs) => fs.filter((f) => f.id !== a.id))
                      }
                    >
                      <X size={12} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textarea}
              aria-label="消息输入"
              placeholder={
                waitingForInput
                  ? "请先在对话中确认本次输入，也可以先写下下一条消息…"
                  : task?.running
                    ? "模型正在工作，你可以先写下下一条消息…"
                    : selections.length
                      ? "描述你想完成的任务…"
                      : "从右侧选择模型，然后描述你想完成的任务…"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void upload(e.clipboardData.files);
                }
              }}
            />
            <div className="composer-toolbar">
              <div className="composer-tools">
                <input
                  type="file"
                  multiple
                  hidden
                  ref={uploadInput}
                  onChange={(e) => {
                    if (e.target.files) void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <IconButton
                  label="上传附件"
                  disabled={uploading || !!task?.running}
                  onClick={() => uploadInput.current?.click()}
                >
                  {uploading ? <Spinner /> : <Paperclip size={18} />}
                </IconButton>
                <span className="toolbar-divider" />
                <span className="mode-control">
                  {task?.settings.mode === "team" ? (
                    <Users size={15} />
                  ) : task?.settings.mode === "workflow" ? (
                    <SlidersHorizontal size={15} />
                  ) : (
                    <MessageSquare size={15} />
                  )}
                  <Select
                    className="mode-select"
                    aria-label="调用方式"
                    value={task?.settings.mode || "direct"}
                    disabled={
                      saving ||
                      submitting ||
                      !task ||
                      (!!task.running && task.settings.mode !== "team")
                    }
                    onChange={(value) => {
                      if (!task) return;
                      const mode = value as TaskSettings["mode"];
                      void settings({
                        ...task.settings,
                        mode,
                        workflow:
                          mode === "workflow" && !task.settings.workflow?.length
                            ? selections.map((s) => ({
                                id: crypto.randomUUID(),
                                providerId: s.providerId,
                                modelId: s.modelId,
                                capability: AUTO_CAPABILITY,
                                prompt: "",
                                inputSource: "previous",
                                optionsJson: "",
                              }))
                            : task.settings.workflow,
                      });
                    }}
                  >
                    <option value="direct">单独调用</option>
                    <option value="team">自动协作</option>
                    <option value="workflow">顺序执行</option>
                  </Select>
                </span>
                {task?.settings.mode === "direct" && selections.length > 0 && (
                  <Select
                    className="target-select"
                    aria-label="本次调用模型"
                    value={primary ? refKey(primary) : ""}
                    disabled={disabled}
                    onChange={(value) => {
                      if (!task) return;
                      const s = selections.find((s) => refKey(s) === value)!;
                      void settings({
                        ...task.settings,
                        primary: refKey(s),
                        capability: AUTO_CAPABILITY,
                      });
                    }}
                  >
                    {selections.map((s) => (
                      <option value={refKey(s)} key={refKey(s)}>
                        {modelName(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {task?.running ? (
                <button
                  type="button"
                  className="send-button stop-button"
                  title="停止运行"
                  aria-label="停止运行"
                  onClick={() =>
                    void api(`/tasks/${task.id}/stop`, "POST", {}).catch((e) =>
                      setError(e.message),
                    )
                  }
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送消息"
                  title="发送消息"
                  type="submit"
                  disabled={
                    submitting ||
                    uploading ||
                    saving ||
                    !task ||
                    (!text.trim() && !files.length)
                  }
                >
                  {submitting ? <Spinner /> : <ArrowUp size={20} />}
                </button>
              )}
            </div>
          </form>
          <div className="composer-footnote">
            <span>
              {primaryModel
                ? task?.settings.mode === "workflow"
                  ? `${task.settings.workflow?.length || 0} 个步骤 · 按顺序传递产出`
                  : task?.settings.mode === "team"
                    ? `${selections.length} 个模型 · 共享任务上下文`
                    : `${primaryModel.name} · 仅调用此模型`
                : "选择 Mstar 模型，开始你的工作"}
            </span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </main>
      <aside
        ref={drawerRef}
        role={isCompact && drawer ? "dialog" : undefined}
        aria-modal={isCompact && drawer ? true : undefined}
        inert={isCompact && sidebar}
        className={`model-drawer ${drawer ? "open" : ""}`}
        aria-label="模型抽屉"
      >
        {providerForm ? (
          <ProviderForm
            key={typeof providerForm === "string" ? "new" : providerForm.id}
            provider={
              typeof providerForm === "string" ? undefined : providerForm
            }
            capabilities={capabilities}
            onClose={() => setProviderForm(null)}
            onSaved={(p) => void providerSaved(p)}
            onDeleted={() => {
              setProviderForm(null);
              void api<Boot>("/bootstrap")
                .then((b) => {
                  setProviders(b.providers);
                  setTasks(b.tasks);
                  if (activeId)
                    void api<TaskDetail>(`/tasks/${activeId}`).then(setTask);
                })
                .catch((e) => setError(e.message));
            }}
          />
        ) : (
          <>
            <div className="drawer-heading">
              <h2>模型</h2>
              {modelTab === "personal" && (
                <button
                  className="text-button add-connection"
                  onClick={() => setProviderForm("new")}
                >
                  <Plus size={15} />
                  添加连接
                </button>
              )}
              <IconButton
                className="mobile-drawer-close"
                label="关闭模型抽屉"
                onClick={() => setDrawer(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <div className="drawer-scroll">
              <section className="task-members">
                <div className="section-row">
                  <h3>当前任务</h3>
                  <span>{selections.length} / 8</span>
                </div>
                {!selections.length ? (
                  <p className="members-empty">
                    从下方连接中勾选模型，
                    <br />
                    加入这个任务一起工作。
                  </p>
                ) : (
                  <div className="member-list">
                    {selections.map((s, i) => (
                      <div className="member-item" key={refKey(s)}>
                        <span className={`member-avatar member-tone-${i % 4}`}>
                          <BrandMark size={16} />
                        </span>
                        <div>
                          <strong title={modelName(s)}>{modelName(s)}</strong>
                          <small>
                            {s.role ||
                              (refKey(s) === refKey(primary)
                                ? task?.settings.mode === "team"
                                  ? "负责汇总"
                                  : "当前调用"
                                : "团队成员")}
                          </small>
                        </div>
                        {refKey(s) !== refKey(primary) && (
                          <button
                            className="make-primary"
                            title={
                              task?.settings.mode === "team"
                                ? "设为汇总模型"
                                : "设为直接调用模型"
                            }
                            disabled={disabled}
                            onClick={() =>
                              task &&
                              void settings({
                                ...task.settings,
                                primary: refKey(s),
                                capability: AUTO_CAPABILITY,
                              })
                            }
                          >
                            设为主模型
                          </button>
                        )}
                        <IconButton
                          label={`移出任务 ${modelName(s)}`}
                          disabled={disabled}
                          onClick={() => {
                            const p = providers.find(
                              (p) => p.id === s.providerId,
                            );
                            void toggleModel(
                              p || { id: s.providerId },
                              s.modelId,
                            );
                          }}
                        >
                          <X size={13} />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                )}
                {selections.length > 1 && task?.settings.mode !== "team" && (
                  <button
                    className="enable-team"
                    disabled={disabled}
                    onClick={() =>
                      task && void settings({ ...task.settings, mode: "team" })
                    }
                  >
                    <Users size={14} />
                    启用自动协作
                    <ChevronRight size={13} />
                  </button>
                )}
              </section>
              <section className="connections">
                <div
                  className="model-tabs"
                  role="tablist"
                  aria-label="模型来源"
                >
                  <button
                    id="mstar-tab"
                    role="tab"
                    aria-selected={modelTab === "mstar"}
                    aria-controls="mstar-panel"
                    onClick={() => {
                      setModelTab("mstar");
                      setModelSearch("");
                    }}
                  >
                    Mstar
                  </button>
                  <button
                    id="personal-tab"
                    role="tab"
                    aria-selected={modelTab === "personal"}
                    aria-controls="personal-panel"
                    onClick={() => {
                      setModelTab("personal");
                      setModelSearch("");
                    }}
                  >
                    我的模型
                  </button>
                </div>
                {modelTab === "mstar" ? (
                  <div
                    id="mstar-panel"
                    className="model-library"
                    role="tabpanel"
                    aria-labelledby="mstar-tab"
                  >
                    <div className="section-row">
                      <h3>可用模型</h3>
                      <span>{managedProviders.length}</span>
                    </div>
                    {!!managedProviders.length && (
                      <label className="search-field model-search">
                        <Search size={14} />
                        <input
                          aria-label="搜索 Mstar 模型"
                          placeholder="搜索模型名称或能力"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                        />
                      </label>
                    )}
                    {!managedProviders.length ? (
                      <div className="empty-connections">
                        <h3>暂无可用模型</h3>
                        <p>
                          管理员授权并上架模型后，
                          <br />
                          就会显示在这里。
                        </p>
                        <span>如需开通模型，请联系管理员。</span>
                      </div>
                    ) : (
                      <div className="mstar-model-list">
                        {managedProviders
                          .filter((p) =>
                            `${p.name} ${p.models[0].capabilities.map((c) => labels[c] || c).join(" ")}`
                              .toLowerCase()
                              .includes(modelSearch.toLowerCase()),
                          )
                          .map((p) => {
                            const m = p.models[0],
                              chosen = selections.some(
                                (s) =>
                                  s.providerId === p.id && s.modelId === m.id,
                              );
                            return (
                              <button
                                className={`model-option mstar-model ${chosen ? "chosen" : ""}`}
                                key={p.id}
                                aria-pressed={chosen}
                                aria-label={`${chosen ? "移出" : "加入"}任务 ${m.name}`}
                                disabled={disabled}
                                onClick={() => void toggleModel(p, m.id)}
                              >
                                <span className="model-check">
                                  {chosen ? (
                                    <Check size={13} />
                                  ) : (
                                    <Plus size={13} />
                                  )}
                                </span>
                                <span>
                                  <strong>{m.name}</strong>
                                  <small>
                                    {m.capabilities
                                      .map((c) => labels[c] || c)
                                      .join(" · ")}
                                  </small>
                                </span>
                              </button>
                            );
                          })}
                        {!!modelSearch &&
                          !managedProviders.some((p) =>
                            `${p.name} ${p.models[0].capabilities.map((c) => labels[c] || c).join(" ")}`
                              .toLowerCase()
                              .includes(modelSearch.toLowerCase()),
                          ) && <p className="list-empty">没有匹配的模型</p>}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    id="personal-panel"
                    className="model-library"
                    role="tabpanel"
                    aria-labelledby="personal-tab"
                  >
                    <div className="section-row">
                      <h3>我的连接</h3>
                      <span>{personalProviders.length}</span>
                    </div>
                    {personalProviders.length > 0 && (
                      <label className="search-field model-search">
                        <Search size={14} />
                        <input
                          aria-label="搜索连接或模型"
                          placeholder="搜索连接或模型"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                        />
                      </label>
                    )}
                    {!personalProviders.length ? (
                      <div className="empty-connections">
                        <div className="empty-link">
                          <Link2 size={26} />
                        </div>
                        <h3>接入你的第一个模型</h3>
                        <p>
                          一个 Key 下的多个模型，
                          <br />
                          展开就能找到、选用。
                        </p>
                        <button
                          className="outline-button"
                          onClick={() => setProviderForm("new")}
                        >
                          <Plus size={15} />
                          添加连接
                        </button>
                        <span>
                          支持 OpenAI 兼容、Claude、Gemini
                          <br />
                          以及本地模型服务
                        </span>
                      </div>
                    ) : (
                      personalProviders
                        .filter((p) =>
                          `${p.name} ${p.url} ${p.models.map((m) => `${m.id} ${m.name}`).join(" ")}`
                            .toLowerCase()
                            .includes(modelSearch.toLowerCase()),
                        )
                        .map((p) => {
                          const filtered = p.models.filter(
                            (m) =>
                              !modelSearch ||
                              `${p.name} ${m.id} ${m.name}`
                                .toLowerCase()
                                .includes(modelSearch.toLowerCase()),
                          );
                          return (
                            <div className="provider-group" key={p.id}>
                              <div className="provider-header">
                                <ModelDropdown
                                  name={p.name}
                                  modelCount={p.models.length}
                                  visibleCount={filtered.length}
                                  selectedCount={
                                    selections.filter(
                                      (s) => s.providerId === p.id,
                                    ).length
                                  }
                                >
                                  {filtered.map((m) => {
                                    const selected = selections.some(
                                      (s) =>
                                        s.providerId === p.id &&
                                        s.modelId === m.id,
                                    );
                                    return (
                                      <button
                                        key={m.id}
                                        className={`model-option ${selected ? "is-selected" : ""}`}
                                        disabled={disabled || !task}
                                        onClick={() =>
                                          void toggleModel(p, m.id)
                                        }
                                        role="checkbox"
                                        aria-checked={selected}
                                        aria-label={`${selected ? "移出" : "加入"}任务 ${m.id}`}
                                      >
                                        <span className="model-option-text">
                                          <strong title={m.id}>{m.name}</strong>
                                          <small>
                                            {m.capabilities.map((c) => (
                                              <span
                                                className="model-capability-label"
                                                key={c}
                                              >
                                                {labels[c] || c}
                                              </span>
                                            ))}
                                          </small>
                                        </span>
                                        <span
                                          className="model-checkbox"
                                          aria-hidden="true"
                                        >
                                          {selected && <Check size={12} />}
                                        </span>
                                      </button>
                                    );
                                  })}
                                  {!filtered.length && (
                                    <p className="list-empty">没有匹配的模型</p>
                                  )}
                                </ModelDropdown>
                                <IconButton
                                  label={`管理连接 ${p.name}`}
                                  onClick={() => setProviderForm(p)}
                                >
                                  <MoreHorizontal size={17} />
                                </IconButton>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>
                )}
              </section>
            </div>
            <div className="drawer-footer">
              <span className="local-indicator" />
              {modelTab === "mstar"
                ? "模型权限由管理员管理"
                : "个人连接仅在你的工作空间中可见"}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
