use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 3;
pub const DATABASE_SCHEMA: &str = "3";
pub const SIGNATURE_VERSION: u32 = 2;
mod integrity;
pub use integrity::*;
mod share_contact;
pub use share_contact::ShareContact;
pub const PROFILE: &str = "opaque-ristretto255-sha512-argon2id-m65536-t3-p1-v1";

/// Account names use one canonical spelling for lookup, verification and storage.
pub fn normalize_login(login: &str) -> String {
    login.to_ascii_lowercase()
}

pub fn valid_account_login(login: &str) -> bool {
    (3..=40).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServerInfo {
    pub server_id: String,
    pub protocol_version: u32,
    pub auth_profile: String,
    pub dev_mode: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct AccountBundle {
    pub envelope: Value,
    pub public_sign: String,
    pub public_share: String,
    pub recovery: Option<RecoveryBundle>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RecoveryBundle {
    pub id: String,
    pub public_key: String,
    pub envelope: Value,
}
#[derive(Serialize, Deserialize)]
pub struct RegisterBegin {
    pub login: String,
    pub email: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct RegisterChallenge {
    pub ticket: String,
    pub account_id: String,
    pub server_id: String,
    pub message: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct RegisterFinish {
    pub manifest: VaultManifest,
    pub ticket: String,
    pub email_code: String,
    pub message: String,
    pub bundle: AccountBundle,
}
#[derive(Serialize, Deserialize)]
pub struct LoginBegin {
    pub login: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct LoginChallenge {
    pub ticket: String,
    pub account_id: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct LoginFinish {
    pub ticket: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct LoginResponse {
    pub token: String,
    pub account_id: String,
    pub bundle: AccountBundle,
    pub timeout_seconds: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredVersion {
    pub signature_version: u32,
    pub operation_id: String,
    pub record_id: String,
    pub version_id: String,
    pub revision: i64,
    pub previous_version: Option<String>,
    pub payload: Value,
    pub signature: String,
    pub archived: bool,
    pub created_at: i64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SaveRecord {
    pub signature_version: u32,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<VaultManifest>,
    pub operation_id: String,
    pub record_id: String,
    pub expected_revision: i64,
    pub version_id: String,
    pub previous_version: Option<String>,
    pub payload: Value,
    pub signature: String,
    pub archived: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub timeout_seconds: u32,
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryBegin {
    pub account_id: String,
    pub recovery_id: String,
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryChallenge {
    pub ticket: String,
    pub challenge: String,
    pub bundle: RecoveryBundle,
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryAuthorize {
    pub ticket: String,
    pub signature: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryPrepared {
    pub ticket: String,
    pub message: String,
}
#[derive(Serialize, Deserialize)]
pub struct RecoveryFinish {
    pub ticket: String,
    pub message: String,
    pub envelope: Value,
}

// The signature has a fixed, length-delimited field order independent of JSON key order.
pub fn record_transcript(server: &str, account: &str, request: &SaveRecord) -> Vec<u8> {
    let fields = [
        "neruvalo-record-v2".to_owned(),
        request.signature_version.to_string(),
        request.created_at.to_string(),
        server.into(),
        account.into(),
        request.operation_id.clone(),
        request.record_id.clone(),
        request.version_id.clone(),
        request.expected_revision.to_string(),
        request.previous_version.clone().unwrap_or_default(),
        request.archived.to_string(),
        canonical_json(&request.payload),
    ];
    let mut bytes = Vec::new();
    for f in fields {
        bytes.extend_from_slice(&(f.len() as u64).to_be_bytes());
        bytes.extend_from_slice(f.as_bytes());
    }
    bytes
}
pub fn stored_transcript(server: &str, account: &str, version: &StoredVersion) -> Vec<u8> {
    let fields = [
        "neruvalo-record-v2".to_owned(),
        version.signature_version.to_string(),
        version.created_at.to_string(),
        server.into(),
        account.into(),
        version.operation_id.clone(),
        version.record_id.clone(),
        version.version_id.clone(),
        (version.revision - 1).to_string(),
        version.previous_version.clone().unwrap_or_default(),
        version.archived.to_string(),
        canonical_json(&version.payload),
    ];
    let mut bytes = Vec::new();
    for field in fields {
        bytes.extend_from_slice(&(field.len() as u64).to_be_bytes());
        bytes.extend_from_slice(field.as_bytes());
    }
    bytes
}
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let sorted: std::collections::BTreeMap<_, _> = map.iter().collect();
            let fields: Vec<_> = sorted
                .into_iter()
                .map(|(k, v)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("key"),
                        canonical_json(v)
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        _ => serde_json::to_string(v).expect("JSON scalar"),
    }
}

/// Atomic update of an encrypted subtree. Snapshot contains opaque IDs only.
#[derive(Clone, Serialize, Deserialize)]
pub struct SaveBatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<VaultManifest>,
    pub operation_id: String,
    pub snapshot: std::collections::BTreeMap<String, i64>,
    pub records: Vec<SaveRecord>,
}

mod sharing;
pub use sharing::*;

/// Encrypted vault history import. Existing versions must match exactly.
#[derive(Clone, Serialize, Deserialize)]
pub struct ImportVault {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<VaultManifest>,
    pub operation_id: String,
    pub versions: Vec<StoredVersion>,
}

#[cfg(test)]
mod login_tests {
    use super::*;

    #[test]
    fn account_names_ignore_case_without_relaxing_other_constraints() {
        for name in ["Test1", "TEST1", "test1"] {
            assert!(valid_account_login(name));
            assert_eq!(normalize_login(name), "test1");
        }
        for invalid in ["ab", "Test 1", "Тест1", "test@example.test", " test1"] {
            assert!(!valid_account_login(invalid));
        }
        assert!(!valid_account_login(&"A".repeat(41)));
    }
}
