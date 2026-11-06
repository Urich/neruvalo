import { useI18n } from "./i18n";
import { Profile } from "./model";
import { KeepassImport } from "./KeepassImport";
import { LocalVaultTools } from "./LocalVaultTools";

export function Imports({ status, profiles, source, busy, onSource, onChanged }: {
  status: { unlocked: boolean; online?: boolean; local?: boolean; profile?: string };
  profiles: Profile[]; source: string; busy: boolean;
  onSource: (id: string) => void; onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const online = status.unlocked && status.online && !status.local && status.profile;
  return <div className="imports-page">
    <h1>{t("ui.imports")}</h1>
    {online ? <KeepassImport key={status.profile} profile={status.profile!} disabled={busy} onChanged={onChanged} /> :
      <section className="import-card"><h2>{t("ui.keepassImport")}</h2><p className="muted">{t("ui.importOnlineRequired")}</p></section>}
    <section className="import-card">
      <h2>{t("ui.importLocalVault")}</h2>
      <p className="muted">{t("ui.importLocalDescription")}</p>
      <LocalVaultTools status={status} profiles={profiles} source={source} busy={busy} importsOnly
        onSource={onSource} onChanged={onChanged} onConnect={async () => {}} />
      {!online && <p className="muted">{t("ui.importOnlineRequired")}</p>}
    </section>
    <section className="import-card">
      <h2>{t("ui.restoreLocalBackup")}</h2>
      <p className="muted">{t("ui.importBackupDescription")}</p>
      {status.unlocked ? <p className="muted">{t("ui.importLockFirst")}</p> :
        <LocalVaultTools status={status} profiles={profiles} source="" busy={busy} restoreOnly
          onSource={onSource} onChanged={onChanged} onConnect={async () => {}} />}
    </section>
  </div>;
}
