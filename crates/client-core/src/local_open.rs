//! Opening an existing vault never uses SQLite's create-if-missing mode.
use super::*;
use std::io::Read;

#[derive(Serialize, Deserialize)]
struct Location {
    database: std::path::PathBuf,
    account_id: String,
    public_sign: String,
}
fn read_profile(path: &Path) -> Result<Profile> {
    ensure!(path.is_file(), "LOCAL_VAULT_FILES_MISSING");
    ensure!(
        std::fs::metadata(path)?.len() <= 64 * 1024,
        "INVALID_LOCAL_VAULT_FILE"
    );
    let p: Profile = decode_profile(&read_limited(path, 64 * 1024)?)
        .map_err(|_| anyhow!("INVALID_LOCAL_VAULT_FILE"))?;
    validate_profile(p)
}
fn validate_profile(p: Profile) -> Result<Profile> {
    ensure!(
        p.kind == ProfileKind::Local
            && p.server.is_empty()
            && p.server_id == "local"
            && p.id.len() <= 128
            && p.id.starts_with("local-")
            && p.id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "INVALID_LOCAL_VAULT_FILE"
    );
    Ok(p)
}
fn location(path: &Path) -> Result<Option<Location>> {
    if !path.exists() {
        return Ok(None);
    }
    ensure!(
        std::fs::metadata(path)?.len() <= 64 * 1024,
        "INVALID_LOCAL_VAULT_FILE"
    );
    Ok(Some(serde_json::from_slice(&std::fs::read(path)?)?))
}
fn matches(link: &Location, p: &Profile) -> bool {
    link.account_id == p.account_id && link.public_sign == p.bundle.public_sign
}

pub(super) async fn profile_for_unlock(
    dir: &Path,
    id: &str,
    p: Profile,
) -> Result<(Profile, PathBuf)> {
    let folder = dir.join(id);
    let Some(link) = location(&folder.join("local-location.json"))? else {
        let mut original = persisted_profile(&folder.join("cache.sqlite3")).await?;
        ensure!(
            original.kind == p.kind
                && original.account_id == p.account_id
                && original.bundle.public_sign == p.bundle.public_sign,
            "VAULT_INTEGRITY: profile identity"
        );
        original.id = id.into();
        original.timeout_seconds = p.timeout_seconds;
        return Ok((original, folder.join("cache.sqlite3")));
    };
    ensure!(
        p.kind == ProfileKind::Local && matches(&link, &p),
        "INVALID_LOCAL_VAULT_FILE"
    );

    // Always reread the original key profile: a remembered link must not retain
    // an obsolete master-password envelope after it changes on another device.
    let mut original = source_profile(&link.database).await?;
    ensure!(matches(&link, &original), "INVALID_LOCAL_VAULT_FILE");
    original.id = id.into();
    original.timeout_seconds = p.timeout_seconds;
    Ok((original, link.database))
}

pub(super) async fn existing_cache(path: &Path) -> Result<AnyPool> {
    ensure!(path.is_file(), "LOCAL_VAULT_FILES_MISSING");
    let mut header = [0; 16];
    std::fs::File::open(path)?
        .read_exact(&mut header)
        .map_err(|_| anyhow!("INVALID_LOCAL_VAULT_FILE"))?;
    ensure!(&header == b"SQLite format 3\0", "INVALID_LOCAL_VAULT_FILE");
    sqlx::any::install_default_drivers();
    // mode=rw fails if the selected file disappears; it cannot create a replacement.
    let url = sqlite_database_url(path)?.replace("?mode=rwc", "?mode=rw");
    let pool = AnyPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    let row = sqlx::query("SELECT value FROM meta WHERE name='schema_version'")
        .fetch_optional(&pool)
        .await
        .map_err(|_| anyhow!("INVALID_LOCAL_VAULT_FILE"))?;
    ensure!(
        row.is_some_and(|r| r.get::<String, _>("value") == DATABASE_SCHEMA),
        "UNSUPPORTED_LOCAL_SCHEMA"
    );
    Ok(pool)
}

