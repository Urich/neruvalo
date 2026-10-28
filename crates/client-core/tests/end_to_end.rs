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
    let url = std::env::var("NERUVALO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| format!("sqlite://{}?mode=rwc", dir.join("server.sqlite3").display()));
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
    let mut a = Client::new(root.join("client-a")).unwrap();
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
