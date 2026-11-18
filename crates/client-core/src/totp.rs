//! Local TOTP generation and provisioning. Never include provisioning data in errors.
use super::*;
use std::io::{Cursor, Read};
use std::time::{SystemTime, UNIX_EPOCH};
use totp_rs::{Algorithm, Builder, Secret, Totp};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct TotpConfig {
    pub secret: String,
    pub issuer: String,
    pub account: String,
    pub algorithm: String,
    pub digits: u8,
    pub period: u64,
}
#[derive(Serialize)]
pub struct TotpCode {
    pub code: String,
    pub generated_at: u64,
    pub valid_until: u64,
    pub period: u64,
}
fn invalid<T>(_: T) -> anyhow::Error {
    anyhow!("INVALID_TOTP")
}
impl TotpConfig {
    pub fn parse(value: &str) -> Result<Self> {
        ensure!(value.len() <= 8192, "INVALID_TOTP");
        if !value.starts_with("otpauth:") {
            let config = Self {
                secret: value.into(),
                issuer: String::new(),
                account: "Account".into(),
                algorithm: "SHA1".into(),
                digits: 6,
                period: 30,
            };
            config.generator()?;
            return Ok(config);
        }
        let uri = reqwest::Url::parse(value).map_err(invalid)?;
        ensure!(
            uri.scheme() == "otpauth"
                && uri.host_str() == Some("totp")
                && uri.username().is_empty()
                && uri.password().is_none()
                && uri.fragment().is_none(),
            "INVALID_TOTP"
        );
        let mut keys = std::collections::BTreeSet::new();
        for (key, _) in uri.query_pairs() {
            ensure!(
                ["secret", "issuer", "algorithm", "digits", "period"].contains(&key.as_ref())
                    && keys.insert(key.to_string()),
                "INVALID_TOTP"
            );
        }
        let totp = Totp::from_url_unchecked(value).map_err(invalid)?;
        let config = Self {
            secret: totp.secret().to_base32(),
            issuer: totp.issuer().unwrap_or("").into(),
            account: totp.account_name().into(),
            algorithm: totp.algorithm().to_string(),
            digits: totp.digits(),
            period: totp.step(),
        };
        config.generator()?;
        Ok(config)
    }
    pub fn generator(&self) -> Result<Totp> {
        ensure!(
            (6..=8).contains(&self.digits)
                && self.period > 0
                && self.period <= 86400
                && self.secret.len() <= 4096
                && self.issuer.len() <= 512
                && self.account.len() <= 512,
            "INVALID_TOTP"
        );
        let algorithm = match self.algorithm.as_str() {
            "SHA1" => Algorithm::SHA1,
            "SHA256" => Algorithm::SHA256,
            "SHA512" => Algorithm::SHA512,
            _ => anyhow::bail!("INVALID_TOTP"),
        };
        let normalized = Zeroizing::new(
            self.secret
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>()
                .to_ascii_uppercase(),
        );
        let secret = Secret::try_from_base32(normalized.as_str()).map_err(invalid)?;
        ensure!(!secret.is_empty() && secret.len() <= 1024, "INVALID_TOTP");
        // Existing authenticators sometimes use keys shorter than the RFC's
        // recommendation. Retain compatibility after explicitly checking all
        // invariants that could make the noncompliant builder panic.
        Ok(Builder::new()
            .with_secret(secret)
            .with_algorithm(algorithm)
            .with_digits(self.digits)
            .with_step_duration(self.period)
            .with_account_name(if self.account.is_empty() {
                "Account"
            } else {
                &self.account
            })
            .with_issuer(if self.issuer.is_empty() {
                None
            } else {
                Some(self.issuer.as_str())
            })
            .build_noncompliant())
    }
    pub fn uri(&self) -> Result<String> {
        self.generator()?.to_url().map_err(invalid)
    }
    pub fn at(&self, now: u64) -> Result<TotpCode> {
        let generator = self.generator()?;
        let valid_until = (now / self.period)
            .checked_add(1)
            .and_then(|step| step.checked_mul(self.period))
            .ok_or_else(|| anyhow!("INVALID_TOTP_TIME"))?;
        Ok(TotpCode {
            code: generator.generate(now).to_string(),
            generated_at: now,
            valid_until,
            period: self.period,
        })
    }
    pub fn current(&self) -> Result<TotpCode> {
        self.at(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| anyhow!("INVALID_TOTP_TIME"))?
            .as_secs())
    }
    pub fn qr(&self) -> Result<String> {
        let uri = Zeroizing::new(self.uri()?);
        qr::render(uri.as_bytes()).map_err(|_| anyhow!("INVALID_TOTP_QR"))
    }
}

