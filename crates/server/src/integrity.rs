use super::*;
use futures_util::TryStreamExt;
use sqlx::AnyConnection;

pub(super) async fn scan(
    conn: &mut AnyConnection,
    s: &AppState,
    actor: &str,
    collect: bool,
) -> anyhow::Result<(VerifiedHistory, Vec<StoredVersion>)> {
    let bundle: AccountBundle = decode(
        &sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
            .bind(actor)
            .fetch_one(&mut *conn)
            .await?
            .try_get::<String, _>("bundle")?,
    )
    .map_err(|_| anyhow::anyhow!("VAULT_INTEGRITY"))?;
    let mut history = VerifiedHistory::default();
    let mut versions = vec![];
    let mut snapshot_bytes = 0usize;
    let mut rows = sqlx::query("SELECT v.id,v.record_id,v.revision,CASE WHEN length(v.body)<=8388608 THEN v.body ELSE '' END AS body FROM versions v JOIN records r ON r.id=v.record_id WHERE r.account=$1 ORDER BY v.record_id,v.revision,v.id").bind(actor).fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let body: String = row.try_get("body")?;
        ensure!(
            !body.is_empty() && body.len() <= MAX_VERSION_BYTES,
            "VAULT_RESOURCE_LIMIT"
        );
        if collect {
            snapshot_bytes += body.len();
            ensure!(snapshot_bytes <= 24 * 1024 * 1024, "VAULT_RESOURCE_LIMIT");
        }
        let id: String = row.try_get("id")?;
        let key = format!("{actor}:{}:{id}", bundle.public_sign);
        let fingerprint = crypto::digest(&body);
        let cached = s
            .verified_versions
            .lock()
            .expect("verification cache")
            .get(&key)
            .filter(|(hash, _)| *hash == fingerprint)
            .cloned();
        let mut decoded = None;
        let stamp = match cached {
            Some((_, stamp)) => stamp,
            None => {
                let version: StoredVersion =
                    serde_json::from_str(&body).map_err(|_| anyhow::anyhow!("VAULT_INTEGRITY"))?;
                let stamp =
                    VerifiedStamp::verify(&s.server_id, actor, &bundle.public_sign, &version)?;
                let mut cache = s.verified_versions.lock().expect("verification cache");
                if cache.len() >= MAX_VERSIONS {
                    cache.clear();
                }
                cache.insert(key, (fingerprint, stamp.clone()));
                decoded = Some(version);
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
        if collect {
            versions.push(match decoded {
                Some(version) => version,
                None => serde_json::from_str(&body)?,
            });
        }
    }
    Ok((history, versions))
}
async fn heads(
    conn: &mut AnyConnection,
    actor: &str,
    manifest: &VaultManifest,
) -> anyhow::Result<()> {
    let mut count = 0usize;
    let mut rows = sqlx::query(
        "SELECT id,version_id,revision,archived FROM records WHERE account=$1 ORDER BY id",
    )
    .bind(actor)
    .fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        let id: String = row.try_get("id")?;
        let head = manifest
            .records
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("VAULT_INTEGRITY: unknown record"))?;
        ensure!(
            head.version_id == row.try_get::<String, _>("version_id")?
                && head.revision == row.try_get::<i64, _>("revision")?
                && i64::from(head.archived) == row.try_get::<i64, _>("archived")?,
            "VAULT_INTEGRITY: record head mismatch"
        );
        count += 1;
    }
    ensure!(
        count == manifest.records.len(),
        "VAULT_INTEGRITY: missing record"
    );
    Ok(())
}
pub(super) async fn current(
    conn: &mut AnyConnection,
    actor: &str,
) -> anyhow::Result<VaultManifest> {
    let row = sqlx::query("SELECT CASE WHEN length(body)<=33554432 THEN body ELSE '' END AS body FROM account_manifests WHERE account=$1").bind(actor).fetch_optional(&mut *conn).await?.ok_or_else(||anyhow::anyhow!("VAULT_INTEGRITY: missing manifest"))?;
    let body = row.try_get::<String, _>("body")?;
    ensure!(
        !body.is_empty() && body.len() <= 32 * 1024 * 1024,
        "VAULT_RESOURCE_LIMIT"
    );
    Ok(serde_json::from_str(&body)?)
}
pub(super) async fn verify(
    conn: &mut AnyConnection,
    s: &AppState,
    actor: &str,
) -> anyhow::Result<VaultManifest> {
    let manifest = current(conn, actor).await?;
    let bundle: AccountBundle = serde_json::from_str(
        &sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
            .bind(actor)
            .fetch_one(&mut *conn)
            .await?
            .try_get::<String, _>("bundle")?,
    )?;
    manifest.verify(
        &s.server_id,
        actor,
        &bundle.public_sign,
        &bundle.public_share,
    )?;
    ensure!(manifest.auxiliary_digest.is_empty(), "VAULT_INTEGRITY");
    let (history, _) = scan(conn, s, actor, false).await?;
    ensure!(
        history.records == manifest.records,
        "VAULT_INTEGRITY: manifest history mismatch"
    );
    heads(conn, actor, &manifest).await?;
    Ok(manifest)
}
pub(super) async fn store(
    conn: &mut AnyConnection,
    actor: &str,
    manifest: &VaultManifest,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO account_manifests(account,body) VALUES($1,$2) ON CONFLICT(account) DO UPDATE SET body=excluded.body").bind(actor).bind(serde_json::to_string(manifest)?).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO manifest_links(account,generation,body) VALUES($1,$2,$3)")
        .bind(actor)
        .bind(manifest.generation as i64)
        .bind(serde_json::to_string(&manifest.link())?)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
