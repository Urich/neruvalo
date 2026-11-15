use super::*;
use std::io::Read;

pub const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
pub const MAX_ATTACHMENTS_BYTES: usize = 4 * MAX_ATTACHMENT_BYTES;
pub const MAX_ATTACHMENTS: usize = 16;

/// File bytes are encrypted independently; `data` is an internal encrypted block,
/// never plaintext base64. Desktop IPC replaces it with a session-bound handle.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: usize,
    pub data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileBlock {
    format_version: u32,
    key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    blob: Option<Envelope>,
}

impl Attachment {
    fn context(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&(
            "neruvalo/file/v1",
            &self.id,
            &self.name,
            self.size,
        ))?)
    }
    fn block(&self) -> Result<FileBlock> {
        ensure!(
            self.data.len() <= (MAX_ATTACHMENT_BYTES + 1024).div_ceil(3) * 4,
            "INVALID_ATTACHMENT"
        );
        let block: FileBlock =
            serde_json::from_str(&self.data).map_err(|_| anyhow!("INVALID_ATTACHMENT"))?;
        ensure!(block.format_version == 1, "UNSUPPORTED_ATTACHMENT_FORMAT");
        crypto::parse_key(&unb64(&block.key)?)?;
        Ok(block)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(Uuid::parse_str(&self.id).is_ok(), "INVALID_ATTACHMENT");
        ensure!(
            !self.name.trim().is_empty()
                && self.name.len() <= 255
                && !self.name.chars().any(|c| c.is_control()
                    || matches!(c, '/' | '\\' | ':' | '<' | '>' | '\"' | '|' | '?' | '*'))
                && self.name != "."
                && self.name != "..",
            "INVALID_ATTACHMENT_NAME"
        );
        ensure!(self.size <= MAX_ATTACHMENT_BYTES, "ATTACHMENT_TOO_LARGE");
        let block = self.block()?;
        let blob = block.blob.ok_or_else(|| anyhow!("INVALID_ATTACHMENT"))?;
        ensure!(
            blob.format_version == 1
                && blob.suite == "xchacha20poly1305-v1"
                && unb64(&blob.nonce)?.len() == 24
                && blob.ciphertext.len() == ((self.size + 16) * 4).div_ceil(3),
            "INVALID_ATTACHMENT"
        );
        Ok(())
    }
    pub fn from_bytes(name: String, bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= MAX_ATTACHMENT_BYTES, "ATTACHMENT_TOO_LARGE");
        let mut attachment = Self {
            id: Uuid::new_v4().to_string(),
            name,
            size: bytes.len(),
            data: String::new(),
        };
        // Encrypt once at ingestion; later record versions reuse this key/ciphertext pair.
        let key = Zeroizing::new(crypto::random::<32>());
        let blob = crypto::seal(key.as_ref(), bytes, &attachment.context()?)?;
        attachment.data = serde_json::to_string(&FileBlock {
            format_version: 1,
            key: b64(key.as_ref()),
            blob: Some(blob),
        })?;
        attachment.validate()?;
        Ok(attachment)
    }
    pub fn from_file(path: &Path) -> Result<Self> {
        let file = std::fs::File::open(path)?;
        ensure!(file.metadata()?.is_file(), "INVALID_ATTACHMENT");
        let mut bytes = Zeroizing::new(Vec::new());
        file.take((MAX_ATTACHMENT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        Self::from_bytes(
            path.file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow!("INVALID_ATTACHMENT_NAME"))?
                .into(),
            &bytes,
        )
    }
    pub fn save_to(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let block = self.block()?;
        let key = Zeroizing::new(unb64(&block.key)?);
        let bytes = crypto::open(&key, &block.blob.unwrap(), &self.context()?)?;
        ensure!(bytes.len() == self.size, "INVALID_ATTACHMENT");
        // Authenticate before opening/truncating the destination file.
        std::fs::write(path, &bytes)?;
        Ok(())
    }
}

