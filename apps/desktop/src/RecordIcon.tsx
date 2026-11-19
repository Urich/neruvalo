import { type ChangeEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useI18n } from "./i18n";

const iconFileLimit = 128 * 1024;
const iconFileTypes = ["image/png", "image/jpeg", "image/webp"];
export const validIcon = (value?: string | null) => !!value && value.length <= 180000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
// Original KeePass standard icon IDs are retained; use local symbols for display.
const keepassIcons = ["🔑","🌐","⚠️","🖥️","📁","💬","🧩","📝","🌐","🪪","📄","📷","📡","🔑","⚡","🔍","⭐","💿","🖥️","✉️","⚙️","📋","📄","🖥️","⚡","📬","💾","💽","📑","🔒","💻","🖨️","🪟","🏃","🔧","💻","🗄️","💳","🖥️","🗓️","🔍","🗒️","🔑","⭐","🔒","👁️","📋","❓","📦","📁","📂","📁","🔓","🔒","✔️","✏️","🖼️","📖","📋","🔧","🏠","⭐","🐧","💻","🍎","🌍","💰","📜","📱"];
export function EntryIcon({ data, name, label }: { data?: { icon?: string | null; keepass_icon_id?: number | null }; name: string; label?: string }) {
  if (!validIcon(data?.icon) && data?.keepass_icon_id != null && Number.isInteger(data.keepass_icon_id) && keepassIcons[data.keepass_icon_id]) return <span className="keepass-record-icon" aria-label={label} aria-hidden={!label || undefined}>{keepassIcons[data.keepass_icon_id]}</span>;
  return validIcon(data?.icon) ? <img className="custom-record-icon" src={data!.icon ?? undefined} alt={label ?? ""} /> : <Icon name={name} label={label} />;
}
export function IconEditor({ name, value, builtin, onChange }: {
  name: string;
  value?: string;
  builtin?: number;
  onChange: (icon: string | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const reading = useRef<FileReader | null>(null);
  const [error, setError] = useState(false);
  const hasIcon = Boolean(value) || builtin != null;

  useEffect(() => () => reading.current?.abort(), []);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    reading.current?.abort();
    if (file.size > iconFileLimit || !iconFileTypes.includes(file.type)) {
      setError(true);
      return;
    }

    const reader = new FileReader();
    reading.current = reader;
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string" && validIcon(result)) {
        setError(false);
        onChange(result);
      } else setError(true);
    };
    reader.onerror = () => setError(true);
    reader.onloadend = () => {
      if (reading.current === reader) reading.current = null;
    };
    reader.readAsDataURL(file);
  }

  function removeIcon() {
    reading.current?.abort();
    setError(false);
    onChange(undefined);
  }

  return (
    <div className="icon-editor">
      <input ref={input} hidden type="file" accept={iconFileTypes.join(",")} onChange={selectFile} />
      <div className="icon-editor-controls">
        <button
          type="button"
          className="secondary icon-file-button"
          onClick={() => input.current?.click()}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-formats`}
        >
          <span className="icon-file-preview" aria-hidden="true">
            <EntryIcon name={name} data={{ icon: value, keepass_icon_id: builtin }} />
          </span>
          <span className="icon-file-copy">
            <span id={`${id}-label`}>{t(hasIcon ? "ui.replaceIcon" : "ui.chooseIcon")}</span>
            <small id={`${id}-formats`}>{t("ui.iconFileRequirements")}</small>
          </span>
          <Icon name="folder" />
        </button>
        {hasIcon && <button
          type="button"
          className="secondary icon-file-remove"
          aria-label={t("ui.removeIcon")}
          title={t("ui.removeIcon")}
          onClick={removeIcon}
        >
          <Icon name="trash" />
        </button>}
      </div>
      {error && <p role="alert">{t("ui.invalidIcon")}</p>}
    </div>
  );
}
