use super::*;

fn data() -> RecordData {
    RecordData {
        record_type: "login".into(),
        schema_version: 1,
        title: "Format check".into(),
        fields: BTreeMap::new(),
        notes: String::new(),
        folder: String::new(),
        tags: vec![],
        extra: BTreeMap::new(),
    }
}
fn password() -> Zeroizing<String> {
    Zeroizing::new("vault format test password".into())
}

#[tokio::test]
async fn unsupported_local_schema_never_unlocks_or_updates_the_schema() {
    let dir = tempfile::tempdir().unwrap();
    let mut client = Client::new(dir.path().into()).unwrap();
    let profile = client
        .create_local("Format test", password())
        .await
        .unwrap();
    let pool = client.unlocked().unwrap().cache.clone();
    sqlx::query("UPDATE meta SET value='999' WHERE name='schema_version'")
        .execute(&pool)
        .await
        .unwrap();
    client.lock();
    let error = client
        .unlock_offline(profile["profile"].as_str().unwrap(), password())
        .await
        .unwrap_err();
    assert!(is_unsupported_vault_error(&error));
    assert_eq!(client.status()["unlocked"], false);
    let row = sqlx::query("SELECT value FROM meta WHERE name='schema_version'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("value"), "999");
}

#[tokio::test]
async fn incompatible_payloads_history_and_content_never_unlock() {
    for mode in ["legacy", "future", "history", "content", "file"] {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().into()).unwrap();
        let profile = client
            .create_local("Format test", password())
            .await
            .unwrap();
        let saved = client.save(None, 0, data(), false).await.unwrap();
        if mode == "history" {
            client
                .save(
                    Some(saved["record_id"].as_str().unwrap().into()),
                    1,
                    data(),
                    false,
                )
                .await
                .unwrap();
        }
        let a = client.unlocked().unwrap();
        let row =
            sqlx::query("SELECT body FROM versions WHERE record_id=$1 ORDER BY revision LIMIT 1")
                .bind(saved["record_id"].as_str().unwrap())
                .fetch_one(&a.cache)
                .await
                .unwrap();
        let mut version: StoredVersion =
            serde_json::from_str(&row.get::<String, _>("body")).unwrap();
        match mode {
            "legacy" => {
                version.payload = version.payload["record"].take();
            }
            "future" | "history" => {
                version.payload["format_version"] = json!(999);
            }
            "file" => {
                version.payload["files"] = json!({"file": {"format_version":999,"suite":"future"}});
            }
            "content" => {
                let mut future = data();
                future.schema_version = 999;
                version.payload["record"] = serde_json::to_value(
                    crypto::encrypt_version(
                        &a.keys,
                        &serde_json::to_vec(&future).unwrap(),
                        &version_context(
                            &a.profile.server_id,
                            &a.profile.account_id,
                            &version.record_id,
                            &version.version_id,
                        ),
                    )
                    .unwrap(),
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let request = SaveRecord {
            operation_id: version.operation_id.clone(),
            record_id: version.record_id.clone(),
            expected_revision: version.revision - 1,
            version_id: version.version_id.clone(),
            previous_version: version.previous_version.clone(),
            payload: version.payload.clone(),
            signature: String::new(),
            archived: version.archived,
        };
        version.signature = a.keys.sign(&record_transcript(
            &a.profile.server_id,
            &a.profile.account_id,
            &request,
        ));
        sqlx::query("UPDATE versions SET body=$1 WHERE id=$2")
            .bind(serde_json::to_string(&version).unwrap())
            .bind(&version.version_id)
            .execute(&a.cache)
            .await
            .unwrap();
        client.lock();
        let error = client
            .unlock_offline(profile["profile"].as_str().unwrap(), password())
            .await
            .unwrap_err();
        assert!(is_unsupported_vault_error(&error), "{mode}: {error}");
        assert_eq!(client.status()["unlocked"], false, "{mode}");
    }
}
