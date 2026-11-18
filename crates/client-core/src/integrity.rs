//! A single authenticated read/write boundary for local vaults and offline caches.
use super::*;
use futures_util::TryStreamExt;
use sqlx::AnyConnection;

pub(super) async fn scan(conn: &mut AnyConnection, profile: &Profile) -> Result<VerifiedHistory> {
    let mut history = VerifiedHistory::default();
    let mut rows = sqlx::query("SELECT id,record_id,revision,CASE WHEN length(body)<=8388608 THEN body ELSE '' END AS body FROM versions ORDER BY record_id,revision,id").fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let version = row_version(&row)?;
        attachments::validate_payload_format(&version.payload, false)?;
        history.push(
            &profile.server_id,
            &profile.account_id,
            &profile.bundle.public_sign,
            &version,
        )?;
    }
    Ok(history)
}
pub(super) fn row_version(row: &sqlx::any::AnyRow) -> Result<StoredVersion> {
    let body: String = row.try_get("body")?;
    ensure!(
        !body.is_empty() && body.len() <= MAX_VERSION_BYTES,
        "VAULT_RESOURCE_LIMIT"
    );
    let version: StoredVersion = serde_json::from_str(&body)
        .map_err(|_| anyhow!("VAULT_INTEGRITY: invalid version body"))?;
    ensure!(
        row.try_get::<String, _>("id")? == version.version_id
            && row.try_get::<String, _>("record_id")? == version.record_id
            && row.try_get::<i64, _>("revision")? == version.revision,
        "VAULT_INTEGRITY: SQL/JSON mismatch"
    );
    Ok(version)
}
async fn auxiliary(conn: &mut AnyConnection) -> Result<String> {
    let values = metadata(conn).await?;
    let mut hashes = BTreeMap::new();
    for (name, value) in values {
        let value = if name == "local_profile" {
            let mut profile: Value = serde_json::from_str(&value)
                .map_err(|_| anyhow!("VAULT_INTEGRITY: embedded profile"))?;
            let object = profile
                .as_object_mut()
                .ok_or_else(|| anyhow!("VAULT_INTEGRITY"))?;
            object.remove("id");
            object.remove("timeout_seconds");
            canonical_json(&profile)
        } else {
            value
        };
        hashes.insert(name, crypto::digest(&value));
    }
    Ok(crypto::digest(&canonical_json(&serde_json::to_value(
        hashes,
    )?)))
}
pub(super) async fn metadata(conn: &mut AnyConnection) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    let mut bytes = 0usize;
    let mut rows=sqlx::query("SELECT name,CASE WHEN length(value)<=33554432 THEN value ELSE '' END AS value FROM meta WHERE name NOT IN ('manifest','schema_version') ORDER BY name").fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let name: String = row.try_get("name")?;
        let value: String = row.try_get("value")?;
        bytes = bytes
            .checked_add(name.len() + value.len())
            .ok_or_else(|| anyhow!("VAULT_RESOURCE_LIMIT"))?;
        ensure!(
            name.len() <= 256
                && value.len() <= 32 * 1024 * 1024
                && !value.is_empty()
                && bytes <= 64 * 1024 * 1024
                && values.len() < 10000,
            "VAULT_RESOURCE_LIMIT"
        );
        values.insert(name, value);
    }
    Ok(values)
}
pub(super) async fn current(conn: &mut AnyConnection) -> Result<VaultManifest> {
    let row = sqlx::query("SELECT CASE WHEN length(value)<=33554432 THEN value ELSE '' END AS value FROM meta WHERE name='manifest'").fetch_optional(&mut *conn).await?.ok_or_else(|| anyhow!("VAULT_INTEGRITY: missing manifest"))?;
    let body = row.try_get::<String, _>("value")?;
    ensure!(
        !body.is_empty() && body.len() <= 32 * 1024 * 1024,
        "VAULT_RESOURCE_LIMIT"
    );
    serde_json::from_str(&body).map_err(|_| anyhow!("VAULT_INTEGRITY: invalid manifest"))
}
pub(super) async fn verify(conn: &mut AnyConnection, profile: &Profile) -> Result<VaultManifest> {
    let schema = sqlx::query("SELECT value FROM meta WHERE name='schema_version'")
        .fetch_optional(&mut *conn)
        .await?;
    ensure!(
        schema.is_some_and(|r| r.get::<String, _>("value") == DATABASE_SCHEMA),
        "UNSUPPORTED_LOCAL_SCHEMA"
    );
    let manifest = current(conn).await?;
    manifest.verify(
        &profile.server_id,
        &profile.account_id,
        &profile.bundle.public_sign,
        &profile.bundle.public_share,
    )?;
    let history = scan(conn, profile).await?;
    ensure!(
        manifest.records == history.records && manifest.auxiliary_digest == auxiliary(conn).await?,
        "VAULT_INTEGRITY: manifest state mismatch"
    );
    Ok(manifest)
}
pub(super) async fn write(conn: &mut AnyConnection, manifest: &VaultManifest) -> Result<()> {
    sqlx::query("INSERT INTO meta(name,value) VALUES('manifest',$1) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(serde_json::to_string(manifest)?).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO manifest_log(generation,body) VALUES($1,$2)")
        .bind(manifest.generation as i64)
        .bind(serde_json::to_string(&manifest.link())?)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
pub(super) async fn refresh(
    conn: &mut AnyConnection,
    a: &Unlocked,
    previous: &VaultManifest,
) -> Result<VaultManifest> {
    let state = scan_cached(conn, a).await?;
    let manifest = VaultManifest::create(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.keys,
        state.records,
        Some(previous),
        auxiliary(conn).await?,
    )?;
    write(conn, &manifest).await?;
    Ok(manifest)
}
pub(super) async fn initialize(
    conn: &mut AnyConnection,
    profile: &Profile,
    keys: &AccountKeys,
) -> Result<()> {
    ensure!(
        sqlx::query("SELECT value FROM meta WHERE name='manifest'")
            .fetch_optional(&mut *conn)
            .await?
            .is_none(),
        "VAULT_INTEGRITY: already initialized"
    );
    let state = scan(conn, profile).await?;
    let manifest = VaultManifest::create(
        &profile.server_id,
        &profile.account_id,
        keys,
        state.records,
        None,
        auxiliary(conn).await?,
    )?;
    write(conn, &manifest).await?;
    Ok(())
}
pub(super) async fn links(conn: &mut AnyConnection) -> Result<Vec<ManifestLink>> {
    let mut result = vec![];
    let mut rows = sqlx::query("SELECT generation,CASE WHEN length(body)<=4096 THEN body ELSE '' END AS body FROM manifest_log ORDER BY generation").fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        ensure!(result.len() < 100_000, "VAULT_RESOURCE_LIMIT");
        let link: ManifestLink = serde_json::from_str(&row.try_get::<String, _>("body")?)
            .map_err(|_| anyhow!("VAULT_INTEGRITY: manifest log"))?;
        ensure!(
            row.try_get::<i64, _>("generation")? == link.generation as i64,
            "VAULT_INTEGRITY"
        );
        result.push(link);
    }
    Ok(result)
}
fn anchor_path(a: &Unlocked, realm: &str) -> PathBuf {
    a.checkpoint_dir.join(format!(
        "{}.json",
        crypto::digest(&format!(
            "{realm}:{}:{}",
            a.profile.server_id, a.profile.account_id
        ))
    ))
}
pub(super) fn check_anchor(
    a: &Unlocked,
    realm: &str,
    manifest: &VaultManifest,
    links: &[ManifestLink],
) -> Result<bool> {
    let path = anchor_path(a, realm);
    if !path.exists() {
        return Ok(false);
    }
    ensure!(
        std::fs::metadata(&path)?.len() <= 4096,
        "VAULT_INTEGRITY: checkpoint size"
    );
    let anchor: ManifestLink = serde_json::from_slice(&std::fs::read(path)?)
        .map_err(|_| anyhow!("VAULT_INTEGRITY: checkpoint"))?;
    anchor.verify(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.profile.bundle.public_sign,
    )?;
    ensure!(manifest.generation >= anchor.generation, "VAULT_ROLLBACK");
    let mut current = anchor;
    for next in links
        .iter()
        .filter(|link| link.generation > current.generation)
        .cloned()
        .collect::<Vec<_>>()
    {
        if next.generation > manifest.generation {
            break;
        }
        next.verify(
            &a.profile.server_id,
            &a.profile.account_id,
            &a.profile.bundle.public_sign,
        )?;
        ensure!(
            next.generation == current.generation + 1
                && next.previous_hash == current.manifest_hash,
            "VAULT_INTEGRITY: unproven checkpoint advance"
        );
        current = next;
    }
    ensure!(
        current.generation == manifest.generation && current.manifest_hash == manifest.hash(),
        "VAULT_ROLLBACK"
    );
    Ok(true)
}
pub(super) fn publish_anchor(
    a: &Unlocked,
    realm: &str,
    manifest: &VaultManifest,
    proof: &[ManifestLink],
    explicit_restore: bool,
) -> Result<()> {
    std::fs::create_dir_all(&a.checkpoint_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&a.checkpoint_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = anchor_path(a, realm);
    let lock_path = path.with_extension("lock");
    let mut lock_options = std::fs::OpenOptions::new();
    lock_options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        lock_options.mode(0o600);
    }
    let lock = lock_options.open(lock_path)?;
    lock.lock()?;
    if !explicit_restore {
        check_anchor(a, realm, manifest, proof)?;
    }
    let temporary = a.checkpoint_dir.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec(&manifest.link())?)?;
    file.sync_all()?;
    drop(file);
    // Atomic replacement on supported platforms; a failed replacement retains the old anchor.
    std::fs::rename(&temporary, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })?;
    #[cfg(unix)]
    {
        std::fs::File::open(&a.checkpoint_dir)?.sync_all()?;
    }
    Ok(())
}
pub(super) async fn checkpoint(a: &Unlocked) -> Result<bool> {
    let mut tx = a.cache.begin().await?;
    let manifest = verify_cached(&mut tx, a).await?;
    let log = links(&mut tx).await?;
    let confirmed = check_anchor(a, "cache", &manifest, &log)?;
    tx.commit().await?;
    publish_anchor(a, "cache", &manifest, &log, false)?;
    Ok(confirmed)
}
/// Return only authenticated heads, within the same database snapshot as the manifest check.
pub(super) async fn read(
    a: &Unlocked,
    ids: Option<&[String]>,
    history: bool,
) -> Result<Vec<StoredVersion>> {
    let mut tx = a.cache.begin().await?;
    let manifest = verify_cached(&mut tx, a).await?;
    let log = links(&mut tx).await?;
    check_anchor(a, "cache", &manifest, &log)?;
    let mut result = Vec::new();
    for (record, head) in &manifest.records {
        if ids.is_some_and(|ids| !ids.contains(record)) {
            continue;
        }
        let query = if history {
            "SELECT id,record_id,revision,body FROM versions WHERE record_id=$1 ORDER BY revision"
        } else {
            "SELECT id,record_id,revision,body FROM versions WHERE id=$1"
        };
        let mut rows = sqlx::query(query)
            .bind(if history { record } else { &head.version_id })
            .fetch(&mut *tx);
        while let Some(row) = rows.try_next().await? {
            result.push(row_version(&row)?);
        }
    }
    tx.commit().await?;
    publish_anchor(a, "cache", &manifest, &log, false)?;
    Ok(result)
}
pub(super) async fn attach_request(a: &Unlocked, request: &mut Value) -> Result<()> {
    let versions = read(a, None, true).await?;
    let mut combined: BTreeMap<String, StoredVersion> = versions
        .into_iter()
        .map(|v| (v.version_id.clone(), v))
        .collect();
    let added: Vec<StoredVersion> = if let Some(v) = request.get("versions") {
        serde_json::from_value(v.clone())?
    } else if let Some(v) = request.get("records") {
        serde_json::from_value::<Vec<SaveRecord>>(v.clone())?
            .iter()
            .map(SaveRecord::stored)
            .collect()
    } else {
        vec![serde_json::from_value::<SaveRecord>(request.clone())?.stored()]
    };
    for version in added {
        if let Some(previous) = combined.get(&version.version_id) {
            ensure!(
                canonical_json(&serde_json::to_value(previous)?)
                    == canonical_json(&serde_json::to_value(&version)?),
                "VAULT_INTEGRITY"
            );
        }
        combined.insert(version.version_id.clone(), version);
    }
    let history = VerifiedHistory::from_versions(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.profile.bundle.public_sign,
        &combined.into_values().collect::<Vec<_>>(),
    )?;
    let row = sqlx::query("SELECT value FROM meta WHERE name='owner_manifest'")
        .fetch_one(&a.cache)
        .await?;
    let previous: VaultManifest = serde_json::from_str(&row.get::<String, _>("value"))?;
    previous.verify(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.profile.bundle.public_sign,
        &a.profile.bundle.public_share,
    )?;
    request["manifest"] = serde_json::to_value(VaultManifest::create(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.keys,
        history.records,
        Some(&previous),
        String::new(),
    )?)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn anchor_path_for_test(a: &Unlocked, realm: &str) -> PathBuf {
    anchor_path(a, realm)
}

pub(super) async fn scan_cached(conn: &mut AnyConnection, a: &Unlocked) -> Result<VerifiedHistory> {
    let mut history = VerifiedHistory::default();
    let mut rows = sqlx::query("SELECT id,record_id,revision,CASE WHEN length(body)<=8388608 THEN body ELSE '' END AS body FROM versions ORDER BY record_id,revision,id").fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let body: String = row.try_get("body")?;
        ensure!(
            !body.is_empty() && body.len() <= MAX_VERSION_BYTES,
            "VAULT_RESOURCE_LIMIT"
        );
        let id: String = row.try_get("id")?;
        let fingerprint = crypto::digest(&body);
        let cached = a
            .verified_versions
            .lock()
            .expect("verification cache")
            .get(&id)
            .filter(|(hash, _)| *hash == fingerprint)
            .cloned();
        let stamp = match cached {
            Some((_, stamp)) => stamp,
            None => {
                let version: StoredVersion = serde_json::from_str(&body)
                    .map_err(|_| anyhow!("VAULT_INTEGRITY: version JSON"))?;
                attachments::validate_payload_format(&version.payload, false)?;
                let stamp = VerifiedStamp::verify(
                    &a.profile.server_id,
                    &a.profile.account_id,
                    &a.profile.bundle.public_sign,
                    &version,
                )?;
                let mut cache = a.verified_versions.lock().expect("verification cache");
                if cache.len() >= MAX_VERSIONS {
                    cache.clear();
                }
                cache.insert(id.clone(), (fingerprint, stamp.clone()));
                stamp
            }
        };
        ensure!(
            stamp.matches_sql(
                &id,
                &row.try_get::<String, _>("record_id")?,
                row.try_get("revision")?
            ),
            "VAULT_INTEGRITY: SQL/JSON mismatch"
        );
        history.accept(&stamp)?;
    }
    Ok(history)
}
pub(super) async fn verify_cached(conn: &mut AnyConnection, a: &Unlocked) -> Result<VaultManifest> {
    let schema = sqlx::query("SELECT value FROM meta WHERE name='schema_version'")
        .fetch_optional(&mut *conn)
        .await?;
    ensure!(
        schema.is_some_and(|r| r.get::<String, _>("value") == DATABASE_SCHEMA),
        "UNSUPPORTED_LOCAL_SCHEMA"
    );
    let manifest = current(conn).await?;
    manifest.verify(
        &a.profile.server_id,
        &a.profile.account_id,
        &a.profile.bundle.public_sign,
        &a.profile.bundle.public_share,
    )?;
    let history = scan_cached(conn, a).await?;
    ensure!(
        manifest.records == history.records && manifest.auxiliary_digest == auxiliary(conn).await?,
        "VAULT_INTEGRITY: manifest state mismatch"
    );
    check_anchor(a, "cache", &manifest, &links(conn).await?)?;
    Ok(manifest)
}

