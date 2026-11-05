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
        let names = [
            "NERUVALO_GATE_ID",
            "NERUVALO_GATE_SECRET",
            "NERUVALO_GATE_INTERNAL",
            "NERUVALO_GATE_PUBLIC",
            "NERUVALO_PUBLIC_ORIGIN",
        ];
        let values: Vec<_> = names.iter().map(|n| std::env::var(n).ok()).collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        ensure!(
            values
                .iter()
                .all(|v| v.as_ref().is_some_and(|s| !s.is_empty())),
            "All GateVeriq settings are required"
        );
        let v: Vec<_> = values.into_iter().map(Option::unwrap).collect();
        for i in [2, 3, 4] {
            let u = reqwest::Url::parse(&v[i])?;
            ensure!(
                u.scheme() == "https"
                    || (u.scheme() == "http"
                        && matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
                "GateVeriq URLs require HTTPS or loopback"
            );
            ensure!(
                u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none()
                    && u.fragment().is_none()
                    && u.path() == "/",
                "Expected URL origin"
            );
        }
        Ok(Some(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            id: v[0].clone(),
            secret: v[1].clone(),
            internal: v[2].trim_end_matches('/').into(),
            public: v[3].trim_end_matches('/').into(),
            origin: v[4].trim_end_matches('/').into(),
            pending: Mutex::default(),
        }))
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
            .map_err(|_| unavailable())?;
        if !r.status().is_success() {
            return Err(unavailable());
        }
        r.json().await.map_err(|_| unavailable())
    }
}
pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/verification",
            get(|| async { Html(include_str!("verification.html")) }),
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
        .ok_or_else(auth_error)?;
    Ok(Json(
        json!({"verified":a.verified,"attempt":a.prepared,"service_url":g.public}),
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
        .ok_or_else(auth_error)?;
    let result = g.post("/internal/v1/verifications/consume", json!({"action":a.action,"context_id":a.context,"request_id":a.request,"verification_token":r["verification_token"]})).await?;
    if result["valid"] != true || result["action"] != a.action || result["context_id"] != a.context
    {
        return Err(auth_error());
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
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let hash = crypto::digest(&format!("{action}:{}", canonical_json(&value)));
    if let Some(token) = parts
        .headers
        .get("x-neruvalo-verification")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
    {
        let mut pending = g.pending.lock().await;
        let a = pending
            .get(token)
            .filter(|a| {
                a.expires > now()
                    && a.verified
                    && (a.hash == hash || a.hash == preparation_hash(action, &value))
            })
            .ok_or_else(auth_error)?;
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
    let identity = if action == "register" {
        json!({"login":value["login"], "email":value["email"]})
    } else {
        json!({"login":value["login"]})
    };
    crypto::digest(&format!("preflight:{action}:{}", canonical_json(&identity)))
}

async fn prepare(
    State(s): State<Arc<AppState>>,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
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
    let context = crypto::token();
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
            expires: now() + 180,
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
            .route("/internal/v1/web/attempts", post(|h: HeaderMap, Json(v): Json<Value>| async move {
                assert_eq!(h["authorization"], "Bearer private-secret");
                assert!(v.get("email").is_none() && v.get("message").is_none());
                assert_ne!(v["account_id"], "alice");
                Json(json!({"decision":"verify","challenge":{"id":"mock"}}))
            }))
            .route("/internal/v1/verifications/consume", post(|Json(v): Json<Value>| async move {
                Json(json!({"valid":v["verification_token"] != "invalid","action":v["action"],"context_id":v["context_id"],"verification_method":if v["verification_token"] == "visual" {"pow_visual"} else {"pow"}}))
            }))
            .route("/internal/v1/web/outcomes", post(|| async { Json(json!({})) }));
        let (internal, mock_task) = serve(mock).await;
        let gate = Gate {
            http: reqwest::Client::new(),
            internal,
            public: "http://127.0.0.1:9080".into(),
            origin: "http://127.0.0.1:8080".into(),
            id: "test".into(),
            secret: "private-secret".into(),
            pending: Mutex::default(),
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
        let app = application_with_gate(
            &format!("sqlite:{encoded}?mode=rwc"),
            outbox.clone(),
            Some(gate),
        )
        .await
        .unwrap();
        let (url, task) = serve(app).await;
        let http = reqwest::Client::new();
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
                .json(&json!({"action":action,"login":"alice","email":"a@example.test"}))
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
