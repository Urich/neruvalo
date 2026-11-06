import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n";
import { errorText, Profile } from "./model";

type Action = "connect" | "create_local" | "restore_local_backup" | "export_local_backup" | "import_local";
export function LocalVaultTools({ status, profiles, source, onSource, onChanged, onConnect, busy: parentBusy = false, toolbar = false }: {
  status: { unlocked: boolean; local?: boolean; online?: boolean; profile?: string };
  busy?: boolean;
  toolbar?: boolean;
  profiles: Profile[]; source: string; onSource: (id: string) => void;
  onChanged: () => Promise<void>; onConnect: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const localProfiles = profiles.filter((p) => p.local);
  const titles: Record<Action, string> = {
    connect: "ui.connectLocalVault", create_local: "ui.createLocalVault", restore_local_backup: "ui.restoreLocalBackup",
    export_local_backup: "ui.exportLocalBackup", import_local: "ui.importLocalVault",
  };
  function open(next: Action) { setError(""); setNotice(""); setPassword(""); setConfirmation(""); setAction(next); }
  function close() { if (!busy) { if (action === "import_local") onSource(""); setAction(null); setPassword(""); setConfirmation(""); } }
  useEffect(() => {
    if (source && status.unlocked && status.online && !status.local) open("import_local");
  }, [source, status.profile]);
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => { modal.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [action]);
  async function submit() {
    if (!action || busy) return;
    setBusy(true); setError("");
    try {
      if (action === "connect") {
        await onConnect();
        setAction(null);
        return;
      }
      const result = await invoke("command", { request: {
        action, expected_profile: status.profile, name, password, source_id: source,
      }});
      if (result === null || result === false) return;
      await onChanged();
      setAction(null); setPassword(""); setConfirmation("");
      if (action === "import_local") onSource("");
      setNotice(action === "export_local_backup" ? "ui.backupSaved" : action === "import_local" ? "ui.localImportComplete" : "ui.localVaultReady");
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  return <div className={toolbar ? "local-vault-tools local-vault-toolbar" : "local-vault-tools"}>
    {!status.unlocked && <>
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("create_local")}>{t("ui.createLocalVault")}</button>
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("restore_local_backup")}>{t("ui.restoreLocalBackup")}</button>
    </>}
    {status.local && <>
      {!toolbar && <p>{t("ui.localVaultDescription")}</p>}
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("export_local_backup")}>{t("ui.exportLocalBackup")}</button>
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy || busy} onClick={() => open("connect")}>{t("ui.connectLocalVault")}</button>
    </>}
    {status.unlocked && status.online && !status.local && localProfiles.length > 0 &&
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => { if (!source) onSource(localProfiles[0].id); open("import_local"); }}>{t("ui.importLocalVault")}</button>}
    {notice && <p role="status">{t(notice)}</p>}
    {error && !action && <p role="alert">{t(error)}</p>}
    {action && <dialog ref={dialog} className="discard-dialog local-vault-dialog" onCancel={(event) => { event.preventDefault(); close(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h2>{t(titles[action])}</h2>
        <p>{t(action === "connect" ? "ui.connectLocalVaultHelp" : action === "import_local" ? "ui.localImportHelp" : action === "create_local" ? "ui.localVaultDescription" : "ui.localBackupHelp")}</p>
        {action === "create_local" && <label>{t("ui.vaultName")}<input value={name} maxLength={256} required onChange={(e) => setName(e.target.value)} disabled={busy} /></label>}
        {action === "import_local" && <label>{t("ui.localVault")}<select value={source} disabled={busy} onChange={(e) => onSource(e.target.value)} required>
          {localProfiles.map((p) => <option key={p.id} value={p.id}>{p.login}</option>)}
        </select></label>}
        {action !== "connect" && <label>{t("ui.localMasterPassword")}<input type="password" value={password} autoComplete={action === "create_local" ? "new-password" : "current-password"}
          minLength={action === "create_local" ? 12 : undefined} required onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>}
        {action === "create_local" && <label>{t("ui.confirmMasterPassword")}<input type="password" value={confirmation} autoComplete="new-password"
          required onChange={(e) => setConfirmation(e.target.value)} disabled={busy} /></label>}
        {error && <p role="alert">{t(error)}</p>}
        <div className="discard-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>{t("ui.cancel")}</button>
          <button type="submit" className="primary" disabled={busy || (action !== "connect" && !password) || (action === "create_local" && (password.length < 12 || password !== confirmation || !name.trim())) || (action === "import_local" && !source)}>
            {busy ? t("ui.pleaseWait") : t(titles[action])}
          </button>
        </div>
      </form>
    </dialog>}
  </div>;
}
