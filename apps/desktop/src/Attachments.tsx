import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Attachment, errorText } from "./model";
import { useI18n } from "./i18n";

export function Attachments({ items = [], profile, disabled = false, onChange }: {
  items?: Attachment[]; profile?: string; disabled?: boolean;
  onChange?: (items: Attachment[]) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (!onChange && !items.length) return null;
  return <section className="attachments" aria-label={t("ui.attachments")}>
    <h3>{t("ui.attachments")}</h3>
    {onChange && <p className="muted">{t("ui.attachmentLimits")}</p>}
    {items.map((item) => <div className="field" key={item.id}>
      <div><span><bdi>{item.name}</bdi> · {(item.size / 1024).toFixed(1)} KiB</span>
        <span>
          <button type="button" className="subtle" disabled={disabled || busy} onClick={() => void run(async () => {
            await invoke("command", { request: { action: "save_attachment", expected_profile: profile, attachment: item } });
          })}>{t("ui.saveAttachment")}</button>
          {onChange && <button type="button" className="subtle" disabled={disabled || busy}
            onClick={() => onChange(items.filter((a) => a.id !== item.id))}>{t("ui.removeAttachment")}</button>}
        </span>
      </div>
    </div>)}
    {onChange && <button type="button" className="secondary" disabled={disabled || busy || items.length >= 16}
      onClick={() => void run(async () => {
        const item = await invoke<Attachment | null>("command", { request: { action: "pick_attachment", expected_profile: profile } });
        if (!item || !mounted.current) return;
        if (items.reduce((sum, a) => sum + a.size, item.size) > 4 * 1024 * 1024) throw new Error("ATTACHMENTS_TOO_LARGE");
        onChange([...items, item]);
      })}>{t("ui.addAttachment")}</button>}
    {error && <p role="alert" className="error">{t(error)}</p>}
  </section>;
}