async fn source_profile(database: &Path) -> Result<Profile> {
    validate_profile(persisted_profile(database).await?)
}
async fn persisted_profile(database: &Path) -> Result<Profile> {
    let pool = existing_cache(database).await?;
    let row = sqlx::query("SELECT CASE WHEN length(CAST(value AS BLOB))<=65536 THEN value ELSE '' END AS value FROM meta WHERE name='local_profile'")
        .fetch_optional(&pool)
        .await?;
    pool.close().await;
    if let Some(row) = row {
        let raw = row.get::<String, _>("value");
        ensure!(raw.len() <= 64 * 1024, "INVALID_LOCAL_VAULT_FILE");
        return decode_profile(raw.as_bytes());
    }
    anyhow::bail!("VAULT_INTEGRITY: missing embedded profile")
}

pub(super) async fn unlock_candidate(
    profile: Profile,
    path: &Path,
    password: Zeroizing<String>,
    checkpoint_dir: PathBuf,
) -> Result<Unlocked> {
    ensure!(profile.format_version == 3, "UNSUPPORTED_LOCAL_SCHEMA");
    let local = profile.local_kdf.derive(&password)?;
    let root = crypto::parse_key(&crypto::open(
        local.as_ref(),
        &profile.local_root,
        &local_context(&profile.server_id, &profile.account_id, &profile.local_kdf),
    )?)?;
    let raw = crypto::open(
        root.as_ref(),
        &serde_json::from_value(profile.bundle.envelope["keys"].clone())?,
        &keys_context(&profile.server_id, &profile.account_id),
    )?;
    let keys: AccountKeys = serde_json::from_slice(&raw)?;
    ensure!(
        keys.public_sign() == profile.bundle.public_sign
            && keys.public_share() == profile.bundle.public_share,
        "PUBLIC_KEY_MISMATCH"
    );
    let mut unlocked = Unlocked {
        profile,
        keys,
        _root: root,
        token: Zeroizing::new(String::new()),
        last_activity: Instant::now(),
        cache: existing_cache(path).await?,
        online: false,
        needs_sync: false,
        index_cache: BTreeMap::new(),
        attachment_handles: attachments::Handles::default(),
        reports: Default::default(),
        last_report: Default::default(),
        checkpoint_dir,
        freshness: "unconfirmed".into(),
        verified_versions: Default::default(),
    };
    validate_cached_vault(&mut unlocked).await?;
    Ok(unlocked)
}

