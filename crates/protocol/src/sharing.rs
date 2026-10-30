use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Serialize, Deserialize)]
pub struct SharedCopy {
    pub format_version: u32,
    pub server_id: String,
    pub owner_id: String,
    pub recipient_id: String,
    pub record_id: String,
    pub source_version_id: String,
    pub source_revision: i64,
    pub share_id: String,
    pub copy_id: String,
    pub copy_revision: i64,
    pub owner_sign: String,
    pub recipient_share: String,
    pub payload: Value,
    pub key_box: String,
    pub signature: String,
}
impl SharedCopy {
    pub fn context(&self) -> Vec<u8> {
        serde_json::to_vec(&(
            "neruvalo-shared-copy-v2",
            self.format_version,
            &self.server_id,
            &self.owner_id,
            &self.recipient_id,
            &self.record_id,
            &self.source_version_id,
            self.source_revision,
            &self.share_id,
            &self.copy_id,
            self.copy_revision,
            &self.owner_sign,
            &self.recipient_share,
        ))
        .expect("context")
    }
    pub fn transcript(&self) -> Vec<u8> {
        serde_json::to_vec(&(
            "neruvalo-shared-signature-v2",
            self.context(),
            super::canonical_json(&self.payload),
            &self.key_box,
        ))
        .expect("signature context")
    }
}
pub fn share_command_transcript(server: &str, actor: &str, request: &Value) -> Vec<u8> {
    let mut body = request.clone();
    body.as_object_mut().expect("object").remove("signature");
    serde_json::to_vec(&(
        "neruvalo-share-command-v2",
        server,
        actor,
        super::canonical_json(&body),
    ))
    .expect("command")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_transcript_vector_binds_identity_version_and_ciphertext() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/shared-copy-v2.json"
        ))
        .unwrap();
        let c: SharedCopy = serde_json::from_value(vector["copy"].clone()).unwrap();
        assert_eq!(
            c.context(),
            vector["context_utf8"].as_str().unwrap().as_bytes()
        );
        assert_eq!(
            c.transcript(),
            vector["transcript_utf8"].as_str().unwrap().as_bytes()
        );
        let mut changed = c.clone();
        changed.recipient_id = "attacker".into();
        assert_ne!(c.transcript(), changed.transcript());
        changed = c.clone();
        changed.payload["ciphertext"] = Value::String("tampered".into());
        assert_ne!(c.transcript(), changed.transcript());
    }
}