pub(super) async fn index(a: &mut Unlocked, ids: Option<&[String]>) -> Result<Vec<ViewRecord>> {
    let pool = a.cache.clone();
    let mut tx = pool.begin().await?;
    let manifest = verify_cached(&mut tx, a).await?;
    let log = links(&mut tx).await?;
    check_anchor(a, "cache", &manifest, &log)?;
    let mut result = Vec::new();
    for (record, head) in &manifest.records {
        if ids.is_some_and(|ids| !ids.contains(record)) {
            continue;
        }
        let row = sqlx::query("SELECT id,record_id,revision,body FROM versions WHERE id=$1")
            .bind(&head.version_id)
            .fetch_one(&mut *tx)
            .await?;
        ensure!(
            row.try_get::<String, _>("id")? == head.version_id
                && row.try_get::<String, _>("record_id")? == *record
                && row.try_get::<i64, _>("revision")? == head.revision,
            "VAULT_INTEGRITY"
        );
        result.push(index_view(
            a,
            &head.version_id,
            &row.try_get::<String, _>("body")?,
        )?);
    }
    if ids.is_none() {
        let retained: std::collections::BTreeSet<_> = manifest
            .records
            .values()
            .map(|head| head.version_id.as_str())
            .collect();
        a.index_cache.retain(|id, _| retained.contains(id.as_str()));
    }
    tx.commit().await?;
    publish_anchor(a, "cache", &manifest, &log, false)?;
    Ok(result)
}

