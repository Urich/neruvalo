use super::*;
use tempfile::TempDir;

fn password() -> Zeroizing<String> {
    Zeroizing::new("database integrity fixture password".into())
}
fn data(title: &str) -> RecordData {
    RecordData {
        record_type: "note".into(),
        schema_version: 1,
        title: title.into(),
        fields: BTreeMap::new(),
        notes: "секрет — synthetic only".into(),
        folder: String::new(),
        tags: vec![],
        extra: BTreeMap::new(),
    }
}
async fn fixture() -> (TempDir, Client, String, String) {
    let dir = TempDir::new().unwrap();
    let mut client = Client::new(dir.path().join("client")).unwrap();
    let id = client.create_local("Проверка", password()).await.unwrap()["profile"]
        .as_str()
        .unwrap()
        .to_owned();
    let record = client.save(None, 0, data("Первая"), false).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    client
        .save(Some(record.clone()), 1, data("Вторая"), false)
        .await
        .unwrap();
    (dir, client, id, record)
}
#[tokio::test]
async fn mutations_never_unlock_or_select_an_unverified_head() {
    for mutation in [
        "sql_id",
        "sql_record",
        "sql_revision",
        "old_revision",
        "historical_signature",
        "timestamp",
        "missing_record",
        "missing_tail",
        "missing_first",
        "missing_manifest",
        "foreign_record",
        "extra_signed_record",
    ] {
        let (_dir, mut client, id, record) = fixture().await;
        let a = client.unlocked().unwrap();
        let pool = a.cache.clone();
        match mutation {
            "sql_id" => {
                sqlx::query("UPDATE versions SET id=$1 WHERE revision=1")
                    .bind(Uuid::new_v4().to_string())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "sql_record" => {
                sqlx::query("UPDATE versions SET record_id=$1 WHERE revision=1")
                    .bind(Uuid::new_v4().to_string())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "sql_revision" | "old_revision" => {
                sqlx::query("UPDATE versions SET revision=99 WHERE revision=1")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "historical_signature" | "timestamp" => {
                let row = sqlx::query("SELECT body FROM versions WHERE revision=1")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                let mut version: StoredVersion =
                    serde_json::from_str(&row.get::<String, _>("body")).unwrap();
                if mutation == "timestamp" {
                    version.created_at += 1;
                } else {
                    version.signature = b64([0; 64]);
                }
                sqlx::query("UPDATE versions SET body=$1 WHERE revision=1")
                    .bind(serde_json::to_string(&version).unwrap())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "missing_record" => {
                sqlx::query("DELETE FROM versions WHERE record_id=$1")
                    .bind(&record)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "missing_tail" => {
                sqlx::query("DELETE FROM versions WHERE revision=2")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "missing_first" => {
                sqlx::query("DELETE FROM versions WHERE revision=1")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "missing_manifest" => {
                sqlx::query("DELETE FROM meta WHERE name='manifest'")
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            "foreign_record" | "extra_signed_record" => {
                let mut request = SaveRecord {
                    signature_version: SIGNATURE_VERSION,
                    created_at: signed_time(),
                    manifest: None,
                    operation_id: Uuid::new_v4().to_string(),
                    record_id: Uuid::new_v4().to_string(),
                    version_id: Uuid::new_v4().to_string(),
                    expected_revision: 0,
                    previous_version: None,
                    payload: json!({}),
                    signature: String::new(),
                    archived: false,
                };
                request.payload = attachments::encrypt_record(
                    &a.keys,
                    &data("Injected"),
                    &version_context(
                        &a.profile.server_id,
                        &a.profile.account_id,
                        &request.record_id,
                        &request.version_id,
                    ),
                )
                .unwrap();
                request.signature = a.keys.sign(&record_transcript(
                    if mutation == "foreign_record" {
                        "foreign-server"
                    } else {
                        &a.profile.server_id
                    },
                    &a.profile.account_id,
                    &request,
                ));
                let version = request.stored();
                sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,1,$3)")
                    .bind(&version.version_id)
                    .bind(&version.record_id)
                    .bind(serde_json::to_string(&version).unwrap())
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(client.list().await.is_err(), "live {mutation}");
        client.lock();
        let error = client.unlock_offline(&id, password()).await.unwrap_err();
        assert!(is_unsupported_vault_error(&error), "{mutation}: {error}");
        assert_eq!(client.status()["unlocked"], false, "{mutation}");
    }
}
#[tokio::test]
async fn constraints_reject_nulls_noninteger_revisions_duplicates_and_invalid_json() {
    let (_dir, mut client, _, record) = fixture().await;
    let pool = client.unlocked().unwrap().cache.clone();
    for statement in [
        "INSERT INTO versions(id,record_id,revision,body) VALUES(NULL,'x',1,'{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x',NULL,1,'{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x','x',0,'{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x','x',-1,'{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x','x',1.5,'{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x','x','bad','{}')",
        "INSERT INTO versions(id,record_id,revision,body) VALUES('x','x',1,'broken')",
        "INSERT INTO meta(name,value) VALUES(NULL,'x')",
    ] {
        assert!(
            sqlx::query(statement).execute(&pool).await.is_err(),
            "{statement}"
        );
    }
    assert!(sqlx::query(
        "INSERT INTO versions(id,record_id,revision,body) VALUES('duplicate',$1,1,'{}')"
    )
    .bind(record)
    .execute(&pool)
    .await
    .is_err());
    assert_eq!(client.list().await.unwrap().len(), 1);
}
#[tokio::test]
async fn whole_file_rollback_is_detected_and_commit_checkpoint_gap_can_be_proven() {
    let (dir, mut client, id, record) = fixture().await;
    let anchor = integrity::anchor_path_for_test(client.unlocked().unwrap(), "cache");
    let previous_anchor = std::fs::read(&anchor).unwrap();
    let old_file = dir.path().join("old.sqlite3");
    let pool = client.unlocked().unwrap().cache.clone();
    sqlx::query("VACUUM INTO $1")
        .bind(old_file.to_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    client
        .save(Some(record), 2, data("Третья"), false)
        .await
        .unwrap();
    // Simulate process death after commit but before anchor publication.
    std::fs::write(&anchor, &previous_anchor).unwrap();
    client.lock();
    client.unlock_offline(&id, password()).await.unwrap();
    assert_eq!(client.list().await.unwrap()[0].data.title, "Третья");
    assert_ne!(std::fs::read(&anchor).unwrap(), previous_anchor);
    client.lock();
    pool.close().await;
    std::fs::copy(
        old_file,
        dir.path().join("client").join(&id).join("cache.sqlite3"),
    )
    .unwrap();
    let error = client.unlock_offline(&id, password()).await.unwrap_err();
    assert!(error.to_string().contains("VAULT_ROLLBACK"), "{error}");
}
#[tokio::test]
async fn a_new_device_reports_unknown_freshness_and_moves_keep_the_known_anchor() {
    let (dir, mut original, id, _) = fixture().await;
    let file = dir.path().join("client").join(&id).join("cache.sqlite3");
    original.lock();
    let mut other = Client::new(dir.path().join("other-device")).unwrap();
    assert_eq!(
        other.open_local(&file, password()).await.unwrap()["freshness"],
        "unconfirmed"
    );
    other.lock();
    assert_eq!(
        other.open_local(&file, password()).await.unwrap()["freshness"],
        "confirmed"
    );
}
#[tokio::test]
async fn concurrent_writers_have_one_success_and_one_conflict_without_manifest_drift() {
    let (dir, mut first, id, record) = fixture().await;
    let file = dir.path().join("client").join(&id).join("cache.sqlite3");
    let mut second = Client::new(dir.path().join("second")).unwrap();
    second.open_local(&file, password()).await.unwrap();
    let (a, b) = tokio::join!(
        first.save(Some(record.clone()), 2, data("A"), false),
        second.save(Some(record), 2, data("B"), false)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let error = a.err().or(b.err()).unwrap();
    assert!(
        error.to_string().contains("RECORD_VERSION_MISMATCH"),
        "{error}"
    );
    assert_eq!(first.list().await.unwrap()[0].revision, 3);
}

#[tokio::test]
async fn same_generation_fork_is_detected_after_explicit_backup_restore() {
    let (dir, mut client, id, record) = fixture().await;
    let backup = dir.path().join("branch.nvbackup");
    client
        .export_local_backup(&backup, password())
        .await
        .unwrap();
    client
        .save(Some(record.clone()), 2, data("Branch A"), false)
        .await
        .unwrap();
    client.lock();
    client
        .restore_local_backup(&backup, password())
        .await
        .unwrap();
    client
        .save(Some(record), 2, data("Branch B"), false)
        .await
        .unwrap();
    client.lock();
    let error = client.unlock_offline(&id, password()).await.unwrap_err();
    assert!(error.to_string().contains("VAULT_ROLLBACK"), "{error}");
}

#[tokio::test]
async fn old_schema_is_rejected_without_touching_the_database() {
    let (dir, mut client, id, _) = fixture().await;
    let pool = client.unlocked().unwrap().cache.clone();
    sqlx::query("UPDATE meta SET value='2' WHERE name='schema_version'")
        .execute(&pool)
        .await
        .unwrap();
    client.lock();
    pool.close().await;
    let file = dir.path().join("client").join(&id).join("cache.sqlite3");
    let original = std::fs::read(&file).unwrap();
    let error = client.unlock_offline(&id, password()).await.unwrap_err();
    assert!(error.to_string().contains("UNSUPPORTED_LOCAL_SCHEMA"));
    assert_eq!(std::fs::read(file).unwrap(), original);
}

#[tokio::test]
async fn metadata_and_password_envelope_cannot_be_replayed_independently() {
    let (_dir, mut client, id, _) = fixture().await;
    let a = client.unlocked().unwrap();
    let pool = a.cache.clone();
    let old_profile = serde_json::to_string(&a.profile).unwrap();
    let changed = || Zeroizing::new("new synthetic password for test".into());
    let mut parameters = crypto::PasswordKdf::new();
    parameters.iterations = 4;
    client
        .change_local_password(password(), changed(), Some(parameters))
        .await
        .unwrap();
    assert_eq!(client.unlocked().unwrap().profile.local_kdf.iterations, 4);
    client.lock();
    client.unlock_offline(&id, changed()).await.unwrap();
    assert_eq!(client.list().await.unwrap().len(), 1);
    sqlx::query("UPDATE meta SET value=$1 WHERE name='local_profile'")
        .bind(old_profile)
        .execute(&pool)
        .await
        .unwrap();
    client.lock();
    let error = client.unlock_offline(&id, password()).await.unwrap_err();
    assert!(error.to_string().contains("VAULT_INTEGRITY"), "{error}");
}

#[tokio::test]
#[ignore = "synthetic scale measurement; NERUVALO_BENCH_SCENARIO=349|10000|100000|attachments"]
async fn measure_database_scale() {
    let scenario = std::env::var("NERUVALO_BENCH_SCENARIO").unwrap_or_else(|_| "349".into());
    let (objects, revisions) = match scenario.as_str() {
        "349" => (349, 1),
        "10000" => (10000, 1),
        "100000" => (10000, 10),
        "attachments" => (1, 1),
        _ => panic!("Unknown benchmark"),
    };
    let dir = TempDir::new().unwrap();
    let mut client = Client::new(dir.path().join("client")).unwrap();
    let id = client
        .create_local("Scale fixture", password())
        .await
        .unwrap()["profile"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = Instant::now();
    {
        let a = client.unlocked().unwrap();
        let mut tx = a.cache.begin().await.unwrap();
        let previous = integrity::verify_cached(&mut tx, a).await.unwrap();
        for object in 0..objects {
            let record = Uuid::new_v4().to_string();
            let mut previous_id = None;
            for revision in 1..=revisions {
                let mut data = data(&format!("Synthetic {object}"));
                if scenario == "attachments" {
                    data.schema_version = 2;
                    let bytes = Zeroizing::new(vec![42; MAX_ATTACHMENT_BYTES]);
                    let files: Vec<_> = (0..4)
                        .map(|index| {
                            Attachment::from_bytes(format!("file-{index}.bin"), &bytes).unwrap()
                        })
                        .collect();
                    data.extra.insert("attachments".into(), json!(files));
                }
                let version = Uuid::new_v4().to_string();
                let payload = attachments::encrypt_record(
                    &a.keys,
                    &data,
                    &version_context(
                        &a.profile.server_id,
                        &a.profile.account_id,
                        &record,
                        &version,
                    ),
                )
                .unwrap();
                let mut request = SaveRecord {
                    signature_version: SIGNATURE_VERSION,
                    created_at: signed_time(),
                    manifest: None,
                    operation_id: Uuid::new_v4().to_string(),
                    record_id: record.clone(),
                    version_id: version.clone(),
                    expected_revision: revision - 1,
                    previous_version: previous_id,
                    payload,
                    signature: String::new(),
                    archived: false,
                };
                request.signature = a.keys.sign(&record_transcript(
                    &a.profile.server_id,
                    &a.profile.account_id,
                    &request,
                ));
                let stored = request.stored();
                sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
                    .bind(&stored.version_id)
                    .bind(&stored.record_id)
                    .bind(stored.revision)
                    .bind(serde_json::to_string(&stored).unwrap())
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                previous_id = Some(version);
            }
        }
        integrity::refresh(&mut tx, a, &previous).await.unwrap();
        tx.commit().await.unwrap();
        integrity::checkpoint(a).await.unwrap();
    }
    let build = started.elapsed();
    client.lock();
    let started = Instant::now();
    client.unlock_offline(&id, password()).await.unwrap();
    let open = started.elapsed();
    let started = Instant::now();
    assert_eq!(client.list_summaries().await.unwrap().len(), objects);
    let index = started.elapsed();
    let started = Instant::now();
    client
        .save(None, 0, data("New measured save"), false)
        .await
        .unwrap();
    let save = started.elapsed();
    let size = std::fs::metadata(dir.path().join("client").join(&id).join("cache.sqlite3"))
        .unwrap()
        .len();
    let peak = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|line| line.starts_with("VmHWM:"))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "peak RSS unavailable".into());
    eprintln!("BENCH scenario={scenario} objects={objects} versions={} build_ms={} open_ms={} index_ms={} save_ms={} bytes={size} {peak}",objects*revisions as usize,build.as_millis(),open.as_millis(),index.as_millis(),save.as_millis());
}

#[tokio::test]
async fn disk_full_rolls_back_data_and_manifest_together() {
    let (_dir, mut client, _, _) = fixture().await;
    let a = client.unlocked().unwrap();
    let pool = a.cache.clone();
    let mut tx = pool.begin().await.unwrap();
    let previous = integrity::verify_cached(&mut tx, a).await.unwrap();
    tx.commit().await.unwrap();
    let pages: i64 = sqlx::query("PRAGMA page_count")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get(0);
    sqlx::query(&format!("PRAGMA max_page_count={}", pages + 1))
        .execute(&pool)
        .await
        .unwrap();
    let mut large = data("Will not fit");
    large.schema_version = 2;
    large.extra.insert(
        "attachments".into(),
        json!([
            Attachment::from_bytes("synthetic.bin".into(), &vec![42; MAX_ATTACHMENT_BYTES])
                .unwrap()
        ]),
    );
    assert!(client.save(None, 0, large, false).await.is_err());
    sqlx::query("PRAGMA max_page_count=2147483646")
        .execute(&pool)
        .await
        .unwrap();
    let a = client.unlocked().unwrap();
    let mut tx = pool.begin().await.unwrap();
    let current = integrity::verify_cached(&mut tx, a).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(previous.hash(), current.hash());
    assert_eq!(client.list().await.unwrap().len(), 1);
}

#[test]
fn import_futures_can_cross_the_desktop_command_boundary() {
    fn send<T: Send>(_: T) {}
    let dir = TempDir::new().unwrap();
    let mut client = Client::new(dir.path().to_owned()).unwrap();
    send(client.cancel_keepass_import("ticket"));
    send(client.commit_keepass_import("ticket"));
    send(client.restore_local_backup(Path::new("missing.nvbackup"), password()));
}

#[tokio::test]
async fn operational_metadata_is_authenticated_before_read_and_before_write() {
    let (_dir, mut client, _, _) = fixture().await;
    let a = client.unlocked().unwrap();
    set_meta(
        a,
        "sharing",
        "{\"incoming\":[],\"outgoing\":[],\"revisions\":{}}",
    )
    .await
    .unwrap();
    assert!(integrity::get_meta(a, "sharing").await.unwrap().is_some());
    let pool = a.cache.clone();
    sqlx::query("DELETE FROM meta WHERE name='sharing'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(integrity::get_meta(a, "sharing")
        .await
        .unwrap_err()
        .to_string()
        .contains("VAULT_INTEGRITY"));
    assert!(set_meta(a, "new-state", "value")
        .await
        .unwrap_err()
        .to_string()
        .contains("VAULT_INTEGRITY"));
    assert!(sqlx::query("SELECT value FROM meta WHERE name='new-state'")
        .fetch_optional(&pool)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn backup_and_password_changes_use_the_current_embedded_profile_across_instances() {
    let (dir, mut first, id, _) = fixture().await;
    let mut second = Client::new(dir.path().join("client")).unwrap();
    second.unlock_offline(&id, password()).await.unwrap();
    let next = || Zeroizing::new("new password from another running process".into());
    second
        .change_local_password(password(), next(), None)
        .await
        .unwrap();
    let backup = dir.path().join("snapshot.nvbackup");
    assert!(first
        .export_local_backup(&backup, password())
        .await
        .is_err());
    assert!(!backup.exists());
    assert!(first
        .change_local_password(password(), password(), None)
        .await
        .is_err());
    first.export_local_backup(&backup, next()).await.unwrap();
    let mut restored = Client::new(dir.path().join("restored-client")).unwrap();
    restored
        .restore_local_backup(&backup, next())
        .await
        .unwrap();
    assert_eq!(restored.list().await.unwrap().len(), 1);
    first
        .change_local_password(next(), password(), None)
        .await
        .unwrap();
    first.lock();
    first.unlock_offline(&id, password()).await.unwrap();
    assert_eq!(first.list().await.unwrap().len(), 1);
}
