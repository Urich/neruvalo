//! Canonical authenticated state. SQL layout is never part of the signed message.
use super::*;
use anyhow::{ensure, Result};
use neruvalo_crypto as crypto;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_VERSION_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_VERSIONS: usize = 200_000;
pub const MAX_STATE_BYTES: usize = 512 * 1024 * 1024;

pub fn signed_time() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs() as i64
}
impl SaveRecord {
    pub fn stored(&self) -> StoredVersion {
        StoredVersion {
            signature_version: self.signature_version,
            operation_id: self.operation_id.clone(),
            record_id: self.record_id.clone(),
            version_id: self.version_id.clone(),
            revision: self.expected_revision + 1,
            previous_version: self.previous_version.clone(),
            payload: self.payload.clone(),
            signature: self.signature.clone(),
            archived: self.archived,
            created_at: self.created_at,
        }
    }
}
impl StoredVersion {
    pub fn request(&self) -> SaveRecord {
        SaveRecord {
            signature_version: self.signature_version,
            created_at: self.created_at,
            manifest: None,
            operation_id: self.operation_id.clone(),
            record_id: self.record_id.clone(),
            expected_revision: self.revision - 1,
            version_id: self.version_id.clone(),
            previous_version: self.previous_version.clone(),
            payload: self.payload.clone(),
            signature: self.signature.clone(),
            archived: self.archived,
        }
    }
}
pub fn validate_stored_version(
    server: &str,
    account: &str,
    public: &str,
    version: &StoredVersion,
) -> Result<()> {
    ensure!(
        version.signature_version == SIGNATURE_VERSION,
        "UNSUPPORTED_SIGNATURE_FORMAT"
    );
    ensure!(
        version.revision > 0 && version.created_at >= 0,
        "VAULT_INTEGRITY"
    );
    for id in [
        &version.operation_id,
        &version.record_id,
        &version.version_id,
    ] {
        ensure!(uuid::Uuid::parse_str(id).is_ok(), "VAULT_INTEGRITY");
    }
    if let Some(id) = &version.previous_version {
        ensure!(uuid::Uuid::parse_str(id).is_ok(), "VAULT_INTEGRITY");
    }
    ensure!(
        serde_json::to_vec(version)?.len() <= MAX_VERSION_BYTES,
        "VAULT_RESOURCE_LIMIT"
    );
    crypto::verify(
        public,
        &stored_transcript(server, account, version),
        &version.signature,
    )
    .map_err(|_| anyhow::anyhow!("VAULT_INTEGRITY: invalid version signature"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordHead {
    pub version_id: String,
    pub revision: i64,
    pub version_count: u64,
    pub history_digest: String,
    pub archived: bool,
}
#[derive(Clone)]
pub struct VerifiedStamp {
    record_id: String,
    version_id: String,
    revision: i64,
    previous_version: Option<String>,
    archived: bool,
    component: String,
    bytes: usize,
}
impl VerifiedStamp {
    pub fn verify(
        server: &str,
        account: &str,
        public: &str,
        version: &StoredVersion,
    ) -> Result<Self> {
        validate_stored_version(server, account, public, version)?;
        let component = crypto::digest(&canonical_json(&serde_json::json!([
            crypto::digest_bytes(&stored_transcript(server, account, version)),
            version.signature
        ])));
        Ok(Self {
            record_id: version.record_id.clone(),
            version_id: version.version_id.clone(),
            revision: version.revision,
            previous_version: version.previous_version.clone(),
            archived: version.archived,
            component,
            bytes: serde_json::to_vec(version)?.len(),
        })
    }
    pub fn matches_sql(&self, id: &str, record: &str, revision: i64) -> bool {
        self.version_id == id && self.record_id == record && self.revision == revision
    }
}
#[derive(Default)]
pub struct VerifiedHistory {
    pub records: BTreeMap<String, RecordHead>,
    ids: BTreeSet<String>,
    bytes: usize,
}
impl VerifiedHistory {
    pub fn push(
        &mut self,
        server: &str,
        account: &str,
        public: &str,
        version: &StoredVersion,
    ) -> Result<()> {
        self.accept(&VerifiedStamp::verify(server, account, public, version)?)
    }
    pub fn accept(&mut self, stamp: &VerifiedStamp) -> Result<()> {
        let old = self.records.get(&stamp.record_id);
        ensure!(
            stamp.revision == old.map_or(1, |v| v.revision + 1)
                && stamp.previous_version.as_ref() == old.map(|v| &v.version_id),
            "VAULT_INTEGRITY: broken history"
        );
        ensure!(self.ids.len() < MAX_VERSIONS, "VAULT_RESOURCE_LIMIT");
        ensure!(
            self.ids.insert(stamp.version_id.clone()),
            "VAULT_INTEGRITY: duplicate version"
        );
        self.bytes = self
            .bytes
            .checked_add(stamp.bytes)
            .ok_or_else(|| anyhow::anyhow!("VAULT_RESOURCE_LIMIT"))?;
        ensure!(self.bytes <= MAX_STATE_BYTES, "VAULT_RESOURCE_LIMIT");
        let digest = crypto::digest(&canonical_json(&serde_json::json!([
            "neruvalo-history-v1",
            old.map(|v| v.history_digest.as_str()).unwrap_or(""),
            stamp.component
        ])));
        self.records.insert(
            stamp.record_id.clone(),
            RecordHead {
                version_id: stamp.version_id.clone(),
                revision: stamp.revision,
                version_count: stamp.revision as u64,
                history_digest: digest,
                archived: stamp.archived,
            },
        );
        Ok(())
    }
    pub fn from_versions(
        server: &str,
        account: &str,
        public: &str,
        versions: &[StoredVersion],
    ) -> Result<Self> {
        ensure!(versions.len() <= MAX_VERSIONS, "VAULT_RESOURCE_LIMIT");
        let mut sorted: Vec<_> = versions.iter().collect();
        sorted.sort_by_key(|v| (&v.record_id, v.revision));
        let mut history = Self::default();
        for version in sorted {
            history.push(server, account, public, version)?;
        }
        Ok(history)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultManifest {
    pub manifest_version: u32,
    pub vault_id: String,
    pub server_id: String,
    pub account_id: String,
    pub generation: u64,
    pub previous_manifest_hash: String,
    pub records: BTreeMap<String, RecordHead>,
    pub metadata_digest: String,
    pub auxiliary_digest: String,
    pub signature: String,
    pub link_signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestLink {
    pub generation: u64,
    pub previous_hash: String,
    pub manifest_hash: String,
    pub signature: String,
}
pub fn identity_digest(server: &str, account: &str, sign: &str, share: &str) -> String {
    crypto::digest(&canonical_json(&serde_json::json!([
        "neruvalo-profile-v3",
        server,
        account,
        sign,
        share
    ])))
}
impl VaultManifest {
    pub fn transcript(&self) -> Vec<u8> {
        canonical_json(&serde_json::json!([
            "neruvalo-vault-manifest-v1",
            self.manifest_version,
            self.vault_id,
            self.server_id,
            self.account_id,
            self.generation,
            self.previous_manifest_hash,
            self.records,
            self.metadata_digest,
            self.auxiliary_digest
        ]))
        .into_bytes()
    }
    pub fn hash(&self) -> String {
        crypto::digest(&canonical_json(&serde_json::json!([
            String::from_utf8(self.transcript()).expect("UTF-8"),
            self.signature
        ])))
    }
    pub fn link(&self) -> ManifestLink {
        ManifestLink {
            generation: self.generation,
            previous_hash: self.previous_manifest_hash.clone(),
            manifest_hash: self.hash(),
            signature: self.link_signature.clone(),
        }
    }
    pub fn create(
        server: &str,
        account: &str,
        keys: &crypto::AccountKeys,
        records: BTreeMap<String, RecordHead>,
        previous: Option<&Self>,
        auxiliary_digest: String,
    ) -> Result<Self> {
        let generation = previous
            .map_or(Some(1), |p| p.generation.checked_add(1))
            .ok_or_else(|| anyhow::anyhow!("VAULT_RESOURCE_LIMIT"))?;
        ensure!(generation <= i64::MAX as u64, "VAULT_RESOURCE_LIMIT");
        let mut manifest = Self {
            manifest_version: 1,
            vault_id: account.into(),
            server_id: server.into(),
            account_id: account.into(),
            generation,
            previous_manifest_hash: previous.map(Self::hash).unwrap_or_default(),
            records,
            metadata_digest: identity_digest(
                server,
                account,
                &keys.public_sign(),
                &keys.public_share(),
            ),
            auxiliary_digest,
            signature: String::new(),
            link_signature: String::new(),
        };
        manifest.signature = keys.sign(&manifest.transcript());
        manifest.link_signature = keys.sign(&manifest.link().transcript(server, account));
        ensure!(
            serde_json::to_vec(&manifest)?.len() <= 32 * 1024 * 1024,
            "VAULT_RESOURCE_LIMIT"
        );
        Ok(manifest)
    }
    pub fn verify(&self, server: &str, account: &str, sign: &str, share: &str) -> Result<()> {
        ensure!(
            self.manifest_version == 1
                && self.server_id == server
                && self.account_id == account
                && self.vault_id == account
                && self.generation > 0
                && self.generation <= i64::MAX as u64
                && (self.generation == 1) == self.previous_manifest_hash.is_empty()
                && self.metadata_digest == identity_digest(server, account, sign, share),
            "VAULT_INTEGRITY: manifest identity"
        );
        crypto::verify(sign, &self.transcript(), &self.signature)
            .map_err(|_| anyhow::anyhow!("VAULT_INTEGRITY: manifest signature"))?;
        self.link().verify(server, account, sign)
    }
    pub fn follows(&self, previous: &Self) -> Result<()> {
        ensure!(
            previous.generation.checked_add(1) == Some(self.generation)
                && self.previous_manifest_hash == previous.hash(),
            "RECORD_VERSION_MISMATCH"
        );
        Ok(())
    }
}
impl ManifestLink {
    fn transcript(&self, server: &str, account: &str) -> Vec<u8> {
        canonical_json(&serde_json::json!([
            "neruvalo-manifest-link-v1",
            server,
            account,
            self.generation,
            self.previous_hash,
            self.manifest_hash
        ]))
        .into_bytes()
    }
    pub fn verify(&self, server: &str, account: &str, public: &str) -> Result<()> {
        crypto::verify(public, &self.transcript(server, account), &self.signature)
            .map_err(|_| anyhow::anyhow!("VAULT_INTEGRITY: manifest link"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_vector_fixes_canonical_bytes_and_signed_timestamp() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/vault-manifest-v1.json"
        ))
        .unwrap();
        let request: SaveRecord = serde_json::from_value(vector["request"].clone()).unwrap();
        let bytes = record_transcript("server-vector", "account-vector", &request);
        assert_eq!(crypto::b64(&bytes), vector["record_transcript_base64"]);
        assert_eq!(
            bytes,
            stored_transcript("server-vector", "account-vector", &request.stored())
        );
        let manifest: VaultManifest = serde_json::from_value(vector["manifest"].clone()).unwrap();
        assert_eq!(
            String::from_utf8(manifest.transcript()).unwrap(),
            vector["manifest_transcript_utf8"]
        );
        assert_eq!(manifest.hash(), vector["manifest_hash"]);
        let mut changed = request.clone();
        changed.created_at += 1;
        assert_ne!(
            bytes,
            record_transcript("server-vector", "account-vector", &changed)
        );
    }
    #[test]
    fn signed_histories_reject_gaps_cycles_foreign_contexts_and_forks() {
        let keys = crypto::AccountKeys::generate();
        let first = SaveRecord {
            signature_version: SIGNATURE_VERSION,
            created_at: 1,
            manifest: None,
            operation_id: uuid::Uuid::new_v4().to_string(),
            record_id: uuid::Uuid::new_v4().to_string(),
            version_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: 0,
            previous_version: None,
            payload: serde_json::json!({}),
            signature: String::new(),
            archived: false,
        };
        let sign = |mut request: SaveRecord| {
            request.signature = keys.sign(&record_transcript("server", "account", &request));
            request.stored()
        };
        let first = sign(first);
        let mut next = first.request();
        next.version_id = uuid::Uuid::new_v4().to_string();
        next.operation_id = uuid::Uuid::new_v4().to_string();
        next.expected_revision = 1;
        next.previous_version = Some(first.version_id.clone());
        let next = sign(next);
        assert!(VerifiedHistory::from_versions(
            "server",
            "account",
            &keys.public_sign(),
            &[next.clone(), first.clone()]
        )
        .is_ok());
        assert!(VerifiedHistory::from_versions(
            "other",
            "account",
            &keys.public_sign(),
            std::slice::from_ref(&first)
        )
        .is_err());
        assert!(VerifiedHistory::from_versions(
            "server",
            "account",
            &keys.public_sign(),
            std::slice::from_ref(&next)
        )
        .is_err());
        let mut fork = next.request();
        fork.version_id = uuid::Uuid::new_v4().to_string();
        assert!(VerifiedHistory::from_versions(
            "server",
            "account",
            &keys.public_sign(),
            &[first.clone(), next.clone(), sign(fork)]
        )
        .is_err());
        let mut cycle = next.request();
        cycle.previous_version = Some(cycle.version_id.clone());
        assert!(VerifiedHistory::from_versions(
            "server",
            "account",
            &keys.public_sign(),
            &[first, sign(cycle)]
        )
        .is_err());
    }
    #[test]
    fn bounded_parser_property_corpus_never_panics() {
        // Deterministic byte corpus exercises malformed UTF-8/JSON and typed integer bounds.
        let mut state = 0x1234_5678u64;
        for length in 0..1024 {
            let bytes: Vec<u8> = (0..length)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state as u8
                })
                .collect();
            let _ = serde_json::from_slice::<VaultManifest>(&bytes);
            let _ = serde_json::from_slice::<StoredVersion>(&bytes);
        }
    }
}