/// Ciphertexts live outside encrypted metadata. Keys and file descriptions remain
/// inside it. Both are covered by the existing signed version/shared-copy transcript.
#[derive(Serialize, Deserialize)]
pub(super) struct FilePayload<T> {
    pub format_version: u32,
    pub record: T,
    pub files: BTreeMap<String, Envelope>,
}

pub(super) fn split(data: &RecordData) -> Result<(RecordData, BTreeMap<String, Envelope>)> {
    data.validate()?;
    let mut metadata = data.clone();
    let mut files = BTreeMap::new();
    if let Some(value) = metadata.extra.get_mut("attachments") {
        let mut attachments: Vec<Attachment> = serde_json::from_value(value.clone())?;
        for file in &mut attachments {
            let mut block = file.block()?;
            files.insert(file.id.clone(), block.blob.take().unwrap());
            file.data = serde_json::to_string(&block)?;
        }
        *value = serde_json::to_value(attachments)?;
    }
    Ok((metadata, files))
}

pub(super) fn join(
    mut metadata: RecordData,
    mut files: BTreeMap<String, Envelope>,
) -> Result<RecordData> {
    if let Some(value) = metadata.extra.get_mut("attachments") {
        let mut attachments: Vec<Attachment> = serde_json::from_value(value.clone())?;
        for file in &mut attachments {
            let mut block = file.block()?;
            ensure!(block.blob.is_none(), "INVALID_ATTACHMENT");
            block.blob = Some(
                files
                    .remove(&file.id)
                    .ok_or_else(|| anyhow!("INVALID_ATTACHMENT"))?,
            );
            file.data = serde_json::to_string(&block)?;
        }
        *value = serde_json::to_value(attachments)?;
    }
    ensure!(files.is_empty(), "INVALID_ATTACHMENT");
    metadata.validate()?;
    Ok(metadata)
}

pub(super) fn encrypt_record(
    keys: &AccountKeys,
    data: &RecordData,
    context: &[u8],
) -> Result<Value> {
    let (metadata, files) = split(data)?;
    let record = crypto::encrypt_version(
        keys,
        &Zeroizing::new(serde_json::to_vec(&metadata)?),
        context,
    )?;
    Ok(serde_json::to_value(FilePayload {
        format_version: 3,
        record,
        files,
    })?)
}

// This preflight inspects envelope headers without opening any file ciphertext.
pub(super) fn validate_payload_format(payload: &Value, shared: bool) -> Result<()> {
    ensure!(payload["format_version"] == 3, "UNSUPPORTED_VAULT_FORMAT");
    fn envelope(value: &Value) -> Result<()> {
        ensure!(
            value["format_version"] == 1 && value["suite"] == "xchacha20poly1305-v1",
            "UNSUPPORTED_VAULT_FORMAT"
        );
        Ok(())
    }
    if shared {
        envelope(&payload["record"])?;
    } else {
        envelope(&payload["record"]["data"])?;
        envelope(&payload["record"]["owner_key"])?;
    }
    for file in payload["files"]
        .as_object()
        .ok_or_else(|| anyhow!("UNSUPPORTED_VAULT_FORMAT"))?
        .values()
    {
        envelope(file)?;
    }
    Ok(())
}

pub(super) fn decrypt_record(
    keys: &AccountKeys,
    payload: &Value,
    context: &[u8],
) -> Result<RecordData> {
    validate_payload_format(payload, false)?;
    let payload: FilePayload<EncryptedVersion> =
        serde_json::from_value(payload.clone()).map_err(|_| anyhow!("UNSUPPORTED_FORMAT"))?;
    ensure!(payload.format_version == 3, "UNSUPPORTED_FORMAT");
    let raw = crypto::decrypt_version(keys, &payload.record, context)?;
    join(serde_json::from_slice(&raw)?, payload.files)
}

