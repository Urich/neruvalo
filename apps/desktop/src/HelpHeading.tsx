import { useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";

export function HelpHeading({ title, level = 2, children }: {
  title: string;
  level?: 1 | 2;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const Heading = level === 1 ? "h1" : "h2";
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  return (
    <div className="help-heading">
      <Heading id={id}>{title}</Heading>
      <button
        ref={button}
        type="button"
        className="secondary help-button"
        aria-label={title}
        aria-expanded={open}
        aria-controls={open ? `${id}-help` : undefined}
        onClick={() => setOpen(!open)}
      >?</button>
      {open && (
        <aside
          id={`${id}-help`}
          className="help-popup"
          role="dialog"
          aria-labelledby={id}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          {children}
          <button type="button" className="secondary" autoFocus onClick={close}>
            {t("ui.close")}
          </button>
        </aside>
      )}
    </div>
  );
}