pub fn read_qr(path: &Path) -> Result<TotpConfig> {
    let file = std::fs::File::open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= 8_000_000,
        "INVALID_TOTP_QR"
    );
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(8_000_001).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 8_000_000, "INVALID_TOTP_QR");
    let mut reader = image::ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|_| anyhow!("INVALID_TOTP_QR"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| anyhow!("INVALID_TOTP_QR"))?
        .to_luma8();
    let mut matches = Vec::new();
    for content in qr::decode(image) {
        if content.starts_with("otpauth://") {
            matches.push(TotpConfig::parse(&content)?);
        }
    }
    ensure!(matches.len() == 1, "INVALID_TOTP_QR");
    Ok(matches.remove(0))
}

impl Client {
    pub async fn record_data(
        &mut self,
        id: &str,
        expected_version: Option<&str>,
    ) -> Result<RecordData> {
        let record = if id.starts_with("shared:") {
            self.sharing().await?["incoming"]
                .as_array()
                .and_then(|items| items.iter().find(|item| item["record_id"] == id))
                .cloned()
                .ok_or_else(|| anyhow!("RECORD_NOT_FOUND"))?
        } else {
            serde_json::to_value(
                self.list_records(&[id.into()])
                    .await?
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("RECORD_NOT_FOUND"))?,
            )?
        };
        ensure!(
            expected_version.is_none_or(|expected| record["version_id"].as_str() == Some(expected)),
            "RECORD_VERSION_MISMATCH"
        );
        Ok(serde_json::from_value(record["data"].clone())?)
    }
    pub async fn totp_code(&mut self, id: &str, version: Option<&str>) -> Result<TotpCode> {
        let data = self.record_data(id, version).await?;
        TotpConfig::parse(
            data.fields
                .get("totp")
                .ok_or_else(|| anyhow!("INVALID_TOTP"))?,
        )?
        .current()
    }
    pub async fn totp_qr(&mut self, id: &str, version: Option<&str>) -> Result<String> {
        let data = self.record_data(id, version).await?;
        TotpConfig::parse(
            data.fields
                .get("totp")
                .ok_or_else(|| anyhow!("INVALID_TOTP"))?,
        )?
        .qr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(algorithm: &str, secret: &[u8]) -> TotpConfig {
        TotpConfig {
            secret: Secret::from(secret.to_vec()).to_base32(),
            issuer: "Example".into(),
            account: "alice@example.test".into(),
            algorithm: algorithm.into(),
            digits: 8,
            period: 30,
        }
    }
    #[test]
    fn matches_all_rfc6238_test_vectors_and_period_boundaries() {
        let times = [
            59,
            1111111109,
            1111111111,
            1234567890,
            2000000000,
            20000000000,
        ];
        let cases = [
            (
                "SHA1",
                b"12345678901234567890".as_slice(),
                [
                    "94287082", "07081804", "14050471", "89005924", "69279037", "65353130",
                ],
            ),
            (
                "SHA256",
                b"12345678901234567890123456789012".as_slice(),
                [
                    "46119246", "68084774", "67062674", "91819424", "90698825", "77737706",
                ],
            ),
            (
                "SHA512",
                b"1234567890123456789012345678901234567890123456789012345678901234".as_slice(),
                [
                    "90693936", "25091201", "99943326", "93441116", "38618901", "47863826",
                ],
            ),
        ];
        for (algorithm, secret, codes) in cases {
            let config = config(algorithm, secret);
            for (now, expected) in times.into_iter().zip(codes) {
                assert_eq!(config.at(now).unwrap().code, expected);
            }
            assert_eq!(config.at(29).unwrap().valid_until, 30);
            assert_eq!(config.at(30).unwrap().valid_until, 60);
            let restored = TotpConfig::parse(&config.uri().unwrap()).unwrap();
            assert_eq!(restored.at(59).unwrap().code, config.at(59).unwrap().code);
        }
    }
    #[test]
    fn rejects_invalid_provisioning_without_exposing_secrets() {
        for input in [
            "otpauth://hotp/test?secret=AA",
            "otpauth://totp/test?secret=AA&period=0",
            "otpauth://totp/test?secret=AA&digits=9",
            "otpauth://totp/test?secret=AA&secret=BB",
            "otpauth://totp/test?secret=AA&algorithm=MD5",
            "NOT-A-BASE32-SECRET",
        ] {
            assert!(TotpConfig::parse(input).is_err());
        }
        let mut config = config("SHA1", b"12345678901234567890");
        config.period = 0;
        assert!(config.at(59).is_err());
        config.period = 30;
        config.digits = 9;
        assert!(config.at(59).is_err());
    }
    #[test]
    fn qr_image_roundtrip_preserves_secret_and_parameters() {
        let config = config("SHA256", b"12345678901234567890123456789012");
        let uri = Zeroizing::new(config.uri().unwrap());
        let qr = qrcode::QrCode::new(uri.as_bytes()).unwrap();
        let width = qr.width();
        let side = ((width + 8) * 6) as u32;
        let colors = qr.to_colors();
        let image = image::GrayImage::from_fn(side, side, |x, y| {
            let x = x as usize / 6;
            let y = y as usize / 6;
            let black = x >= 4
                && y >= 4
                && x < width + 4
                && y < width + 4
                && colors[(y - 4) * width + x - 4] == qrcode::Color::Dark;
            image::Luma([if black { 0 } else { 255 }])
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("totp.png");
        image.save(&path).unwrap();
        let restored = read_qr(&path).unwrap();
        assert_eq!(
            restored.at(1234567890).unwrap().code,
            config.at(1234567890).unwrap().code
        );
        assert_eq!(restored.issuer, config.issuer);
        assert_eq!(restored.account, config.account);
        assert!(config
            .qr()
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        std::fs::write(&path, b"not an image").unwrap();
        assert!(read_qr(&path).is_err());
    }
    #[tokio::test]
    async fn local_codes_survive_offline_unlock_and_reject_stale_versions_and_lock() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().into()).unwrap();
        let password = || Zeroizing::new("local totp password".into());
        let profile = client.create_local("TOTP", password()).await.unwrap();
        let config = config("SHA1", b"12345678901234567890");
        let data = RecordData {
            record_type: "login".into(),
            schema_version: 1,
            title: "TOTP test".into(),
            fields: BTreeMap::from([("totp".into(), config.uri().unwrap())]),
            notes: String::new(),
            folder: String::new(),
            tags: vec![],
            extra: BTreeMap::new(),
        };
        let result = client.save(None, 0, data, false).await.unwrap();
        let id = result["record_id"].as_str().unwrap();
        assert_eq!(client.totp_code(id, None).await.unwrap().code.len(), 8);
        assert!(client.totp_code(id, Some("stale-version")).await.is_err());
        client.lock();
        assert!(client.totp_code(id, None).await.is_err());
        client
            .unlock_offline(profile["profile"].as_str().unwrap(), password())
            .await
            .unwrap();
        assert_eq!(client.totp_code(id, None).await.unwrap().code.len(), 8);
        assert!(client
            .totp_qr(id, None)
            .await
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
    }
}