#[derive(Default)]
pub(super) struct Handles {
    files: BTreeMap<String, Attachment>,
    fingerprints: BTreeMap<String, String>,
}
impl Handles {
    fn expose(&mut self, file: Attachment) -> Result<Value> {
        file.validate()?;
        let fingerprint = crypto::digest(&serde_json::to_string(&file)?);
        let handle = self
            .fingerprints
            .entry(fingerprint)
            .or_insert_with(crypto::token)
            .clone();
        let value = json!({"id":file.id,"name":file.name,"size":file.size,"data":handle});
        self.files.insert(handle, file);
        Ok(value)
    }
    fn resolve(&self, value: Value) -> Result<Attachment> {
        let descriptor: Attachment = serde_json::from_value(value)?;
        let file = self
            .files
            .get(&descriptor.data)
            .ok_or_else(|| anyhow!("INVALID_ATTACHMENT_HANDLE"))?;
        ensure!(
            file.id == descriptor.id
                && file.name == descriptor.name
                && file.size == descriptor.size,
            "INVALID_ATTACHMENT_HANDLE"
        );
        Ok(file.clone())
    }
}
impl Client {
    /// Replace encrypted file blocks (including their keys) with opaque session handles.
    /// Called only at the desktop IPC boundary, never for storage/export/sharing.
    pub fn expose_attachments(&mut self, mut value: Value) -> Result<Value> {
        fn visit(value: &mut Value, handles: &mut Handles) -> Result<()> {
            match value {
                Value::Object(map)
                    if map.contains_key("id")
                        && map.contains_key("name")
                        && map.contains_key("size")
                        && map.contains_key("data") =>
                {
                    *value = handles.expose(serde_json::from_value(value.take())?)?;
                }
                Value::Object(map) => {
                    for item in map.values_mut() {
                        visit(item, handles)?;
                    }
                }
                Value::Array(items) => {
                    for item in items {
                        visit(item, handles)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        if let Some(a) = self.active.as_mut() {
            visit(&mut value, &mut a.attachment_handles)?;
        }
        Ok(value)
    }
    pub fn resolve_attachment(&mut self, value: Value) -> Result<Attachment> {
        self.unlocked()?.attachment_handles.resolve(value)
    }
    pub fn resolve_record_attachments(&mut self, data: &mut RecordData) -> Result<()> {
        if let Some(value) = data.extra.get_mut("attachments") {
            let items = value
                .as_array()
                .ok_or_else(|| anyhow!("INVALID_ATTACHMENT"))?;
            let files: Vec<_> = items
                .iter()
                .map(|item| self.resolve_attachment(item.clone()))
                .collect::<Result<_>>()?;
            *value = serde_json::to_value(files)?;
        }
        Ok(())
    }
}

pub(super) fn validate(data: &RecordData) -> Result<()> {
    if let Some(value) = data.extra.get("attachments") {
        let attachments: Vec<Attachment> = serde_json::from_value(value.clone())?;
        ensure!(attachments.len() <= MAX_ATTACHMENTS, "TOO_MANY_ATTACHMENTS");
        ensure!(
            data.record_type != "group" || attachments.is_empty(),
            "INVALID_GROUP"
        );
        let mut ids = std::collections::BTreeSet::new();
        let mut total = 0usize;
        for attachment in attachments {
            attachment.validate()?;
            ensure!(ids.insert(attachment.id), "INVALID_ATTACHMENT");
            total += attachment.size;
            ensure!(total <= MAX_ATTACHMENTS_BYTES, "ATTACHMENTS_TOO_LARGE");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item() -> Attachment {
        Attachment::from_bytes("ключ.bin".into(), &[0, 255, 42]).unwrap()
    }
    fn record(items: Vec<Attachment>) -> RecordData {
        RecordData {
            record_type: "note".into(),
            schema_version: 2,
            title: "Files".into(),
            fields: BTreeMap::new(),
            notes: String::new(),
            folder: String::new(),
            tags: vec![],
            extra: BTreeMap::from([("attachments".into(), json!(items))]),
        }
    }
    #[test]
    fn files_roundtrip_and_invalid_metadata_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ключ.bin");
        item().save_to(&path).unwrap();
        let read = Attachment::from_file(&path).unwrap();
        let output = dir.path().join("output.bin");
        read.save_to(&output).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), [0, 255, 42]);
        assert_eq!(read.name, "ключ.bin");
        let empty = Attachment::from_bytes("empty.bin".into(), b"").unwrap();
        empty.save_to(&path).unwrap();
        assert!(std::fs::read(&path).unwrap().is_empty());
        let mut bad = item();
        bad.size = 2;
        assert!(bad.validate().is_err());
        for name in ["../secret", "..", "C:\\secret", "bad\nname"] {
            let mut bad = item();
            bad.name = name.into();
            assert!(bad.validate().is_err());
        }
        let mut bad = item();
        bad.data = "!".into();
        assert!(bad.validate().is_err());
        std::fs::write(&path, vec![0; MAX_ATTACHMENT_BYTES + 1]).unwrap();
        assert!(Attachment::from_file(&path).is_err());
    }
    #[test]
    fn record_limits_and_format_guard() {
        let a = item();
        assert!(record(vec![a.clone()]).validate().is_ok());
        assert!(record(vec![a.clone(), a]).validate().is_err());
        assert!(record((0..17).map(|_| item()).collect())
            .validate()
            .is_err());
        let big =
            || Attachment::from_bytes("large.bin".into(), &vec![0; MAX_ATTACHMENT_BYTES]).unwrap();
        assert!(record((0..4).map(|_| big()).collect()).validate().is_ok());
        assert!(record((0..5).map(|_| big()).collect()).validate().is_err());
        let mut old = record(vec![item()]);
        old.schema_version = 1;
        assert!(old.validate().is_err());
        let mut group = record(vec![item()]);
        group.record_type = "group".into();
        assert!(group.validate().is_err());
    }
    #[test]
    fn file_vector_and_metadata_binding() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/attachment-v1.json"
        ))
        .unwrap();
        let file: Attachment = serde_json::from_value(vector["attachment"].clone()).unwrap();
        assert_eq!(
            String::from_utf8(file.context().unwrap()).unwrap(),
            vector["aad_utf8"]
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.bin");
        file.save_to(&path).unwrap();
        assert_eq!(
            b64(std::fs::read(&path).unwrap()),
            vector["plaintext_base64"]
        );
        for changed in [
            Attachment {
                id: Uuid::new_v4().to_string(),
                ..file.clone()
            },
            Attachment {
                name: "changed.bin".into(),
                ..file.clone()
            },
            Attachment {
                size: 4,
                ..file.clone()
            },
        ] {
            std::fs::write(&path, b"existing file").unwrap();
            assert!(changed.save_to(&path).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"existing file");
        }
    }

    #[test]
    fn metadata_read_and_edit_never_open_the_file_ciphertext() {
        let keys = AccountKeys::generate();
        let mut file = item();
        let mut block = file.block().unwrap();
        let blob = block.blob.as_mut().unwrap();
        let mut corrupted = unb64(&blob.ciphertext).unwrap();
        corrupted[0] ^= 1;
        blob.ciphertext = b64(corrupted);
        file.data = serde_json::to_string(&block).unwrap();
        let mut data = record(vec![file.clone()]);
        let payload = encrypt_record(&keys, &data, b"version-1").unwrap();
        assert!(payload["files"][&file.id].is_object());
        let envelope: EncryptedVersion = serde_json::from_value(payload["record"].clone()).unwrap();
        let metadata: RecordData = serde_json::from_slice(
            &crypto::decrypt_version(&keys, &envelope, b"version-1").unwrap(),
        )
        .unwrap();
        let descriptor: Attachment =
            serde_json::from_value(metadata.extra["attachments"][0].clone()).unwrap();
        assert!(descriptor.block().unwrap().blob.is_none());
        assert!(
            metadata.extra["attachments"][0]["data"]
                .as_str()
                .unwrap()
                .len()
                < 128
        );
        let read = decrypt_record(&keys, &payload, b"version-1").unwrap();
        assert_eq!(read.extra["attachments"], data.extra["attachments"]);
        data.title = "Edited without opening file".into();
        let edited = encrypt_record(&keys, &data, b"version-2").unwrap();
        assert_eq!(edited["files"], payload["files"]);
        assert!(decrypt_record(&keys, &edited, b"version-2").is_ok());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.bin");
        std::fs::write(&path, b"preserve destination").unwrap();
        assert!(file.save_to(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"preserve destination");
        assert!(decrypt_record(&keys, &payload, b"wrong version").is_err());
        let mut missing = payload.clone();
        missing["files"] = json!({});
        assert!(decrypt_record(&keys, &missing, b"version-1").is_err());
        let mut extra = payload;
        extra["files"][Uuid::new_v4().to_string()] = edited["files"][&file.id].clone();
        assert!(decrypt_record(&keys, &extra, b"version-1").is_err());
        let old = crypto::encrypt_version(&keys, b"{}", b"old").unwrap();
        assert!(decrypt_record(&keys, &serde_json::to_value(old).unwrap(), b"old").is_err());
    }

    #[tokio::test]
    async fn desktop_handles_hide_keys_and_expire_on_lock() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().into()).unwrap();
        let password = || Zeroizing::new("attachment session password".into());
        let profile = client.create_local("Files", password()).await.unwrap();
        let file = item();
        let exposed = client
            .expose_attachments(json!({"data":record(vec![file.clone()])}))
            .unwrap();
        let descriptor = &exposed["data"]["attachments"][0];
        assert_ne!(descriptor["data"], file.data);
        assert!(!serde_json::to_string(&exposed)
            .unwrap()
            .contains(&file.block().unwrap().key));
        assert_eq!(
            client.resolve_attachment(descriptor.clone()).unwrap().data,
            file.data
        );
        let mut forged = descriptor.clone();
        forged["name"] = json!("another.bin");
        assert!(client.resolve_attachment(forged).is_err());
        assert!(client.resolve_attachment(json!(file)).is_err());
        client.lock();
        assert!(client.resolve_attachment(descriptor.clone()).is_err());
        client
            .unlock_offline(profile["profile"].as_str().unwrap(), password())
            .await
            .unwrap();
        assert!(client.resolve_attachment(descriptor.clone()).is_err());
    }

