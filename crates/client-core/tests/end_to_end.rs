use neruvalo_client::{Client, Profile, RecordData};
use neruvalo_crypto as crypto;
use neruvalo_protocol::{SaveRecord, StoredVersion};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};
use tempfile::TempDir;
use zeroize::Zeroizing;

fn password() -> Zeroizing<String> {
    Zeroizing::new("correct horse neruvalo prototype".into())
}
fn data(title: &str, secret: &str) -> RecordData {
    RecordData {
        record_type: "login".into(),
        schema_version: 1,
        title: title.into(),
        fields: BTreeMap::from([("password".into(), secret.into())]),
        notes: String::new(),
        folder: String::new(),
        tags: vec![],
        extra: BTreeMap::new(),
    }
}
async fn start(dir: &Path) -> (String, tokio::task::JoinHandle<()>) {
    let url = std::env::var("NERUVALO_TEST_DATABASE_URL").unwrap_or_else(|_| {
        neruvalo_client::sqlite_database_url(&dir.join("server.sqlite3")).unwrap()
    });
    if std::env::var("NERUVALO_TEST_DATABASE_URL").is_ok() {
        sqlx::any::install_default_drivers();
        let pool = sqlx::AnyPool::connect(&url).await.unwrap();
        // Restart within the same test reuses the database; a new test starts with a fresh schema.
        if !dir.join("postgres-initialized").exists() {
            sqlx::raw_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
                .execute(&pool)
                .await
                .unwrap();
            std::fs::write(dir.join("postgres-initialized"), b"test database").unwrap();
        }
        pool.close().await;
    }
    let app = neruvalo_server::application(&url, dir.join("outbox"))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (server, handle)
}
async fn register(
    c: &mut Client,
    server: &str,
    login: &str,
    dir: &Path,
) -> Option<Zeroizing<String>> {
    let begin = c
        .register_begin(
            server,
            login,
            &format!("{login}@example.test"),
            password(),
            true,
        )
        .await
        .unwrap();
    let file = dir
        .join("outbox")
        .join(format!("{}.txt", begin["ticket"].as_str().unwrap()));
    let email = std::fs::read_to_string(file).unwrap();
    let code = email
        .lines()
        .find_map(|l| l.strip_prefix("Confirmation code: "))
        .unwrap();
    c.register_finish(server, code).await.unwrap();
    c.take_certificate()
}

