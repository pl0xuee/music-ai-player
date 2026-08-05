import { useEffect, useRef, useState } from "react";

export interface PickerOption {
  value: string;
  label: string;
  /** A count or share, set quietly to the right of the label. */
  hint?: string;
}

interface Props {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  /** Accessible name — there is no visible `<label>` beside these. */
  label: string;
  title?: string;
  /** Extra classes for the trigger, e.g. `is-wide` or `is-quiet`. */
  className?: string;
  disabled?: boolean;
}

/**
 * A drop-down that belongs to this window.
 *
 * A native `<select>` is styled everywhere except the one place it matters: the
 * open list is drawn by the toolkit, so on this build it appears as a white
 * panel with a system-blue highlight in the middle of a dark amber interface,
 * looking like a different program has opened on top. `option` cannot be
 * styled around that — the popup is not part of the page — so the list is
 * built here instead.
 *
 * Keyboard behaviour is the part worth keeping honest, since replacing a native
 * control means replacing what it already did: arrows move, Enter and Space
 * choose, Escape closes without changing anything, Home and End jump.
 */
export function Picker({ value, options, onChange, label, title, className, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  const close = (): void => setOpen(false);
  const choose = (index: number): void => {
    const option = options[index];
    if (option !== undefined) onChange(option.value);
    setOpen(false);
  };

  // Opening lands on the current value rather than the top of the list, which
  // is what the native control does and what makes arrow keys predictable.
  useEffect(() => {
    if (open) setActive(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row in view when the list is longer than its box.
  useEffect(() => {
    if (!open || listRef.current === null) return;
    const row = listRef.current.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "ArrowDown":
        event.preventDefault();
        setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        break;
      default:
        break;
    }
  };

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className={className === undefined ? "picker-btn" : `picker-btn ${className}`}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
      >
        <span className="picker-value">{selected?.label ?? ""}</span>
        {selected?.hint !== undefined && <span className="picker-hint">{selected.hint}</span>}
        <svg className="picker-caret" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 10l5 5 5-5" />
        </svg>
      </button>

      {open && (
        <div className="picker-list" role="listbox" aria-label={label} ref={listRef}>
          {options.map((option, index) => {
            const classes = ["picker-opt"];
            if (index === selectedIndex) classes.push("is-selected");
            if (index === active) classes.push("is-active");
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={index === selectedIndex}
                className={classes.join(" ")}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  // `mousedown`, because the outside-click handler above closes
                  // on the way down and a `click` would never arrive.
                  event.preventDefault();
                  choose(index);
                }}
              >
                <span className="picker-opt-label">{option.label}</span>
                {option.hint !== undefined && <span className="picker-hint">{option.hint}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
