import { useEffect, useId, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";

export default function WorkspaceHelp({ active }: { active: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = useRef(false);
  const [open, setOpen] = useState(false);

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  function position() {
    if (!trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const width = Math.min(380, innerWidth - 24);
    const above = anchor.top - 20;
    const below = innerHeight - anchor.bottom - 20;
    const upwards = above >= below;
    Object.assign(panel.current.style, {
      width: `${width}px`,
      maxHeight: `${Math.max(0, Math.min(420, upwards ? above : below))}px`,
      left: `${Math.max(12, Math.min(anchor.left - 16, innerWidth - width - 12))}px`,
      top: upwards ? `${anchor.top - 10}px` : `${anchor.bottom + 10}px`,
      transform: upwards ? "translateY(-100%)" : "none",
    });
  }
  function show() {
    clearTimer();
    if (!active || !panel.current) return;
    panel.current.showPopover();
    position();
    visible.current = true;
    setOpen(true);
  }
  function hide() {
    clearTimer();
    panel.current?.hidePopover();
    visible.current = false;
    setOpen(false);
  }
  function leave() {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (
        panel.current?.matches(":hover") ||
        trigger.current?.matches(":hover, :focus-visible")
      )
        return;
      hide();
    }, 180);
  }
  useEffect(() => () => clearTimer(), []);
  useEffect(() => {
    if (!active) hide();
  }, [active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !trigger.current?.contains(target) &&
        !panel.current?.contains(target)
      )
        hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !visible.current) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    const scroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) hide();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <div className="workspace-help">
      <button
        ref={trigger}
        type="button"
        className="icon-button workspace-help-trigger"
        aria-label="使用说明"
        aria-describedby={open ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") show();
        }}
        onPointerLeave={leave}
        onFocus={show}
        onBlur={leave}
        onClick={show}
      >
        <CircleHelp size={12} aria-hidden="true" />
      </button>
      <section
        ref={panel}
        id={id}
        className="help-panel"
        role="tooltip"
        popover="manual"
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
      >
        <h2>开始使用</h2>
        <ol>
          <li>在右侧 Mstar 中选择已授权的模型，加入当前任务。</li>
          <li>需要使用自己的模型服务时，切换到「我的模型」添加连接。</li>
          <li>
            单模型直接调用；选择「自动协作」让模型并行工作，或用「顺序执行」设置前后步骤。
          </li>
          <li>把需求、图片或音频发在这里，所有结果都会留在本任务。</li>
        </ol>
        <p>
          Mstar
          的模型权限由管理员管理。停止工作台运行不保证取消远端已经开始的生成任务。
        </p>
      </section>
    </div>
  );
}
