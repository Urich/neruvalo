import { Data } from "./model";
import { Icon } from "./Icon";
import { useI18n } from "./i18n";
import { useState } from "react";
export const validIcon = (value?: string | null) => !!value && value.length <= 180000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
// Original KeePass standard icon IDs are retained; use local symbols for display.
const keepassIcons = ["🔑","🌐","⚠️","🖥️","📁","💬","🧩","📝","🌐","🪪","📄","📷","📡","🔑","⚡","🔍","⭐","💿","🖥️","✉️","⚙️","📋","📄","🖥️","⚡","📬","💾","💽","📑","🔒","💻","🖨️","🪟","🏃","🔧","💻","🗄️","💳","🖥️","🗓️","🔍","🗒️","🔑","⭐","🔒","👁️","📋","❓","📦","📁","📂","📁","🔓","🔒","✔️","✏️","🖼️","📖","📋","🔧","🏠","⭐","🐧","💻","🍎","🌍","💰","📜","📱"];
export function EntryIcon({ data, name, label }: { data?: { icon?: string | null; keepass_icon_id?: number | null }; name: string; label?: string }) {
  if (!validIcon(data?.icon) && data?.keepass_icon_id != null && Number.isInteger(data.keepass_icon_id) && keepassIcons[data.keepass_icon_id]) return <span className="keepass-record-icon" aria-label={label} aria-hidden={!label || undefined}>{keepassIcons[data.keepass_icon_id]}</span>;
  return validIcon(data?.icon) ? <img className="custom-record-icon" src={data!.icon ?? undefined} alt={label ?? ""} /> : <Icon name={name} label={label} />;
}
export function IconEditor({ value, builtin, onChange }: { value?: string; builtin?: number; onChange: (icon: string | undefined) => void }) {
  const { t } = useI18n();
  const [error, setError] = useState(false);
  return <div className="icon-editor"><div className="icon-editor-controls"><label>{t("ui.customIcon")}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (file.size > 131072 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError(true); return; }
    const reader = new FileReader();
    reader.onload = () => { const result = String(reader.result); if (validIcon(result)) { setError(false); onChange(result); } else setError(true); };
    reader.onerror = () => setError(true);
    reader.readAsDataURL(file);
  }} /></label>{(value || builtin !== undefined) && <button type="button" className="secondary" onClick={() => onChange(undefined)}>{t("ui.removeIcon")}</button>}</div>{error && <p role="alert">{t("ui.invalidIcon")}</p>}</div>;
}
