use super::*;
use std::io::Read;

pub const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
pub const MAX_ATTACHMENTS_BYTES: usize = 4 * MAX_ATTACHMENT_BYTES;
pub const MAX_ATTACHMENTS: usize = 16;

/// Stored inside the authenticated, encrypted record, including its history.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: usize,
    pub data: String,
}

impl Attachment {
    pub fn validate(&self) -> Result<()> {
        ensure!(Uuid::parse_str(&self.id).is_ok(), "INVALID_ATTACHMENT");
        ensure!(
            !self.name.trim().is_empty()
                && self.name.len() <= 255
                && !self.name.chars().any(|c| c.is_control()
                    || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
                && self.name != "."
                && self.name != "..",
            "INVALID_ATTACHMENT_NAME"
        );
        ensure!(
            self.size <= MAX_ATTACHMENT_BYTES
                && self.data.len() <= MAX_ATTACHMENT_BYTES.div_ceil(3) * 4,
            "ATTACHMENT_TOO_LARGE"
        );
        let bytes = Zeroizing::new(unb64(&self.data)?);
        ensure!(bytes.len() == self.size, "INVALID_ATTACHMENT");
        Ok(())
    }

    pub fn from_file(path: &Path) -> Result<Self> {
        // Bound the read as well as the metadata: the file may change during reading.
        let file = std::fs::File::open(path)?;
        ensure!(file.metadata()?.is_file(), "INVALID_ATTACHMENT");
        let mut bytes = Zeroizing::new(Vec::new());
        file.take((MAX_ATTACHMENT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= MAX_ATTACHMENT_BYTES, "ATTACHMENT_TOO_LARGE");
        let attachment = Self {
            id: Uuid::new_v4().to_string(),
            name: path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| anyhow!("INVALID_ATTACHMENT_NAME"))?
                .into(),
            size: bytes.len(),
            data: b64(&bytes),
        };
        attachment.validate()?;
        Ok(attachment)
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let bytes = Zeroizing::new(unb64(&self.data)?);
        std::fs::write(path, &bytes)?;
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
        Attachment {
            id: Uuid::new_v4().to_string(),
            name: "ключ.bin".into(),
            size: 3,
            data: b64([0, 255, 42]),
        }
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
        assert_eq!(unb64(&read.data).unwrap(), [0, 255, 42]);
        assert_eq!(read.name, "ключ.bin");
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
        let big = || Attachment {
            size: MAX_ATTACHMENT_BYTES,
            data: b64(vec![0; MAX_ATTACHMENT_BYTES]),
            ..item()
        };
        assert!(record((0..4).map(|_| big()).collect()).validate().is_ok());
        assert!(record((0..5).map(|_| big()).collect()).validate().is_err());
        let mut old = record(vec![item()]);
        old.schema_version = 1;
        assert!(old.validate().is_err());
        let mut group = record(vec![item()]);
        group.record_type = "group".into();
        assert!(group.validate().is_err());
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
        client.lock();
        client
            .restore_local_backup(&backup, password())
            .await
            .unwrap();
        assert_eq!(
            client.history(id).await.unwrap()[1].data.extra["attachments"][0]["data"],
            file.data
        );
    }
}
