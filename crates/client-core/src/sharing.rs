use super::*;
use neruvalo_protocol::{share_command_transcript, SharedCopy};
async fn cached(a: &Unlocked) -> Result<Value> {
    Ok(
        match sqlx::query("SELECT value FROM meta WHERE name='sharing'")
            .fetch_optional(&a.cache)
            .await?
        {
            Some(r) => serde_json::from_str(&r.get::<String, _>("value"))?,
            None => json!({"incoming":[],"outgoing":[],"revisions":{}}),
        },
    )
}
fn content(data: &RecordData) -> Value {
    json!({"record_type":data.record_type,"schema_version":data.schema_version,"title":data.title,"fields":data.fields,"notes":data.notes})
}
fn make_copy(a: &Unlocked, data: &RecordData, mut c: SharedCopy) -> Result<SharedCopy> {
    let key = Zeroizing::new(crypto::random::<32>());
    c.payload = serde_json::to_value(crypto::seal(
        key.as_ref(),
        &Zeroizing::new(serde_json::to_vec(&content(data))?),
        &c.context(),
    )?)?;
    c.key_box = crypto::seal_shared_key(&c.recipient_share, key.as_ref())?;
    c.signature = a.keys.sign(&c.transcript());
    Ok(c)
}
fn read_copy(a: &Unlocked, c: &SharedCopy) -> Result<RecordData> {
    ensure!(
        c.format_version == 2
            && c.server_id == a.profile.server_id
            && c.recipient_id == a.profile.account_id
            && c.recipient_share == a.keys.public_share(),
        "INVALID_SHARED_COPY"
    );
    crypto::verify(&c.owner_sign, &c.transcript(), &c.signature)?;
    let key = crypto::open_shared_key(&a.keys, &c.key_box)?;
    let raw = crypto::open(
        &key,
        &serde_json::from_value(c.payload.clone())?,
        &c.context(),
    )?;
    let value: Value = serde_json::from_slice(&raw)?;
    let data = RecordData {
        record_type: value["record_type"]
            .as_str()
            .ok_or_else(|| anyhow!("INVALID_SHARED_COPY"))?
            .into(),
        schema_version: serde_json::from_value(value["schema_version"].clone())?,
        title: value["title"].as_str().unwrap_or("").into(),
        fields: serde_json::from_value(value["fields"].clone())?,
        notes: value["notes"].as_str().unwrap_or("").into(),
        folder: String::new(),
        tags: vec![],
        extra: BTreeMap::new(),
    };
    ensure!(data.record_type != "group", "INVALID_SHARED_COPY");
    data.validate()?;
    Ok(data)
}
pub(super) async fn attach(a: &Unlocked, r: &mut SaveRecord, data: &RecordData) -> Result<()> {
    let state = cached(a).await?;
    let revision = state["revisions"][&r.record_id].as_i64().unwrap_or(0);
    let mut updates = Vec::new();
    if !r.archived {
        if let Some(list) = state["outgoing"].as_array() {
            for item in list
                .iter()
                .filter(|s| s["record_id"].as_str() == Some(&r.record_id))
            {
                let mut c: SharedCopy = serde_json::from_value(item["copy"].clone())?;
                c.source_version_id = r.version_id.clone();
                c.source_revision = r.expected_revision + 1;
                c.copy_revision += 1;
                updates.push(make_copy(a, data, c)?);
            }
        }
    }
    r.payload["sharing"] = json!({"revision":revision,"updates":updates});
    Ok(())
}
fn validate_copy_set(state: &Value) -> Result<()> {
    let mut copies = std::collections::BTreeSet::new();
    let mut shares = std::collections::BTreeSet::new();
    for item in state["incoming"]
        .as_array()
        .ok_or_else(|| anyhow!("INVALID_SHARED_SNAPSHOT"))?
    {
        let c: SharedCopy = serde_json::from_value(item["copy"].clone())?;
        ensure!(
            c.copy_revision > 0
                && c.source_revision > 0
                && copies.insert(c.copy_id)
                && shares.insert(c.share_id),
            "INVALID_SHARED_SNAPSHOT"
        );
    }
    Ok(())
}
fn advance_guard(state: &Value, previous: &Value) -> Result<Value> {
    validate_copy_set(state)?;
    let mut next = previous.clone();
    if !next.is_object() {
        next = json!({});
    }
    for value in next.as_object_mut().expect("object").values_mut() {
        value["active"] = json!(false);
    }
    for item in state["incoming"].as_array().expect("validated array") {
        let c: SharedCopy = serde_json::from_value(item["copy"].clone())?;
        let digest = crypto::digest(&crypto::b64(c.transcript()));
        if let Some(old) = previous.get(&c.copy_id) {
            ensure!(old["active"].as_bool() == Some(true), "REVOKED_SHARED_COPY");
            ensure!(
                c.copy_revision >= old["revision"].as_i64().unwrap_or(0),
                "SHARED_COPY_ROLLBACK"
            );
            if c.copy_revision == old["revision"].as_i64().unwrap_or(0) {
                ensure!(
                    old["digest"].as_str() == Some(digest.as_str()),
                    "SHARED_COPY_FORK"
                );
            }
        }
        next[&c.copy_id] = json!({"active":true,"revision":c.copy_revision,"digest":digest});
    }
    Ok(next)
}
pub(super) async fn verify_snapshot(a: &Unlocked, state: &Value) -> Result<Value> {
    validate_copy_set(state)?;
    let old = cached(a).await?;
    let guard: Value = match sqlx::query("SELECT value FROM meta WHERE name='share_guard'")
        .fetch_optional(&a.cache)
        .await?
    {
        Some(row) => serde_json::from_str(&row.get::<String, _>("value"))?,
        None => json!({}),
    };
    let next_guard = advance_guard(state, &guard)?;
    let mut pins: BTreeMap<String, String> =
        match sqlx::query("SELECT value FROM meta WHERE name='share_pins'")
            .fetch_optional(&a.cache)
            .await?
        {
            Some(r) => serde_json::from_str(&r.get::<String, _>("value"))?,
            None => BTreeMap::new(),
        };
    for item in state["incoming"]
        .as_array()
        .ok_or_else(|| anyhow!("INVALID_SHARED_SNAPSHOT"))?
    {
        let c: SharedCopy = serde_json::from_value(item["copy"].clone())?;
        ensure!(
            item["owner_sign"].as_str() == Some(&c.owner_sign),
            "PUBLIC_KEY_MISMATCH"
        );
        if let Some(pin) = pins.get(&c.owner_id) {
            ensure!(pin == &c.owner_sign, "PUBLIC_KEY_MISMATCH");
        }
        pins.insert(c.owner_id.clone(), c.owner_sign.clone());
        read_copy(a, &c)?;
        if let Some(previous) = old["incoming"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["copy"]["copy_id"] == c.copy_id))
        {
            ensure!(
                c.copy_revision >= previous["copy"]["copy_revision"].as_i64().unwrap_or(0),
                "SHARED_COPY_ROLLBACK"
            );
        }
    }
    set_meta(&a.cache, "share_pins", &serde_json::to_string(&pins)?).await?;
    Ok(next_guard)
}
impl Client {
    pub async fn sharing(&mut self) -> Result<Value> {
        let a = self.unlocked()?;
        let state = cached(a).await?;
        let mut incoming = Vec::new();
        if let Some(list) = state["incoming"].as_array() {
            for item in list {
                let c: SharedCopy = serde_json::from_value(item["copy"].clone())?;
                let data = read_copy(a, &c)?;
                incoming.push(json!({"record_id":c.copy_id,"version_id":c.source_version_id,"revision":c.copy_revision,"archived":false,"data":data,"received":true,"owner_login":item["owner_login"],"share_id":c.share_id,"source_record_id":c.record_id,"sharing_revision":item["sharing_revision"],"source_revision":c.source_revision}));
            }
        }
        Ok(json!({"incoming":incoming,"outgoing":state["outgoing"]}))
    }
    pub async fn resolve_recipient(&mut self, login: &str) -> Result<Value> {
        ensure!(
            login.len() <= 40
                && login
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "INVALID_LOGIN"
        );
        let http = self.http.clone();
        let a = self.unlocked()?;
        ensure!(a.online && !a.token.is_empty(), "OFFLINE_READ_ONLY");
        let recipient: Value = response(
            http.get(format!("{}/api/v2/accounts/{}", a.profile.server, login))
                .bearer_auth(a.token.as_str())
                .send()
                .await?,
        )
        .await?;
        ensure!(
            recipient["id"].as_str() != Some(&a.profile.account_id),
            "CANNOT_SHARE_WITH_SELF"
        );
        let mut pins: BTreeMap<String, String> =
            match sqlx::query("SELECT value FROM meta WHERE name='recipient_pins'")
                .fetch_optional(&a.cache)
                .await?
            {
                Some(r) => serde_json::from_str(&r.get::<String, _>("value"))?,
                None => BTreeMap::new(),
            };
        let id = recipient["id"]
            .as_str()
            .ok_or_else(|| anyhow!("INVALID_RECIPIENT"))?;
        let pin = format!(
            "{}:{}",
            recipient["public_sign"].as_str().unwrap_or(""),
            recipient["public_share"].as_str().unwrap_or("")
        );
        if let Some(old) = pins.get(id) {
            ensure!(old == &pin, "PUBLIC_KEY_MISMATCH");
        }
        pins.insert(id.into(), pin);
        set_meta(&a.cache, "recipient_pins", &serde_json::to_string(&pins)?).await?;
        Ok(recipient)
    }
    pub async fn share_change(
        &mut self,
        kind: &str,
        id: &str,
        login_or_share: &str,
    ) -> Result<Value> {
        ensure!(
            ["create", "revoke", "dismiss"].contains(&kind),
            "INVALID_SHARE_OPERATION"
        );
        let recipient = if kind == "create" {
            Some(self.resolve_recipient(login_or_share).await?)
        } else {
            None
        };
        let objects = self.objects().await?;
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
        let state = cached(a).await?;
        let (revision, sharing_revision) = if kind == "dismiss" {
            let incoming = state["incoming"]
                .as_array()
                .and_then(|v| {
                    v.iter().find(|v| {
                        v["copy"]["share_id"] == login_or_share && v["copy"]["record_id"] == id
                    })
                })
                .ok_or_else(|| anyhow!("SHARE_NOT_FOUND"))?;
            (
                incoming["copy"]["source_revision"].as_i64().unwrap_or(0),
                incoming["sharing_revision"].as_i64().unwrap_or(0),
            )
        } else {
            let original = objects
                .iter()
                .find(|o| o.record_id == id)
                .ok_or_else(|| anyhow!("RECORD_NOT_FOUND"))?;
            ensure!(
                !original.archived && original.data.record_type != "group",
                "RECORD_NOT_SHAREABLE"
            );
            (
                original.revision,
                state["revisions"][id].as_i64().unwrap_or(0),
            )
        };
        let mut request = json!({"kind":kind,"operation_id":Uuid::new_v4().to_string(),"record_id":id,"expected_revision":revision,"expected_sharing_revision":sharing_revision,"share_id":login_or_share});
        if let Some(recipient) = recipient {
            let original = objects
                .iter()
                .find(|r| r.record_id == id)
                .ok_or_else(|| anyhow!("RECORD_NOT_FOUND"))?;
            let c = SharedCopy {
                format_version: 2,
                server_id: a.profile.server_id.clone(),
                owner_id: a.profile.account_id.clone(),
                recipient_id: recipient["id"].as_str().unwrap_or("").into(),
                record_id: id.into(),
                source_version_id: original.version_id.clone(),
                source_revision: original.revision,
                share_id: Uuid::new_v4().to_string(),
                copy_id: Uuid::new_v4().to_string(),
                copy_revision: 1,
                owner_sign: a.keys.public_sign(),
                recipient_share: recipient["public_share"].as_str().unwrap_or("").into(),
                payload: Value::Null,
                key_box: String::new(),
                signature: String::new(),
            };
            request["copy"] = serde_json::to_value(make_copy(a, &original.data, c)?)?;
        }
        request["signature"] = json!(a.keys.sign(&share_command_transcript(
            &a.profile.server_id,
            &a.profile.account_id,
            &request
        )));
        set_meta(
            &a.cache,
            "pending_operation",
            &serde_json::to_string(&request)?,
        )
        .await?;
        let resp = http
            .post(format!("{}/api/v2/shares/change", a.profile.server))
            .bearer_auth(a.token.as_str())
            .json(&request)
            .send()
            .await;
        match resp {
            Ok(resp) if resp.status().is_success() => {
                let _: Value = response(resp).await?;
            }
            Ok(resp) if resp.status().is_client_error() => {
                sqlx::query("DELETE FROM meta WHERE name='pending_operation'")
                    .execute(&a.cache)
                    .await?;
                a.needs_sync = true;
                let _: Value = response(resp).await?;
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
        Ok(json!({"changed":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_rejects_duplicate_copies_and_nonpositive_revisions() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/shared-copy-v2.json"
        ))
        .unwrap();
        let item = json!({"copy":vector["copy"]});
        assert!(validate_copy_set(&json!({"incoming":[item.clone()]})).is_ok());
        assert!(validate_copy_set(&json!({"incoming":[item.clone(),item.clone()]})).is_err());
        let mut invalid = item;
        invalid["copy"]["copy_revision"] = json!(0);
        assert!(validate_copy_set(&json!({"incoming":[invalid]})).is_err());
    }
    #[test]
    fn confirmed_removal_cannot_be_replayed_as_a_new_copy() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../docs/test-vectors/shared-copy-v2.json"
        ))
        .unwrap();
        let item = json!({"copy":vector["copy"]});
        let state = json!({"incoming":[item.clone()]});
        let first = advance_guard(&state, &json!({})).unwrap();
        let removed = advance_guard(&json!({"incoming":[]}), &first).unwrap();
        assert!(advance_guard(&state, &removed)
            .unwrap_err()
            .to_string()
            .contains("REVOKED_SHARED_COPY"));
        let mut reissued = item;
        reissued["copy"]["copy_id"] = json!("new-copy-id");
        reissued["copy"]["share_id"] = json!("new-share-id");
        assert!(advance_guard(&json!({"incoming":[reissued]}), &removed).is_ok());
        let mut fork = state.clone();
        fork["incoming"][0]["copy"]["key_box"] = json!("another-container");
        assert!(advance_guard(&fork, &first)
            .unwrap_err()
            .to_string()
            .contains("SHARED_COPY_FORK"));
        let mut older = state;
        older["incoming"][0]["copy"]["copy_revision"] = json!(1);
        assert!(advance_guard(&older, &first).is_err());
    }
}
