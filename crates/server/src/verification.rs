use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::Request,
    middleware::Next,
    response::Html,
};

pub(super) struct Gate {
    http: reqwest::Client,
    internal: String,
    public: String,
    origin: String,
    id: String,
    secret: String,
    pending: Mutex<HashMap<String, Attempt>>,
}
struct Attempt {
    action: String,
    context: String,
    request: String,
    hash: String,
    prepared: Value,
    expires: i64,
    verified: bool,
}
#[derive(Clone)]
pub(super) struct Proof(Value);
fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "VERIFICATION_UNAVAILABLE")
}
fn verification_failed() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "VERIFICATION_FAILED")
}
fn verification_expired() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "VERIFICATION_EXPIRED")
}
impl Gate {
    pub(super) async fn report(&self, proof: &Proof, success: bool) {
        let mut outcome = proof.0.clone();
        outcome["success"] = json!(success);
        if self
            .post("/internal/v1/web/outcomes", outcome)
            .await
            .is_err()
        {
            tracing::warn!("GateVeriq outcome report failed");
        }
    }
    pub(super) fn from_env() -> anyhow::Result<Option<Self>> {
        crate::config::GateConfig::from_env()?
            .as_ref()
            .map(Self::from_config)
            .transpose()
    }
    pub(super) fn from_config(config: &crate::config::GateConfig) -> anyhow::Result<Self> {
        config.validate()?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            id: config.id.clone(),
            secret: config.secret.clone(),
            internal: config.internal.trim_end_matches('/').into(),
            public: config.public.trim_end_matches('/').into(),
            origin: config.origin.trim_end_matches('/').into(),
            pending: Mutex::default(),
        })
    }
    async fn post(&self, path: &str, mut body: Value) -> Result<Value, ApiError> {
        body["integration_id"] = json!(self.id);
        let r = self
            .http
            .post(format!("{}{path}", self.internal))
            .bearer_auth(&self.secret)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(
                    endpoint = path,
                    timeout = error.is_timeout(),
                    connect = error.is_connect(),
                    "GateVeriq request failed"
                );
                unavailable()
            })?;
        if !r.status().is_success() {
            tracing::warn!(endpoint = path, status = %r.status(), "GateVeriq rejected request");
            return Err(unavailable());
        }
        r.json().await.map_err(|_| {
            tracing::warn!(endpoint = path, "GateVeriq returned invalid JSON");
            unavailable()
        })
    }
}
pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/verification/themes.css",
            get(|| async {
                (
                    [("content-type", "text/css")],
                    include_str!("../../../apps/desktop/src/themes.css"),
                )
            }),
        )
        .route(
            "/verification/slider.js",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("verification/slider.js"),
                )
            }),
        )
        .route(
            "/verification",
            get(|| async {
                Html(include_str!("verification.html").replace(
                    "__VERIFICATION_MESSAGES__",
                    include_str!("verification/messages.json"),
                ))
            }),
        )
        .route(
            "/verification/widget.js",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("verification/widget.js"),
                )
            }),
        )
        .route(
            "/verification/worker.js",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("verification/worker.js"),
                )
            }),
        )
        .route("/api/v1/verification", get(status).post(complete))
        .route("/api/v1/verification/prepare", post(prepare))
}
fn bearer(h: &HeaderMap) -> Result<&str, ApiError> {
    h.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(auth_error)
}
async fn status(State(s): State<Arc<AppState>>, h: HeaderMap) -> Api<Value> {
    let g = s.verification.as_ref().ok_or_else(unavailable)?;
    let pending = g.pending.lock().await;
    let a = pending
        .get(bearer(&h)?)
        .filter(|a| a.expires > now())
        .ok_or_else(verification_expired)?;
    Ok(Json(
        json!({"verified":a.verified,"attempt":a.prepared,"service_url":g.public,"expires_at":a.expires}),
    ))
}
async fn complete(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(r): Json<Value>,
) -> Api<Value> {
    let g = s.verification.as_ref().ok_or_else(unavailable)?;
    let mut pending = g.pending.lock().await;
    let a = pending
        .get_mut(bearer(&h)?)
        .filter(|a| a.expires > now())
        .ok_or_else(verification_expired)?;
    let result = g.post("/internal/v1/verifications/consume", json!({"action":a.action,"context_id":a.context,"request_id":a.request,"verification_token":r["verification_token"]})).await?;
    if result["valid"] != true
        || result["action"] != a.action
        || result["context_id"] != a.context
        || !matches!(
            result["verification_method"].as_str(),
            Some("pow" | "pow_visual")
        )
    {
        return Err(verification_failed());
    }
    a.verified = true;
    Ok(Json(json!({"verified":true})))
}
pub(super) async fn guard(State(s): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let mut response = match protect(s, req, next).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("referrer-policy", "no-referrer".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
async fn protect(s: Arc<AppState>, req: Request, next: Next) -> Result<Response, ApiError> {
    let Some(g) = s.verification.as_ref() else {
        return Ok(next.run(req).await);
    };
    let action = match (req.method().as_str(), req.uri().path()) {
        ("POST", "/api/v1/register/begin") => "register",
        ("POST", "/api/v1/auth/begin") => "login",
        _ => return Ok(next.run(req).await),
    };
    let (mut parts, body) = req.into_parts();
    let bytes = to_bytes(body, 2 * 1024 * 1024)
        .await
        .map_err(|_| invalid())?;
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    normalize_identity(&mut value);
    let hash = crypto::digest(&format!("{action}:{}", canonical_json(&value)));
    if let Some(token) = parts
        .headers
        .get("x-neruvalo-verification")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
    {
        let mut pending = g.pending.lock().await;
        let a = pending.get(token).ok_or_else(verification_expired)?;
        if a.expires <= now() {
            return Err(verification_expired());
        }
        if !a.verified
            || a.action != action
            || !(a.hash == hash || a.hash == preparation_hash(action, &value))
        {
            return Err(verification_failed());
        }
        let outcome = json!({"action":a.action,"context_id":a.context,"request_id":a.request});
        pending.remove(token); // Spend before dispatch, including invalid business requests.
        drop(pending);
        parts.extensions.insert(Proof(outcome.clone()));
        let response = next
            .run(Request::from_parts(parts, Body::from(bytes)))
            .await;
        if action != "login" {
            g.report(&Proof(outcome), response.status().is_success())
                .await;
        }
        return Ok(response);
    }
    create_attempt(&s, g, action, &value, hash).await
}

fn preparation_hash(action: &str, value: &Value) -> String {
    let mut value = value.clone();
    normalize_identity(&mut value);
    let identity = if action == "register" {
        json!({"login":value["login"], "email":value["email"]})
    } else {
        json!({"login":value["login"]})
    };
    crypto::digest(&format!("preflight:{action}:{}", canonical_json(&identity)))
}

fn normalize_identity(value: &mut Value) {
    if let Some(login) = value["login"].as_str() {
        value["login"] = json!(normalize_login(login));
    }
}

async fn prepare(
    State(s): State<Arc<AppState>>,
    Json(mut value): Json<Value>,
) -> Result<Response, ApiError> {
    normalize_identity(&mut value);
    let action = value["action"].as_str().ok_or_else(invalid)?;
    if !matches!(action, "login" | "register")
        || !value["login"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 1024)
        || (action == "register"
            && !value["email"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1024))
    {
        return Err(invalid());
    }
    let Some(g) = s.verification.as_ref() else {
        return Ok(Json(json!({"enabled":false})).into_response());
    };
    create_attempt(&s, g, action, &value, preparation_hash(action, &value)).await
}

async fn create_attempt(
    s: &Arc<AppState>,
    g: &Gate,
    action: &str,
    value: &Value,
    hash: String,
) -> Result<Response, ApiError> {
    rate(s, "verification").await?;
    let issued = g
        .post("/internal/v1/contexts", json!({"action":action}))
        .await?;
    let context = issued["context_id"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        })
        .ok_or_else(unavailable)?
        .to_owned();
    let expires = issued["expires_at"]
        .as_i64()
        .filter(|expires| *expires > now())
        .ok_or_else(unavailable)?
        .min(now() + 180);
    // A server secret makes this mapping stable and opaque even for unknown logins.
    let identity = value[if action == "email_verify" {
        "ticket"
    } else {
        "login"
    }]
    .as_str()
    .ok_or_else(invalid)?;
    let account_id =
        crypto::b64(crypto::derive(g.secret.as_bytes(), identity.as_bytes())?.as_slice());
    let prepared = g
        .post(
            "/internal/v1/web/attempts",
            json!({"action":action,"context_id":context,"account_id":account_id,"origin":g.origin}),
        )
        .await?;
    let token = crypto::token();
    let mut pending = g.pending.lock().await;
    pending.retain(|_, a| a.expires > now());
    if pending.len() >= 4096 {
        return Err(unavailable());
    }
    pending.insert(
        token.clone(),
        Attempt {
            action: action.into(),
            context,
            request: crypto::token(),
            hash,
            prepared,
            expires,
            verified: false,
        },
    );
    Ok((
        StatusCode::PRECONDITION_REQUIRED,
        Json(json!({"error":{"code":"VERIFICATION_REQUIRED"},"verification_secret":token})),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (url, task)
    }
    #[tokio::test]
    async fn verification_binds_request_accepts_pow_and_is_one_use() {
        let mock = Router::new()
            .route("/internal/v1/contexts", post(|h: HeaderMap, Json(v): Json<Value>| async move {
                assert_eq!(h["authorization"], "Bearer private-secret");
                assert_eq!(v["integration_id"], "test");
                assert!(matches!(v["action"].as_str(), Some("login" | "register")));
                assert_eq!(v.as_object().unwrap().len(), 2);
                Json(json!({"context_id":format!("mock-signed-{}", crypto::token()),"expires_at":now()+120}))
            }))
            .route("/internal/v1/web/attempts", post(|h: HeaderMap, Json(v): Json<Value>| async move {
                assert_eq!(h["authorization"], "Bearer private-secret");
                assert!(v.get("email").is_none() && v.get("message").is_none());
                assert_ne!(v["account_id"], "alice");
                assert!(v["context_id"].as_str().unwrap().starts_with("mock-signed-"));
                Json(json!({"decision":"verify","challenge":{"id":"mock"}}))
            }))
            .route("/internal/v1/verifications/consume", post(|Json(v): Json<Value>| async move {
                Json(json!({"valid":v["verification_token"] != "invalid","action":v["action"],"context_id":v["context_id"],"verification_method":if v["verification_token"] == "visual" {"pow_visual"} else {"pow"}}))
            }))
            .route("/internal/v1/web/outcomes", post(|| async { Json(json!({})) }));
        let (internal, mock_task) = serve(mock).await;
        let gate = crate::config::GateConfig {
            internal,
            public: "http://127.0.0.1:9080".into(),
            origin: "http://127.0.0.1:8080".into(),
            id: "test".into(),
            secret: "private-secret".into(),
        };
        let outbox = std::env::temp_dir().join(format!("neruvalo-gate-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&outbox).unwrap();
        let db = outbox.join("test.sqlite");
        let encoded: String = db
            .to_str()
            .unwrap()
            .bytes()
            .map(|b| format!("%{b:02X}"))
            .collect();
        let app = application_with_config(&crate::config::ServerConfig {
            dev_mode: true,
            database_url: format!("sqlite:{encoded}?mode=rwc"),
            dev_outbox: outbox.clone(),
            gateveriq: Some(gate),
            ..crate::config::ServerConfig::default()
        })
        .await
        .unwrap();
        let (url, task) = serve(app).await;
        let http = reqwest::Client::new();
        let page = http
            .get(format!("{url}/verification"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!page.contains("__VERIFICATION_MESSAGES__"));
        assert!(page.contains("incorrectPasswordOrDamagedData") && page.contains("translations"));
        assert!(page.contains("/verification/themes.css") && page.contains(".gateveriq-slider"));
        for asset in ["slider.js", "worker.js", "widget.js", "themes.css"] {
            assert!(http
                .get(format!("{url}/verification/{asset}"))
                .send()
                .await
                .unwrap()
                .status()
                .is_success());
        }
        let endpoint = format!("{url}/api/v1/register/begin");
        let body = json!({"login":"alice","email":"a@example.test","message":"invalid"});
        let r = http.post(&endpoint).json(&body).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(r.headers()["cache-control"], "no-store");
        let r: Value = r.json().await.unwrap();
        let secret = r["verification_secret"].as_str().unwrap();
        let status = format!("{url}/api/v1/verification");
        assert_eq!(
            http.get(&status).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            http.post(&status)
                .bearer_auth(secret)
                .json(&json!({"verification_token":"invalid"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let r: Value = http
            .get(&status)
            .bearer_auth(secret)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r["verified"], false);
        assert!(http
            .post(&status)
            .bearer_auth(secret)
            .json(&json!({"verification_token":"pow"}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        let mut changed = body.clone();
        changed["email"] = json!("other@example.test");
        assert_eq!(
            http.post(&endpoint)
                .header("x-neruvalo-verification", secret)
                .json(&changed)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let r = http
            .post(&endpoint)
            .header("x-neruvalo-verification", secret)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST); // Gate accepted; invalid OPAQUE message rejected.
        assert_eq!(
            http.post(&endpoint)
                .header("x-neruvalo-verification", secret)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        // Prepared checks bind to the identity before an OPAQUE message exists.
        for action in ["register", "login"] {
            let r = http
                .post(format!("{url}/api/v1/verification/prepare"))
                .json(&json!({"action":action,"login":"AlIcE","email":"a@example.test"}))
                .send()
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::PRECONDITION_REQUIRED);
            let r: Value = r.json().await.unwrap();
            let proof = r["verification_secret"].as_str().unwrap();
            assert!(http
                .post(&status)
                .bearer_auth(proof)
                .json(&json!({"verification_token":"visual"}))
                .send()
                .await
                .unwrap()
                .status()
                .is_success());
            let endpoint = format!(
                "{url}/api/v1/{}",
                if action == "login" {
                    "auth/begin"
                } else {
                    "register/begin"
                }
            );
            for changed in [
                json!({"login":"bob","email":"a@example.test","message":"invalid"}),
                json!({"login":"alice","email":"other@example.test","message":"invalid"}),
            ] {
                if action == "login" && changed["login"] == "alice" {
                    continue;
                }
                assert_eq!(
                    http.post(&endpoint)
                        .header("x-neruvalo-verification", proof)
                        .json(&changed)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::UNAUTHORIZED
                );
            }
            assert_eq!(
                http.post(&endpoint)
                    .header("x-neruvalo-verification", proof)
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
            assert_eq!(
                http.post(&endpoint)
                    .header("x-neruvalo-verification", proof)
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        // Email confirmation reaches its own handler without creating a bot check.
        assert_ne!(
            http.post(format!("{url}/api/v1/register/finish"))
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        task.abort();
        mock_task.abort();
        let _ = task.await;
        let _ = std::fs::remove_file(db);
        let _ = std::fs::remove_dir(&outbox);
    }
}
