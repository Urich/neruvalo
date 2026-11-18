use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) fn times(data: &mut RecordData, source: &keepass::db::Times) {
    if let Some(time) = source.creation {
        data.extra
            .insert("created_at".into(), json!(time.and_utc().timestamp()));
    }
    if let Some(time) = source.last_modification {
        data.extra
            .insert("modified_at".into(), json!(time.and_utc().timestamp()));
    }
    if data.record_type != "group" {
        if let Some(expires) = source.expires {
            data.fields
                .insert("never_expires".into(), (!expires).to_string());
            data.fields
                .insert("expires".into(), source.expiry.and_utc().to_rfc3339());
        }
    }
}

pub(super) fn icon(
    data: &mut RecordData,
    icon: Option<&keepass::db::Icon>,
    custom: Option<keepass::db::CustomIconRef<'_>>,
) -> Result<()> {
    if let Some(custom) = custom {
        ensure!(custom.data.len() <= 128 * 1024, "ICON_TOO_LARGE");
        let bytes = &custom.data;
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "png"
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            "jpeg"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "webp"
        } else {
            anyhow::bail!("UNSUPPORTED_ICON");
        };
        data.extra.insert(
            "icon".into(),
            json!(format!(
                "data:image/{mime};base64,{}",
                STANDARD.encode(bytes)
            )),
        );
    } else if let Some(keepass::db::Icon::BuiltIn(id)) = icon {
        ensure!(*id <= 68, "UNSUPPORTED_ICON");
        data.extra.insert("keepass_icon_id".into(), json!(id));
    }
    Ok(())
}

fn decode_base32(value: &str) -> Result<Vec<u8>> {
    let value: String = value.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut bytes = vec![];
    let mut bits = 0u32;
    let mut count = 0;
    for c in value.trim_end_matches('=').chars() {
        let c = c.to_ascii_uppercase();
        let n = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            '2'..='7' => c as u32 - '2' as u32 + 26,
            _ => anyhow::bail!("INVALID_TOTP"),
        };
        bits = (bits << 5) | n;
        count += 5;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    ensure!(
        !bytes.is_empty() && count < 5 && bits & ((1 << count) - 1) == 0,
        "INVALID_TOTP"
    );
    Ok(bytes)
}
fn encode_base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut result = String::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in bytes {
        bits = (bits << 8) | *byte as u32;
        count += 8;
        while count >= 5 {
            count -= 5;
            result.push(ALPHABET[((bits >> count) & 31) as usize] as char);
        }
    }
    if count > 0 {
        result.push(ALPHABET[((bits << (5 - count)) & 31) as usize] as char);
    }
    result
}
fn native_secret(key: &str, value: &str) -> Result<Vec<u8>> {
    if key.ends_with("Base32") {
        decode_base32(value)
    } else if key.ends_with("Base64") {
        Ok(STANDARD.decode(
            value
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>(),
        )?)
    } else if key.ends_with("Hex") {
        let value: String = value.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        ensure!(
            value.len().is_multiple_of(2) && value.is_ascii(),
            "INVALID_TOTP"
        );
        (0..value.len())
            .step_by(2)
            .map(|i| Ok(u8::from_str_radix(&value[i..i + 2], 16)?))
            .collect()
    } else {
        Ok(value.as_bytes().to_vec())
    }
}