pub(super) async fn advance(
    conn: &mut AnyConnection,
    s: &AppState,
    actor: &str,
    candidate: Option<&VaultManifest>,
) -> anyhow::Result<()> {
    let candidate =
        candidate.ok_or_else(|| anyhow::anyhow!("VAULT_INTEGRITY: missing update manifest"))?;
    let previous = current(conn, actor).await?;
    candidate.follows(&previous)?;
    let bundle: AccountBundle = serde_json::from_str(
        &sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
            .bind(actor)
            .fetch_one(&mut *conn)
            .await?
            .try_get::<String, _>("bundle")?,
    )?;
    candidate.verify(
        &s.server_id,
        actor,
        &bundle.public_sign,
        &bundle.public_share,
    )?;
    ensure!(candidate.auxiliary_digest.is_empty(), "VAULT_INTEGRITY");
    let (history, _) = scan(conn, s, actor, false).await?;
    ensure!(
        candidate.records == history.records,
        "VAULT_INTEGRITY: incomplete update manifest"
    );
    heads(conn, actor, candidate).await?;
    store(conn, actor, candidate).await
}
pub(super) async fn links(
    conn: &mut AnyConnection,
    actor: &str,
) -> anyhow::Result<Vec<ManifestLink>> {
    let mut result = vec![];
    let mut rows = sqlx::query("SELECT generation,CASE WHEN length(body)<=4096 THEN body ELSE '' END AS body FROM manifest_links WHERE account=$1 ORDER BY generation").bind(actor).fetch(&mut *conn);
    while let Some(row) = rows.try_next().await? {
        ensure!(result.len() < 100000, "VAULT_RESOURCE_LIMIT");
        let link: ManifestLink = serde_json::from_str(&row.try_get::<String, _>("body")?)?;
        ensure!(
            link.generation as i64 == row.try_get::<i64, _>("generation")?,
            "VAULT_INTEGRITY"
        );
        result.push(link);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn legacy_schema_and_missing_server_keys_are_never_repaired() {
        sqlx::any::install_default_drivers();
        let directory =
            std::env::temp_dir().join(format!("neruvalo-schema-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("server.sqlite3");
        let encoded: String = file
            .to_str()
            .unwrap()
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect();
        let url = format!("sqlite:{encoded}?mode=rwc");
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata(name,value) VALUES('schema_version','2');").execute(&pool).await.unwrap();
        pool.close().await;
        let original = std::fs::read(&file).unwrap();
        let error = application_with_gate(&url, directory.join("outbox"), None)
            .await
            .map(|_| ())
            .expect_err("legacy must fail");
        assert!(error.to_string().contains("UNSUPPORTED_DATABASE_SCHEMA"));
        assert_eq!(std::fs::read(&file).unwrap(), original);
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("UPDATE metadata SET value='3' WHERE name='schema_version'")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let error = application_with_gate(&url, directory.join("outbox"), None)
            .await
            .map(|_| ())
            .expect_err("missing keys must fail");
        assert!(error.to_string().contains("VAULT_INTEGRITY"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
