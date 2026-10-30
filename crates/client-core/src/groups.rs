use super::*;

#[derive(Clone, Serialize)]
pub struct GroupView {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub legacy_path: Option<String>,
    pub revision: i64,
    pub archived: bool,
}
impl Client {
    pub async fn groups(&mut self) -> Result<Vec<GroupView>> {
        self.objects()
            .await?
            .into_iter()
            .filter(|v| v.data.record_type == "group")
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
                    archived: v.archived,
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
            ensure!(!group.archived, "GROUP_ARCHIVED");
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

impl Client {
    /// Build the entire operation from the local snapshot. The server checks every
    /// current revision atomically, detecting even a concurrently inserted child.
    pub async fn archive_tree(&mut self, id: &str, archived: bool) -> Result<Value> {
        let objects = self.objects().await?;
        let groups = self.groups().await?;
        let parent_of = |r: &ViewRecord| -> Option<String> {
            let key = if r.data.record_type == "group" {
                "parent_group_id"
            } else {
                "group_id"
            };
            if let Some(v) = r.data.extra.get(key) {
                return v.as_str().map(str::to_owned);
            }
            groups
                .iter()
                .filter(|g| {
                    g.legacy_path.as_ref().is_some_and(|p| {
                        r.data.folder == *p || r.data.folder.starts_with(&format!("{p}/"))
                    })
                })
                .max_by_key(|g| g.legacy_path.as_ref().map_or(0, String::len))
                .map(|g| g.id.clone())
        };
        let legacy = id.strip_prefix("legacy:");
        let target = objects.iter().find(|r| r.record_id == id);
        ensure!(target.is_some() || legacy.is_some(), "RECORD_NOT_FOUND");
        let is_group = legacy.is_some() || target.is_some_and(|r| r.data.record_type == "group");
        let mut selected = std::collections::BTreeSet::new();
        if let Some(target) = target {
            selected.insert(target.record_id.clone());
        }
        if is_group {
            loop {
                let before = selected.len();
                for r in &objects {
                    let path = if r.data.record_type == "group" {
                        r.data
                            .extra
                            .get("legacy_path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                    } else if !r.data.extra.contains_key("group_id") {
                        &r.data.folder
                    } else {
                        ""
                    };
                    let in_legacy = legacy.is_some_and(|prefix| {
                        path == prefix || path.starts_with(&format!("{prefix}/"))
                    });
                    let in_materialized_legacy = groups.iter().any(|g| {
                        selected.contains(&g.id)
                            && g.legacy_path.as_ref().is_some_and(|prefix| {
                                !path.is_empty()
                                    && (path == prefix || path.starts_with(&format!("{prefix}/")))
                            })
                    });
                    if in_legacy
                        || in_materialized_legacy
                        || parent_of(r).is_some_and(|p| selected.contains(&p))
                    {
                        selected.insert(r.record_id.clone());
                    }
                }
                if selected.len() == before {
                    break;
                }
            }
        }
        if !archived {
            for r in &objects {
                if !selected.contains(&r.record_id) {
                    continue;
                }
                let mut parent = parent_of(r);
                let mut seen = std::collections::BTreeSet::new();
                while let Some(p) = parent {
                    ensure!(seen.insert(p.clone()), "INVALID_GROUP");
                    selected.insert(p.clone());
                    parent = groups
                        .iter()
                        .find(|g| g.id == p)
                        .and_then(|g| g.parent_id.clone());
                }
            }
        }
        let http = self.http.clone();
        let a = self.unlocked()?;
        ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
        ensure!(!a.needs_sync, "SYNCHRONIZATION_REQUIRED");
        ensure!(
            sqlx::query("SELECT value FROM meta WHERE name='pending_operation'")
                .fetch_optional(&a.cache)
                .await?
                .is_none(),
            "SAVE_RESULT_UNKNOWN"
        );
        let operation_id = Uuid::new_v4().to_string();
        let mut records = Vec::new();
        for r in &objects {
            if !selected.contains(&r.record_id) || r.archived == archived {
                continue;
            }
            let version_id = Uuid::new_v4().to_string();
            let raw = Zeroizing::new(serde_json::to_vec(&r.data)?);
            let payload = crypto::encrypt_version(
                &a.keys,
                &raw,
                &version_context(
                    &a.profile.server_id,
                    &a.profile.account_id,
                    &r.record_id,
                    &version_id,
                ),
            )?;
            let mut save = SaveRecord {
                operation_id: operation_id.clone(),
                record_id: r.record_id.clone(),
                expected_revision: r.revision,
                version_id,
                previous_version: Some(r.version_id.clone()),
                payload: serde_json::to_value(payload)?,
                signature: String::new(),
                archived,
            };
            sharing::attach(a, &mut save, &r.data).await?;
            save.signature = a.keys.sign(&record_transcript(
                &a.profile.server_id,
                &a.profile.account_id,
                &save,
            ));
            records.push(save);
        }
        if records.is_empty() {
            return Ok(json!({"changed":0}));
        }
        let batch = neruvalo_protocol::SaveBatch {
            operation_id,
            snapshot: objects
                .iter()
                .map(|r| (r.record_id.clone(), r.revision))
                .collect(),
            records,
        };
        set_meta(
            &a.cache,
            "pending_operation",
            &serde_json::to_string(&batch)?,
        )
        .await?;
        let response = http
            .post(format!("{}/api/v1/records/batch", a.profile.server))
            .bearer_auth(a.token.as_str())
            .json(&batch)
            .send()
            .await;
        match response {
            Ok(resp) if resp.status().is_success() => {
                let _: Value = super::response(resp).await?;
            }
            Ok(resp) if resp.status().is_client_error() => {
                sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
                    .execute(&a.cache)
                    .await?;
                a.needs_sync = true;
                let _: Value = super::response(resp).await?;
            }
            _ => {
                a.online = false;
                bail!("SAVE_RESULT_UNKNOWN");
            }
        }
        sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
            .execute(&a.cache)
            .await?;
        self.sync().await?;
        Ok(json!({"changed":batch.records.len()}))
    }
}
