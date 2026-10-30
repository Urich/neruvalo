use super::*;
use sqlx::{Any, Transaction};
pub(super) async fn guard(tx: &mut Transaction<'_, Any>) -> Result<(), ApiError> {
    // One portable transaction guard. Prototype favors correctness over write concurrency.
    sqlx::query("UPDATE metadata SET value=value WHERE name='schema_version'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(super) async fn resolve(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(login): Path<String>,
) -> Api<Value> {
    let actor = account(&s, &h).await?;
    rate(&s, &format!("resolve:{actor}")).await?;
    let r = sqlx::query("SELECT id,login,bundle FROM accounts WHERE login=$1")
        .bind(login)
        .fetch_optional(&s.pool)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "ACCOUNT_NOT_FOUND"))?;
    let b: AccountBundle = decode(&r.get::<String, _>("bundle"))?;
    Ok(Json(
        json!({"id":r.get::<String,_>("id"),"login":r.get::<String,_>("login"),"public_sign":b.public_sign,"public_share":b.public_share,"fingerprint":crypto::digest(&format!("{}:{}",b.public_sign,b.public_share))}),
    ))
}
pub(super) async fn snapshot(
    tx: &mut Transaction<'_, Any>,
    actor: &str,
) -> Result<Value, ApiError> {
    let rows=sqlx::query("SELECT s.id,s.copy_id,s.record_id,s.owner,s.recipient,s.state,s.body,a.login,a.bundle,r.sharing_revision FROM shares s JOIN records r ON r.id=s.record_id JOIN accounts a ON a.id=s.recipient WHERE s.owner=$1 AND s.state='active'").bind(actor).fetch_all(&mut **tx).await?;
    let mut outgoing = Vec::new();
    for r in rows {
        let b: AccountBundle = decode(&r.get::<String, _>("bundle"))?;
        outgoing.push(json!({"share_id":r.get::<String,_>("id"),"copy_id":r.get::<String,_>("copy_id"),"record_id":r.get::<String,_>("record_id"),"recipient_id":r.get::<String,_>("recipient"),"recipient_login":r.get::<String,_>("login"),"public_share":b.public_share,"public_sign":b.public_sign,"copy":decode::<Value>(&r.get::<String,_>("body"))?}));
    }
    let rows = sqlx::query("SELECT id,sharing_revision FROM records WHERE account=$1")
        .bind(actor)
        .fetch_all(&mut **tx)
        .await?;
    let revisions: std::collections::BTreeMap<String, i64> = rows
        .iter()
        .map(|r| (r.get("id"), r.get("sharing_revision")))
        .collect();
    let rows=sqlx::query("SELECT s.body,a.login,a.bundle,r.sharing_revision FROM shares s JOIN accounts a ON a.id=s.owner JOIN records r ON r.id=s.record_id WHERE s.recipient=$1 AND s.state='active'").bind(actor).fetch_all(&mut **tx).await?;
    let mut incoming = Vec::new();
    for r in rows {
        let b: AccountBundle = decode(&r.get::<String, _>("bundle"))?;
        incoming.push(json!({"sharing_revision":r.get::<i64,_>("sharing_revision"),"owner_login":r.get::<String,_>("login"),"owner_sign":b.public_sign,"copy":decode::<Value>(&r.get::<String,_>("body"))?}));
    }
    Ok(json!({"outgoing":outgoing,"incoming":incoming,"revisions":revisions}))
}
async fn verify_copy(
    tx: &mut Transaction<'_, Any>,
    s: &AppState,
    c: &SharedCopy,
    owner: &str,
    record: &str,
    version: &str,
    revision: i64,
) -> Result<(), ApiError> {
    if c.format_version != 2
        || c.server_id != s.server_id
        || c.owner_id != owner
        || c.record_id != record
        || c.source_version_id != version
        || c.source_revision != revision
        || c.copy_revision < 1
        || c.recipient_id == owner
        || Uuid::parse_str(&c.share_id).is_err()
        || Uuid::parse_str(&c.copy_id).is_err()
    {
        return Err(invalid());
    }
    let r = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(owner)
        .fetch_one(&mut **tx)
        .await?;
    let b: AccountBundle = decode(&r.get::<String, _>("bundle"))?;
    let r = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&c.recipient_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(invalid())?;
    let recipient: AccountBundle = decode(&r.get::<String, _>("bundle"))?;
    if b.public_sign != c.owner_sign || recipient.public_share != c.recipient_share {
        return Err(ApiError(StatusCode::CONFLICT, "PUBLIC_KEY_MISMATCH"));
    }
    crypto::verify(&b.public_sign, &c.transcript(), &c.signature)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "INVALID_SIGNATURE"))
}
pub(super) async fn apply_updates(
    tx: &mut Transaction<'_, Any>,
    actor: &str,
    r: &SaveRecord,
) -> Result<(), ApiError> {
    let row = sqlx::query("SELECT sharing_revision FROM records WHERE id=$1 AND account=$2")
        .bind(&r.record_id)
        .bind(actor)
        .fetch_one(&mut **tx)
        .await?;
    let revision = row.get::<i64, _>("sharing_revision");
    let expected = r.payload["sharing"]["revision"].as_i64().unwrap_or(0);
    if revision != expected {
        return Err(ApiError(StatusCode::CONFLICT, "SHARING_VERSION_MISMATCH"));
    }
    let rows = sqlx::query(
        "SELECT id,copy_id,recipient,body FROM shares WHERE record_id=$1 AND state='active'",
    )
    .bind(&r.record_id)
    .fetch_all(&mut **tx)
    .await?;
    if r.archived {
        if !rows.is_empty() {
            sqlx::query("UPDATE shares SET state='revoked',body='null' WHERE record_id=$1 AND state='active'").bind(&r.record_id).execute(&mut **tx).await?;
            sqlx::query("UPDATE records SET sharing_revision=sharing_revision+1 WHERE id=$1")
                .bind(&r.record_id)
                .execute(&mut **tx)
                .await?;
        }
        return Ok(());
    }
    let updates: Vec<SharedCopy> =
        serde_json::from_value(r.payload["sharing"]["updates"].clone()).unwrap_or_default();
    if updates.len() != rows.len() {
        return Err(ApiError(StatusCode::CONFLICT, "SHARING_VERSION_MISMATCH"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for c in updates {
        if !seen.insert(c.share_id.clone()) {
            return Err(invalid());
        }
        let old = rows
            .iter()
            .find(|row| row.get::<String, _>("id") == c.share_id)
            .ok_or(invalid())?;
        let previous: SharedCopy = decode(&old.get::<String, _>("body"))?;
        if c.copy_id != old.get::<String, _>("copy_id")
            || c.recipient_id != old.get::<String, _>("recipient")
            || c.copy_revision != previous.copy_revision + 1
        {
            return Err(invalid());
        }
        // The ordinary signature binds this entire update payload; the copy has its own signature.
        if c.record_id != r.record_id
            || c.owner_id != actor
            || c.source_version_id != r.version_id
            || c.source_revision != r.expected_revision + 1
            || c.owner_sign != previous.owner_sign
            || c.recipient_share != previous.recipient_share
            || c.server_id != previous.server_id
            || c.format_version != 2
        {
            return Err(invalid());
        }
        crypto::verify(&c.owner_sign, &c.transcript(), &c.signature)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "INVALID_SIGNATURE"))?;
        sqlx::query("UPDATE shares SET body=$1 WHERE id=$2")
            .bind(ser(&c)?)
            .bind(&c.share_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
pub(super) async fn change(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(r): Json<Value>,
) -> Api<Value> {
    let actor = account(&s, &h).await?;
    let operation = r["operation_id"].as_str().ok_or(invalid())?;
    if Uuid::parse_str(operation).is_err() {
        return Err(invalid());
    }
    let b = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&actor)
        .fetch_one(&s.pool)
        .await?;
    let b: AccountBundle = decode(&b.get::<String, _>("bundle"))?;
    crypto::verify(
        &b.public_sign,
        &share_command_transcript(&s.server_id, &actor, &r),
        r["signature"].as_str().ok_or(invalid())?,
    )
    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "INVALID_SIGNATURE"))?;
    let hash = crypto::digest(&ser(&r)?);
    let mut tx = s.pool.begin().await?;
    guard(&mut tx).await?;
    if let Some(row) =
        sqlx::query("SELECT request_hash,result FROM operations WHERE account=$1 AND id=$2")
            .bind(&actor)
            .bind(operation)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.get::<String, _>("request_hash") != hash {
            return Err(ApiError(StatusCode::CONFLICT, "OPERATION_ID_REUSED"));
        }
        return Ok(Json(decode(&row.get::<String, _>("result"))?));
    }
    let record = r["record_id"].as_str().ok_or(invalid())?;
    let row = sqlx::query(
        "SELECT account,revision,version_id,archived,sharing_revision FROM records WHERE id=$1",
    )
    .bind(record)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(ApiError(StatusCode::FORBIDDEN, "ACCESS_DENIED"))?;
    let owner = row.get::<String, _>("account");
    if r["expected_revision"].as_i64() != Some(row.get("revision")) {
        return Err(conflict());
    }
    if r["expected_sharing_revision"].as_i64() != Some(row.get("sharing_revision")) {
        return Err(ApiError(StatusCode::CONFLICT, "SHARING_VERSION_MISMATCH"));
    }
    match r["kind"].as_str() {
        Some("create") if actor == owner && row.get::<i64, _>("archived") == 0 => {
            let c: SharedCopy = serde_json::from_value(r["copy"].clone()).map_err(|_| invalid())?;
            verify_copy(
                &mut tx,
                &s,
                &c,
                &owner,
                record,
                &row.get::<String, _>("version_id"),
                row.get("revision"),
            )
            .await?;
            if c.copy_revision != 1 {
                return Err(invalid());
            }
            if sqlx::query(
                "SELECT id FROM shares WHERE record_id=$1 AND recipient=$2 AND state='active'",
            )
            .bind(record)
            .bind(&c.recipient_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some()
            {
                return Err(ApiError(StatusCode::CONFLICT, "ALREADY_SHARED"));
            }
            sqlx::query("INSERT INTO shares(id,copy_id,record_id,owner,recipient,state,body) VALUES($1,$2,$3,$4,$5,'active',$6)").bind(&c.share_id).bind(&c.copy_id).bind(record).bind(&owner).bind(&c.recipient_id).bind(ser(&c)?).execute(&mut *tx).await?;
        }
        Some(kind @ ("revoke" | "dismiss")) => {
            let id = r["share_id"].as_str().ok_or(invalid())?;
            let grant=sqlx::query("SELECT owner,recipient FROM shares WHERE id=$1 AND record_id=$2 AND state='active'").bind(id).bind(record).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::FORBIDDEN,"ACCESS_DENIED"))?;
            if (kind == "revoke" && grant.get::<String, _>("owner") != actor)
                || (kind == "dismiss" && grant.get::<String, _>("recipient") != actor)
            {
                return Err(ApiError(StatusCode::FORBIDDEN, "ACCESS_DENIED"));
            }
            sqlx::query("UPDATE shares SET state=$1,body='null' WHERE id=$2")
                .bind(if kind == "revoke" {
                    "revoked"
                } else {
                    "dismissed"
                })
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        _ => return Err(ApiError(StatusCode::FORBIDDEN, "ACCESS_DENIED")),
    }
    sqlx::query("UPDATE records SET sharing_revision=sharing_revision+1 WHERE id=$1")
        .bind(record)
        .execute(&mut *tx)
        .await?;
    let result = json!({"operation_id":operation,"changed":true});
    sqlx::query("INSERT INTO operations(account,id,request_hash,result) VALUES($1,$2,$3,$4)")
        .bind(&actor)
        .bind(operation)
        .bind(hash)
        .bind(ser(&result)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(result))
}