pub(super) async fn backup_snapshot(
    a: &Unlocked,
) -> Result<(
    VaultManifest,
    Vec<ManifestLink>,
    Vec<StoredVersion>,
    BTreeMap<String, String>,
)> {
    let mut tx = a.cache.begin().await?;
    let manifest = verify_cached(&mut tx, a).await?;
    let log = links(&mut tx).await?;
    check_anchor(a, "cache", &manifest, &log)?;
    let metadata = metadata(&mut tx).await?;
    let mut versions = Vec::new();
    let mut backup_bytes = metadata.values().map(String::len).sum::<usize>();
    let mut rows =
        sqlx::query("SELECT id,record_id,revision,body FROM versions ORDER BY record_id,revision")
            .fetch(&mut *tx);
    while let Some(row) = rows.try_next().await? {
        backup_bytes += row.try_get::<String, _>("body")?.len();
        ensure!(backup_bytes <= 32 * 1024 * 1024, "BACKUP_TOO_LARGE");
        versions.push(row_version(&row)?);
    }
    drop(rows);
    tx.commit().await?;
    Ok((manifest, log, versions, metadata))
}

/// Read protected operational metadata from the snapshot that authenticated it.
pub(super) async fn get_meta(a: &Unlocked, name: &str) -> Result<Option<String>> {
    let mut tx = a.cache.begin().await?;
    let manifest = verify_cached(&mut tx, a).await?;
    let proof = links(&mut tx).await?;
    let value = sqlx::query("SELECT value FROM meta WHERE name=$1")
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| row.try_get::<String, _>("value"))
        .transpose()?;
    tx.commit().await?;
    publish_anchor(a, "cache", &manifest, &proof, false)?;
    Ok(value)
}
