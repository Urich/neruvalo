use super::*;
use std::collections::BTreeSet;

const BACKUP_CONTEXT: &[u8] = b"neruvalo-local-backup-v1";

#[derive(Serialize, Deserialize)]
struct Backup {
    format: String,
    version: u32,
    salt: String,
    envelope: Envelope,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    profile: Profile,
    versions: Vec<StoredVersion>,
}
#[derive(Default, Serialize, Deserialize)]
struct Transfer {
    ids: BTreeMap<String, String>,
    versions: BTreeMap<String, StoredVersion>,
    fingerprint: String,
    operation: String,
}

async fn versions(a: &Unlocked) -> Result<Vec<StoredVersion>> {
    sqlx::query("SELECT body FROM versions ORDER BY record_id,revision")
        .fetch_all(&a.cache)
        .await?
        .into_iter()
        .map(|r| Ok(serde_json::from_str(&r.get::<String, _>("body"))?))
        .collect()
}

/// Apply all local changes in one transaction, including subtree archive changes.
pub(super) async fn commit(
    a: &Unlocked,
    records: &[SaveRecord],
    snapshot: Option<&BTreeMap<String, i64>>,
) -> Result<Value> {
    let mut tx = a.cache.begin().await?;
    // Take a SQLite write lock before checking the snapshot (also across processes).
    sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
        .execute(&mut *tx)
        .await?;
    if let Some(expected) = snapshot {
        let rows = sqlx::query(
            "SELECT record_id,MAX(revision) AS revision FROM versions GROUP BY record_id",
        )
        .fetch_all(&mut *tx)
        .await?;
        let actual: BTreeMap<String, i64> = rows
            .into_iter()
            .map(|r| (r.get("record_id"), r.get("revision")))
            .collect();
        ensure!(&actual == expected, "RECORD_VERSION_MISMATCH");
    }
    for r in records {
        let latest = sqlx::query(
            "SELECT body FROM versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1",
        )
        .bind(&r.record_id)
        .fetch_optional(&mut *tx)
        .await?;
        let previous: Option<StoredVersion> = latest
            .map(|v| serde_json::from_str(&v.get::<String, _>("body")))
            .transpose()?;
        ensure!(
            previous.as_ref().map_or(0, |v| v.revision) == r.expected_revision
                && previous.as_ref().map(|v| &v.version_id) == r.previous_version.as_ref(),
            "RECORD_VERSION_MISMATCH"
        );
        let v = StoredVersion {
            operation_id: r.operation_id.clone(),
            record_id: r.record_id.clone(),
            version_id: r.version_id.clone(),
            revision: r.expected_revision + 1,
            previous_version: r.previous_version.clone(),
            payload: r.payload.clone(),
            signature: r.signature.clone(),
            archived: r.archived,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs() as i64,
        };
        verify_version(&a.profile, &v)?;
        sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
            .bind(&v.version_id)
            .bind(&v.record_id)
            .bind(v.revision)
            .bind(serde_json::to_string(&v)?)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    let r = records.first().ok_or_else(|| anyhow!("EMPTY_OPERATION"))?;
    Ok(json!({"record_id":r.record_id,"version_id":r.version_id,"revision":r.expected_revision+1}))
}

impl Client {
    pub async fn create_local(&mut self, name: &str, password: Zeroizing<String>) -> Result<Value> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 256,
            "INVALID_VAULT_NAME"
        );
        ensure!(
            password.len() >= 12,
            "Use a master password of at least 12 characters"
        );
        let id = format!("local-{}", Uuid::new_v4());
        let root = Zeroizing::new(crypto::random::<32>());
        let keys = AccountKeys::generate();
        let salt = crypto::random::<16>();
        let password_key = crypto::password_key(&password, &salt)?;
        let keys_envelope = crypto::seal(
            root.as_ref(),
            &Zeroizing::new(serde_json::to_vec(&keys)?),
            &keys_context("local", &id),
        )?;
        let profile = Profile {
            kind: ProfileKind::Local,
            id: id.clone(),
            server: String::new(),
            server_id: "local".into(),
            account_id: id.clone(),
            login: name.trim().into(),
            opaque_public: String::new(),
            bundle: AccountBundle {
                envelope: json!({"keys":keys_envelope}),
                public_sign: keys.public_sign(),
                public_share: keys.public_share(),
                recovery: None,
            },
            local_salt: b64(salt),
            local_root: crypto::seal(
                password_key.as_ref(),
                root.as_ref(),
                &local_context("local", &id),
            )?,
            timeout_seconds: 300,
        };
        let db = cache(&self.dir, &id).await?;
        self.store_profile(&profile)?;
        self.lock();
        self.active = Some(Unlocked {
            profile,
            keys,
            _root: root,
            token: Zeroizing::new(String::new()),
            last_activity: Instant::now(),
            cache: db,
            online: false,
            needs_sync: false,
        });
        Ok(self.status())
    }

    pub async fn export_local_backup(
        &mut self,
        path: &Path,
        password: Zeroizing<String>,
    ) -> Result<()> {
        let a = self.unlocked()?;
        ensure!(
            a.profile.kind == ProfileKind::Local,
            "LOCAL_PROFILE_REQUIRED"
        );
        // Authenticate the supplied password before using it to protect a backup.
        let local = crypto::password_key(&password, &unb64(&a.profile.local_salt)?)?;
        let root = Zeroizing::new(crypto::open(
            local.as_ref(),
            &a.profile.local_root,
            &local_context(&a.profile.server_id, &a.profile.account_id),
        )?);
        ensure!(root.as_slice() == a._root.as_ref(), "INVALID_PASSWORD");
        let snapshot = Snapshot {
            profile: a.profile.clone(),
            versions: versions(a).await?,
        };
        let salt = crypto::random::<16>();
        let key = crypto::password_key(&password, &salt)?;
        let raw = Zeroizing::new(serde_json::to_vec(&snapshot)?);
        let backup = Backup {
            format: "neruvalo-local-backup".into(),
            version: 1,
            salt: b64(salt),
            envelope: crypto::seal(key.as_ref(), &raw, BACKUP_CONTEXT)?,
        };
        // Never overwrite an existing backup or the active profile through a file picker.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let encoded = serde_json::to_vec(&backup)?;
        ensure!(encoded.len() <= 64 * 1024 * 1024, "BACKUP_TOO_LARGE");
        let mut file = options.open(path)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        Ok(())
    }

    pub async fn restore_local_backup(
        &mut self,
        path: &Path,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        ensure!(
            std::fs::metadata(path)?.len() <= 64 * 1024 * 1024,
            "BACKUP_TOO_LARGE"
        );
        let backup: Backup = serde_json::from_slice(&std::fs::read(path)?)?;
        ensure!(
            backup.format == "neruvalo-local-backup" && backup.version == 1,
            "UNSUPPORTED_BACKUP"
        );
        let key = crypto::password_key(&password, &unb64(&backup.salt)?)?;
        let raw = Zeroizing::new(crypto::open(
            key.as_ref(),
            &backup.envelope,
            BACKUP_CONTEXT,
        )?);
        let mut snapshot: Snapshot = serde_json::from_slice(&raw)?;
        ensure!(
            snapshot.profile.kind == ProfileKind::Local && snapshot.profile.server.is_empty(),
            "INVALID_BACKUP"
        );
        let local = crypto::password_key(&password, &unb64(&snapshot.profile.local_salt)?)?;
        let root = crypto::parse_key(&crypto::open(
            local.as_ref(),
            &snapshot.profile.local_root,
            &local_context(&snapshot.profile.server_id, &snapshot.profile.account_id),
        )?)?;
        let raw_keys = Zeroizing::new(crypto::open(
            root.as_ref(),
            &serde_json::from_value(snapshot.profile.bundle.envelope["keys"].clone())?,
            &keys_context(&snapshot.profile.server_id, &snapshot.profile.account_id),
        )?);
        let keys: AccountKeys = serde_json::from_slice(&raw_keys)?;
        ensure!(
            keys.public_sign() == snapshot.profile.bundle.public_sign
                && keys.public_share() == snapshot.profile.bundle.public_share,
            "PUBLIC_KEY_MISMATCH"
        );
        // A restore is a new local profile; existing profiles are never replaced.
        snapshot.profile.id = format!("local-{}", Uuid::new_v4());
        let db = cache(&self.dir, &snapshot.profile.id).await?;
        let restored = Unlocked {
            profile: snapshot.profile,
            keys,
            _root: root,
            token: Zeroizing::new(String::new()),
            last_activity: Instant::now(),
            cache: db,
            online: false,
            needs_sync: false,
        };
        let mut chains = BTreeMap::<String, (i64, String)>::new();
        let mut ids = BTreeSet::new();
        for v in &snapshot.versions {
            ensure!(ids.insert(&v.version_id), "INVALID_BACKUP");
            let previous = chains.get(&v.record_id);
            ensure!(
                v.revision == previous.map_or(1, |p| p.0 + 1)
                    && v.previous_version.as_ref() == previous.map(|p| &p.1),
                "INVALID_BACKUP"
            );
            view(&restored, v)?.data.validate()?;
            chains.insert(v.record_id.clone(), (v.revision, v.version_id.clone()));
        }
        let mut tx = restored.cache.begin().await?;
        for v in &snapshot.versions {
            sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
                .bind(&v.version_id)
                .bind(&v.record_id)
                .bind(v.revision)
                .bind(serde_json::to_string(v)?)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        self.store_profile(&restored.profile)?;
        self.lock();
        self.active = Some(restored);
        Ok(self.status())
    }

    /// Run while signed into the destination. The original local vault stays intact.
    pub async fn import_local(
        &mut self,
        source_id: &str,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        let mut source = Client::new(self.dir.clone())?;
        source.unlock_offline(source_id, password).await?;
        let src = source.unlocked()?;
        ensure!(
            src.profile.kind == ProfileKind::Local,
            "LOCAL_PROFILE_REQUIRED"
        );
        let original = versions(src).await?;
        ensure!(original.len() <= 10000, "IMPORT_TOO_LARGE");
        let http = self.http.clone();
        let target = self.unlocked()?;
        ensure!(
            target.profile.kind == ProfileKind::Server && target.online && !target.token.is_empty(),
            "ONLINE_LOGIN_REQUIRED"
        );
        let journal_name = format!("local-transfer:{}", target.profile.id);
        let context = format!("neruvalo-local-transfer-v1:{}", target.profile.id);
        // Serialize journal creation across app processes before allocating IDs.
        let mut journal_tx = src.cache.begin().await?;
        sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
            .execute(&mut *journal_tx)
            .await?;
        let stored = sqlx::query("SELECT value FROM meta WHERE name=$1")
            .bind(&journal_name)
            .fetch_optional(&mut *journal_tx)
            .await?;
        let mut transfer: Transfer = match stored {
            Some(row) => {
                let envelope: Envelope = serde_json::from_str(&row.get::<String, _>("value"))?;
                serde_json::from_slice(&Zeroizing::new(crypto::open(
                    src._root.as_ref(),
                    &envelope,
                    context.as_bytes(),
                )?))?
            }
            None => Transfer::default(),
        };
        for v in &original {
            transfer
                .ids
                .entry(v.record_id.clone())
                .or_insert_with(|| Uuid::new_v4().to_string());
            transfer
                .ids
                .entry(v.version_id.clone())
                .or_insert_with(|| Uuid::new_v4().to_string());
        }
        for v in &original {
            if transfer.versions.contains_key(&v.version_id) {
                continue;
            }
            let mut data = view(src, v)?.data;
            data.validate()?;
            for key in ["group_id", "parent_group_id"] {
                if let Some(id) = data.extra.get(key).and_then(Value::as_str) {
                    let mapped = transfer
                        .ids
                        .get(id)
                        .ok_or_else(|| anyhow!("INVALID_GROUP"))?
                        .clone();
                    data.extra.insert(key.into(), json!(mapped));
                }
            }
            let record_id = transfer.ids[&v.record_id].clone();
            let version_id = transfer.ids[&v.version_id].clone();
            let payload = crypto::encrypt_version(
                &target.keys,
                &Zeroizing::new(serde_json::to_vec(&data)?),
                &version_context(
                    &target.profile.server_id,
                    &target.profile.account_id,
                    &record_id,
                    &version_id,
                ),
            )?;
            let mut r = SaveRecord {
                operation_id: Uuid::new_v4().to_string(),
                record_id,
                version_id,
                expected_revision: v.revision - 1,
                previous_version: v
                    .previous_version
                    .as_ref()
                    .map(|id| transfer.ids[id].clone()),
                payload: serde_json::to_value(payload)?,
                signature: String::new(),
                archived: v.archived,
            };
            r.signature = target.keys.sign(&record_transcript(
                &target.profile.server_id,
                &target.profile.account_id,
                &r,
            ));
            transfer.versions.insert(
                v.version_id.clone(),
                StoredVersion {
                    operation_id: r.operation_id,
                    record_id: r.record_id,
                    version_id: r.version_id,
                    revision: v.revision,
                    previous_version: r.previous_version,
                    payload: r.payload,
                    signature: r.signature,
                    archived: v.archived,
                    created_at: v.created_at,
                },
            );
        }
        let fingerprint = crypto::digest(&serde_json::to_string(&original)?);
        if transfer.fingerprint != fingerprint {
            transfer.fingerprint = fingerprint;
            transfer.operation = Uuid::new_v4().to_string();
        }
        let envelope = crypto::seal(
            src._root.as_ref(),
            &Zeroizing::new(serde_json::to_vec(&transfer)?),
            context.as_bytes(),
        )?;
        sqlx::query("INSERT INTO meta(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
            .bind(&journal_name).bind(serde_json::to_string(&envelope)?).execute(&mut *journal_tx).await?;
        journal_tx.commit().await?;
        let request = ImportVault {
            operation_id: transfer.operation,
            versions: original
                .iter()
                .map(|v| transfer.versions[&v.version_id].clone())
                .collect(),
        };
        ensure!(
            serde_json::to_vec(&request)?.len() <= 32 * 1024 * 1024,
            "IMPORT_TOO_LARGE"
        );
        let _: Value = response(
            http.post(format!("{}/api/v1/vault/import", target.profile.server))
                .bearer_auth(target.token.as_str())
                .json(&request)
                .send()
                .await?,
        )
        .await?;
        self.sync().await?;
        let target = self.unlocked()?;
        let received: BTreeMap<String, StoredVersion> = versions(target)
            .await?
            .into_iter()
            .map(|v| (v.version_id.clone(), v))
            .collect();
        for expected in &request.versions {
            let actual = received
                .get(&expected.version_id)
                .ok_or_else(|| anyhow!("IMPORT_VERIFICATION_FAILED"))?;
            ensure!(
                canonical_json(&serde_json::to_value(actual)?)
                    == canonical_json(&serde_json::to_value(expected)?),
                "IMPORT_VERIFICATION_FAILED"
            );
            view(target, actual)?.data.validate()?;
        }
        Ok(
            json!({"imported":request.versions.len(),"source_profile":source_id,"profile":target.profile.id}),
        )
    }
}