#[tokio::test]
async fn encrypted_lifecycle_conflict_offline_recovery_and_server_restart() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let (server, handle) = start(root).await;
    let mut a = Client::new(root.join("Client A #50% Пример")).unwrap();
    let certificate = register(&mut a, &server, "alice", root).await.unwrap();
    assert!(a
        .login(&server, "alice", Zeroizing::new("wrong password".into()))
        .await
        .is_err());
    a.login(&server, "alice", password()).await.unwrap();
    let saved = a
        .save(
            None,
            0,
            data("Mail", "never-on-the-server-in-cleartext"),
            false,
        )
        .await
        .unwrap();
    let id = saved["record_id"].as_str().unwrap();
    let mut b = Client::new(root.join("client-b")).unwrap();
    b.login(&server, "alice", password()).await.unwrap();
    a.save(
        Some(id.into()),
        1,
        data("Mail changed", "second secret"),
        false,
    )
    .await
    .unwrap();
    let error = b
        .save(Some(id.into()), 1, data("Stale", "lost update"), false)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "RECORD_VERSION_MISMATCH");
    assert_eq!(
        b.save(Some(id.into()), 1, data("Again", "stale"), false)
            .await
            .unwrap_err()
            .to_string(),
        "SYNCHRONIZATION_REQUIRED"
    );
    b.sync().await.unwrap();
    assert_eq!(b.history(id).await.unwrap().len(), 2);
    b.save(Some(id.into()), 2, data("Archived", "second secret"), true)
        .await
        .unwrap();
    assert!(b.list().await.unwrap()[0].archived);
    b.save(Some(id.into()), 3, data("Restored", "second secret"), false)
        .await
        .unwrap();
    assert_eq!(b.history(id).await.unwrap().len(), 4);
    let profile_id = b.profiles().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    b.lock();
    b.unlock_offline(&profile_id, password()).await.unwrap();
    assert_eq!(b.history(id).await.unwrap().len(), 4);
    assert_eq!(
        b.save(None, 0, data("Offline", "no"), false)
            .await
            .unwrap_err()
            .to_string(),
        "OFFLINE_READ_ONLY"
    );
    // Another account must never see Alice's records.
    let mut other = Client::new(root.join("other")).unwrap();
    register(&mut other, &server, "bob", root).await;
    other.login(&server, "bob", password()).await.unwrap();
    assert!(other.list().await.unwrap().is_empty());
    let mut recovery = Client::new(root.join("recovery")).unwrap();
    let new_password = || Zeroizing::new("replacement master password".into());
    recovery.recover(certificate, new_password()).await.unwrap();
    assert_eq!(a.sync().await.unwrap_err().to_string(), "AUTH_FAILED");
    assert!(recovery.login(&server, "alice", password()).await.is_err());
    recovery
        .login(&server, "alice", new_password())
        .await
        .unwrap();
    assert_eq!(recovery.history(id).await.unwrap().len(), 4);
    handle.abort();
    let _ = handle.await;
    let (server2, handle2) = start(root).await;
    // Persistent OPAQUE setup permits login after process restart (origin changes in this test only).
    let mut fresh = Client::new(root.join("fresh")).unwrap();
    fresh
        .login(&server2, "alice", new_password())
        .await
        .unwrap();
    assert_eq!(
        fresh.list().await.unwrap()[0].data.fields["password"],
        "second secret"
    );
    handle2.abort();
    if std::env::var("NERUVALO_TEST_DATABASE_URL").is_err() {
        let bytes = std::fs::read(root.join("server.sqlite3")).unwrap();
        assert!(!bytes
            .windows(b"never-on-the-server-in-cleartext".len())
            .any(|w| w == b"never-on-the-server-in-cleartext"));
    }
}