    #[tokio::test]
    async fn local_history_offline_and_encrypted_backup_keep_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut client = Client::new(dir.path().join("client")).unwrap();
        let password = || Zeroizing::new("correct horse attachment password".to_owned());
        let profile = client.create_local("Files", password()).await.unwrap();
        let file = item();
        let first = client
            .save(None, 0, record(vec![file.clone()]), false)
            .await
            .unwrap();
        let id = first["record_id"].as_str().unwrap();
        client
            .save(Some(id.into()), 1, record(vec![]), false)
            .await
            .unwrap();
        assert_eq!(
            client.list().await.unwrap()[0].data.extra["attachments"],
            json!([])
        );
        assert_eq!(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0]["data"],
            file.data
        );
        let from_history: Attachment = serde_json::from_value(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0].clone(),
        )
        .unwrap();
        let output = dir.path().join("restored-file.bin");
        from_history.save_to(&output).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), [0, 255, 42]);
        let backup = dir.path().join("files.nvbackup");
        client
            .export_local_backup(&backup, password())
            .await
            .unwrap();
        assert!(!std::fs::read_to_string(&backup)
            .unwrap()
            .contains(&file.name));
        client.lock();
        client
            .unlock_offline(profile["profile"].as_str().unwrap(), password())
            .await
            .unwrap();
        assert_eq!(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0]["data"],
            file.data
        );
        let from_history: Attachment = serde_json::from_value(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0].clone(),
        )
        .unwrap();
        let output = dir.path().join("restored-file.bin");
        from_history.save_to(&output).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), [0, 255, 42]);
        client.lock();
        client
            .restore_local_backup(&backup, password())
            .await
            .unwrap();
        assert_eq!(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0]["data"],
            file.data
        );
        let from_history: Attachment = serde_json::from_value(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0].clone(),
        )
        .unwrap();
        let output = dir.path().join("restored-file.bin");
        from_history.save_to(&output).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), [0, 255, 42]);
    }
}
