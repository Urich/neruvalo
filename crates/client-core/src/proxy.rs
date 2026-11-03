use super::*;
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ProxySettings {
    pub mode: String,
    pub url: String,
    pub username: String,
    pub password: String,
}
impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: "system".into(),
            url: String::new(),
            username: String::new(),
            password: String::new(),
        }
    }
}
fn http(settings: &ProxySettings) -> Result<reqwest::Client> {
    ensure!(
        settings.url.len() <= 2048
            && settings.username.len() <= 255
            && settings.password.len() <= 255,
        "INVALID_PROXY_CONFIG"
    );
    ensure!(
        ["system", "direct", "manual"].contains(&settings.mode.as_str()),
        "INVALID_PROXY_CONFIG"
    );
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if settings.mode == "direct" {
        builder = builder.no_proxy();
    }
    if settings.mode == "manual" {
        let url =
            reqwest::Url::parse(&settings.url).map_err(|_| anyhow!("INVALID_PROXY_CONFIG"))?;
        ensure!(
            ["http", "https", "socks5", "socks5h"].contains(&url.scheme())
                && url.host_str().is_some()
                && url.port_or_known_default().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && (url.path().is_empty() || url.path() == "/")
                && url.query().is_none()
                && url.fragment().is_none(),
            "INVALID_PROXY_CONFIG"
        );
        ensure!(
            settings.username.len() <= 255 && settings.password.len() <= 255,
            "INVALID_PROXY_CONFIG"
        );
        let mut proxy = reqwest::Proxy::all(url).map_err(|_| anyhow!("INVALID_PROXY_CONFIG"))?;
        if !settings.username.is_empty() || !settings.password.is_empty() {
            proxy = proxy.basic_auth(&settings.username, &settings.password);
        }
        builder = builder.no_proxy().proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| anyhow!("PROXY_CONFIGURATION_FAILED"))
}
#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into()?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI owns the output allocation. Input is read-only; no UI or machine-wide scope.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    ensure!(ok != 0, "LOCAL_PROXY_STORE_ERROR");
    let value = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    unsafe {
        if !output.pbData.is_null() {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            LocalFree(output.pbData.cast());
        }
    }
    Ok(value)
}
pub(super) fn load(dir: &Path) -> Result<(ProxySettings, reqwest::Client)> {
    let path = dir.join("proxy-settings.bin");
    let settings = if path.exists() {
        ensure!(
            std::fs::metadata(&path)?.len() <= 1024 * 1024,
            "LOCAL_PROXY_STORE_ERROR"
        );
        let bytes = std::fs::read(path)?;
        #[cfg(windows)]
        let raw = Zeroizing::new(protect(&bytes, true)?);
        #[cfg(not(windows))]
        let raw = Zeroizing::new(bytes);
        serde_json::from_slice::<ProxySettings>(&raw)
            .map_err(|_| anyhow!("LOCAL_PROXY_STORE_ERROR"))?
    } else {
        ProxySettings::default()
    };
    let client = http(&settings)?;
    Ok((settings, client))
}
impl Client {
    pub fn proxy_settings(&self) -> Result<Value> {
        let (settings, _) = load(&self.dir)?;
        Ok(json!({"settings":settings,"protected_credentials":cfg!(windows)}))
    }
    pub fn set_proxy(&mut self, settings: ProxySettings) -> Result<Value> {
        let client = http(&settings)?;
        #[cfg(not(windows))]
        ensure!(
            settings.username.is_empty() && settings.password.is_empty(),
            "PROXY_CREDENTIAL_STORAGE_UNAVAILABLE"
        );
        let raw = Zeroizing::new(serde_json::to_vec(&settings)?);
        #[cfg(windows)]
        let bytes = protect(&raw, false)?;
        #[cfg(not(windows))]
        let bytes = raw.to_vec();
        let path = self.dir.join(format!("proxy-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<()> {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&path, self.dir.join("proxy-settings.bin"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        result.map_err(|_| anyhow!("LOCAL_PROXY_STORE_ERROR"))?;
        self.http = client;
        Ok(json!({"saved":true}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn proxy_mode_roundtrip_and_fail_closed_validation() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().to_owned()).unwrap();
        let settings = ProxySettings {
            mode: "manual".into(),
            url: "socks5h://127.0.0.1:10808".into(),
            ..Default::default()
        };
        client.set_proxy(settings).unwrap();
        assert_eq!(
            client.proxy_settings().unwrap()["settings"]["url"],
            "socks5h://127.0.0.1:10808"
        );
        let reloaded = Client::new(dir.path().to_owned()).unwrap();
        assert_eq!(
            reloaded.proxy_settings().unwrap()["settings"]["mode"],
            "manual"
        );
        assert!(client
            .set_proxy(ProxySettings {
                mode: "manual".into(),
                url: "file:///tmp/unsafe".into(),
                ..Default::default()
            })
            .is_err());
        assert_eq!(
            client.proxy_settings().unwrap()["settings"]["mode"],
            "manual"
        );
        client
            .set_proxy(ProxySettings {
                mode: "direct".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            client.proxy_settings().unwrap()["settings"]["mode"],
            "direct"
        );
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn credentials_are_dpapi_protected_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().to_owned()).unwrap();
        client
            .set_proxy(ProxySettings {
                mode: "manual".into(),
                url: "http://127.0.0.1:8080".into(),
                username: "proxy-user".into(),
                password: "proxy-secret-not-a-real-password".into(),
            })
            .unwrap();
        let bytes = std::fs::read(dir.path().join("proxy-settings.bin")).unwrap();
        assert!(!bytes.windows(12).any(|w| w == b"proxy-secret"));
        assert_eq!(
            client.proxy_settings().unwrap()["settings"]["password"],
            "proxy-secret-not-a-real-password"
        );
    }
    #[tokio::test]
    async fn manual_http_proxy_carries_server_requests_without_direct_bypass() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                assert!(request.len() < 16384);
            }
            let body = r#"{"server_id":"proxy-test","protocol_version":0,"auth_profile":"","dev_mode":true}"#;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().to_owned()).unwrap();
        client
            .set_proxy(ProxySettings {
                mode: "manual".into(),
                url: format!("http://{address}"),
                ..Default::default()
            })
            .unwrap();
        assert!(client
            .login(
                "http://127.0.0.1:9",
                "alice",
                Zeroizing::new("test-password-only".into())
            )
            .await
            .is_err());
        let request = task.await.unwrap();
        assert!(
            request.starts_with("GET http://127.0.0.1:9/api/v1/info HTTP/1.1"),
            "proxy did not receive the server request"
        );
    }
}
