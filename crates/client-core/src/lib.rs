use anyhow::{anyhow, bail, ensure, Result};
use neruvalo_crypto::{
    self as crypto, account_context, b64, unb64, AccountKeys, EncryptedVersion, Envelope, Suite,
};
use neruvalo_protocol::*;
use opaque_ke::{
    rand::rngs::OsRng, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialResponse, Identifiers, RegistrationResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{any::AnyPoolOptions, AnyPool, Row};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroizing;
mod groups;
mod sharing;
pub use groups::GroupView;

#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub server: String,
    pub server_id: String,
    pub account_id: String,
    pub login: String,
    pub opaque_public: String,
    pub bundle: AccountBundle,
    pub local_salt: String,
    pub local_root: Envelope,
    pub timeout_seconds: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RecordData {
    pub record_type: String,
    pub schema_version: u32,
    pub title: String,
    pub fields: BTreeMap<String, String>,
    pub notes: String,
    pub folder: String,
    pub tags: Vec<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}
impl RecordData {
    pub fn validate(&self) -> Result<()> {
        let group = self.record_type == "group";
        ensure!(
            self.schema_version == if group { 2 } else { 1 },
            "UNSUPPORTED_FORMAT"
        );
        ensure!(
            [
                "login",
                "bank_card",
                "note",
                "bank_account",
                "api_token",
                "ssh_key",
                "document",
                "crypto_wallet",
                "group"
            ]
            .contains(&self.record_type.as_str()),
            "UNSUPPORTED_TYPE"
        );
        ensure!(
            !self.title.trim().is_empty() && self.title.len() <= 1024,
            "Title is required (maximum 1024 bytes)"
        );
        for key in if group {
            &["parent_group_id"][..]
        } else {
            &["group_id"][..]
        } {
            if let Some(value) = self.extra.get(*key) {
                ensure!(
                    value.is_null() || value.as_str().is_some_and(|s| Uuid::parse_str(s).is_ok()),
                    "INVALID_GROUP"
                );
            }
        }
        if group {
            ensure!(
                self.fields.is_empty()
                    && self.notes.is_empty()
                    && self.folder.is_empty()
                    && self.tags.is_empty(),
                "INVALID_GROUP"
            );
            if let Some(path) = self.extra.get("legacy_path") {
                ensure!(
                    path.as_str().is_some_and(|p| !p.is_empty()),
                    "INVALID_GROUP"
                );
            }
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= 256 * 1024,
            "Record exceeds 256 KiB"
        );
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryCertificate {
    pub format: String,
    pub format_version: u32,
    pub server: String,
    pub server_id: String,
    pub account_id: String,
    pub recovery_id: String,
    pub secret: String,
}
struct Pending {
    finish: RegisterFinish,
    certificate: Option<Zeroizing<String>>,
}
struct Unlocked {
    profile: Profile,
    keys: AccountKeys,
    _root: Zeroizing<[u8; 32]>,
    token: Zeroizing<String>,
    last_activity: Instant,
    cache: AnyPool,
    online: bool,
    needs_sync: bool,
}
pub struct Client {
    dir: PathBuf,
    http: reqwest::Client,
    active: Option<Unlocked>,
    pending: Option<Pending>,
    certificate: Option<Zeroizing<String>>,
}
#[derive(Serialize)]
pub struct ViewRecord {
    pub record_id: String,
    pub version_id: String,
    pub revision: i64,
    pub archived: bool,
    pub data: RecordData,
}

pub fn normalize_server(server: &str) -> Result<String> {
    let u = reqwest::Url::parse(server)?;
    ensure!(
        u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none(),
        "Invalid server URL"
    );
    ensure!(u.path() == "/", "Use the server origin without a path");
    let loopback = matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    ensure!(
        u.scheme() == "https" || (u.scheme() == "http" && loopback),
        "HTTPS is required (HTTP allowed only on loopback for development)"
    );
    Ok(u.to_string().trim_end_matches('/').to_owned())
}
fn opaque_ids<'a>(account: &'a str, server: &'a str) -> Identifiers<'a> {
    Identifiers {
        client: Some(account.as_bytes()),
        server: Some(server.as_bytes()),
    }
}
fn root_context(s: &str, a: &str) -> Vec<u8> {
    account_context(s, a, "root")
}
fn keys_context(s: &str, a: &str) -> Vec<u8> {
    account_context(s, a, "keys")
}
fn local_context(s: &str, a: &str) -> Vec<u8> {
    account_context(s, a, "local-root")
}
fn version_context(s: &str, a: &str, r: &str, v: &str) -> Vec<u8> {
    serde_json::to_vec(&("neruvalo-record-data-v1", s, a, r, v)).expect("tuple")
}
fn recovery_context(s: &str, a: &str, id: &str) -> Vec<u8> {
    serde_json::to_vec(&("neruvalo-recovery-envelope-v1", s, a, id)).expect("tuple")
}
fn recovery_transcript(s: &str, a: &str, r: &str, t: &str, c: &str, m: &str) -> Vec<u8> {
    serde_json::to_vec(&("neruvalo-recovery-v1", s, a, r, t, c, m)).expect("tuple")
}
async fn response<T: serde::de::DeserializeOwned>(r: reqwest::Response) -> Result<T> {
    let status = r.status();
    let bytes = r.bytes().await?;
    ensure!(bytes.len() <= 32 * 1024 * 1024, "Server response too large");
    if !status.is_success() {
        let e: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        bail!(
            "{}",
            e.pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("SERVER_ERROR")
        );
    }
    Ok(serde_json::from_slice(&bytes)?)
}
/// Build a SQLite URL without interpreting a Windows drive as a URL authority.
/// Encoding the entire filename also preserves Unicode, spaces, `%`, `#` and `?`.
pub fn sqlite_database_url(path: &Path) -> Result<String> {
    let filename = path
        .to_str()
        .ok_or_else(|| anyhow!("DATABASE_PATH_NOT_UTF8"))?;
    let encoded: String = filename
        .as_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    Ok(format!("sqlite:{encoded}?mode=rwc"))
}

async fn cache(dir: &Path, id: &str) -> Result<AnyPool> {
    sqlx::any::install_default_drivers();
    let folder = dir.join(id);
    std::fs::create_dir_all(&folder)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))?;
    }
    let db = folder.join("cache.sqlite3");
    let pool = AnyPoolOptions::new()
        .max_connections(1)
        .connect(&sqlite_database_url(&db)?)
        .await?;
    sqlx::raw_sql("CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,record_id TEXT NOT NULL,revision BIGINT NOT NULL,body TEXT NOT NULL);").execute(&pool).await?;
    if let Some(row) = sqlx::query("SELECT value FROM meta WHERE name='schema_version'")
        .fetch_optional(&pool)
        .await?
    {
        ensure!(
            row.get::<String, _>("value") == "2",
            "UNSUPPORTED_LOCAL_SCHEMA"
        );
    } else {
        sqlx::query("INSERT INTO meta(name,value) VALUES('schema_version','2')")
            .execute(&pool)
            .await?;
    }
    Ok(pool)
}
async fn set_meta(pool: &AnyPool, name: &str, value: &str) -> Result<()> {
    sqlx::query("INSERT INTO meta(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(name).bind(value).execute(pool).await?;
    Ok(())
}
impl Client {
    pub fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            dir,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            active: None,
            pending: None,
            certificate: None,
        })
    }
    pub fn lock(&mut self) {
        self.active = None;
        self.pending = None;
        self.certificate = None;
    }
    fn unlocked(&mut self) -> Result<&mut Unlocked> {
        let expired = self.active.as_ref().is_some_and(|a| {
            a.profile.timeout_seconds > 0
                && a.last_activity.elapsed()
                    >= Duration::from_secs(a.profile.timeout_seconds as u64)
        });
        if expired {
            self.lock();
        }
        self.active.as_mut().ok_or_else(|| anyhow!("LOCKED"))
    }
    pub fn touch(&mut self) -> Result<()> {
        self.unlocked()?.last_activity = Instant::now();
        Ok(())
    }
    pub fn status(&mut self) -> Value {
        match self.unlocked() {
            Ok(a) => {
                json!({"unlocked":true,"profile":a.profile.id,"login":a.profile.login,"server":a.profile.server,"online":a.online,"timeout_seconds":a.profile.timeout_seconds})
            }
            Err(_) => json!({"unlocked":false}),
        }
    }
    pub async fn profiles(&self) -> Result<Vec<Value>> {
        let mut profiles = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let p = entry.path().join("profile.json");
            if p.is_file() {
                let profile: Profile = serde_json::from_slice(&std::fs::read(p)?)?;
                profiles
                    .push(json!({"id":profile.id,"login":profile.login,"server":profile.server}));
            }
        }
        Ok(profiles)
    }
    fn store_profile(&self, p: &Profile) -> Result<()> {
        let folder = self.dir.join(&p.id);
        std::fs::create_dir_all(&folder)?;
        let path = folder.join("profile.json");
        let temporary = folder.join("profile.json.tmp");
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.create(true).truncate(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(p)?)?;
            file.sync_all()?;
        }
        // Windows rename does not replace an existing target. Both files contain only encrypted key envelopes.
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(temporary, path)?;
        Ok(())
    }
    async fn info(&self, server: &str) -> Result<ServerInfo> {
        let info: ServerInfo = response(
            self.http
                .get(format!("{server}/api/v1/info"))
                .send()
                .await?,
        )
        .await?;
        ensure!(
            info.protocol_version == PROTOCOL_VERSION && info.auth_profile == PROFILE,
            "UNSUPPORTED_PROTOCOL"
        );
        Ok(info)
    }
    pub async fn register_begin(
        &mut self,
        server: &str,
        login: &str,
        email: &str,
        password: Zeroizing<String>,
        with_recovery: bool,
    ) -> Result<Value> {
        self.lock();
        ensure!(
            password.len() >= 12,
            "Use a master password of at least 12 characters"
        );
        let server = normalize_server(server)?;
        let info = self.info(&server).await?;
        let start = ClientRegistration::<Suite>::start(&mut OsRng, password.as_bytes())
            .map_err(|_| anyhow!("OPAQUE_START_FAILED"))?;
        let challenge: RegisterChallenge = response(
            self.http
                .post(format!("{server}/api/v1/register/begin"))
                .json(&RegisterBegin {
                    login: login.into(),
                    email: email.into(),
                    message: b64(start.message.serialize()),
                })
                .send()
                .await?,
        )
        .await?;
        ensure!(challenge.server_id == info.server_id, "SERVER_ID_CHANGED");
        let kdf = crypto::kdf();
        let finish = start
            .state
            .finish(
                &mut OsRng,
                password.as_bytes(),
                RegistrationResponse::deserialize(&unb64(&challenge.message)?)
                    .map_err(|_| anyhow!("INVALID_OPAQUE_MESSAGE"))?,
                ClientRegistrationFinishParameters::new(
                    opaque_ids(&challenge.account_id, &info.server_id),
                    Some(&kdf),
                ),
            )
            .map_err(|_| anyhow!("OPAQUE_FINISH_FAILED"))?;
        let root = Zeroizing::new(crypto::random::<32>());
        let keys = AccountKeys::generate();
        let wrapping = crypto::derive(&finish.export_key, b"server-root")?;
        let root_envelope = crypto::seal(
            wrapping.as_ref(),
            root.as_ref(),
            &root_context(&info.server_id, &challenge.account_id),
        )?;
        let encoded_keys = Zeroizing::new(serde_json::to_vec(&keys)?);
        let keys_envelope = crypto::seal(
            root.as_ref(),
            &encoded_keys,
            &keys_context(&info.server_id, &challenge.account_id),
        )?;
        let mut certificate = None;
        let recovery = if with_recovery {
            let secret = Zeroizing::new(crypto::random::<32>());
            let recovery_id = Uuid::new_v4().to_string();
            let wrap = crypto::derive(secret.as_ref(), b"recovery-wrap")?;
            let sign = crypto::derive(secret.as_ref(), b"recovery-sign")?;
            certificate = Some(Zeroizing::new(serde_json::to_string_pretty(
                &RecoveryCertificate {
                    format: "neruvalo-recovery".into(),
                    format_version: 1,
                    server: server.clone(),
                    server_id: info.server_id.clone(),
                    account_id: challenge.account_id.clone(),
                    recovery_id: recovery_id.clone(),
                    secret: b64(secret.as_ref()),
                },
            )?));
            Some(RecoveryBundle {
                id: recovery_id.clone(),
                public_key: crypto::public_seed(&sign),
                envelope: serde_json::to_value(crypto::seal(
                    wrap.as_ref(),
                    root.as_ref(),
                    &recovery_context(&info.server_id, &challenge.account_id, &recovery_id),
                )?)?,
            })
        } else {
            None
        };
        let bundle = AccountBundle {
            envelope: json!({"root":root_envelope,"keys":keys_envelope}),
            public_sign: keys.public_sign(),
            public_share: keys.public_share(),
            recovery,
        };
        self.pending = Some(Pending {
            finish: RegisterFinish {
                ticket: challenge.ticket.clone(),
                email_code: String::new(),
                message: b64(finish.message.serialize()),
                bundle,
            },
            certificate,
        });
        Ok(
            json!({"ticket":challenge.ticket,"server":server,"dev_mode":info.dev_mode,"message":"Read the confirmation code in the server development outbox"}),
        )
    }
    pub async fn register_finish(&mut self, server: &str, code: &str) -> Result<Value> {
        let server = normalize_server(server)?;
        let p = self
            .pending
            .as_mut()
            .ok_or_else(|| anyhow!("NO_PENDING_REGISTRATION"))?;
        p.finish.email_code = code.trim().into();
        let result: Value = response(
            self.http
                .post(format!("{server}/api/v1/register/finish"))
                .json(&p.finish)
                .send()
                .await?,
        )
        .await?;
        self.certificate = self.pending.take().and_then(|p| p.certificate);
        Ok(result)
    }
    pub fn save_certificate_to(&mut self, path: &Path) -> Result<()> {
        use std::io::Write;
        let certificate = self
            .certificate
            .as_ref()
            .ok_or_else(|| anyhow!("NO_CERTIFICATE"))?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(certificate.as_bytes())?;
        file.sync_all()?;
        self.certificate = None;
        Ok(())
    }
    pub fn take_certificate(&mut self) -> Option<Zeroizing<String>> {
        self.certificate.take()
    }
    pub async fn login(
        &mut self,
        server: &str,
        login: &str,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        self.lock();
        let server = normalize_server(server)?;
        let info = self.info(&server).await?;
        let start = ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes())
            .map_err(|_| anyhow!("OPAQUE_START_FAILED"))?;
        let challenge: LoginChallenge = response(
            self.http
                .post(format!("{server}/api/v1/auth/begin"))
                .json(&LoginBegin {
                    login: login.into(),
                    message: b64(start.message.serialize()),
                })
                .send()
                .await?,
        )
        .await?;
        let kdf = crypto::kdf();
        let finish = start
            .state
            .finish(
                &mut OsRng,
                password.as_bytes(),
                CredentialResponse::deserialize(&unb64(&challenge.message)?)
                    .map_err(|_| anyhow!("INVALID_OPAQUE_MESSAGE"))?,
                ClientLoginFinishParameters::new(
                    Some(b"neruvalo-login-v1"),
                    opaque_ids(&challenge.account_id, &info.server_id),
                    Some(&kdf),
                ),
            )
            .map_err(|_| anyhow!("AUTH_FAILED"))?;
        let id = crypto::digest(&format!("{}:{}", info.server_id, challenge.account_id));
        let path = self.dir.join(&id).join("profile.json");
        let public = b64(finish.server_s_pk.serialize());
        if path.exists() {
            let old: Profile = serde_json::from_slice(&std::fs::read(path)?)?;
            ensure!(
                old.server_id == info.server_id && old.opaque_public == public,
                "SERVER_KEY_CHANGED"
            );
        }
        // Also detect a replaced server at a previously used origin, even if it returns a different ID.
        for profile in self.profiles().await? {
            if profile["server"] == server && profile["login"] == login {
                ensure!(profile["id"] == id, "SERVER_ID_CHANGED");
            }
        }
        let result: LoginResponse = response(
            self.http
                .post(format!("{server}/api/v1/auth/finish"))
                .json(&LoginFinish {
                    ticket: challenge.ticket,
                    message: b64(finish.message.serialize()),
                })
                .send()
                .await?,
        )
        .await?;
        ensure!(result.account_id == challenge.account_id, "ACCOUNT_CHANGED");
        let wrap = crypto::derive(&finish.export_key, b"server-root")?;
        let root = crypto::parse_key(&crypto::open(
            wrap.as_ref(),
            &serde_json::from_value(result.bundle.envelope["root"].clone())?,
            &root_context(&info.server_id, &result.account_id),
        )?)?;
        let raw = crypto::open(
            root.as_ref(),
            &serde_json::from_value(result.bundle.envelope["keys"].clone())?,
            &keys_context(&info.server_id, &result.account_id),
        )?;
        let keys: AccountKeys = serde_json::from_slice(&raw)?;
        ensure!(
            keys.public_sign() == result.bundle.public_sign
                && keys.public_share() == result.bundle.public_share,
            "PUBLIC_KEY_MISMATCH"
        );
        let salt = crypto::random::<16>();
        let local = crypto::password_key(&password, &salt)?;
        let local_root = crypto::seal(
            local.as_ref(),
            root.as_ref(),
            &local_context(&info.server_id, &result.account_id),
        )?;
        let profile = Profile {
            id: id.clone(),
            server,
            server_id: info.server_id,
            account_id: result.account_id,
            login: login.into(),
            opaque_public: public,
            bundle: result.bundle,
            local_salt: b64(salt),
            local_root,
            timeout_seconds: result.timeout_seconds,
        };
        let db = cache(&self.dir, &id).await?;
        self.store_profile(&profile)?;
        self.active = Some(Unlocked {
            profile,
            keys,
            _root: root,
            token: Zeroizing::new(result.token),
            last_activity: Instant::now(),
            cache: db,
            online: true,
            needs_sync: false,
        });
        self.sync().await?;
        Ok(self.status())
    }
    pub async fn unlock_offline(&mut self, id: &str, password: Zeroizing<String>) -> Result<Value> {
        self.lock();
        ensure!(
            id.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
            "Invalid profile"
        );
        let p: Profile =
            serde_json::from_slice(&std::fs::read(self.dir.join(id).join("profile.json"))?)?;
        let local = crypto::password_key(&password, &unb64(&p.local_salt)?)?;
        let root = crypto::parse_key(&crypto::open(
            local.as_ref(),
            &p.local_root,
            &local_context(&p.server_id, &p.account_id),
        )?)?;
        let raw = crypto::open(
            root.as_ref(),
            &serde_json::from_value(p.bundle.envelope["keys"].clone())?,
            &keys_context(&p.server_id, &p.account_id),
        )?;
        let keys: AccountKeys = serde_json::from_slice(&raw)?;
        let db = cache(&self.dir, id).await?;
        self.active = Some(Unlocked {
            profile: p,
            keys,
            _root: root,
            token: Zeroizing::new(String::new()),
            last_activity: Instant::now(),
            cache: db,
            online: false,
            needs_sync: false,
        });
        Ok(self.status())
    }
    pub async fn sync(&mut self) -> Result<Value> {
        let http = self.http.clone();
        let a = self.unlocked()?;
        ensure!(!a.token.is_empty(), "ONLINE_LOGIN_REQUIRED");
        if let Some(row) = sqlx::query("SELECT value FROM meta WHERE name='pending_operation'")
            .fetch_optional(&a.cache)
            .await?
        {
            let pending: Value = serde_json::from_str(&row.get::<String, _>("value"))?;
            let check = http
                .get(format!(
                    "{}/api/v1/operations/{}",
                    a.profile.server,
                    pending["operation_id"]
                        .as_str()
                        .ok_or_else(|| anyhow!("INVALID_PENDING_OPERATION"))?
                ))
                .bearer_auth(a.token.as_str())
                .send()
                .await?;
            if check.status() == reqwest::StatusCode::NOT_FOUND {
                let replay = http
                    .post(format!(
                        "{}/{}",
                        a.profile.server,
                        if pending.get("kind").is_some() {
                            "api/v2/shares/change"
                        } else if pending.get("records").is_some() {
                            "api/v1/records/batch"
                        } else {
                            "api/v1/records/save"
                        }
                    ))
                    .bearer_auth(a.token.as_str())
                    .json(&pending)
                    .send()
                    .await?;
                if replay.status().is_server_error() {
                    bail!("SAVE_RESULT_UNKNOWN");
                }
                if !replay.status().is_success() {
                    if replay.status().is_client_error() {
                        sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
                            .execute(&a.cache)
                            .await?;
                    } else {
                        let _: Value = response(replay).await?;
                    }
                }
            } else {
                let _: Value = response(check).await?;
            }
            sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
                .execute(&a.cache)
                .await?;
        }
        let result = http
            .get(format!("{}/api/v1/snapshot", a.profile.server))
            .bearer_auth(a.token.as_str())
            .send()
            .await;
        let snapshot: Value = match result {
            Ok(r) => match response(r).await {
                Ok(v) => v,
                Err(e) => {
                    a.online = false;
                    return Err(e);
                }
            },
            Err(e) => {
                a.online = false;
                return Err(e.into());
            }
        };
        let versions: Vec<StoredVersion> = serde_json::from_value(snapshot["versions"].clone())?;
        for v in &versions {
            verify_version(&a.profile, v)?;
        }
        sharing::verify_snapshot(a, &snapshot["sharing"]).await?;
        let mut tx = a.cache.begin().await?;
        sqlx::query("INSERT INTO meta(name,value) VALUES('sharing',$1) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(serde_json::to_string(&snapshot["sharing"])?).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM versions")
            .execute(&mut *tx)
            .await?;
        for v in &versions {
            sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
                .bind(&v.version_id)
                .bind(&v.record_id)
                .bind(v.revision)
                .bind(serde_json::to_string(v)?)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        a.profile.timeout_seconds = snapshot["timeout_seconds"].as_u64().unwrap_or(60) as u32;
        a.online = true;
        a.needs_sync = false;
        let p = a.profile.clone();
        self.store_profile(&p)?;
        Ok(json!({"synced":true,"versions":versions.len()}))
    }
    pub async fn list(&mut self) -> Result<Vec<ViewRecord>> {
        Ok(self
            .objects()
            .await?
            .into_iter()
            .filter(|r| r.data.record_type != "group")
            .collect())
    }
    async fn objects(&mut self) -> Result<Vec<ViewRecord>> {
        let a = self.unlocked()?;
        let rows=sqlx::query("SELECT v.body FROM versions v WHERE v.revision=(SELECT MAX(v2.revision) FROM versions v2 WHERE v2.record_id=v.record_id) ORDER BY v.record_id").fetch_all(&a.cache).await?;
        rows.into_iter()
            .map(|r| {
                let v: StoredVersion = serde_json::from_str(&r.get::<String, _>("body"))?;
                view(a, &v)
            })
            .collect()
    }
    pub async fn history(&mut self, id: &str) -> Result<Vec<ViewRecord>> {
        let a = self.unlocked()?;
        let rows =
            sqlx::query("SELECT body FROM versions WHERE record_id=$1 ORDER BY revision DESC")
                .bind(id)
                .fetch_all(&a.cache)
                .await?;
        rows.into_iter()
            .map(|r| {
                let v: StoredVersion = serde_json::from_str(&r.get::<String, _>("body"))?;
                view(a, &v)
            })
            .collect()
    }
    pub async fn save(
        &mut self,
        id: Option<String>,
        expected_revision: i64,
        data: RecordData,
        archived: bool,
    ) -> Result<Value> {
        ensure!(data.record_type != "group", "GROUP_OPERATION_REQUIRED");
        self.save_object(id, expected_revision, data, archived, None)
            .await
    }
    async fn save_object(
        &mut self,
        id: Option<String>,
        expected_revision: i64,
        data: RecordData,
        archived: bool,
        creation_id: Option<String>,
    ) -> Result<Value> {
        data.validate()?;
        self.validate_group_link(id.as_deref(), &data).await?;
        let structure_snapshot = if data.record_type == "group"
            || data.extra.contains_key("group_id")
            || !data.folder.is_empty()
        {
            Some(
                self.objects()
                    .await?
                    .into_iter()
                    .map(|r| (r.record_id, r.revision))
                    .collect::<BTreeMap<_, _>>(),
            )
        } else {
            None
        };
        let http = self.http.clone();
        let a = self.unlocked()?;
        ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
        ensure!(!a.needs_sync, "SYNCHRONIZATION_REQUIRED");
        ensure!(
            sqlx::query("SELECT value FROM meta WHERE name='pending_operation'")
                .fetch_optional(&a.cache)
                .await?
                .is_none(),
            "SAVE_RESULT_UNKNOWN"
        );
        let previous = if let Some(ref id) = id {
            let row = sqlx::query(
                "SELECT body FROM versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1",
            )
            .bind(id)
            .fetch_optional(&a.cache)
            .await?
            .ok_or_else(|| anyhow!("RECORD_NOT_FOUND"))?;
            let v: StoredVersion = serde_json::from_str(&row.get::<String, _>("body"))?;
            ensure!(v.revision == expected_revision, "RECORD_VERSION_MISMATCH");
            ensure!(
                (view(a, &v)?.data.record_type == "group") == (data.record_type == "group"),
                "GROUP_OPERATION_REQUIRED"
            );
            Some(v.version_id)
        } else {
            ensure!(expected_revision == 0, "INVALID_REVISION");
            None
        };
        let id = id
            .or(creation_id)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let version = Uuid::new_v4().to_string();
        let raw = Zeroizing::new(serde_json::to_vec(&data)?);
        let payload = crypto::encrypt_version(
            &a.keys,
            &raw,
            &version_context(&a.profile.server_id, &a.profile.account_id, &id, &version),
        )?;
        let mut r = SaveRecord {
            operation_id: Uuid::new_v4().to_string(),
            record_id: id,
            expected_revision,
            version_id: version,
            previous_version: previous,
            payload: serde_json::to_value(payload)?,
            signature: String::new(),
            archived,
        };
        sharing::attach(a, &mut r, &data).await?;
        r.signature = a.keys.sign(&record_transcript(
            &a.profile.server_id,
            &a.profile.account_id,
            &r,
        ));
        let grouped = structure_snapshot.is_some();
        let request = if let Some(snapshot) = structure_snapshot {
            serde_json::to_value(neruvalo_protocol::SaveBatch {
                operation_id: r.operation_id.clone(),
                snapshot,
                records: vec![r],
            })?
        } else {
            serde_json::to_value(r)?
        };
        set_meta(
            &a.cache,
            "pending_operation",
            &serde_json::to_string(&request)?,
        )
        .await?;
        let result = http
            .post(format!(
                "{}/api/v1/records/{}",
                a.profile.server,
                if grouped { "batch" } else { "save" }
            ))
            .bearer_auth(a.token.as_str())
            .json(&request)
            .send()
            .await;
        let result: Value = match result {
            Ok(resp) if resp.status().is_server_error() => {
                a.online = false;
                bail!("SAVE_RESULT_UNKNOWN");
            }
            Ok(resp) => match response(resp).await {
                Ok(v) => v,
                Err(e) => {
                    sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
                        .execute(&a.cache)
                        .await?;
                    if ["RECORD_VERSION_MISMATCH", "SHARING_VERSION_MISMATCH"]
                        .contains(&e.to_string().as_str())
                    {
                        a.needs_sync = true;
                    }
                    return Err(e);
                }
            },
            Err(_) => {
                a.online = false;
                bail!("SAVE_RESULT_UNKNOWN: reconnect and synchronize before another edit")
            }
        };
        sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
            .execute(&a.cache)
            .await?;
        self.sync().await?;
        Ok(if grouped {
            result["records"][0].clone()
        } else {
            result
        })
    }
    pub async fn settings(&mut self, seconds: u32) -> Result<Value> {
        let http = self.http.clone();
        let a = self.unlocked()?;
        ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
        let r: Settings = response(
            http.put(format!("{}/api/v1/settings", a.profile.server))
                .bearer_auth(a.token.as_str())
                .json(&Settings {
                    timeout_seconds: seconds,
                })
                .send()
                .await?,
        )
        .await?;
        a.profile.timeout_seconds = r.timeout_seconds;
        let p = a.profile.clone();
        self.store_profile(&p)?;
        Ok(json!({"timeout_seconds":seconds}))
    }
    pub async fn recover(
        &mut self,
        certificate: Zeroizing<String>,
        password: Zeroizing<String>,
    ) -> Result<Value> {
        self.lock();
        ensure!(
            password.len() >= 12,
            "Use a master password of at least 12 characters"
        );
        let c: RecoveryCertificate = serde_json::from_str(&certificate)?;
        ensure!(
            c.format == "neruvalo-recovery" && c.format_version == 1,
            "UNSUPPORTED_CERTIFICATE"
        );
        let server = normalize_server(&c.server)?;
        let info = self.info(&server).await?;
        ensure!(info.server_id == c.server_id, "SERVER_ID_CHANGED");
        let secret = Zeroizing::new(unb64(&c.secret)?);
        ensure!(secret.len() == 32, "Invalid recovery secret");
        let wrap = crypto::derive(&secret, b"recovery-wrap")?;
        let sign = crypto::derive(&secret, b"recovery-sign")?;
        let challenge: RecoveryChallenge = response(
            self.http
                .post(format!("{server}/api/v1/recovery/begin"))
                .json(&RecoveryBegin {
                    account_id: c.account_id.clone(),
                    recovery_id: c.recovery_id.clone(),
                })
                .send()
                .await?,
        )
        .await?;
        ensure!(
            challenge.bundle.id == c.recovery_id
                && challenge.bundle.public_key == crypto::public_seed(&sign),
            "RECOVERY_KEY_CHANGED"
        );
        let root = crypto::parse_key(&crypto::open(
            wrap.as_ref(),
            &serde_json::from_value(challenge.bundle.envelope)?,
            &recovery_context(&c.server_id, &c.account_id, &c.recovery_id),
        )?)?;
        let start = ClientRegistration::<Suite>::start(&mut OsRng, password.as_bytes())
            .map_err(|_| anyhow!("OPAQUE_START_FAILED"))?;
        let message = b64(start.message.serialize());
        let signature = crypto::sign_seed(
            &sign,
            &recovery_transcript(
                &c.server_id,
                &c.account_id,
                &c.recovery_id,
                &challenge.ticket,
                &challenge.challenge,
                &message,
            ),
        );
        let prepared: RecoveryPrepared = response(
            self.http
                .post(format!("{server}/api/v1/recovery/authorize"))
                .json(&RecoveryAuthorize {
                    ticket: challenge.ticket,
                    signature,
                    message,
                })
                .send()
                .await?,
        )
        .await?;
        let kdf = crypto::kdf();
        let finish = start
            .state
            .finish(
                &mut OsRng,
                password.as_bytes(),
                RegistrationResponse::deserialize(&unb64(&prepared.message)?)
                    .map_err(|_| anyhow!("OPAQUE_MESSAGE_INVALID"))?,
                ClientRegistrationFinishParameters::new(
                    opaque_ids(&c.account_id, &c.server_id),
                    Some(&kdf),
                ),
            )
            .map_err(|_| anyhow!("OPAQUE_FINISH_FAILED"))?;
        let key = crypto::derive(&finish.export_key, b"server-root")?;
        let envelope = serde_json::to_value(crypto::seal(
            key.as_ref(),
            root.as_ref(),
            &root_context(&c.server_id, &c.account_id),
        )?)?;
        response(
            self.http
                .post(format!("{server}/api/v1/recovery/finish"))
                .json(&RecoveryFinish {
                    ticket: prepared.ticket,
                    message: b64(finish.message.serialize()),
                    envelope,
                })
                .send()
                .await?,
        )
        .await
    }
}
fn verify_version(p: &Profile, v: &StoredVersion) -> Result<()> {
    ensure!(v.revision > 0, "INVALID_REVISION");
    let r = SaveRecord {
        operation_id: v.operation_id.clone(),
        record_id: v.record_id.clone(),
        expected_revision: v.revision - 1,
        version_id: v.version_id.clone(),
        previous_version: v.previous_version.clone(),
        payload: v.payload.clone(),
        signature: v.signature.clone(),
        archived: v.archived,
    };
    crypto::verify(
        &p.bundle.public_sign,
        &record_transcript(&p.server_id, &p.account_id, &r),
        &v.signature,
    )
}
fn view(a: &Unlocked, v: &StoredVersion) -> Result<ViewRecord> {
    verify_version(&a.profile, v)?;
    let payload: EncryptedVersion = serde_json::from_value(v.payload.clone())?;
    let clear = crypto::decrypt_version(
        &a.keys,
        &payload,
        &version_context(
            &a.profile.server_id,
            &a.profile.account_id,
            &v.record_id,
            &v.version_id,
        ),
    )?;
    Ok(ViewRecord {
        record_id: v.record_id.clone(),
        version_id: v.version_id.clone(),
        revision: v.revision,
        archived: v.archived,
        data: serde_json::from_slice(&clear)?,
    })
}
