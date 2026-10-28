use anyhow::{ensure, Context};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use neruvalo_crypto::{self as crypto, b64, unb64, Suite};
use neruvalo_protocol::*;
use opaque_ke::{
    rand::rngs::OsRng, CredentialFinalization, CredentialRequest, Identifiers, RegistrationRequest,
    RegistrationUpload, ServerLogin, ServerLoginParameters, ServerRegistration, ServerSetup,
};
use serde_json::{json, Value};
use sqlx::{any::AnyPoolOptions, AnyPool, Row};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
struct PendingRegistration {
    account: String,
    login: String,
    email: String,
    code_hash: String,
    expires: i64,
}
struct PendingLogin {
    account: String,
    registration_hash: String,
    state: ServerLogin<Suite>,
    expires: i64,
}
struct PendingRecovery {
    account: String,
    recovery_id: String,
    challenge: String,
    authorized: bool,
    expires: i64,
}
pub struct AppState {
    pool: AnyPool,
    setup: ServerSetup<Suite>,
    server_id: String,
    outbox: PathBuf,
    registrations: Mutex<HashMap<String, PendingRegistration>>,
    logins: Mutex<HashMap<String, PendingLogin>>,
    recoveries: Mutex<HashMap<String, PendingRecovery>>,
    attempts: Mutex<HashMap<String, (i64, u32)>>,
}
#[derive(Debug)]
struct ApiError(StatusCode, &'static str);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":{"code":self.1}}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(_: anyhow::Error) -> Self {
        Self(StatusCode::BAD_REQUEST, "INVALID_REQUEST")
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::warn!(error=%e,"database operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR")
    }
}
type Api<T> = Result<Json<T>, ApiError>;
fn invalid() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "INVALID_REQUEST")
}
fn auth_error() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "AUTH_FAILED")
}
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "RECORD_VERSION_MISMATCH")
}
fn decode<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, ApiError> {
    serde_json::from_str(s).map_err(|_| invalid())
}
fn ser<T: serde::Serialize>(v: &T) -> Result<String, ApiError> {
    serde_json::to_string(v).map_err(|_| invalid())
}
fn login_valid(s: &str) -> bool {
    (3..=40).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

pub async fn application(url: &str, outbox: PathBuf) -> anyhow::Result<Router> {
    sqlx::any::install_default_drivers();
    let pool = AnyPoolOptions::new()
        .max_connections(5)
        .connect(url)
        .await?;
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )
    .execute(&pool)
    .await?;
    if let Some(row) = sqlx::query("SELECT value FROM metadata WHERE name='schema_version'")
        .fetch_optional(&pool)
        .await?
    {
        ensure!(
            row.get::<String, _>("value") == "1",
            "Unsupported database schema"
        );
    }
    sqlx::raw_sql("CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,email TEXT NOT NULL UNIQUE,registration TEXT NOT NULL,bundle TEXT NOT NULL,timeout_seconds BIGINT NOT NULL DEFAULT 60);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),expires BIGINT NOT NULL);
 CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,account TEXT NOT NULL REFERENCES accounts(id),revision BIGINT NOT NULL,version_id TEXT NOT NULL,archived BIGINT NOT NULL);
 CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id),revision BIGINT NOT NULL,body TEXT NOT NULL,UNIQUE(record_id,revision));
 CREATE TABLE IF NOT EXISTS operations(account TEXT NOT NULL REFERENCES accounts(id),id TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(account,id));
 CREATE INDEX IF NOT EXISTS records_account ON records(account);") .execute(&pool).await?;
    let schema = sqlx::query("SELECT value FROM metadata WHERE name='schema_version'")
        .fetch_optional(&pool)
        .await?;
    if let Some(row) = schema {
        ensure!(
            row.get::<String, _>("value") == "1",
            "Unsupported database schema"
        );
    } else {
        sqlx::query("INSERT INTO metadata(name,value) VALUES('schema_version','1')")
            .execute(&pool)
            .await?;
    }
    let setup = metadata(
        &pool,
        "opaque_setup",
        b64(ServerSetup::<Suite>::new(&mut OsRng).serialize()),
    )
    .await?;
    let server_id = metadata(&pool, "server_id", Uuid::new_v4().to_string()).await?;
    std::fs::create_dir_all(&outbox)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&outbox, std::fs::Permissions::from_mode(0o700))?;
    }
    let s = Arc::new(AppState {
        pool,
        setup: ServerSetup::deserialize(&unb64(&setup)?)
            .map_err(|_| anyhow::anyhow!("bad OPAQUE setup"))?,
        server_id,
        outbox,
        registrations: Mutex::default(),
        logins: Mutex::default(),
        recoveries: Mutex::default(),
        attempts: Mutex::default(),
    });
    Ok(Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")})) }),
        )
        .route("/api/v1/info", get(info))
        .route("/api/v1/register/begin", post(register_begin))
        .route("/api/v1/register/finish", post(register_finish))
        .route("/api/v1/auth/begin", post(auth_begin))
        .route("/api/v1/auth/finish", post(auth_finish))
        .route("/api/v1/session/close", post(logout))
        .route("/api/v1/snapshot", get(snapshot))
        .route("/api/v1/records/save", post(save_record))
        .route("/api/v1/records/{id}/history", get(history))
        .route("/api/v1/settings", put(settings))
        .route("/api/v1/operations/{id}", get(operation_result))
        .route("/api/v1/recovery/begin", post(recovery_begin))
        .route("/api/v1/recovery/authorize", post(recovery_authorize))
        .route("/api/v1/recovery/finish", post(recovery_finish))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(s))
}
async fn metadata(pool: &AnyPool, name: &str, value: String) -> anyhow::Result<String> {
    sqlx::query("INSERT INTO metadata(name,value) VALUES($1,$2) ON CONFLICT(name) DO NOTHING")
        .bind(name)
        .bind(value)
        .execute(pool)
        .await?;
    Ok(sqlx::query("SELECT value FROM metadata WHERE name=$1")
        .bind(name)
        .fetch_one(pool)
        .await?
        .get("value"))
}
async fn rate(s: &AppState, key: &str) -> Result<(), ApiError> {
    let mut attempts = s.attempts.lock().await;
    attempts.retain(|_, (t, _)| *t > now() - 60);
    if attempts.len() > 4096 {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"));
    }
    let entry = attempts.entry(key.into()).or_insert((now(), 0));
    entry.1 += 1;
    if entry.1 > 20 {
        return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"));
    }
    Ok(())
}
async fn info(State(s): State<Arc<AppState>>) -> Json<ServerInfo> {
    Json(ServerInfo {
        server_id: s.server_id.clone(),
        protocol_version: PROTOCOL_VERSION,
        auth_profile: PROFILE.into(),
        dev_mode: true,
    })
}
async fn register_begin(
    State(s): State<Arc<AppState>>,
    Json(mut r): Json<RegisterBegin>,
) -> Api<RegisterChallenge> {
    rate(&s, "registration").await?;
    r.email = r.email.trim().to_lowercase();
    if !login_valid(&r.login) || !r.email.contains('@') || r.email.len() > 254 {
        return Err(invalid());
    }
    if sqlx::query("SELECT id FROM accounts WHERE login=$1 OR email=$2")
        .bind(&r.login)
        .bind(&r.email)
        .fetch_optional(&s.pool)
        .await?
        .is_some()
    {
        return Err(ApiError(StatusCode::CONFLICT, "ACCOUNT_EXISTS"));
    }
    let account = Uuid::new_v4().to_string();
    let ticket = crypto::token();
    let code = crypto::token();
    let response = ServerRegistration::<Suite>::start(
        &s.setup,
        RegistrationRequest::deserialize(&unb64(&r.message)?).map_err(|_| invalid())?,
        account.as_bytes(),
    )
    .map_err(|_| invalid())?;
    // Development-only email spool. Codes are never returned by the public API.
    let path = s.outbox.join(format!("{ticket}.txt"));
    let text=format!("Neruvalo DEVELOPMENT EMAIL\nTo: {}\nLogin: {}\nConfirmation code: {}\nExpires in 10 minutes.\n",r.email,r.login,code);
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(path)
            .context("dev outbox write")?
            .write_all(text.as_bytes())
            .context("dev outbox write")?;
    }
    let mut p = s.registrations.lock().await;
    p.retain(|_, v| v.expires > now());
    p.insert(
        ticket.clone(),
        PendingRegistration {
            account: account.clone(),
            login: r.login,
            email: r.email,
            code_hash: crypto::digest(&code),
            expires: now() + 600,
        },
    );
    Ok(Json(RegisterChallenge {
        ticket,
        account_id: account,
        server_id: s.server_id.clone(),
        message: b64(response.message.serialize()),
    }))
}
async fn register_finish(
    State(s): State<Arc<AppState>>,
    Json(r): Json<RegisterFinish>,
) -> Api<Value> {
    rate(&s, "registration-finish").await?;
    let mut pending = s.registrations.lock().await;
    let p = pending.get(&r.ticket).ok_or_else(invalid)?;
    if p.expires < now() || p.code_hash != crypto::digest(&r.email_code) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "INVALID_EMAIL_CODE"));
    }
    validate_bundle(&r.bundle)?;
    let registration = ServerRegistration::<Suite>::finish(
        RegistrationUpload::deserialize(&unb64(&r.message)?).map_err(|_| invalid())?,
    );
    let result = sqlx::query(
        "INSERT INTO accounts(id,login,email,registration,bundle) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(&p.account)
    .bind(&p.login)
    .bind(&p.email)
    .bind(b64(registration.serialize()))
    .bind(ser(&r.bundle)?)
    .execute(&s.pool)
    .await;
    if let Err(e) = result {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(ApiError(StatusCode::CONFLICT, "ACCOUNT_EXISTS"));
        }
        return Err(e.into());
    }
    pending.remove(&r.ticket);
    let _ = std::fs::remove_file(s.outbox.join(format!("{}.txt", r.ticket)));
    Ok(Json(json!({"registered":true})))
}
fn validate_bundle(b: &AccountBundle) -> Result<(), ApiError> {
    if unb64(&b.public_sign)?.len() != 32 || unb64(&b.public_share)?.len() != 32 {
        return Err(invalid());
    }
    if !b.envelope.is_object() {
        return Err(invalid());
    }
    if let Some(r) = &b.recovery {
        if unb64(&r.public_key)?.len() != 32 {
            return Err(invalid());
        }
    }
    Ok(())
}
fn params<'a>(account: &'a str, server: &'a str) -> ServerLoginParameters<'a, 'a> {
    ServerLoginParameters {
        context: Some(b"neruvalo-login-v1"),
        identifiers: Identifiers {
            client: Some(account.as_bytes()),
            server: Some(server.as_bytes()),
        },
    }
}
async fn auth_begin(
    State(s): State<Arc<AppState>>,
    Json(r): Json<LoginBegin>,
) -> Api<LoginChallenge> {
    rate(&s, &format!("login:{}", r.login)).await?;
    let row = sqlx::query("SELECT id,registration FROM accounts WHERE login=$1")
        .bind(&r.login)
        .fetch_optional(&s.pool)
        .await?;
    let account = row
        .as_ref()
        .map(|x| x.get::<String, _>("id"))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let registration_hash = row
        .as_ref()
        .map(|r| crypto::digest(&r.get::<String, _>("registration")))
        .unwrap_or_default();
    let file = match row {
        Some(row) => Some(
            ServerRegistration::<Suite>::deserialize(&unb64(
                &row.get::<String, _>("registration"),
            )?)
            .map_err(|_| invalid())?,
        ),
        None => None,
    };
    let start = ServerLogin::<Suite>::start(
        &mut OsRng,
        &s.setup,
        file,
        CredentialRequest::deserialize(&unb64(&r.message)?).map_err(|_| invalid())?,
        account.as_bytes(),
        params(&account, &s.server_id),
    )
    .map_err(|_| auth_error())?;
    let ticket = crypto::token();
    let message = b64(start.message.serialize());
    let mut p = s.logins.lock().await;
    p.retain(|_, v| v.expires > now());
    if p.len() > 4096 {
        return Err(invalid());
    }
    p.insert(
        ticket.clone(),
        PendingLogin {
            account: account.clone(),
            registration_hash,
            state: start.state,
            expires: now() + 120,
        },
    );
    Ok(Json(LoginChallenge {
        ticket,
        account_id: account,
        message,
    }))
}
async fn auth_finish(
    State(s): State<Arc<AppState>>,
    Json(r): Json<LoginFinish>,
) -> Api<LoginResponse> {
    let p = s
        .logins
        .lock()
        .await
        .remove(&r.ticket)
        .ok_or_else(auth_error)?;
    if p.expires < now() {
        return Err(auth_error());
    }
    p.state
        .finish(
            CredentialFinalization::deserialize(&unb64(&r.message)?).map_err(|_| auth_error())?,
            params(&p.account, &s.server_id),
        )
        .map_err(|_| auth_error())?;
    let mut tx = s.pool.begin().await?;
    // Serialize session issuance with recovery/password replacement on this account.
    sqlx::query("UPDATE accounts SET registration=registration WHERE id=$1")
        .bind(&p.account)
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query("SELECT bundle,timeout_seconds,registration FROM accounts WHERE id=$1")
        .bind(&p.account)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(auth_error)?;
    if crypto::digest(&row.get::<String, _>("registration")) != p.registration_hash {
        return Err(auth_error());
    }
    let token = crypto::token();
    let inserted=sqlx::query("INSERT INTO sessions(token_hash,account,expires) SELECT $1,id,$2 FROM accounts WHERE id=$3 AND registration=$4")
 .bind(crypto::digest(&token)).bind(now()+12*3600).bind(&p.account).bind(row.get::<String,_>("registration")).execute(&mut *tx).await?.rows_affected();
    if inserted != 1 {
        return Err(auth_error());
    }
    tx.commit().await?;
    Ok(Json(LoginResponse {
        token,
        account_id: p.account,
        bundle: decode(&row.get::<String, _>("bundle"))?,
        timeout_seconds: row.get::<i64, _>("timeout_seconds") as u32,
    }))
}
async fn account(s: &AppState, h: &HeaderMap) -> Result<String, ApiError> {
    let token = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(auth_error)?;
    let row = sqlx::query("SELECT account FROM sessions WHERE token_hash=$1 AND expires>$2")
        .bind(crypto::digest(token))
        .bind(now())
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(auth_error)?;
    Ok(row.get("account"))
}
async fn logout(State(s): State<Arc<AppState>>, h: HeaderMap) -> Api<Value> {
    account(&s, &h).await?;
    let token = h["authorization"]
        .to_str()
        .map_err(|_| auth_error())?
        .trim_start_matches("Bearer ");
    sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
        .bind(crypto::digest(token))
        .execute(&s.pool)
        .await?;
    Ok(Json(json!({"closed":true})))
}
async fn snapshot(State(s): State<Arc<AppState>>, h: HeaderMap) -> Api<Value> {
    let id = account(&s, &h).await?;
    // A single query gives all versions and current archive state at one statement snapshot.
    let rows=sqlx::query("SELECT v.body FROM versions v JOIN records r ON r.id=v.record_id WHERE r.account=$1 ORDER BY v.record_id,v.revision").bind(&id).fetch_all(&s.pool).await?;
    let mut versions = Vec::new();
    for row in rows {
        let v: StoredVersion = decode(&row.get::<String, _>("body"))?;
        versions.push(v);
    }
    let timeout = sqlx::query("SELECT timeout_seconds FROM accounts WHERE id=$1")
        .bind(&id)
        .fetch_one(&s.pool)
        .await?
        .get::<i64, _>("timeout_seconds");
    Ok(Json(json!({"versions":versions,"timeout_seconds":timeout})))
}
async fn operation_result(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Api<Value> {
    let actor = account(&s, &h).await?;
    let row = sqlx::query("SELECT result FROM operations WHERE account=$1 AND id=$2")
        .bind(actor)
        .bind(id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "OPERATION_NOT_FOUND"))?;
    Ok(Json(decode(&row.get::<String, _>("result"))?))
}
async fn save_record(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(r): Json<SaveRecord>,
) -> Api<Value> {
    let actor = account(&s, &h).await?;
    if r.expected_revision < 0
        || Uuid::parse_str(&r.record_id).is_err()
        || Uuid::parse_str(&r.version_id).is_err()
        || Uuid::parse_str(&r.operation_id).is_err()
    {
        return Err(invalid());
    }
    let row = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&actor)
        .fetch_one(&s.pool)
        .await?;
    let bundle: AccountBundle = decode(&row.get::<String, _>("bundle"))?;
    crypto::verify(
        &bundle.public_sign,
        &record_transcript(&s.server_id, &actor, &r),
        &r.signature,
    )
    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "INVALID_SIGNATURE"))?;
    let request_hash = crypto::digest(&ser(&r)?);
    let mut tx = s.pool.begin().await?;
    if let Some(row) =
        sqlx::query("SELECT request_hash,result FROM operations WHERE account=$1 AND id=$2")
            .bind(&actor)
            .bind(&r.operation_id)
            .fetch_optional(&mut *tx)
            .await?
    {
        if row.get::<String, _>("request_hash") != request_hash {
            return Err(ApiError(StatusCode::CONFLICT, "OPERATION_ID_REUSED"));
        }
        return Ok(Json(decode(&row.get::<String, _>("result"))?));
    }
    let revision = r.expected_revision + 1;
    if r.expected_revision == 0 {
        if r.previous_version.is_some() {
            return Err(invalid());
        }
        let rows=sqlx::query("INSERT INTO records(id,account,revision,version_id,archived) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING").bind(&r.record_id).bind(&actor).bind(revision).bind(&r.version_id).bind(r.archived as i64).execute(&mut *tx).await?.rows_affected();
        if rows != 1 {
            return Err(conflict());
        }
    } else {
        let row = sqlx::query("SELECT revision,version_id FROM records WHERE id=$1 AND account=$2")
            .bind(&r.record_id)
            .bind(&actor)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(ApiError(StatusCode::FORBIDDEN, "ACCESS_DENIED"))?;
        if row.get::<i64, _>("revision") != r.expected_revision
            || Some(row.get::<String, _>("version_id")) != r.previous_version
        {
            return Err(conflict());
        }
        let rows=sqlx::query("UPDATE records SET revision=$1,version_id=$2,archived=$3 WHERE id=$4 AND account=$5 AND revision=$6").bind(revision).bind(&r.version_id).bind(r.archived as i64).bind(&r.record_id).bind(&actor).bind(r.expected_revision).execute(&mut *tx).await?.rows_affected();
        if rows != 1 {
            return Err(conflict());
        }
    }
    let v = StoredVersion {
        operation_id: r.operation_id.clone(),
        record_id: r.record_id.clone(),
        version_id: r.version_id.clone(),
        revision,
        previous_version: r.previous_version.clone(),
        payload: r.payload,
        signature: r.signature,
        archived: r.archived,
        created_at: now(),
    };
    sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
        .bind(&v.version_id)
        .bind(&v.record_id)
        .bind(revision)
        .bind(ser(&v)?)
        .execute(&mut *tx)
        .await?;
    let result = json!({"operation_id":r.operation_id,"record_id":v.record_id,"version_id":v.version_id,"revision":revision});
    sqlx::query("INSERT INTO operations(account,id,request_hash,result) VALUES($1,$2,$3,$4)")
        .bind(&actor)
        .bind(&r.operation_id)
        .bind(request_hash)
        .bind(ser(&result)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn history(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Api<Vec<StoredVersion>> {
    let actor = account(&s, &h).await?;
    if sqlx::query("SELECT id FROM records WHERE id=$1 AND account=$2")
        .bind(&id)
        .bind(actor)
        .fetch_optional(&s.pool)
        .await?
        .is_none()
    {
        return Err(ApiError(StatusCode::FORBIDDEN, "ACCESS_DENIED"));
    }
    let rows = sqlx::query("SELECT body FROM versions WHERE record_id=$1 ORDER BY revision")
        .bind(id)
        .fetch_all(&s.pool)
        .await?;
    Ok(Json(
        rows.iter()
            .map(|r| decode(&r.get::<String, _>("body")))
            .collect::<Result<_, _>>()?,
    ))
}
async fn settings(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Json(r): Json<Settings>,
) -> Api<Settings> {
    let actor = account(&s, &h).await?;
    if r.timeout_seconds > 86400 {
        return Err(invalid());
    }
    sqlx::query("UPDATE accounts SET timeout_seconds=$1 WHERE id=$2")
        .bind(r.timeout_seconds as i64)
        .bind(actor)
        .execute(&s.pool)
        .await?;
    Ok(Json(r))
}
async fn recovery_begin(
    State(s): State<Arc<AppState>>,
    Json(r): Json<RecoveryBegin>,
) -> Api<RecoveryChallenge> {
    rate(&s, "recovery").await?;
    let row = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&r.account_id)
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(auth_error)?;
    let b: AccountBundle = decode(&row.get::<String, _>("bundle"))?;
    let bundle = b
        .recovery
        .filter(|b| b.id == r.recovery_id)
        .ok_or(ApiError(StatusCode::FORBIDDEN, "RECOVERY_REVOKED"))?;
    let ticket = crypto::token();
    let challenge = crypto::token();
    let mut p = s.recoveries.lock().await;
    p.retain(|_, v| v.expires > now());
    p.insert(
        ticket.clone(),
        PendingRecovery {
            account: r.account_id,
            recovery_id: r.recovery_id,
            challenge: challenge.clone(),
            authorized: false,
            expires: now() + 120,
        },
    );
    Ok(Json(RecoveryChallenge {
        ticket,
        challenge,
        bundle,
    }))
}
pub fn recovery_transcript(
    server: &str,
    account: &str,
    recovery: &str,
    ticket: &str,
    challenge: &str,
    message: &str,
) -> Vec<u8> {
    serde_json::to_vec(&(
        "neruvalo-recovery-v1",
        server,
        account,
        recovery,
        ticket,
        challenge,
        message,
    ))
    .expect("tuple")
}
async fn recovery_authorize(
    State(s): State<Arc<AppState>>,
    Json(r): Json<RecoveryAuthorize>,
) -> Api<RecoveryPrepared> {
    let mut p = s.recoveries.lock().await;
    let pending = p.get_mut(&r.ticket).ok_or_else(auth_error)?;
    if pending.expires < now() || pending.authorized {
        return Err(auth_error());
    }
    let row = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&pending.account)
        .fetch_one(&s.pool)
        .await?;
    let bundle: AccountBundle = decode(&row.get::<String, _>("bundle"))?;
    let recovery = bundle
        .recovery
        .filter(|v| v.id == pending.recovery_id)
        .ok_or_else(auth_error)?;
    crypto::verify(
        &recovery.public_key,
        &recovery_transcript(
            &s.server_id,
            &pending.account,
            &pending.recovery_id,
            &r.ticket,
            &pending.challenge,
            &r.message,
        ),
        &r.signature,
    )
    .map_err(|_| auth_error())?;
    let result = ServerRegistration::<Suite>::start(
        &s.setup,
        RegistrationRequest::deserialize(&unb64(&r.message)?).map_err(|_| invalid())?,
        pending.account.as_bytes(),
    )
    .map_err(|_| invalid())?;
    pending.authorized = true;
    Ok(Json(RecoveryPrepared {
        ticket: r.ticket,
        message: b64(result.message.serialize()),
    }))
}
async fn recovery_finish(
    State(s): State<Arc<AppState>>,
    Json(r): Json<RecoveryFinish>,
) -> Api<Value> {
    let pending = s
        .recoveries
        .lock()
        .await
        .remove(&r.ticket)
        .ok_or_else(auth_error)?;
    if pending.expires < now() || !pending.authorized {
        return Err(auth_error());
    }
    let registration = ServerRegistration::<Suite>::finish(
        RegistrationUpload::deserialize(&unb64(&r.message)?).map_err(|_| invalid())?,
    );
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query("SELECT bundle FROM accounts WHERE id=$1")
        .bind(&pending.account)
        .fetch_one(&mut *tx)
        .await?;
    let old: String = row.get("bundle");
    let mut bundle: AccountBundle = decode(&old)?;
    if !bundle
        .recovery
        .as_ref()
        .is_some_and(|x| x.id == pending.recovery_id)
    {
        return Err(auth_error());
    }
    bundle.envelope["root"] = r.envelope;
    let count =
        sqlx::query("UPDATE accounts SET registration=$1,bundle=$2 WHERE id=$3 AND bundle=$4")
            .bind(b64(registration.serialize()))
            .bind(ser(&bundle)?)
            .bind(&pending.account)
            .bind(old)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if count != 1 {
        return Err(ApiError(StatusCode::CONFLICT, "KEY_STATE_CHANGED"));
    }
    sqlx::query("DELETE FROM sessions WHERE account=$1")
        .bind(&pending.account)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"recovered":true})))
}
