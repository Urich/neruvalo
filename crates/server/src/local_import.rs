use super::*;

pub(super) async fn import(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(r): Json<ImportVault>,
) -> Api<Value> {
    let actor = account(&s, &h).await?;
    if Uuid::parse_str(&r.operation_id).is_err() || r.versions.len() > 10000 {
        return Err(invalid());
    }
    let hash = crypto::digest(&ser(&r)?);
    let mut requests = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    let mut chains = std::collections::BTreeMap::<String, (i64, String)>::new();
    for v in &r.versions {
        let previous = chains.get(&v.record_id);
        if !ids.insert(&v.version_id)
            || v.revision != previous.map_or(1, |p| p.0 + 1)
            || v.previous_version.as_ref() != previous.map(|p| &p.1)
            || v.created_at < 0
        {
            return Err(invalid());
        }
        chains.insert(v.record_id.clone(), (v.revision, v.version_id.clone()));
        let save = SaveRecord {
            operation_id: v.operation_id.clone(),
            record_id: v.record_id.clone(),
            version_id: v.version_id.clone(),
            expected_revision: v.revision - 1,
            previous_version: v.previous_version.clone(),
            payload: v.payload.clone(),
            signature: v.signature.clone(),
            archived: v.archived,
        };
        validate_save(&s, &actor, &save).await?;
        requests.push(save);
    }
    let mut tx = s.pool.begin().await?;
    sharing::guard(&mut tx).await?;
    if let Some(row) =
        sqlx::query("SELECT request_hash,result FROM operations WHERE account=$1 AND id=$2")
            .bind(&actor)
            .bind(&r.operation_id)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.get::<String, _>("request_hash") != hash {
            return Err(ApiError(StatusCode::CONFLICT, "OPERATION_ID_REUSED"));
        }
        return Ok(Json(decode(&row.get::<String, _>("result"))?));
    }
    for (save, version) in requests.iter().zip(&r.versions) {
        if let Some(row) = sqlx::query("SELECT v.body,r.account FROM versions v JOIN records r ON r.id=v.record_id WHERE v.id=$1")
            .bind(&version.version_id).fetch_optional(&mut *tx).await? {
            let old: StoredVersion = decode(&row.get::<String,_>("body"))?;
            if row.get::<String,_>("account") != actor || canonical_json(&serde_json::to_value(old).map_err(|_| invalid())?) != canonical_json(&serde_json::to_value(version).map_err(|_| invalid())?) {
                return Err(conflict());
            }
            continue;
        }
        apply_save(&mut tx, &actor, save).await?;
        // Preserve historical timestamps; payloads and signatures are unchanged.
        sqlx::query("UPDATE versions SET body=$1 WHERE id=$2")
            .bind(ser(version)?)
            .bind(&version.version_id)
            .execute(&mut *tx)
            .await?;
    }
    let result = json!({"operation_id":r.operation_id,"imported":r.versions.len()});
    sqlx::query("INSERT INTO operations(account,id,request_hash,result) VALUES($1,$2,$3,$4)")
        .bind(&actor)
        .bind(&r.operation_id)
        .bind(hash)
        .bind(ser(&result)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(result))
}
