import { useState, useRef, useEffect } from "react";
import { Icon } from "./Icon";
import { types } from "./model";
import { useI18n } from "./i18n";
export function TypePicker({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={root}
      className="type-dropdown"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const options = Array.from(
            root.current!.querySelectorAll<HTMLButtonElement>(
              '[role="option"]',
            ),
          );
          const i = options.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          options[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? options.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                  options.length
          ]?.focus();
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-label={t("Тип")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={value} />
        <span>{t(types[value].label)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="listbox" aria-label={t("Тип")} className="type-options">
          {Object.entries(types).map(([key, type]) => (
            <button
              type="button"
              role="option"
              aria-selected={key === value}
              key={key}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                if (key !== value) onChange(key);
              }}
            >
              <Icon name={key} />
              <span>{t(type.label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