#[tokio::test]
async fn server_idempotency_authorization_and_tampered_requests() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let (server, handle) = start(root).await;
    let mut c = Client::new(root.join("client")).unwrap();
    register(&mut c, &server, "carol", root).await;
    c.login(&server, "carol", password()).await.unwrap();
    let first = c
        .save(None, 0, data("Private", "private secret"), false)
        .await
        .unwrap();
    let profile_id = c.profiles().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let profile: Profile = serde_json::from_slice(
        &std::fs::read(root.join("client").join(&profile_id).join("profile.json")).unwrap(),
    )
    .unwrap();
    // Obtain a session through the real OPAQUE protocol, rather than bypassing authentication.
    use neruvalo_protocol::{LoginBegin, LoginChallenge, LoginFinish, LoginResponse};
    use opaque_ke::{
        rand::rngs::OsRng, ClientLogin, ClientLoginFinishParameters, CredentialResponse,
        Identifiers,
    };
    let http = reqwest::Client::new();
    let start = ClientLogin::<crypto::Suite>::start(&mut OsRng, password().as_bytes()).unwrap();
    let ch: LoginChallenge = http
        .post(format!("{server}/api/v1/auth/begin"))
        .json(&LoginBegin {
            login: "carol".into(),
            message: crypto::b64(start.message.serialize()),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let kdf = crypto::kdf();
    let finish = start
        .state
        .finish(
            &mut OsRng,
            password().as_bytes(),
            CredentialResponse::deserialize(&crypto::unb64(&ch.message).unwrap()).unwrap(),
            ClientLoginFinishParameters::new(
                Some(b"neruvalo-login-v1"),
                Identifiers {
                    client: Some(ch.account_id.as_bytes()),
                    server: Some(profile.server_id.as_bytes()),
                },
                Some(&kdf),
            ),
        )
        .unwrap();
    let session: LoginResponse = http
        .post(format!("{server}/api/v1/auth/finish"))
        .json(&LoginFinish {
            ticket: ch.ticket,
            message: crypto::b64(finish.message.serialize()),
        })
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let snap: Value = http
        .get(format!("{server}/api/v1/snapshot"))
        .bearer_auth(&session.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let v: StoredVersion = serde_json::from_value(snap["versions"][0].clone()).unwrap();
    let mut request = SaveRecord {
        operation_id: v.operation_id,
        record_id: v.record_id,
        expected_revision: 0,
        version_id: v.version_id,
        previous_version: None,
        payload: v.payload,
        signature: v.signature,
        archived: false,
    };
    let replay = http
        .post(format!("{server}/api/v1/records/save"))
        .bearer_auth(&session.token)
        .json(&request)
        .send()
        .await
        .unwrap();
    assert!(replay.status().is_success());
    assert_eq!(replay.json::<Value>().await.unwrap(), first);
    // Reconstruct and replay a committed batch exactly as after a lost response.
    c.archive_tree(&request.record_id, true).await.unwrap();
    let snapshot: Value = http
        .get(format!("{server}/api/v1/snapshot"))
        .bearer_auth(&session.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let archived: StoredVersion = serde_json::from_value(
        snapshot["versions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["revision"] == 2)
            .unwrap()
            .clone(),
    )
    .unwrap();
    let batch = neruvalo_protocol::SaveBatch {
        operation_id: archived.operation_id.clone(),
        snapshot: BTreeMap::from([(request.record_id.clone(), 1)]),
        records: vec![SaveRecord {
            operation_id: archived.operation_id,
            record_id: archived.record_id,
            expected_revision: 1,
            version_id: archived.version_id,
            previous_version: archived.previous_version,
            payload: archived.payload,
            signature: archived.signature,
            archived: true,
        }],
    };
    let replay = http
        .post(format!("{server}/api/v1/records/batch"))
        .bearer_auth(&session.token)
        .json(&batch)
        .send()
        .await
        .unwrap();
    assert!(replay.status().is_success());
    let mut changed = batch.clone();
    changed.snapshot.clear();
    assert_eq!(
        http.post(format!("{server}/api/v1/records/batch"))
            .bearer_auth(&session.token)
            .json(&changed)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::CONFLICT
    );
    c.sync().await.unwrap();
    assert_eq!(c.history(&request.record_id).await.unwrap().len(), 2);
    request.payload["data"]["ciphertext"] = Value::String("changed".into());
    let bad = http
        .post(format!("{server}/api/v1/records/save"))
        .bearer_auth(&session.token)
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(
        http.get(format!("{server}/api/v1/snapshot"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    handle.abort();
}

#[tokio::test]
async fn encrypted_groups_legacy_paths_and_offline_tree() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let (server, handle) = start(root).await;
    let mut a = Client::new(root.join("groups-a")).unwrap();
    register(&mut a, &server, "groupsalice", root).await;
    a.login(&server, "groupsalice", password()).await.unwrap();
    assert_eq!(a.status()["server"], server);
    let mut old = data("Old entry", "00123");
    old.folder = "Private Bank/Cards".into();
    let old_id = a.save(None, 0, old.clone(), false).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut b = Client::new(root.join("groups-b")).unwrap();
    b.login(&server, "groupsalice", password()).await.unwrap();
    let top = a
        .create_group("Private empty group".into(), None)
        .await
        .unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = a.create_group("Child".into(), Some(&top)).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(a.groups().await.unwrap().len(), 2);
    assert_eq!(a.list().await.unwrap().len(), 1); // metadata objects never appear as secret entries
    assert_eq!(
        a.groups()
            .await
            .unwrap()
            .iter()
            .find(|g| g.id == child)
            .unwrap()
            .parent_id
            .as_deref(),
        Some(top.as_str())
    );
    let moved = a
        .save_in_group(
            Some(old_id.clone()),
            1,
            old.clone(),
            false,
            Some("legacy:Private Bank/Cards"),
        )
        .await
        .unwrap();
    let legacy_id = moved["group_id"].as_str().unwrap().to_owned();
    let history = a.history(&old_id).await.unwrap();
    assert_eq!(history.len(), 2);
    assert!(!history[1].data.extra.contains_key("group_id"));
    assert_eq!(history[1].data.folder, "Private Bank/Cards");
    assert_eq!(history[0].data.folder, history[1].data.folder);
    assert_eq!(history[0].data.fields, history[1].data.fields);
    // b's snapshot predates materialization: deterministic private IDs resolve
    // the server conflict and reuse both ancestors instead of duplicating them.
    b.save_in_group(
        None,
        0,
        data("Another", "different"),
        false,
        Some("legacy:Private Bank/Cards"),
    )
    .await
    .unwrap();
    let paths = b.groups().await.unwrap();
    assert_eq!(paths.iter().filter(|g| g.legacy_path.is_some()).count(), 2);
    assert!(paths.iter().any(|g| g.id == legacy_id));
    assert!(a
        .save(
            Some(top.clone()),
            1,
            data("Cannot convert group", ""),
            false
        )
        .await
        .is_err());
    assert!(a
        .create_group("Invalid".into(), Some("not-an-id"))
        .await
        .is_err());
    let groups_before = a.groups().await.unwrap().len();
    assert!(a
        .create_group(" ".into(), Some("legacy:Should/Not/Exist"))
        .await
        .is_err());
    assert_eq!(a.groups().await.unwrap().len(), groups_before);
    a.sync().await.unwrap();
    let profile = a.profiles().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    a.lock();
    let mut reopened = Client::new(root.join("groups-a")).unwrap();
    reopened.unlock_offline(&profile, password()).await.unwrap();
    assert_eq!(reopened.groups().await.unwrap().len(), 4);
    assert_eq!(reopened.list().await.unwrap().len(), 2);
    assert_eq!(
        reopened
            .create_group("Offline".into(), None)
            .await
            .unwrap_err()
            .to_string(),
        "OFFLINE_READ_ONLY"
    );
    assert!(reopened
        .save_in_group(Some(old_id.clone()), 2, old, false, Some(&child))
        .await
        .is_err());
    reopened.lock();
    assert!(reopened.groups().await.is_err());
    let pool = sqlx::AnyPool::connect(&std::env::var("NERUVALO_TEST_DATABASE_URL").unwrap_or_else(
        |_| neruvalo_client::sqlite_database_url(&root.join("server.sqlite3")).unwrap(),
    ))
    .await
    .unwrap();
    let raw: Vec<(String,)> = sqlx::query_as("SELECT body FROM versions")
        .fetch_all(&pool)
        .await
        .unwrap();
    let bodies = raw.into_iter().map(|r| r.0).collect::<String>();
    assert!(!bodies.contains("Private empty group"));
    assert!(!bodies.contains("Private Bank"));
    pool.close().await;
    handle.abort();
}

#[tokio::test]
async fn atomic_group_archive_restore_and_conflict() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let (server, handle) = start(root).await;
    let mut a = Client::new(root.join("archive-a")).unwrap();
    register(&mut a, &server, "archiveuser", root).await;
    a.login(&server, "archiveuser", password()).await.unwrap();
    let group = a.create_group("Bank".into(), None).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let sub = a.create_group("Cards".into(), Some(&group)).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let empty = a.create_group("Empty".into(), Some(&group)).await.unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = a
        .save_in_group(None, 0, data("One", "secret-1"), false, Some(&sub))
        .await
        .unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let second = a
        .save_in_group(None, 0, data("Two", "secret-2"), false, Some(&sub))
        .await
        .unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    a.archive_tree(&second, true).await.unwrap();
    let mut b = Client::new(root.join("archive-b")).unwrap();
    b.login(&server, "archiveuser", password()).await.unwrap();
    // A newly inserted child must invalidate the entire batch, without partial changes.
    a.save_in_group(None, 0, data("Concurrent", "secret-3"), false, Some(&group))
        .await
        .unwrap();
    assert!(b
        .archive_tree(&group, true)
        .await
        .unwrap_err()
        .to_string()
        .contains("RECORD_VERSION_MISMATCH"));
    b.sync().await.unwrap();
    assert!(b.groups().await.unwrap().iter().all(|g| !g.archived));
    assert!(
        !b.list()
            .await
            .unwrap()
            .iter()
            .find(|r| r.record_id == first)
            .unwrap()
            .archived
    );
    b.archive_tree(&group, true).await.unwrap();
    assert!(a
        .save_in_group(None, 0, data("Stale child", "x"), false, Some(&sub))
        .await
        .unwrap_err()
        .to_string()
        .contains("RECORD_VERSION_MISMATCH"));
    assert!(b.groups().await.unwrap().iter().all(|g| g.archived));
    assert!(b.list().await.unwrap().iter().all(|r| r.archived));
    assert_eq!(b.history(&second).await.unwrap().len(), 2); // no duplicate archive version
    b.archive_tree(&first, false).await.unwrap();
    let groups = b.groups().await.unwrap();
    assert!(!groups.iter().find(|g| g.id == group).unwrap().archived);
    assert!(!groups.iter().find(|g| g.id == sub).unwrap().archived);
    assert!(groups.iter().find(|g| g.id == empty).unwrap().archived);
    assert!(
        b.list()
            .await
            .unwrap()
            .iter()
            .find(|r| r.record_id == second)
            .unwrap()
            .archived
    );
    assert!(b
        .save_in_group(None, 0, data("Denied", "x"), false, Some(&empty))
        .await
        .is_err());
    b.archive_tree(&group, false).await.unwrap();
    assert!(b.groups().await.unwrap().iter().all(|g| !g.archived));
    assert!(b.list().await.unwrap().iter().all(|r| !r.archived));
    assert_eq!(b.history(&first).await.unwrap().len(), 3);
    assert_eq!(b.history(&second).await.unwrap().len(), 3);
    b.archive_tree(&empty, true).await.unwrap();
    assert!(
        b.groups()
            .await
            .unwrap()
            .iter()
            .find(|g| g.id == empty)
            .unwrap()
            .archived
    );
    let profile = b.profiles().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    b.lock();
    b.unlock_offline(&profile, password()).await.unwrap();
    assert!(b
        .archive_tree(&group, true)
        .await
        .unwrap_err()
        .to_string()
        .contains("OFFLINE_READ_ONLY"));
    handle.abort();
}

#[tokio::test]
async fn shared_copies_update_revoke_dismiss_archive_and_offline() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let (server, handle) = start(root).await;
    let mut owner = Client::new(root.join("owner")).unwrap();
    register(&mut owner, &server, "owner", root).await;
    owner.login(&server, "owner", password()).await.unwrap();
    let mut bob = Client::new(root.join("bob")).unwrap();
    register(&mut bob, &server, "bob", root).await;
    bob.login(&server, "bob", password()).await.unwrap();
    let mut carol = Client::new(root.join("carol")).unwrap();
    register(&mut carol, &server, "carol", root).await;
    carol.login(&server, "carol", password()).await.unwrap();
    let group = owner
        .create_group("PRIVATE-GROUP".into(), None)
        .await
        .unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut original = data("Mail", "old-secret");
    original.tags = vec!["PRIVATE-TAG".into()];
    original.notes = "shared notes".into();
    original
        .extra
        .insert("private-metadata".into(), serde_json::json!("hidden"));
    let id = owner
        .save_in_group(None, 0, original, false, Some(&group))
        .await
        .unwrap()["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    owner.share_change("create", &id, "bob").await.unwrap();
    bob.sync().await.unwrap();
    let received = bob.sharing().await.unwrap();
    let copy_id = received["incoming"][0]["record_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let share_id = received["incoming"][0]["share_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(received["incoming"].as_array().unwrap().len(), 1);
    assert_eq!(
        received["incoming"][0]["data"]["fields"]["password"],
        "old-secret"
    );
    assert_eq!(received["incoming"][0]["data"]["notes"], "shared notes");
    assert_eq!(
        received["incoming"][0]["data"]["tags"],
        serde_json::json!([])
    );
    assert!(!received.to_string().contains("PRIVATE-GROUP"));
    assert!(!received.to_string().contains("PRIVATE-TAG"));
    assert!(!received.to_string().contains("private-metadata"));
    // Tampering must not advance the recipient cache or replace its verified copy.
    let db_url = std::env::var("NERUVALO_TEST_DATABASE_URL").unwrap_or_else(|_| {
        neruvalo_client::sqlite_database_url(&root.join("server.sqlite3")).unwrap()
    });
    let db = sqlx::AnyPool::connect(&db_url).await.unwrap();
    let body = owner.sharing().await.unwrap()["outgoing"][0]["copy"].clone();
    let mut corrupt = body.clone();
    corrupt["source_revision"] = serde_json::json!(999);
    sqlx::query("UPDATE shares SET body=$1 WHERE id=$2")
        .bind(corrupt.to_string())
        .bind(&share_id)
        .execute(&db)
        .await
        .unwrap();
    assert!(bob.sync().await.is_err());
    assert_eq!(
        bob.sharing().await.unwrap()["incoming"][0]["data"]["fields"]["password"],
        "old-secret"
    );
    sqlx::query("UPDATE shares SET body=$1 WHERE id=$2")
        .bind(body.to_string())
        .bind(&share_id)
        .execute(&db)
        .await
        .unwrap();
    bob.sync().await.unwrap();
    db.close().await;
    assert!(bob.history(&id).await.unwrap().is_empty());
    assert!(bob.history(&copy_id).await.unwrap().is_empty());
    assert!(bob.share_change("create", &id, "carol").await.is_err());
    assert!(bob
        .save(Some(copy_id.clone()), 1, data("Attack", "x"), false)
        .await
        .is_err());
    assert!(owner
        .share_change("create", &id, "bob")
        .await
        .unwrap_err()
        .to_string()
        .contains("ALREADY_SHARED"));
    owner.sync().await.unwrap();
    owner.share_change("create", &id, "carol").await.unwrap();
    let current = owner
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.record_id == id)
        .unwrap();
    let mut changed = current.data;
    changed
        .fields
        .insert("password".into(), "new-secret".into());
    owner
        .save(Some(id.clone()), current.revision, changed, false)
        .await
        .unwrap();
    bob.sync().await.unwrap();
    carol.sync().await.unwrap();
    assert_eq!(
        bob.sharing().await.unwrap()["incoming"][0]["data"]["fields"]["password"],
        "new-secret"
    );
    assert_eq!(
        bob.sharing().await.unwrap()["incoming"][0]["record_id"],
        copy_id
    );
    assert_eq!(
        carol.sharing().await.unwrap()["incoming"][0]["data"]["fields"]["password"],
        "new-secret"
    );
    bob.share_change("dismiss", &id, &share_id).await.unwrap();
    assert!(bob.sharing().await.unwrap()["incoming"]
        .as_array()
        .unwrap()
        .is_empty());
    let stale = owner
        .list()
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.record_id == id)
        .unwrap();
    assert!(owner
        .save(Some(id.clone()), stale.revision, stale.data, false)
        .await
        .unwrap_err()
        .to_string()
        .contains("SHARING_VERSION_MISMATCH"));
    owner.sync().await.unwrap();
    assert_eq!(
        owner.sharing().await.unwrap()["outgoing"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let carol_share = owner.sharing().await.unwrap()["outgoing"][0]["share_id"]
        .as_str()
        .unwrap()
        .to_owned();
    owner
        .share_change("revoke", &id, &carol_share)
        .await
        .unwrap();
    // Until synchronization the recipient can still read the last granted copy offline.
    assert_eq!(
        carol.sharing().await.unwrap()["incoming"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    carol.sync().await.unwrap();
    assert!(carol.sharing().await.unwrap()["incoming"]
        .as_array()
        .unwrap()
        .is_empty());
    owner.share_change("create", &id, "bob").await.unwrap();
    bob.sync().await.unwrap();
    assert_ne!(
        bob.sharing().await.unwrap()["incoming"][0]["record_id"],
        copy_id
    );
    owner.archive_tree(&group, true).await.unwrap();
    bob.sync().await.unwrap();
    assert!(bob.sharing().await.unwrap()["incoming"]
        .as_array()
        .unwrap()
        .is_empty());
    owner.archive_tree(&group, false).await.unwrap();
    bob.sync().await.unwrap();
    assert!(bob.sharing().await.unwrap()["incoming"]
        .as_array()
        .unwrap()
        .is_empty());
    owner.share_change("create", &id, "bob").await.unwrap();
    bob.sync().await.unwrap();
    let profile = bob.profiles().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    bob.lock();
    bob.unlock_offline(&profile, password()).await.unwrap();
    assert_eq!(
        bob.sharing().await.unwrap()["incoming"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(bob.share_change("dismiss", &id, "anything").await.is_err());
    assert_eq!(owner.history(&id).await.unwrap().len(), 4);
    handle.abort();
}