pub(super) fn totp(fields: &BTreeMap<String, String>, title: &str) -> Result<Option<String>> {
    let get = |key: &str| fields.get(key).map(String::as_str);
    let mut candidates = vec![];
    for key in ["otp", "TOTP", "totp", "TOTP Seed"] {
        if let Some(value) = get(key).filter(|v| !v.is_empty()) {
            let value = if value.starts_with("otpauth:") {
                value.to_owned()
            } else {
                let mut uri = reqwest::Url::parse("otpauth://totp/")?;
                uri.set_path(title);
                let settings = get("TOTP Settings").unwrap_or("30;6");
                let (period, digits) = settings.split_once(';').unwrap_or((settings, "6"));
                uri.query_pairs_mut()
                    .append_pair("secret", &encode_base32(&decode_base32(value)?))
                    .append_pair("period", period)
                    .append_pair("digits", digits);
                uri.to_string()
            };
            candidates.push(value);
        }
    }
    let seeds: Vec<_> = [
        "TimeOtp-Secret",
        "TimeOtp-Secret-Hex",
        "TimeOtp-Secret-Base32",
        "TimeOtp-Secret-Base64",
    ]
    .into_iter()
    .filter_map(|key| get(key).map(|value| (key, value)))
    .collect();
    if !seeds.is_empty() {
        ensure!(seeds.len() == 1, "AMBIGUOUS_TOTP");
        let secret = native_secret(seeds[0].0, seeds[0].1)?;
        ensure!(!secret.is_empty(), "INVALID_TOTP");
        let algorithm = match get("TimeOtp-Algorithm").unwrap_or("HMAC-SHA-1") {
            "HMAC-SHA-1" | "SHA1" => "SHA1",
            "HMAC-SHA-256" | "SHA256" => "SHA256",
            "HMAC-SHA-512" | "SHA512" => "SHA512",
            _ => anyhow::bail!("INVALID_TOTP"),
        };
        let mut uri = reqwest::Url::parse("otpauth://totp/")?;
        uri.set_path(title);
        uri.query_pairs_mut()
            .append_pair("secret", &encode_base32(&secret))
            .append_pair("period", get("TimeOtp-Period").unwrap_or("30"))
            .append_pair("digits", get("TimeOtp-Length").unwrap_or("6"))
            .append_pair("algorithm", algorithm);
        candidates.push(uri.to_string());
    }
    let mut normalized = None;
    for value in candidates {
        let mut uri = reqwest::Url::parse(&value)?;
        ensure!(
            uri.scheme() == "otpauth"
                && uri.host_str() == Some("totp")
                && uri.username().is_empty()
                && uri.password().is_none()
                && uri.fragment().is_none(),
            "INVALID_TOTP"
        );
        let mut query = BTreeMap::new();
        for (k, v) in uri.query_pairs() {
            ensure!(
                query.insert(k.to_string(), v.to_string()).is_none(),
                "INVALID_TOTP"
            );
        }
        ensure!(
            query.keys().all(
                |k| ["secret", "period", "digits", "algorithm", "issuer"].contains(&k.as_str())
            ),
            "UNSUPPORTED_TOTP"
        );
        let secret = decode_base32(query.get("secret").ok_or_else(|| anyhow!("INVALID_TOTP"))?)?;
        let period: u32 = query
            .get("period")
            .map(String::as_str)
            .unwrap_or("30")
            .parse()?;
        let digits: u32 = query
            .get("digits")
            .map(String::as_str)
            .unwrap_or("6")
            .parse()?;
        let algorithm = query
            .get("algorithm")
            .map(String::as_str)
            .unwrap_or("SHA1")
            .to_ascii_uppercase();
        ensure!(
            period > 0
                && (6..=8).contains(&digits)
                && ["SHA1", "SHA256", "SHA512"].contains(&algorithm.as_str()),
            "INVALID_TOTP"
        );
        query.insert("secret".into(), encode_base32(&secret));
        query.insert("period".into(), period.to_string());
        query.insert("digits".into(), digits.to_string());
        query.insert("algorithm".into(), algorithm);
        uri.set_query(None);
        uri.query_pairs_mut().extend_pairs(query.iter());
        let identity = (
            query["secret"].clone(),
            query["period"].clone(),
            query["digits"].clone(),
            query["algorithm"].clone(),
        );
        if let Some((previous, _)) = &normalized {
            ensure!(*previous == identity, "AMBIGUOUS_TOTP");
        } else {
            normalized = Some((identity, uri.to_string()));
        }
    }
    let uri = normalized.map(|(_, uri)| uri);
    if let Some(value) = &uri {
        crate::totp::TotpConfig::parse(value)?.generator()?;
    }
    Ok(uri)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn otp_encodings_and_nondefault_parameters_are_preserved() {
        let bytes = b"12345678901234567890";
        let encoded = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(encode_base32(bytes), encoded);
        assert_eq!(decode_base32(encoded).unwrap(), bytes);
        for (key, value) in [
            ("TimeOtp-Secret", String::from_utf8(bytes.to_vec()).unwrap()),
            (
                "TimeOtp-Secret-Hex",
                "3132333435363738393031323334353637383930".into(),
            ),
            ("TimeOtp-Secret-Base32", encoded.into()),
            ("TimeOtp-Secret-Base64", STANDARD.encode(bytes)),
        ] {
            let fields = BTreeMap::from([
                (key.into(), value),
                ("TimeOtp-Length".into(), "8".into()),
                ("TimeOtp-Period".into(), "60".into()),
                ("TimeOtp-Algorithm".into(), "HMAC-SHA-512".into()),
            ]);
            let value = totp(&fields, "Example account").unwrap().unwrap();
            let uri = reqwest::Url::parse(&value).unwrap();
            let query: BTreeMap<_, _> = uri
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            assert_eq!(query["secret"], encoded);
            assert_eq!(query["digits"], "8");
            assert_eq!(query["period"], "60");
            assert_eq!(query["algorithm"], "SHA512");
        }
        let fields = BTreeMap::from([
            (
                "otp".into(),
                "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&issuer=Example".into(),
            ),
            ("TimeOtp-Secret-Base32".into(), "JBSWY3DPEHPK3PXP".into()),
        ]);
        assert!(totp(&fields, "Test")
            .unwrap()
            .unwrap()
            .contains("issuer=Example"));
        for invalid in [
            "otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP",
            "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=0",
            "otpauth://totp/Test?secret=AA&digits=99",
            "otpauth://totp/Test?secret=AA&secret=BB",
            "otpauth://totp/Test?secret=AA&encoder=steam",
        ] {
            assert!(totp(&BTreeMap::from([("otp".into(), invalid.into())]), "Test").is_err());
        }
        let fields = BTreeMap::from([
            ("TOTP Seed".into(), "JBSWY3DPEHPK3PXP".into()),
            ("TOTP Settings".into(), "60;8".into()),
        ]);
        assert!(totp(&fields, "Test")
            .unwrap()
            .unwrap()
            .contains("period=60"));
        let fields = BTreeMap::from([
            ("otp".into(), "otpauth://totp/Test?secret=AA".into()),
            ("TimeOtp-Secret-Base32".into(), "BB".into()),
        ]);
        assert!(totp(&fields, "Test").is_err());
    }
}
