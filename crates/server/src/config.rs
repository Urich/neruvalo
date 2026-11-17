use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

pub const DEFAULT_CONFIG: &str = "neruvalo-server.toml";

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub dev_mode: bool,
    pub listen: SocketAddr,
    pub database_url: String,
    pub dev_outbox: PathBuf,
    pub gateveriq: Option<GateConfig>,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            dev_mode: false,
            listen: "127.0.0.1:8787".parse().unwrap(),
            database_url: "sqlite://neruvalo-server.sqlite3?mode=rwc".into(),
            dev_outbox: "local-data/dev-outbox".into(),
            gateveriq: None,
        }
    }
}
// No Debug implementation: this structure contains a bearer secret.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateConfig {
    pub id: String,
    pub secret: String,
    pub internal: String,
    pub public: String,
    pub origin: String,
}
impl ServerConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let source = std::fs::read_to_string(path)
            .with_context(|| format!("Cannot read server config {}", path.display()))?;
        Self::parse(&source).with_context(|| format!("Invalid server config {}", path.display()))
    }
    pub fn parse(source: &str) -> Result<Self> {
        // Full TOML diagnostics include source lines, which may contain secrets.
        let config: Self = toml::from_str(source).map_err(|error| {
            let offset = error.span().map_or(0, |span| span.start.min(source.len()));
            let line = source.as_bytes()[..offset]
                .iter()
                .filter(|b| **b == b'\n')
                .count()
                + 1;
            anyhow::anyhow!(
                "Invalid TOML configuration at line {line}; check field names and value types"
            )
        })?;
        config.validate()?;
        Ok(config)
    }
    /// Legacy launchers are used only when no config file is selected.
    pub fn from_env() -> Result<Self> {
        let mut config = Self {
            dev_mode: std::env::var("NERUVALO_DEV_MODE").as_deref() == Ok("true"),
            gateveriq: GateConfig::from_env()?,
            ..Self::default()
        };
        if let Ok(value) = std::env::var("NERUVALO_LISTEN") {
            config.listen = value.parse().context("Invalid NERUVALO_LISTEN")?;
        }
        if let Ok(value) = std::env::var("DATABASE_URL") {
            config.database_url = value;
        }
        if let Ok(value) = std::env::var("NERUVALO_DEV_OUTBOX") {
            config.dev_outbox = value.into();
        }
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(self.dev_mode, "This prototype requires dev_mode = true in the server config (or legacy NERUVALO_DEV_MODE=true)");
        ensure!(
            self.listen.ip().is_loopback(),
            "Prototype must listen on loopback"
        );
        ensure!(
            !self.database_url.trim().is_empty(),
            "database_url must not be empty"
        );
        ensure!(
            !self.dev_outbox.as_os_str().is_empty(),
            "dev_outbox must not be empty"
        );
        if let Some(gate) = &self.gateveriq {
            gate.validate()?;
        }
        Ok(())
    }
    pub fn prepare_directories(&self) -> Result<()> {
        if self.database_url.starts_with("sqlite:") {
            let options: sqlx::sqlite::SqliteConnectOptions = self
                .database_url
                .parse()
                .context("Invalid SQLite database_url")?;
            if let Some(parent) = options
                .get_filename()
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)
                    .context("Cannot create SQLite database directory")?;
            }
        }
        Ok(())
    }
}
impl GateConfig {
    pub fn from_env() -> Result<Option<Self>> {
        let names = [
            "NERUVALO_GATE_ID",
            "NERUVALO_GATE_SECRET",
            "NERUVALO_GATE_INTERNAL",
            "NERUVALO_GATE_PUBLIC",
            "NERUVALO_PUBLIC_ORIGIN",
        ];
        let values: Vec<_> = names.iter().map(|name| std::env::var(name).ok()).collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        ensure!(
            values
                .iter()
                .all(|v| v.as_ref().is_some_and(|s| !s.trim().is_empty())),
            "All GateVeriq settings are required"
        );
        let mut values = values.into_iter().map(Option::unwrap);
        Ok(Some(Self {
            id: values.next().unwrap(),
            secret: values.next().unwrap(),
            internal: values.next().unwrap(),
            public: values.next().unwrap(),
            origin: values.next().unwrap(),
        }))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [
                &self.id,
                &self.secret,
                &self.internal,
                &self.public,
                &self.origin
            ]
            .iter()
            .all(|v| !v.trim().is_empty()),
            "All GateVeriq settings are required"
        );
        for value in [&self.internal, &self.public, &self.origin] {
            let url = reqwest::Url::parse(value).context("Invalid GateVeriq URL")?;
            ensure!(
                url.scheme() == "https"
                    || (url.scheme() == "http"
                        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
                "GateVeriq URLs require HTTPS or loopback"
            );
            ensure!(
                url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path() == "/",
                "Expected URL origin for GateVeriq"
            );
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_complete_config_and_gate() {
        let config = ServerConfig::parse(
            r#"
dev_mode = true
listen = "127.0.0.1:8888"
database_url = "sqlite://local-data/server.sqlite3?mode=rwc"
dev_outbox = "local-data/outbox"
[gateveriq]
id = "integration"
secret = "private-secret"
internal = "http://127.0.0.1:9081"
public = "http://127.0.0.1:9080"
origin = "http://127.0.0.1:8888"
"#,
        )
        .unwrap();
        assert_eq!(config.listen.port(), 8888);
        assert_eq!(config.gateveriq.unwrap().id, "integration");
    }
    #[test]
    fn rejects_unsafe_incomplete_and_unknown_settings_without_leaking_secrets() {
        for source in [
            "",
            "dev_mode = true\nlisten = '0.0.0.0:8787'",
            "dev_mode = true\nlistne = '127.0.0.1:8787'",
            "dev_mode = true\n[gateveriq]\nsecret = 'private-secret'",
            "dev_mode = true\n[gateveriq]\nid='id'\nsecret='private-secret'\ninternal='http://example.com'\npublic='https://example.com'\norigin='http://127.0.0.1:8787'",
        ] {
            let error = ServerConfig::parse(source).err().expect("must reject config");
            assert!(!format!("{error:#}").contains("private-secret"));
        }
    }
    #[test]
    fn minimal_config_disables_gate_and_missing_file_fails() {
        assert!(ServerConfig::parse("dev_mode = true")
            .unwrap()
            .gateveriq
            .is_none());
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(ServerConfig::load(&path).is_err());
    }
    #[test]
    fn creates_missing_sqlite_parent() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let config = ServerConfig {
            dev_mode: true,
            database_url: format!("sqlite://{}/data/server.sqlite3?mode=rwc", dir.display()),
            ..ServerConfig::default()
        };
        config.prepare_directories().unwrap();
        assert!(dir.join("data").is_dir());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
