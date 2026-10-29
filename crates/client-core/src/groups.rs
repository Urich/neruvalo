use super::*;

#[derive(Clone, Serialize)]
pub struct GroupView {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub legacy_path: Option<String>,
    pub revision: i64,
}
impl Client {
    pub async fn groups(&mut self) -> Result<Vec<GroupView>> {
        self.objects()
            .await?
            .into_iter()
            .filter(|v| v.data.record_type == "group" && !v.archived)
            .map(|v| {
                v.data.validate()?;
                Ok(GroupView {
                    id: v.record_id,
                    title: v.data.title,
                    parent_id: v
                        .data
                        .extra
                        .get("parent_group_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    legacy_path: v
                        .data
                        .extra
                        .get("legacy_path")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revision: v.revision,
                })
            })
            .collect()
    }
    pub(super) async fn validate_group_link(
        &mut self,
        id: Option<&str>,
        data: &RecordData,
    ) -> Result<()> {
        let a = self.unlocked()?;
        ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
        ensure!(!a.needs_sync, "SYNCHRONIZATION_REQUIRED");
        let key = if data.record_type == "group" {
            "parent_group_id"
        } else {
            "group_id"
        };
        let mut parent = data
            .extra
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned);
        if parent.is_none() {
            return Ok(());
        }
        let groups = self.groups().await?;
        let mut seen = std::collections::BTreeSet::new();
        while let Some(ref current) = parent {
            ensure!(
                Some(current.as_str()) != id
                    && seen.insert(current.clone())
                    && seen.len() <= if data.record_type == "group" { 63 } else { 64 },
                "INVALID_GROUP"
            );
            let group = groups
                .iter()
                .find(|g| &g.id == current)
                .ok_or_else(|| anyhow!("GROUP_NOT_FOUND"))?;
            parent = group.parent_id.clone();
        }
        Ok(())
    }
    // A group is an encrypted metadata object, not a user-visible ninth secret type.
    fn group_data(title: String, parent: Option<String>, legacy: Option<String>) -> RecordData {
        let mut extra = BTreeMap::from([("parent_group_id".into(), json!(parent))]);
        if let Some(path) = legacy {
            extra.insert("legacy_path".into(), json!(path));
        }
        RecordData {
            record_type: "group".into(),
            schema_version: 2,
            title,
            fields: BTreeMap::new(),
            notes: String::new(),
            folder: String::new(),
            tags: vec![],
            extra,
        }
    }
    // Legacy paths remain in their original record versions. Materialize only when
    // attaching something to that branch; derive IDs privately to avoid duplicates
    // if two devices materialize the same path concurrently.
    async fn resolve_group(&mut self, selection: Option<&str>) -> Result<Option<String>> {
        let Some(selection) = selection else {
            return Ok(None);
        };
        let Some(path) = selection.strip_prefix("legacy:") else {
            ensure!(Uuid::parse_str(selection).is_ok(), "INVALID_GROUP");
            ensure!(
                self.groups().await?.iter().any(|g| g.id == selection),
                "GROUP_NOT_FOUND"
            );
            return Ok(Some(selection.to_owned()));
        };
        ensure!(
            !path.is_empty() && path.split('/').count() < 64,
            "INVALID_GROUP"
        );
        let mut parent = None;
        let mut prefix = String::new();
        for (i, part) in path.split('/').enumerate() {
            if i > 0 {
                prefix.push('/');
            }
            prefix.push_str(part);
            if prefix.is_empty() {
                continue;
            }
            let groups = self.groups().await?;
            if let Some(existing) = groups
                .iter()
                .find(|g| g.legacy_path.as_deref() == Some(&prefix))
            {
                parent = Some(existing.id.clone());
                continue;
            }
            let a = self.unlocked()?;
            ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
            let context = [
                b"neruvalo-legacy-group-id-v1\0".as_slice(),
                prefix.as_bytes(),
            ]
            .concat();
            let derived = crypto::derive(a._root.as_ref(), &context)?;
            let mut bytes = [0u8; 16];
            bytes.copy_from_slice(&derived[..16]);
            bytes[6] = (bytes[6] & 0x0f) | 0x80;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            let id = Uuid::from_bytes(bytes).to_string();
            let title = if part.is_empty() {
                prefix.clone()
            } else {
                part.to_owned()
            };
            let data = Self::group_data(title, parent.clone(), Some(prefix.clone()));
            if let Err(e) = self
                .save_object(None, 0, data, false, Some(id.clone()))
                .await
            {
                if e.to_string() != "RECORD_VERSION_MISMATCH" {
                    return Err(e);
                }
                self.sync().await?;
                ensure!(
                    self.groups()
                        .await?
                        .iter()
                        .any(|g| g.id == id && g.legacy_path.as_deref() == Some(&prefix)),
                    "INVALID_GROUP"
                );
            }
            parent = Some(id);
        }
        Ok(parent)
    }
    pub async fn create_group(&mut self, title: String, parent: Option<&str>) -> Result<Value> {
        // Check the name before any lazy materialization creates parent objects.
        Self::group_data(title.clone(), None, None).validate()?;
        let parent = self.resolve_group(parent).await?;
        self.save_object(None, 0, Self::group_data(title, parent, None), false, None)
            .await
    }
    pub async fn save_in_group(
        &mut self,
        id: Option<String>,
        revision: i64,
        mut data: RecordData,
        archived: bool,
        selection: Option<&str>,
    ) -> Result<Value> {
        ensure!(data.record_type != "group", "GROUP_OPERATION_REQUIRED");
        data.validate()?;
        let parent = self.resolve_group(selection).await?;
        data.extra.insert("group_id".into(), json!(parent));
        let mut result = self.save(id, revision, data, archived).await?;
        result["group_id"] = json!(parent);
        Ok(result)
    }
}
