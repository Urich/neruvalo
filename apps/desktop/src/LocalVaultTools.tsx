import { SecretInput } from "./SecretInput";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n";
import { errorText, Profile } from "./model";

type Action = "connect" | "create_local" | "restore_local_backup" | "export_local_backup" | "import_local";
export function LocalVaultTools({ status, profiles, source, onSource, onChanged, onConnect, onUnsupportedVault, busy: parentBusy = false, toolbar = false, importsOnly = false, restoreOnly = false }: {
  status: { unlocked: boolean; local?: boolean; online?: boolean; profile?: string };
  onUnsupportedVault?: (error: unknown) => Promise<boolean>;
  busy?: boolean;
  toolbar?: boolean;
  importsOnly?: boolean;
  restoreOnly?: boolean;
  profiles: Profile[]; source: string; onSource: (id: string) => void;
  onChanged: () => Promise<void>; onConnect: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [action, setAction] = useState<Action | null>(null);
  const [filePath, setFilePath] = useState("");
  const [fileInfo, setFileInfo] = useState<{path: string; exists: boolean} | null>(null);
  const [fileChecking, setFileChecking] = useState(false);
  const [fileError, setFileError] = useState("");
  const [fileRevision, setFileRevision] = useState(0);
  const vaultForm = action === "create_local";
  const existing = !!fileInfo?.exists;
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
  function open(next: Action) { setFilePath(""); setFileInfo(null); setFileError(""); setError(""); setNotice(""); setPassword(""); setConfirmation(""); setAction(next); }
  function close() { if (!busy) { if (action === "import_local") onSource(""); setAction(null); setPassword(""); setConfirmation(""); } }
  useEffect(() => {
    if (importsOnly && source && status.unlocked && status.online && !status.local) open("import_local");
  }, [source, status.profile]);
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => { modal.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [action]);
  useEffect(() => {
    if (!vaultForm || !filePath.trim()) { setFileInfo(null); setFileChecking(false); setFileError(""); return; }
    let current = true;
    setFileInfo(null); setFileChecking(true); setFileError("");
    // Discard results for older paths; they must never enable Create/Open for a newer filename.
    invoke<{path: string; exists: boolean}>("command", {request: {action:"local_file_info",path:filePath}})
      .then(info => { if (current) setFileInfo(info); })
      .catch(error => { if (current) setFileError(errorText(error)); })
      .finally(() => { if (current) setFileChecking(false); });
    return () => { current = false; };
  }, [vaultForm, filePath, fileRevision]);
  async function pickTarget(mode: "new" | "existing" = "existing") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const selected = await invoke<string | null>("command", {request: {
        action:"local_pick_target",expected_profile:status.profile,path:filePath,mode,title:t(mode === "new" ? "ui.localNewFile" : "ui.localChooseFile"),
      }});
      if (!selected) return;
      // Choosing a path is separate from creating/opening it; the existence
      // check below determines which action the user can explicitly confirm.
      setFilePath(selected);setFileRevision(value => value + 1);setPassword("");setConfirmation("");
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!action || busy || (vaultForm && (!fileInfo || fileChecking || !password || (!existing && (password.length < 12 || password !== confirmation))))) return;
    setBusy(true); setError("");
    try {
      if (action === "connect") {
        await onConnect();
        setAction(null);
        return;
      }
      const result = await invoke("command", { request: {
        action: vaultForm ? existing ? "open_local_path" : "create_local_file" : action,
        expected_profile: status.profile, password, source_id: source,
        ...(vaultForm ? {path:filePath, ...(existing ? {} : {confirmation})} : {}),
      }});
      if (result === null || result === false) return;
      await onChanged();
      setAction(null); setPassword(""); setConfirmation("");
      if (action === "import_local") onSource("");
      if (action !== "import_local") setNotice(action === "export_local_backup" ? "ui.backupSaved" : "ui.localVaultReady");
    } catch (e) {
      if (onUnsupportedVault && await onUnsupportedVault(e)) {
        setAction(null); setPassword(""); setConfirmation("");
        return;
      }
      if (vaultForm && /LOCAL_VAULT_FILE_EXISTS|LOCAL_VAULT_FILES_MISSING/.test(String(e))) {
        setPassword(""); setConfirmation(""); setFileRevision(value => value + 1);
      }
      setError(errorText(e));
    }
    finally { setBusy(false); }
  }
  const hint = busy ? "ui.pleaseWait" : vaultForm && !filePath.trim() ? "ui.localFilenameRequired"
    : vaultForm && fileChecking ? "ui.localFilenameChecking" : vaultForm && !fileInfo ? fileError || "ui.localFilenameRequired"
    : vaultForm && !existing && password.length < 12 ? "ui.passwordMinimum"
    : vaultForm && !existing && password !== confirmation ? "ui.passwordMismatch"
    : action !== "connect" && !password ? "ui.localMasterPassword" : action === "import_local" && !source ? "ui.localVault" : "";
  return <div className={toolbar ? "local-vault-tools local-vault-toolbar" : "local-vault-tools"}>
    {!importsOnly && !status.unlocked && <>
      {!restoreOnly && <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("create_local")}>{t("ui.createLocalVault")}</button>}
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("restore_local_backup")}>{t("ui.restoreLocalBackup")}</button>
    </>}
    {!importsOnly && !restoreOnly && status.local && <>
      {!toolbar && <p>{t("ui.localVaultDescription")}</p>}
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => open("export_local_backup")}>{t("ui.exportLocalBackup")}</button>
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy || busy} onClick={() => open("connect")}>{t("ui.connectLocalVault")}</button>
    </>}
    {importsOnly && status.unlocked && status.online && !status.local && localProfiles.length > 0 &&
      <button type="button" className={toolbar ? "subtle" : "secondary"} disabled={parentBusy} onClick={() => { if (!source) onSource(localProfiles[0].id); open("import_local"); }}>{t("ui.importLocalVault")}</button>}
    {notice && <p role="status">{t(notice)}</p>}
    {error && !action && <p role="alert">{t(error)}</p>}
    {action && <dialog ref={dialog} className="discard-dialog local-vault-dialog" onCancel={(event) => { event.preventDefault(); close(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <h2>{t(vaultForm ? "ui.localVault" : titles[action])}</h2>
        <p>{t(vaultForm ? "ui.localFileFormHelp" : action === "connect" ? "ui.connectLocalVaultHelp" : action === "import_local" ? "ui.localImportHelp" : "ui.localBackupHelp")}</p>
        {vaultForm && <>
          <label>{t("ui.localVaultFile")}<span className="file-picker-row">
            <input value={filePath} onChange={event => {setFilePath(event.target.value);setFileInfo(null);setError("");}} placeholder="vault.nvdb" disabled={busy} autoFocus required spellCheck={false} dir="ltr" />
          </span></label>
          <div className="local-file-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void pickTarget("new")}>{t("ui.localNewFile")}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void pickTarget("existing")}>{t("ui.localChooseFile")}</button>
          </div>
          {fileInfo && <div className="local-file-summary" role="status">
            <p>{t(existing ? "ui.localFileExists" : "ui.localFileNew")}</p>
            <small dir="ltr">{fileInfo.path}</small>
          </div>}
          {fileError && <p role="alert">{t(fileError)}</p>}
        </>}
        {action === "import_local" && <label>{t("ui.localVault")}<select value={source} disabled={busy} onChange={(e) => onSource(e.target.value)} required>
          {localProfiles.map((p) => <option key={p.id} value={p.id}>{p.login}</option>)}
        </select></label>}
        {action !== "connect" && <label>{t("ui.localMasterPassword")}<SecretInput  value={password} autoComplete={vaultForm && !existing ? "new-password" : "current-password"}
          minLength={vaultForm && !existing ? 12 : undefined} required onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>}
        {vaultForm && !existing && <label>{t("ui.confirmMasterPassword")}<SecretInput  value={confirmation} autoComplete="new-password"
          required onChange={(e) => setConfirmation(e.target.value)} disabled={busy} /></label>}
        {error && <p role="alert">{t(error)}</p>}
        {hint && <p role="status" id="local-vault-hint">{t(hint)}</p>}
        <div className="discard-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>{t("ui.cancel")}</button>
          <button type="submit" aria-describedby="local-vault-hint" title={hint ? t(hint) : undefined} className="primary" disabled={busy || !!hint}>
            {busy ? t("ui.pleaseWait") : vaultForm ? t(existing ? "ui.open" : "ui.createLocalVault") : t(titles[action])}
          </button>
        </div>
      </form>
    </dialog>}
  </div>;
}
