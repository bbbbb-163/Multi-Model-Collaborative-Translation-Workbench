import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type OptionHTMLAttributes,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";

type SelectProps = {
  value: string | number | undefined;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  "aria-label": string;
};

export default function Select({
  value,
  onChange,
  children,
  className = "",
  disabled = false,
  "aria-label": label,
}: SelectProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pendingIndex = useRef<number | null>(null);
  const search = useRef({ text: "", time: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const options = Children.toArray(children)
    .filter(isValidElement<OptionHTMLAttributes<HTMLOptionElement>>)
    .map(({ props }) => ({
      value: String(props.value ?? ""),
      label: props.label || Children.toArray(props.children).join(""),
      disabled: !!props.disabled,
    }));
  const selected = options.findIndex(
    (option) => option.value === String(value),
  );
  const first = options.findIndex((option) => !option.disabled);

  function close() {
    list.current?.hidePopover();
    if (list.current) delete list.current.dataset.positioned;
    setOpen(false);
  }
  function position() {
    const button = trigger.current;
    const popup = list.current;
    if (!button || !popup) return;
    const anchor = button.getBoundingClientRect();
    popup.style.minWidth = `${Math.min(Math.max(anchor.width, 160), innerWidth - 16)}px`;
    popup.style.maxWidth = `${Math.max(0, Math.min(560, innerWidth - 16))}px`;
    const below = innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    const upwards = below < Math.min(popup.scrollHeight, 240) && above > below;
    popup.style.maxHeight = `${Math.max(0, Math.min(300, upwards ? above : below))}px`;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
    popup.style.top = `${Math.max(8, upwards ? anchor.top - bounds.height - 6 : anchor.bottom + 6)}px`;
    popup.dataset.positioned = "true";
  }
  function show(index = selected >= 0 ? selected : first) {
    if (disabled || first < 0) return;
    pendingIndex.current = index;
    if (list.current) delete list.current.dataset.positioned;
    list.current?.showPopover();
    position();
    setActive(index);
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    trigger.current?.focus({ preventScroll: true });
    if (option.value !== String(value)) onChange(option.value);
  }
  function keys(event: KeyboardEvent<HTMLButtonElement>) {
    const expanded = list.current?.matches(":popover-open");
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      close();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(active);
      else show();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const enabled = options.flatMap((option, index) =>
        option.disabled ? [] : [index],
      );
      if (!enabled.length) return;
      let next = selected >= 0 ? selected : first;
      if (event.key === "Home") next = enabled[0];
      else if (event.key === "End") next = enabled.at(-1)!;
      else if (expanded) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        next =
          enabled[
            (enabled.indexOf(active) + direction + enabled.length) %
              enabled.length
          ];
      }
      if (expanded) setActive(next);
      else show(next);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      search.current.text =
        (now - search.current.time < 700 ? search.current.text : "") +
        event.key.toLocaleLowerCase();
      search.current.time = now;
      const index = options.findIndex(
        (option) =>
          !option.disabled &&
          option.label.toLocaleLowerCase().startsWith(search.current.text),
      );
      if (index >= 0) {
        event.preventDefault();
        if (expanded) setActive(index);
        else show(index);
      }
    }
  }
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const scroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={`select-trigger ${className}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        disabled={disabled || first < 0}
        popoverTarget={id}
        title={options[selected]?.label}
        onClick={() => {
          if (list.current && !list.current.matches(":popover-open")) {
            delete list.current.dataset.positioned;
          }
        }}
        onKeyDown={keys}
        onBlur={() => close()}
      >
        <span>{options[selected]?.label || "请选择"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <div
        ref={list}
        id={id}
        popover="auto"
        role="listbox"
        aria-label={label}
        className="select-dropdown"
        onToggle={(event) => {
          const expanded =
            event.newState === "open" &&
            event.currentTarget.matches(":popover-open");
          if (expanded) {
            position();
            if (pendingIndex.current === null) {
              setActive(selected >= 0 ? selected : first);
            }
            pendingIndex.current = null;
          } else {
            delete event.currentTarget.dataset.positioned;
            search.current = { text: "", time: 0 };
          }
          setOpen(expanded);
        }}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <div
            key={option.value}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === selected}
            aria-disabled={option.disabled || undefined}
            data-index={index}
            data-value={option.value}
            data-active={index === active || undefined}
            className="select-option"
            onPointerMove={() => !option.disabled && setActive(index)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              choose(index);
            }}
          >
            <span>{option.label}</span>
            {index === selected && <Check size={14} aria-hidden="true" />}
          </div>
        ))}
      </div>
    </>
  );
}