impl Client {
    /// Relative filenames are stored in the app's vaults folder; absolute paths
    /// remain under user control. Inspection itself never creates directories.
    pub fn local_file_path(&self, value: &str) -> Result<PathBuf> {
        ensure!(
            !value.trim().is_empty() && value.len() <= 32768,
            "INVALID_LOCAL_VAULT_PATH"
        );
        let path = PathBuf::from(value.trim());
        ensure!(
            path.file_name().is_some()
                && !path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir)),
            "INVALID_LOCAL_VAULT_PATH"
        );
        let filename = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| anyhow!("INVALID_LOCAL_VAULT_PATH"))?;
        ensure!(filename.len() <= 255 && !filename.ends_with(['.',' '])
            && !filename.chars().any(|c| c.is_control() || matches!(c,'<'|'>'|':'|'"'|'|'|'?'|'*')), "INVALID_LOCAL_VAULT_PATH");
        let root = if self.dir.is_absolute() {
            self.dir.clone()
        } else {
            std::env::current_dir()?.join(&self.dir)
        };
        Ok(if path.is_absolute() {
            path
        } else {
            root.join("vaults").join(path)
        })
    }
    pub fn local_file_info(&self, value: &str) -> Result<Value> {
        let path = self.local_file_path(value)?;
        let exists = path.try_exists()?;
        ensure!(!exists || path.is_file(), "INVALID_LOCAL_VAULT_PATH");
        if !exists && Path::new(value.trim()).is_absolute() {
            ensure!(
                path.parent().is_some_and(Path::is_dir),
                "LOCAL_VAULT_FOLDER_MISSING"
            );
        }
        Ok(json!({"path":path.to_string_lossy(),"exists":exists}))
    }
    pub async fn create_local_file(
        &mut self,
        value: &str,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        ensure!(self.status()["unlocked"] != true, "LOCK_VAULT_FIRST");
        let path = self.local_file_path(value)?;
        ensure!(!path.exists(), "LOCAL_VAULT_FILE_EXISTS");
        let name = path
            .file_stem()
            .and_then(|v| v.to_str())
            .ok_or_else(|| anyhow!("INVALID_LOCAL_VAULT_PATH"))?;
        let (profile, keys, _) = local::new_profile(name, &password)?;
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("INVALID_LOCAL_VAULT_PATH"))?;
        if !Path::new(value.trim()).is_absolute() {
            std::fs::create_dir_all(parent)?;
        }
        ensure!(parent.is_dir(), "LOCAL_VAULT_FOLDER_MISSING");
        // Exclusive creation is authoritative even if the earlier UI inspection
        // said the path was free. Existing files are never truncated.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                anyhow!("LOCAL_VAULT_FILE_EXISTS")
            } else {
                e.into()
            }
        })?;
        drop(file);
        sqlx::any::install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect(&sqlite_database_url(&path)?.replace("?mode=rwc", "?mode=rw"))
            .await?;
        let setup: Result<()> = async {
            let mut tx = pool.begin().await?;
            for statement in CACHE_SCHEMA.split(';').filter(|s| !s.trim().is_empty()) {
                sqlx::query(statement).execute(&mut *tx).await?;
            }
            sqlx::query("INSERT INTO meta(name,value) VALUES('local_profile',$1)")
                .bind(serde_json::to_string(&profile)?)
                .execute(&mut *tx)
                .await?;
            integrity::initialize(&mut tx, &profile, &keys).await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        pool.close().await;
        if let Err(error) = setup {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        self.open_local(&path, password).await
    }
    /// Open the selected database in place and remember it only after all checks pass.
    pub async fn open_local(
        &mut self,
        selected: &Path,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        ensure!(self.status()["unlocked"] != true, "LOCK_VAULT_FIRST");
        ensure!(selected.is_file(), "LOCAL_VAULT_FILES_MISSING");
        let selected = std::fs::canonicalize(selected)?;
        let parent = selected
            .parent()
            .ok_or_else(|| anyhow!("INVALID_LOCAL_VAULT_FILE"))?;
        let database = if selected.file_name().is_some_and(|s| s == "profile.json") {
            parent.join("cache.sqlite3")
        } else {
            selected.clone()
        };
        ensure!(database.is_file(), "LOCAL_VAULT_FILES_MISSING");
        let database = std::fs::canonicalize(database)?;
        let mut profile = source_profile(&database).await?;
        let managed_database = self.dir.join(&profile.id).join("cache.sqlite3");
        let managed =
            managed_database.is_file() && std::fs::canonicalize(&managed_database)? == database;
        let mut remembered = None;
        if !managed {
            for entry in std::fs::read_dir(&self.dir)? {
                let entry = entry?;
                let Some(link) = location(&entry.path().join("local-location.json"))? else {
                    continue;
                };
                if link.database == database && matches(&link, &profile) {
                    let saved_profile = entry.path().join("profile.json");
                    if !saved_profile.is_file() {
                        continue;
                    }
                    let saved = read_profile(&saved_profile)?;
                    if matches(&link, &saved)
                        && entry.file_name().to_str() == Some(saved.id.as_str())
                    {
                        profile.timeout_seconds = saved.timeout_seconds;
                        remembered = Some(saved.id);
                        break;
                    }
                }
            }
            profile.id = remembered
                .clone()
                .unwrap_or_else(|| format!("local-{}", Uuid::new_v4()));
        }
        let unlocked =
            unlock_candidate(profile, &database, password, self.dir.join("integrity")).await?;
        if !managed {
            let folder = self.dir.join(&unlocked.profile.id);
            if remembered.is_none() {
                std::fs::create_dir_all(&folder)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
                }
                // The profile is the publication marker. Write the location first,
                // so an interrupted registration cannot appear as an empty vault.
                let link = Location {
                    database,
                    account_id: unlocked.profile.account_id.clone(),
                    public_sign: unlocked.profile.bundle.public_sign.clone(),
                };
                std::fs::write(
                    folder.join("local-location.json"),
                    serde_json::to_vec(&link)?,
                )?;
            }
            self.store_profile(&unlocked.profile)?;
        }
        self.active = Some(unlocked);
        Ok(self.status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn password() -> Zeroizing<String> {
        Zeroizing::new("existing local vault password".into())
    }
    fn data(title: &str) -> RecordData {
        RecordData {
            record_type: "note".into(),
            schema_version: 1,
            title: title.into(),
            fields: BTreeMap::new(),
            notes: String::new(),
            folder: String::new(),
            tags: vec![],
            extra: BTreeMap::new(),
        }
    }
    #[tokio::test]
    async fn opens_in_place_remembers_and_deduplicates_existing_vaults() {
        let dir = tempfile::tempdir().unwrap();
        let mut original = Client::new(dir.path().join("source")).unwrap();
        let created = original.create_local("Existing", password()).await.unwrap();
        let original_id = created["profile"].as_str().unwrap();
        original
            .save(None, 0, data("Original"), false)
            .await
            .unwrap();
        original.lock();
        let folder = dir.path().join("source").join(original_id);
        let mut client = Client::new(dir.path().join("app")).unwrap();
        let opened = client
            .open_local(&folder.join("cache.sqlite3"), password())
            .await
            .unwrap();
        let id = opened["profile"].as_str().unwrap().to_owned();
        assert_ne!(id, original_id);
        assert_eq!(client.list().await.unwrap()[0].data.title, "Original");
        client
            .save(None, 0, data("Written in place"), false)
            .await
            .unwrap();
        assert!(!dir
            .path()
            .join("app")
            .join(&id)
            .join("cache.sqlite3")
            .exists());
        client.settings(60).await.unwrap();
        client.lock();
        let reopened = client
            .open_local(&folder.join("profile.json"), password())
            .await
            .unwrap();
        assert_eq!(reopened["profile"], id);
        assert_eq!(reopened["timeout_seconds"], 60);
        assert_eq!(client.profiles().await.unwrap().len(), 1);
        client.lock();
        let mut restarted = Client::new(dir.path().join("app")).unwrap();
        restarted.unlock_offline(&id, password()).await.unwrap();
        assert_eq!(restarted.list().await.unwrap().len(), 2);
        assert_eq!(restarted.status()["timeout_seconds"], 60);
        restarted.lock();
        original
            .unlock_offline(original_id, password())
            .await
            .unwrap();
        assert_eq!(original.list().await.unwrap().len(), 2);
        original.lock();
        let reopened = original
            .open_local(&folder.join("profile.json"), password())
            .await
            .unwrap();
        assert_eq!(reopened["profile"], original_id);
        assert_eq!(original.profiles().await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn failed_open_never_registers_a_profile_or_creates_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut original = Client::new(dir.path().join("source")).unwrap();
        let created = original.create_local("Existing", password()).await.unwrap();
        let folder = dir
            .path()
            .join("source")
            .join(created["profile"].as_str().unwrap());
        let mut client = Client::new(dir.path().join("app")).unwrap();
        assert!(client
            .open_local(
                &folder.join("cache.sqlite3"),
                Zeroizing::new("wrong password".into())
            )
            .await
            .is_err());
        assert_eq!(client.status()["unlocked"], false);
        assert!(client.profiles().await.unwrap().is_empty());
        let empty = dir.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        std::fs::copy(folder.join("profile.json"), empty.join("profile.json")).unwrap();
        let error = client
            .open_local(&empty.join("profile.json"), password())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("LOCAL_VAULT_FILES_MISSING"));
        assert!(!empty.join("cache.sqlite3").exists());
        std::fs::write(empty.join("cache.sqlite3"), b"not a database").unwrap();
        let error = client
            .open_local(&empty.join("cache.sqlite3"), password())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("INVALID_LOCAL_VAULT_FILE"));
        assert_eq!(
            std::fs::read(empty.join("cache.sqlite3")).unwrap(),
            b"not a database"
        );
        assert!(client.profiles().await.unwrap().is_empty());
        sqlx::query("UPDATE meta SET value='999' WHERE name='schema_version'")
            .execute(&original.unlocked().unwrap().cache)
            .await
            .unwrap();
        let error = client
            .open_local(&folder.join("cache.sqlite3"), password())
            .await
            .unwrap_err();
        assert!(is_unsupported_vault_error(&error));
        assert_eq!(client.status()["unlocked"], false);
        assert!(client.profiles().await.unwrap().is_empty());
    }
    #[tokio::test]
    async fn remembered_vault_requires_original_files_and_uses_current_password_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let mut original = Client::new(dir.path().join("source")).unwrap();
        let created = original.create_local("Existing", password()).await.unwrap();
        let source_id = created["profile"].as_str().unwrap();
        let folder = dir.path().join("source").join(source_id);
        let mut client = Client::new(dir.path().join("app")).unwrap();
        let opened = client
            .open_local(&folder.join("profile.json"), password())
            .await
            .unwrap();
        let id = opened["profile"].as_str().unwrap();
        client.lock();
        let new_password = || Zeroizing::new(String::from("changed local vault password"));
        original
            .change_local_password(password(), new_password(), None)
            .await
            .unwrap();
        original.lock();
        assert!(client.unlock_offline(id, password()).await.is_err());
        client.unlock_offline(id, new_password()).await.unwrap();
        client.lock();
        std::fs::remove_file(folder.join("cache.sqlite3")).unwrap();
        let error = client.unlock_offline(id, new_password()).await.unwrap_err();
        assert!(error.to_string().contains("LOCAL_VAULT_FILES_MISSING"));
        assert!(!folder.join("cache.sqlite3").exists());
        assert_eq!(client.status()["unlocked"], false);
    }
    #[tokio::test]
    async fn named_single_file_vault_is_portable_and_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().join("app")).unwrap();
        let info = client.local_file_info("work notes #1.nvdb").unwrap();
        assert_eq!(info["exists"], false);
        assert!(!dir.path().join("app/vaults").exists());
        let created = client
            .create_local_file("work notes #1.nvdb", password())
            .await
            .unwrap();
        let path = PathBuf::from(info["path"].as_str().unwrap());
        assert!(path.is_file());
        assert!(!path.parent().unwrap().join("profile.json").exists());
        assert_eq!(created["login"], "work notes #1");
        let mut record = data("Private record");
        record.notes = "file-vault-secret-never-plaintext".into();
        client.save(None, 0, record, false).await.unwrap();
        let pool = client.unlocked().unwrap().cache.clone();
        client.lock();
        pool.close().await;
        let bytes = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("file-vault-secret-never-plaintext"));
        assert!(client
            .create_local_file("work notes #1.nvdb", password())
            .await
            .unwrap_err()
            .to_string()
            .contains("LOCAL_VAULT_FILE_EXISTS"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let copied = dir.path().join("portable.nvdb");
        std::fs::copy(&path, &copied).unwrap();
        let mut other = Client::new(dir.path().join("other-app")).unwrap();
        assert!(other
            .open_local(&copied, Zeroizing::new("wrong".into()))
            .await
            .is_err());
        assert!(other.profiles().await.unwrap().is_empty());
        let opened = other.open_local(&copied, password()).await.unwrap();
        assert_eq!(
            other.list().await.unwrap()[0].data.notes,
            "file-vault-secret-never-plaintext"
        );
        other.lock();
        other
            .unlock_offline(opened["profile"].as_str().unwrap(), password())
            .await
            .unwrap();
        assert_eq!(other.list().await.unwrap().len(), 1);
        let backup = dir.path().join("single-file.nvbackup");
        other
            .export_local_backup(&backup, password())
            .await
            .unwrap();
        let mut restored = Client::new(dir.path().join("restore")).unwrap();
        restored
            .restore_local_backup(&backup, password())
            .await
            .unwrap();
        assert_eq!(
            restored.list().await.unwrap()[0].data.notes,
            "file-vault-secret-never-plaintext"
        );
    }

    #[tokio::test]
    async fn invalid_paths_and_missing_parent_do_not_create_a_vault() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().join("app")).unwrap();
        for path in ["", "../vault.nvdb", "bad?.nvdb", "bad."] {
            assert!(client.local_file_info(path).is_err(), "{path}");
        }
        let path = dir.path().join("missing/vault.nvdb");
        assert!(client
            .create_local_file(path.to_str().unwrap(), password())
            .await
            .unwrap_err()
            .to_string()
            .contains("LOCAL_VAULT_FOLDER_MISSING"));
        assert!(!path.exists());
        assert!(client.profiles().await.unwrap().is_empty());
    }
}
