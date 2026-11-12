import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Plus,
  Trash2,
  ListOrdered,
  X,
} from "lucide-react";
import type {
  WorkflowStep,
  WorkspaceProvider,
  Selection,
} from "../shared/types";
import { refKey, AUTO_CAPABILITY } from "../shared/types";
import { IconButton } from "./components";
import Select from "./Select";

export default function WorkflowEditor({
  steps,
  selections,
  providers,
  disabled,
  onChange,
}: {
  steps: WorkflowStep[];
  selections: Selection[];
  providers: WorkspaceProvider[];
  disabled: boolean;
  onChange: (steps: WorkflowStep[]) => void;
}) {
  const [draft, setDraft] = useState(steps);
  const [open, setOpen] = useState(false);
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLElement>(null);
  useEffect(() => setDraft(steps), [steps]);
  function close() {
    popup.current?.hidePopover();
  }
  function position() {
    const panel = popup.current;
    const button = trigger.current;
    const composer = button?.closest(".composer-area");
    if (!panel || !button || !composer) return;
    const anchor = button.getBoundingClientRect();
    const composerBounds = composer.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(composer).paddingLeft);
    panel.style.width = `${Math.min(640, composerBounds.width - inset * 2, innerWidth - 24)}px`;
    panel.style.maxHeight = `${Math.max(0, Math.min(440, anchor.top - 20))}px`;
    const bounds = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - bounds.width - 12))}px`;
    panel.style.top = "auto";
    panel.style.bottom = `${innerHeight - anchor.top + 8}px`;
    panel.dataset.positioned = "true";
  }
  useEffect(() => {
    if (!open) return;
    const composer = trigger.current?.closest(".composer-area");
    const observer = new ResizeObserver(position);
    if (composer) observer.observe(composer);
    window.addEventListener("resize", close);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", close);
    };
  }, [open]);
  function commit(next: WorkflowStep[]) {
    setDraft(next);
    onChange(next);
  }
  function update(id: string, patch: Partial<WorkflowStep>, save = true) {
    const next = draft.map((s) => (s.id === id ? { ...s, ...patch } : s));
    if (save) commit(next);
    else setDraft(next);
  }
  function add() {
    const s = selections[draft.length % selections.length];
    if (!s) return;
    commit([
      ...draft,
      {
        id: crypto.randomUUID(),
        providerId: s.providerId,
        modelId: s.modelId,
        capability: AUTO_CAPABILITY,
        prompt: "",
        inputSource: "previous",
        optionsJson: "",
      },
    ]);
  }
  const invalid = draft.some(
    (s) => !selections.some((m) => refKey(m) === refKey(s)),
  );
  return (
    <div className="workflow-control">
      <button
        ref={trigger}
        type="button"
        className="workflow-toggle"
        popoverTarget={popupId}
        aria-haspopup="dialog"
        aria-controls={popupId}
        aria-expanded={open}
        aria-label="管理顺序步骤"
      >
        <ListOrdered size={15} />
        <span>顺序步骤</span>
        <small>{draft.length}</small>
        <ChevronDown size={12} />
      </button>
      <section
        ref={popup}
        id={popupId}
        popover="auto"
        role="dialog"
        className="workflow-editor"
        aria-label="顺序执行步骤"
        onToggle={(event) => {
          if (event.target !== event.currentTarget) return;
          const expanded =
            event.newState === "open" &&
            event.currentTarget.matches(":popover-open");
          if (expanded) position();
          else delete event.currentTarget.dataset.positioned;
          setOpen(expanded);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <div className="workflow-heading">
          <div className="workflow-title">
            <ListOrdered size={16} />
            <strong>顺序执行</strong>
            <span>
              {draft.length
                ? `${draft.length} 步 · 自动传递产出`
                : "设置模型的执行顺序"}
            </span>
          </div>
          <div className="workflow-actions">
            <button
              type="button"
              className="text-button"
              onClick={add}
              disabled={disabled || !selections.length || draft.length >= 12}
            >
              <Plus size={13} />
              添加步骤
            </button>
            <IconButton label="关闭顺序步骤" onClick={close}>
              <X size={15} />
            </IconButton>
          </div>
        </div>
        <div className="workflow-steps">
          {!draft.length && (
            <p>
              添加步骤，为每一步选择任务内的模型。下一步默认使用上一步的真实产出。
            </p>
          )}
          {draft.map((step, i) => {
            return (
              <div className="workflow-step" key={step.id}>
                <div className="workflow-step-row">
                  <span className="step-number">{i + 1}</span>
                  <Select
                    className="workflow-model-select"
                    aria-label={`步骤 ${i + 1} 模型`}
                    value={refKey(step)}
                    disabled={disabled}
                    onChange={(value) => {
                      const s = selections.find((s) => refKey(s) === value)!;
                      update(step.id, {
                        providerId: s.providerId,
                        modelId: s.modelId,
                        capability: AUTO_CAPABILITY,
                      });
                    }}
                  >
                    {!selections.some((s) => refKey(s) === refKey(step)) && (
                      <option value={refKey(step)}>模型已移出任务</option>
                    )}
                    {selections.map((s) => (
                      <option key={refKey(s)} value={refKey(s)}>
                        {providers
                          .find((p) => p.id === s.providerId)
                          ?.models.find((m) => m.id === s.modelId)?.name ||
                          "模型已不可用"}{" "}
                        · {providers.find((p) => p.id === s.providerId)?.name}
                      </option>
                    ))}
                  </Select>
                  <IconButton
                    label={`上移步骤 ${i + 1}`}
                    disabled={disabled || !i}
                    onClick={() => {
                      const next = [...draft];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      commit(next);
                    }}
                  >
                    <ArrowUp size={12} />
                  </IconButton>
                  <IconButton
                    label={`下移步骤 ${i + 1}`}
                    disabled={disabled || i === draft.length - 1}
                    onClick={() => {
                      const next = [...draft];
                      [next[i + 1], next[i]] = [next[i], next[i + 1]];
                      commit(next);
                    }}
                  >
                    <ArrowDown size={12} />
                  </IconButton>
                  <IconButton
                    label={`删除步骤 ${i + 1}`}
                    disabled={disabled}
                    onClick={() =>
                      commit(draft.filter((s) => s.id !== step.id))
                    }
                  >
                    <Trash2 size={12} />
                  </IconButton>
                </div>
                <details className="step-details">
                  <summary>
                    <span>
                      {step.prompt ||
                        (i
                          ? "使用上一步的产出，按任务要求继续"
                          : "使用本次任务的要求与附件")}
                    </span>
                    <ChevronDown size={12} />
                  </summary>
                  <div>
                    <label>
                      本步指令{" "}
                      <textarea
                        aria-label={`步骤 ${i + 1} 指令`}
                        rows={2}
                        placeholder="留空使用本次消息，也可以写：将上一步的参考图生成 5 秒视频"
                        value={step.prompt}
                        disabled={disabled}
                        onChange={(e) =>
                          update(step.id, { prompt: e.target.value }, false)
                        }
                        onBlur={() => {
                          if (JSON.stringify(draft) !== JSON.stringify(steps))
                            onChange(draft);
                        }}
                      />
                    </label>
                    <div className="step-detail-bottom">
                      <label>
                        输入来源
                        <Select
                          aria-label={`步骤 ${i + 1} 输入来源`}
                          value={step.inputSource}
                          disabled={disabled}
                          onChange={(value) =>
                            update(step.id, {
                              inputSource: value as WorkflowStep["inputSource"],
                            })
                          }
                        >
                          <option value="previous">
                            {i ? "上一步的产出" : "本次消息与附件"}
                          </option>
                          <option value="original">本次消息与附件</option>
                          <option value="all">所有前序步骤的产出</option>
                        </Select>
                      </label>
                    </div>
                  </div>
                </details>
                {i < draft.length - 1 && (
                  <div className="step-transfer">
                    <ArrowDown size={11} />
                    文字与文件自动交给下一步
                  </div>
                )}
              </div>
            );
          })}
          {invalid && (
            <p className="danger-text">
              有步骤使用了已移出任务的模型，请重新选择。
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
