import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export default function ModelDropdown({
  name,
  modelCount,
  visibleCount,
  selectedCount,
  children,
}: {
  name: string;
  modelCount: number;
  visibleCount: number;
  selectedCount: number;
  children: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  function close() {
    popup.current?.hidePopover();
  }
  function position() {
    if (!trigger.current || !popup.current) return;
    const anchor = (
      trigger.current.closest(".provider-header") || trigger.current
    ).getBoundingClientRect();
    const width = Math.min(Math.max(anchor.width, 260), innerWidth - 24);
    const below = innerHeight - anchor.bottom - 16;
    const above = anchor.top - 16;
    const upwards = below < 200 && above > below;
    const height = Math.max(0, Math.min(300, upwards ? above : below));
    Object.assign(popup.current.style, {
      width: `${width}px`,
      maxHeight: `${height}px`,
      left: `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`,
      top: upwards ? `${anchor.top - 6}px` : `${anchor.bottom + 6}px`,
      transform: upwards ? "translateY(-100%)" : "none",
    });
  }
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && popup.current?.matches(":popover-open")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.current?.focus();
      }
    };
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="provider-expand"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        popoverTarget={id}
      >
        <span className="provider-initial" aria-hidden="true">
          {Array.from(name)[0]?.toUpperCase()}
        </span>
        <span className="provider-info">
          <strong title={name}>{name}</strong>
          <small className="provider-meta">
            <span>{modelCount} 个模型</span>
            {selectedCount > 0 && (
              <span className="provider-selected-count">
                已选 {selectedCount}
              </span>
            )}
          </small>
        </span>
        <ChevronDown
          className="provider-chevron"
          size={14}
          aria-hidden="true"
        />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`${name}的模型列表`}
        className="provider-models"
        onToggle={(event) => {
          if (event.newState === "open") position();
          setOpen(event.newState === "open");
        }}
      >
        <div className="provider-models-heading">
          <strong title={name}>{name}</strong>
          <span>
            {visibleCount === modelCount
              ? `${modelCount} 个模型`
              : `${visibleCount} 个匹配`}
            {selectedCount > 0 ? ` · 已选 ${selectedCount}` : ""}
          </span>
        </div>
        <div className="provider-model-options">{children}</div>
      </div>
    </>
  );
}
