//! Opt-in check against a real local GateVeriq, using a temporary Neruvalo database.
use neruvalo_client::Client;
use neruvalo_crypto::{b64, unb64};
use neruvalo_server::{application_with_config, config::ServerConfig};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use zeroize::Zeroizing;

async fn verify(
    http: &reqwest::Client,
    server: &str,
    public: &str,
    origin: &str,
    action: &str,
    login: &str,
) -> String {
    let response = http
        .post(format!("{server}/api/v1/verification/prepare"))
        .json(&json!({"action":action,"login":login,"email":format!("{}@example.test", login.to_ascii_lowercase())}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 428);
    let body: Value = response.json().await.unwrap();
    let secret = body["verification_secret"].as_str().unwrap().to_owned();
    let status: Value = http
        .get(format!("{server}/api/v1/verification"))
        .bearer_auth(&secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let attempt = &status["attempt"];
    assert_eq!(
        attempt["decision"], "verify",
        "This test requires adaptive policies and an unblocked source"
    );
    let challenge = attempt["challenge"].clone();
    let challenge_id = challenge["challenge_id"].as_str().unwrap().to_owned();
    let nonce = tokio::task::spawn_blocking(move || {
        let mut bytes = b"gateveriq:pow:v1".to_vec();
        bytes.extend(unb64(challenge["challenge_id"].as_str().unwrap()).unwrap());
        bytes.extend(unb64(challenge["salt"].as_str().unwrap()).unwrap());
        let bits = challenge["difficulty_bits"].as_u64().unwrap() as usize;
        assert!((1..=24).contains(&bits));
        for nonce in 0u64.. {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hasher.update(nonce.to_le_bytes());
            let digest = hasher.finalize();
            if (0..bits).all(|bit| digest[bit / 8] & (128 >> (bit % 8)) == 0) {
                return b64(nonce.to_le_bytes());
            }
        }
        unreachable!()
    })
    .await
    .unwrap();
    let result = http.post(format!("{public}/public/v1/web/solutions")).header("origin", origin)
        .json(&json!({"challenge_id":challenge_id,"nonce":nonce,
            "browser":{"webdriver":false,"cookies_enabled":true,"languages_count":1},
            "behavior":{"challenge_id":challenge_id,"elapsed_ms":500,"activation_ms":500,"trusted_activations":1,"pointer_events":2,"keyboard_events":0,"focus_changes":1}}))
        .send().await.unwrap();
    assert!(
        result.status().is_success(),
        "Real GateVeriq solution returned {}",
        result.status()
    );
    let result: Value = result.json().await.unwrap();
    let response = http
        .post(format!("{server}/api/v1/verification"))
        .bearer_auth(&secret)
        .json(&json!({"verification_token":result["verification_token"]}))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "Real GateVeriq consume returned {}",
        response.status()
    );
    secret
}

#[tokio::test]
#[ignore = "requires local GateVeriq with adaptive register/login policies; reads NERUVALO_TEST_GATE_CONFIG"]
async fn real_gate_register_confirm_and_login() {
    let path = std::env::var("NERUVALO_TEST_GATE_CONFIG")
        .expect("Set NERUVALO_TEST_GATE_CONFIG to the server TOML path");
    let mut config = ServerConfig::load(std::path::Path::new(&path)).unwrap();
    let gate = config.gateveriq.as_ref().expect("Enable GateVeriq");
    let (public, origin) = (gate.public.clone(), gate.origin.clone());
    let temp = TempDir::new().unwrap();
    config.database_url =
        neruvalo_client::sqlite_database_url(&temp.path().join("server.sqlite3")).unwrap();
    config.dev_outbox = temp.path().join("outbox");
    let app = application_with_config(&config).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    let login = format!("gate_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let mut client = Client::new(temp.path().join("client")).unwrap();
    let proof = verify(
        &http,
        &server,
        &public,
        &origin,
        "register",
        &login.to_ascii_uppercase(),
    )
    .await;
    client.set_verification_secret(Some(proof));
    let password = || Zeroizing::new("GateVeriq integration test password".to_owned());
    // Invalid form input must be reported before spending the already completed check.
    let invalid_login = client
        .register_begin(
            &server,
            "Invalid Login",
            &format!("{login}@example.test"),
            password(),
            false,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(invalid_login.to_string(), "INVALID_LOGIN");
    let invalid_email = client
        .register_begin(&server, &login, "invalid", password(), false)
        .await
        .err()
        .unwrap();
    assert_eq!(invalid_email.to_string(), "INVALID_EMAIL");
    let begin = client
        .register_begin(
            &server,
            &login,
            &format!("{login}@example.test"),
            password(),
            false,
        )
        .await
        .unwrap();
    let mail = std::fs::read_to_string(
        config
            .dev_outbox
            .join(format!("{}.txt", begin["ticket"].as_str().unwrap())),
    )
    .unwrap();
    let code = mail
        .lines()
        .find_map(|line| line.strip_prefix("Confirmation code: "))
        .unwrap();
    client.register_finish(&server, code).await.unwrap();
    let proof = verify(&http, &server, &public, &origin, "login", &login).await;
    client.set_verification_secret(Some(proof));
    client
        .login(&server, &login.to_ascii_uppercase(), password())
        .await
        .unwrap();
    assert_eq!(client.status()["login"], login);
    assert_eq!(client.status()["unlocked"], true);
    task.abort();
}
