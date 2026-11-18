use super::*;
use keepass::{db::GroupRef, Database, DatabaseKey};
use std::io::Read;
mod metadata;
mod references;

const JOURNAL: &str = "keepass_import";
const CONTEXT: &[u8] = b"neruvalo-keepass-import-v1";
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_IMPORT: usize = 24 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub struct KeepassIssue {
    pub code: String,
    pub item: String,
    pub blocking: bool,
    #[serde(default)]
    pub group_path: Vec<String>,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub field: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct KeepassReport {
    pub report_available: bool,
    pub omitted_issues: usize,
    pub ticket: String,
    pub folder: String,
    pub entries: usize,
    pub groups: usize,
    pub attachments: usize,
    pub archived: usize,
    pub history_versions: usize,
    pub issues: Vec<KeepassIssue>,
    pub can_confirm: bool,
    pub dispatched: bool,
    #[serde(default)]
    pub completed: bool,
}
#[derive(Serialize, Deserialize)]
struct Prepared {
    #[serde(skip)]
    report: KeepassReport,
    ticket: String,
    can_confirm: bool,
    dispatched: bool,
    request: ImportVault,
    #[serde(skip)]
    stored: Option<String>,
}
struct Plan {
    report: KeepassReport,
    records: Vec<(String, RecordData, bool)>,
    bytes: usize,
    blocked: bool,
    report_bytes: usize,
}
struct GroupPolicy<'a> {
    tags: &'a [String],
    recycle: Option<Uuid>,
}
struct IssueContext {
    name: String,
    group_path: Vec<String>,
    source_id: String,
}
fn source_path(group: &GroupRef<'_>) -> Vec<String> {
    let mut names = vec![];
    let database = group.database();
    let mut current = Some(group.id());
    while let Some(id) = current {
        let group = database
            .group(id)
            .expect("Parsed groups have valid parents");
        names.push(group.name.clone());
        current = group.parent().map(|g| g.id());
    }
    names.reverse();
    names
}
fn time_fields(times: &keepass::db::Times) -> Vec<&'static str> {
    let mut fields = vec![];
    for (name, present) in [
        ("LastAccessTime", times.last_access.is_some()),
        ("LocationChanged", times.location_changed.is_some()),
        ("UsageCount", times.usage_count.is_some()),
        ("Expires", times.expires.is_some()),
        ("ExpiryTime", times.expires == Some(true)),
    ] {
        if present {
            fields.push(name);
        }
    }
    fields
}
impl Plan {
    fn push(&mut self, id: String, data: RecordData, archived: bool) -> Result<()> {
        self.bytes = self.bytes.saturating_add(serde_json::to_vec(&data)?.len());
        ensure!(
            self.bytes <= 16 * 1024 * 1024 && self.records.len() < 10000,
            "IMPORT_TOO_LARGE"
        );
        self.records.push((id, data, archived));
        Ok(())
    }
    fn issue(
        &mut self,
        context: &IssueContext,
        field: impl Into<String>,
        code: &str,
        blocking: bool,
    ) -> Result<()> {
        self.blocked |= blocking;
        let field = field.into();
        let bytes = context.name.len()
            + context.source_id.len()
            + context.group_path.iter().map(String::len).sum::<usize>()
            + field.len()
            + code.len()
            + 256;
        if self.report.issues.len() >= 1000 || self.report_bytes.saturating_add(bytes) > 256 * 1024
        {
            self.report.omitted_issues += 1;
            if blocking {
                self.report.can_confirm = false;
            }
            return Ok(());
        }
        self.report_bytes += bytes;
        self.report.issues.push(KeepassIssue {
            code: code.into(),
            item: context.name.clone(),
            blocking,
            group_path: context.group_path.clone(),
            source_id: context.source_id.clone(),
            field,
        });
        Ok(())
    }
    fn group(
        &mut self,
        group: GroupRef<'_>,
        parent: &str,
        archived: bool,
        depth: usize,
        policy: GroupPolicy<'_>,
        references: &references::References,
    ) -> Result<()> {
        ensure!(
            depth <= 62 && self.records.len() < 10000,
            "IMPORT_TOO_LARGE"
        );
        let GroupPolicy {
            tags: inherited_tags,
            recycle,
        } = policy;
        let archived = archived || recycle == Some(group.id().uuid());
        let id = Uuid::new_v4().to_string();
        let title = if group.name.trim().is_empty() {
            "KeePass group"
        } else {
            &group.name
        };
        let context = IssueContext {
            name: title.into(),
            group_path: source_path(&group),
            source_id: group.id().to_string(),
        };
        let mut data = Client::group_data(title.into(), Some(parent.into()), None);
        metadata::times(&mut data, &group.times);
        if metadata::icon(&mut data, group.icon(), group.custom_icon()).is_err() {
            self.issue(&context, "Icon", "icon_unsupported", true)?;
        }
        if data.validate().is_err() {
            self.issue(&context, "Name", "record_limit", true)?;
        }
        self.push(id.clone(), data, archived)?;
        self.report.groups += 1;
        for (field, present) in [
            (
                "Notes",
                group.notes.as_deref().is_some_and(|s| !s.is_empty()),
            ),
            ("Tags", !group.tags.is_empty()),
            (
                "DefaultAutoTypeSequence",
                group.default_autotype_sequence.is_some(),
            ),
            ("EnableAutoType", group.enable_autotype.is_some()),
            ("EnableSearching", group.enable_searching.is_some()),
            ("IsExpanded", true),
        ] {
            if present {
                self.issue(&context, field, "group_metadata", false)?;
            }
        }
        for field in group.custom_data.keys() {
            self.issue(
                &context,
                format!("CustomData.{field}"),
                "group_metadata",
                false,
            )?;
        }
        for field in time_fields(&group.times) {
            self.issue(&context, format!("Times.{field}"), "group_metadata", false)?;
        }
        let mut tags = inherited_tags.to_vec();
        for tag in &group.tags {
            if !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }
        for entry in group.entries() {
            ensure!(self.records.len() < 10000, "IMPORT_TOO_LARGE");
            let title = entry
                .get_title()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("KeePass {}", entry.id().uuid()));
            let context = IssueContext {
                name: title.clone(),
                group_path: context.group_path.clone(),
                source_id: entry.id().uuid().to_string(),
            };
            let mut data = RecordData {
                record_type: "login".into(),
                schema_version: 1,
                title: title.clone(),
                fields: BTreeMap::new(),
                notes: entry.get("Notes").unwrap_or("").into(),
                folder: String::new(),
                tags: tags.clone(),
                extra: BTreeMap::from([("group_id".into(), json!(id))]),
            };
            for tag in &entry.tags {
                if !data.tags.contains(tag) {
                    data.tags.push(tag.clone());
                }
            }
            metadata::times(&mut data, &entry.times);
            if metadata::icon(&mut data, entry.icon(), entry.custom_icon()).is_err() {
                self.issue(&context, "Icon", "icon_unsupported", true)?;
            }
            let mut resolved = BTreeMap::new();
            let mut originals = BTreeMap::new();
            let source_id = entry.id().uuid().simple().to_string().to_ascii_uppercase();
            for (key, value) in &entry.fields {
                match references.field(&source_id, key) {
                    Ok(value_resolved) => {
                        if &value_resolved != value.get() {
                            originals.insert(key.clone(), value.get().clone());
                            self.issue(&context, key, "references_resolved", false)?;
                        }
                        resolved.insert(key.clone(), value_resolved);
                    }
                    Err(_) => {
                        self.issue(&context, key, "references_invalid", true)?;
                        resolved.insert(key.clone(), value.get().clone());
                    }
                }
            }
            if !originals.is_empty() {
                data.extra
                    .insert("keepass_references".into(), json!(originals));
            }
            data.title = resolved
                .get("Title")
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .unwrap_or(title.clone());
            data.notes = resolved.get("Notes").cloned().unwrap_or_default();
            for (key, value) in &resolved {
                let target = match key.as_str() {
                    "Title" | "Notes" => continue,
                    "UserName" => "login".into(),
                    "Password" => "password".into(),
                    "URL" => "url".into(),
                    _ => format!("custom:{key}"),
                };
                data.fields.insert(target, value.clone());
            }
            match metadata::totp(&resolved, &data.title) {
                Ok(Some(uri)) => {
                    data.fields.insert("totp".into(), uri);
                    if data
                        .fields
                        .get("password")
                        .is_some_and(|v| v.eq_ignore_ascii_case("{TIMEOTP}"))
                    {
                        data.fields.insert("password".into(), String::new());
                        data.fields
                            .insert("custom:KeePass Password Source".into(), "{TIMEOTP}".into());
                    }
                    self.issue(&context, "TOTP", "totp_converted", false)?;
                }
                Ok(None) => (),
                Err(_) => self.issue(&context, "TOTP", "totp_invalid", true)?,
            }
            for (field, present) in [
                ("AutoType", entry.autotype.is_some()),
                ("OverrideURL", entry.override_url.is_some()),
                ("ForegroundColor", entry.foreground_color.is_some()),
                ("BackgroundColor", entry.background_color.is_some()),
                ("QualityCheck", true),
                ("PreviousParentGroup", entry.previous_parent().is_some()),
            ] {
                if present {
                    self.issue(&context, field, "entry_metadata", false)?;
                }
            }
            for field in entry.custom_data.keys() {
                self.issue(
                    &context,
                    format!("CustomData.{field}"),
                    "entry_metadata",
                    false,
                )?;
            }
            for field in time_fields(&entry.times)
                .into_iter()
                .filter(|f| !["Expires", "ExpiryTime"].contains(f))
            {
                self.issue(&context, format!("Times.{field}"), "entry_metadata", false)?;
            }
            self.report.history_versions +=
                entry.history.as_ref().map_or(0, |h| h.get_entries().len());
            for index in 0..entry.history.as_ref().map_or(0, |h| h.get_entries().len()) {
                let previous = entry
                    .historical(index)
                    .ok_or_else(|| anyhow!("KEEPASS_INVALID_FILE"))?;
                self.issue(
                    &context,
                    format!("History[{}]", index + 1),
                    "history",
                    false,
                )?;
                for field in previous.fields.keys() {
                    self.issue(
                        &context,
                        format!("History[{}].{field}", index + 1),
                        "history",
                        false,
                    )?;
                }
                for (name, _) in previous.attachments_named() {
                    self.issue(
                        &context,
                        format!("History[{}].Attachments.{name}", index + 1),
                        "history",
                        false,
                    )?;
                }
            }
            let mut attachments = Vec::new();
            let mut total = 0usize;
            for (name, file) in entry.attachments_named() {
                let bytes = file.data.get();
                if bytes.len() > MAX_ATTACHMENT_BYTES {
                    self.issue(
                        &context,
                        format!("Attachments.{name}"),
                        "attachment_size",
                        true,
                    )?;
                    continue;
                }
                let attachment = match Attachment::from_bytes(name.into(), bytes) {
                    Ok(file) => file,
                    Err(_) => {
                        self.issue(
                            &context,
                            format!("Attachments.{name}"),
                            "attachment_name",
                            true,
                        )?;
                        continue;
                    }
                };
                total = total.saturating_add(bytes.len());
                let reason = if attachment.validate().is_err() {
                    Some("attachment_name")
                } else if attachments.len() >= MAX_ATTACHMENTS {
                    Some("attachment_count")
                } else if total > MAX_ATTACHMENTS_BYTES {
                    Some("attachment_total")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    self.issue(&context, format!("Attachments.{name}"), reason, true)?;
                    continue;
                }
                attachments.push(attachment);
                self.report.attachments += 1;
            }
            if !attachments.is_empty() {
                data.schema_version = 2;
                data.extra.insert("attachments".into(), json!(attachments));
            }
            if data.validate().is_err() {
                self.issue(
                    &context,
                    if data.title.len() > 1024 {
                        "Title"
                    } else {
                        "Record"
                    },
                    "record_limit",
                    true,
                )?;
            }
            self.report.entries += 1;
            self.report.archived += usize::from(archived);
            self.push(Uuid::new_v4().to_string(), data, archived)?;
        }
        for child in group.groups() {
            self.group(
                child,
                &id,
                archived,
                depth + 1,
                GroupPolicy {
                    tags: &tags,
                    recycle,
                },
                references,
            )?;
        }
        Ok(())
    }
}

fn read_bounded(path: &Path, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
    let file = std::fs::File::open(path)?;
    ensure!(file.metadata()?.is_file(), "KEEPASS_INVALID_FILE");
    let mut bytes = Zeroizing::new(Vec::new());
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "IMPORT_TOO_LARGE");
    Ok(bytes)
}
fn parse(
    path: &Path,
    password: Zeroizing<String>,
    keyfile: Option<&Path>,
    folder: String,
) -> Result<Plan> {
    ensure!(
        !folder.trim().is_empty() && folder.len() <= 1024,
        "KEEPASS_FOLDER_REQUIRED"
    );
    let bytes = read_bounded(path, MAX_FILE)?;
    let version = Database::get_version(&mut bytes.as_slice())
        .map_err(|_| anyhow!("KEEPASS_INVALID_FILE"))?;
    ensure!(
        matches!(
            version,
            keepass::config::DatabaseVersion::KDB3(1)
                | keepass::config::DatabaseVersion::KDB4(0..=1)
        ),
        "KEEPASS_UNSUPPORTED_VERSION"
    );
    let mut key = DatabaseKey::new();
    if !password.is_empty() {
        key = key.with_password(&password);
    }
    if let Some(path) = keyfile {
        let keybytes = read_bounded(path, 1024 * 1024)?;
        key = key
            .with_keyfile(&mut keybytes.as_slice())
            .map_err(|_| anyhow!("KEEPASS_INVALID_KEYFILE"))?;
    }
    ensure!(!key.is_empty(), "KEEPASS_KEY_REQUIRED");
    let db = Database::parse(&bytes, key).map_err(|e| {
        if e.to_string().contains("KEEPASS_RESOURCE_LIMIT") {
            anyhow!("KEEPASS_RESOURCE_LIMIT")
        } else {
            anyhow!("KEEPASS_OPEN_FAILED")
        }
    })?;
    let root_id = Uuid::new_v4().to_string();
    let mut plan = Plan {
        bytes: 0,
        blocked: false,
        report_bytes: 0,
        report: KeepassReport {
            report_available: true,
            ticket: Uuid::new_v4().to_string(),
            folder: folder.trim().into(),
            groups: 1,
            ..Default::default()
        },
        records: vec![(
            root_id.clone(),
            Client::group_data(folder.trim().into(), None, None),
            false,
        )],
    };
    let recycle = if db.meta.recyclebin_enabled == Some(false) {
        None
    } else {
        db.meta.recyclebin_uuid
    };
    let references = references::References::new(&db);
    plan.group(
        db.root(),
        &root_id,
        false,
        1,
        GroupPolicy { tags: &[], recycle },
        &references,
    )?;
    plan.report.issues.sort_by(|a, b| {
        (&a.group_path, &a.source_id, &a.field, &a.code).cmp(&(
            &b.group_path,
            &b.source_id,
            &b.field,
            &b.code,
        ))
    });
    ensure!(
        serde_json::to_vec(&plan.report)?.len() <= 8 * 1024 * 1024,
        "IMPORT_TOO_LARGE"
    );
    plan.report.can_confirm = !plan.blocked
        && !plan.report.issues.iter().any(|i| i.blocking)
        && !plan
            .records
            .iter()
            .any(|(_, data, _)| data.validate().is_err());
    Ok(plan)
}

async fn load(a: &Unlocked) -> Result<Option<Prepared>> {
    let row = integrity::get_meta(a, JOURNAL).await?;
    row.map(|r| -> Result<_> {
        let envelope: Envelope = serde_json::from_str(&r)?;
        let mut prepared: Prepared =
            serde_json::from_slice(&crypto::open(a._root.as_ref(), &envelope, CONTEXT)?)?;
        prepared.report = a
            .reports
            .lock()
            .expect("report memory")
            .get(&prepared.ticket)
            .cloned()
            .unwrap_or_else(|| KeepassReport {
                ticket: prepared.ticket.clone(),
                can_confirm: prepared.can_confirm,
                dispatched: prepared.dispatched,
                ..Default::default()
            });
        prepared.report.dispatched = prepared.dispatched;
        prepared.stored = Some(r);
        Ok(prepared)
    })
    .transpose()
}
async fn store(a: &Unlocked, prepared: &mut Prepared) -> Result<()> {
    prepared.ticket = prepared.report.ticket.clone();
    prepared.can_confirm = prepared.report.can_confirm;
    prepared.dispatched = prepared.report.dispatched;
    let envelope = crypto::seal(
        a._root.as_ref(),
        &Zeroizing::new(serde_json::to_vec(prepared)?),
        CONTEXT,
    )?;
    let encoded = serde_json::to_string(&envelope)?;
    let mut tx = a.cache.begin().await?;
    sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
        .execute(&mut *tx)
        .await?;
    let previous = integrity::verify_cached(&mut tx, a).await?;
    let changed = if let Some(stored) = &prepared.stored {
        sqlx::query("UPDATE meta SET value=$1 WHERE name=$2 AND value=$3")
            .bind(&encoded)
            .bind(JOURNAL)
            .bind(stored)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    } else {
        sqlx::query("INSERT INTO meta(name,value) VALUES($1,$2) ON CONFLICT(name) DO NOTHING")
            .bind(JOURNAL)
            .bind(&encoded)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    };
    ensure!(changed == 1, "KEEPASS_IMPORT_PENDING");
    integrity::refresh(&mut tx, a, &previous).await?;
    tx.commit().await?;
    integrity::checkpoint(a).await?;
    if prepared.report.report_available {
        let mut reports = a.reports.lock().expect("report memory");
        reports.clear();
        reports.insert(prepared.ticket.clone(), prepared.report.clone());
    }
    prepared.stored = Some(encoded);
    Ok(())
}
fn writable_vault(a: &Unlocked) -> Result<()> {
    ensure!(
        a.profile.kind == ProfileKind::Local || (a.online && !a.token.is_empty()),
        "ONLINE_LOGIN_REQUIRED"
    );
    ensure!(!a.needs_sync, "SYNCHRONIZATION_REQUIRED");
    Ok(())
}
// The journal and imported versions change atomically; reports stay in memory. A failed
// transaction can be retried with the same ticket without partial imports.
async fn commit_local_import(a: &Unlocked, mut prepared: Prepared) -> Result<Value> {
    prepared.report.completed = true;
    prepared.report.dispatched = false;
    let mut tx = a.cache.begin().await?;
    sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
        .execute(&mut *tx)
        .await?;
    let previous = integrity::verify_cached(&mut tx, a).await?;
    integrity::check_anchor(a, "cache", &previous, &integrity::links(&mut tx).await?)?;
    let removed = sqlx::query("DELETE FROM meta WHERE name=$1 AND value=$2")
        .bind(JOURNAL)
        .bind(&prepared.stored)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    ensure!(removed == 1, "KEEPASS_IMPORT_MISSING");
    for version in &prepared.request.versions {
        ensure!(
            version.revision == 1 && version.previous_version.is_none(),
            "INVALID_REVISION"
        );
        verify_version(&a.profile, version)?;
        view(a, version)?.data.validate()?;
        sqlx::query("INSERT INTO versions(id,record_id,revision,body) VALUES($1,$2,$3,$4)")
            .bind(&version.version_id)
            .bind(&version.record_id)
            .bind(version.revision)
            .bind(serde_json::to_string(version)?)
            .execute(&mut *tx)
            .await?;
    }
    integrity::refresh(&mut tx, a, &previous).await?;
    tx.commit().await?;
    integrity::checkpoint(a).await?;
    remember_report(a, prepared.report);
    Ok(json!({"imported": prepared.request.versions.len()}))
}
impl Client {
    pub async fn keepass_last_report(&mut self) -> Result<Option<KeepassReport>> {
        let a = self.unlocked()?;
        let ticket = a.last_report.lock().expect("report memory").clone();
        Ok(ticket.and_then(|ticket| {
            a.reports
                .lock()
                .expect("report memory")
                .get(&ticket)
                .cloned()
        }))
    }
    pub fn forget_keepass_report(&mut self, ticket: &str) -> Result<()> {
        let a = self.unlocked()?;
        a.reports.lock().expect("report memory").remove(ticket);
        *a.last_report.lock().expect("report memory") = None;
        Ok(())
    }
    pub async fn keepass_report_html(
        &mut self,
        ticket: &str,
        labels: &BTreeMap<String, String>,
    ) -> Result<String> {
        let report = if let Some(prepared) = load(self.unlocked()?)
            .await?
            .filter(|p| p.report.ticket == ticket)
        {
            prepared.report
        } else {
            self.keepass_last_report()
                .await?
                .filter(|r| r.ticket == ticket)
                .ok_or_else(|| anyhow!("KEEPASS_IMPORT_MISSING"))?
        };
        ensure!(report.report_available, "KEEPASS_REPORT_UNAVAILABLE");
        Ok(render_report(&report, labels))
    }
    pub async fn keepass_import_status(&mut self) -> Result<Option<KeepassReport>> {
        Ok(load(self.unlocked()?).await?.map(|p| p.report))
    }
    pub async fn prepare_keepass_import(
        &mut self,
        path: PathBuf,
        password: Zeroizing<String>,
        keyfile: Option<PathBuf>,
        folder: String,
    ) -> Result<KeepassReport> {
        let a = self.unlocked()?;
        writable_vault(a)?;
        ensure!(load(a).await?.is_none(), "KEEPASS_IMPORT_PENDING");
        if a.profile.kind != ProfileKind::Local {
            self.sync().await?;
        }
        let a = self.unlocked()?;
        let profile = a.profile.id.clone();
        let plan =
            tokio::task::spawn_blocking(move || parse(&path, password, keyfile.as_deref(), folder))
                .await??;
        let a = self.unlocked()?;
        writable_vault(a)?;
        // Parsing runs outside this task; recheck the destination before staging writes.
        ensure!(a.profile.id == profile, "KEEPASS_PROFILE_CHANGED");
        let mut request = ImportVault {
            manifest: None,
            operation_id: Uuid::new_v4().to_string(),
            versions: vec![],
        };
        for (record_id, data, archived) in plan.records {
            let version_id = Uuid::new_v4().to_string();
            let payload = attachments::encrypt_record(
                &a.keys,
                &data,
                &version_context(
                    &a.profile.server_id,
                    &a.profile.account_id,
                    &record_id,
                    &version_id,
                ),
            )?;
            let mut save = SaveRecord {
                signature_version: SIGNATURE_VERSION,
                created_at: signed_time(),
                manifest: None,
                operation_id: Uuid::new_v4().to_string(),
                record_id,
                version_id,
                expected_revision: 0,
                previous_version: None,
                payload,
                signature: String::new(),
                archived,
            };
            save.signature = a.keys.sign(&record_transcript(
                &a.profile.server_id,
                &a.profile.account_id,
                &save,
            ));
            request.versions.push(StoredVersion {
                signature_version: SIGNATURE_VERSION,
                operation_id: save.operation_id,
                record_id: save.record_id,
                version_id: save.version_id,
                revision: 1,
                previous_version: None,
                payload: save.payload,
                signature: save.signature,
                archived,
                created_at: save.created_at,
            });
        }
        ensure!(
            serde_json::to_vec(&request)?.len() <= MAX_IMPORT,
            "IMPORT_TOO_LARGE"
        );
        // Leave room in the current full snapshot for the entire atomic import.
        let current = sqlx::query("SELECT COALESCE(SUM(length(body)),0) AS bytes FROM versions")
            .fetch_one(&a.cache)
            .await?
            .try_get::<i64, _>("bytes")?;
        let current = usize::try_from(current).map_err(|_| anyhow!("IMPORT_TOO_LARGE"))?;
        let sharing = sqlx::query("SELECT value FROM meta WHERE name='sharing'")
            .fetch_optional(&a.cache)
            .await?
            .map_or(0, |r| r.get::<String, _>("value").len());
        ensure!(
            current + sharing + serde_json::to_vec(&request)?.len() <= MAX_IMPORT,
            "IMPORT_TOO_LARGE"
        );
        let mut prepared = Prepared {
            ticket: plan.report.ticket.clone(),
            can_confirm: plan.report.can_confirm,
            dispatched: false,
            report: plan.report,
            request,
            stored: None,
        };
        store(a, &mut prepared).await?;
        Ok(prepared.report)
    }
    pub async fn cancel_keepass_import(&mut self, ticket: &str) -> Result<()> {
        let a = self.unlocked()?;
        let prepared = load(a)
            .await?
            .ok_or_else(|| anyhow!("KEEPASS_IMPORT_MISSING"))?;
        ensure!(prepared.report.ticket == ticket, "KEEPASS_IMPORT_MISSING");
        ensure!(!prepared.report.dispatched, "KEEPASS_IMPORT_UNCERTAIN");
        let mut tx = a.cache.begin().await?;
        sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
            .execute(&mut *tx)
            .await?;
        let previous = integrity::verify_cached(&mut tx, a).await?;
        let changed = sqlx::query("DELETE FROM meta WHERE name=$1 AND value=$2")
            .bind(JOURNAL)
            .bind(&prepared.stored)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        ensure!(changed == 1, "KEEPASS_IMPORT_PENDING");
        integrity::refresh(&mut tx, a, &previous).await?;
        tx.commit().await?;
        integrity::checkpoint(a).await?;
        a.reports.lock().expect("report memory").remove(ticket);
        Ok(())
    }
    pub async fn commit_keepass_import(&mut self, ticket: &str) -> Result<Value> {
        let http = self.http.clone();
        let a = self.unlocked()?;
        writable_vault(a)?;
        let mut prepared = load(a)
            .await?
            .ok_or_else(|| anyhow!("KEEPASS_IMPORT_MISSING"))?;
        ensure!(
            prepared.report.ticket == ticket && prepared.report.can_confirm,
            "KEEPASS_IMPORT_BLOCKED"
        );
        if a.profile.kind == ProfileKind::Local {
            return commit_local_import(a, prepared).await;
        }
        if prepared.request.manifest.is_none() {
            let mut request = serde_json::to_value(&prepared.request)?;
            integrity::attach_request(a, &mut request).await?;
            prepared.request = serde_json::from_value(request)?;
        }
        prepared.report.dispatched = true;
        store(a, &mut prepared).await?;
        let result = http
            .post(format!("{}/api/v1/vault/import", a.profile.server))
            .bearer_auth(a.token.as_str())
            .json(&prepared.request)
            .send()
            .await;
        let result = result.map_err(|_| anyhow!("KEEPASS_IMPORT_UNCERTAIN"))?;
        if result.status().is_client_error() {
            prepared.report.dispatched = false;
            prepared.request.manifest = None;
            store(a, &mut prepared).await?;
        }
        let result: Value = response(result).await?;
        self.sync().await?;
        let a = self.unlocked()?;
        for expected in &prepared.request.versions {
            let row = sqlx::query("SELECT body FROM versions WHERE id=$1")
                .bind(&expected.version_id)
                .fetch_one(&a.cache)
                .await?;
            let actual: StoredVersion = serde_json::from_str(&row.get::<String, _>("body"))?;
            ensure!(
                canonical_json(&serde_json::to_value(&actual)?)
                    == canonical_json(&serde_json::to_value(expected)?),
                "IMPORT_VERIFICATION_FAILED"
            );
            view(a, &actual)?.data.validate()?;
        }
        prepared.report.completed = true;
        let mut tx = a.cache.begin().await?;
        sqlx::query("UPDATE meta SET value=value WHERE name='schema_version'")
            .execute(&mut *tx)
            .await?;
        let previous = integrity::verify_cached(&mut tx, a).await?;
        sqlx::query("DELETE FROM meta WHERE name=$1 AND value=$2")
            .bind(JOURNAL)
            .bind(&prepared.stored)
            .execute(&mut *tx)
            .await?;
        integrity::refresh(&mut tx, a, &previous).await?;
        tx.commit().await?;
        integrity::checkpoint(a).await?;
        prepared.report.dispatched = false;
        remember_report(a, prepared.report);
        Ok(result)
    }
}

fn remember_report(a: &Unlocked, report: KeepassReport) {
    if report.report_available {
        *a.last_report.lock().expect("report memory") = Some(report.ticket.clone());
        let mut reports = a.reports.lock().expect("report memory");
        reports.clear();
        reports.insert(report.ticket.clone(), report);
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn render_report(report: &KeepassReport, labels: &BTreeMap<String, String>) -> String {
    let label = |key: &str| escape_html(labels.get(key).map(String::as_str).unwrap_or(key));
    let status = if report.completed {
        "reportCompleted"
    } else if !report.can_confirm {
        "reportBlocked"
    } else if report.dispatched {
        "keepassUncertain"
    } else {
        "reportPreview"
    };
    let mut html = format!("<!doctype html><html lang=\"{}\" dir=\"{}\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font:16px/1.5 system-ui,sans-serif;color:#18202b;background:#fff;margin:32px}}h1{{font-size:26px}}p{{max-width:1000px}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{padding:10px;border:1px solid #ccd3dc;text-align:start;vertical-align:top;overflow-wrap:anywhere}}th{{background:#eef2f7}}tbody tr:nth-child(even){{background:#f7f9fc}}.table-wrap{{overflow:auto}}code{{font-size:12px}}@media print{{body{{margin:0}}thead{{display:table-header-group}}tr{{break-inside:avoid}}}}</style></head><body><h1>{}</h1><p><strong>{}</strong></p><p>{}: {}</p><p>{}: {} · {}: {} · {}: {} · {}: {} · {}: {}</p><p>{}</p><div class=\"table-wrap\"><table><thead><tr>",
        label("language"), if labels.get("language").is_some_and(|s| s == "ar") { "rtl" } else { "ltr" },
        label("reportTitle"), label("reportTitle"), label(status), label("keepassFolder"), escape_html(&report.folder),
        label("keepassEntries"), report.entries, label("keepassGroups"), report.groups, label("attachments"), report.attachments,
        label("keepassArchived"), report.archived, label("keepassHistory"), report.history_versions, label("reportPrivacy"));
    for key in [
        "reportGroup",
        "reportEntry",
        "reportSourceId",
        "reportField",
        "reportResult",
        "reportReason",
    ] {
        html.push_str(&format!("<th scope=\"col\">{}</th>", label(key)));
    }
    html.push_str("</tr></thead><tbody>");
    for issue in &report.issues {
        let action = if issue.blocking {
            "reportRejected"
        } else if ["references_resolved", "totp_converted"].contains(&issue.code.as_str()) {
            "reportConverted"
        } else if issue.code == "references" {
            "reportAsText"
        } else {
            "reportExcluded"
        };
        html.push_str(&format!("<tr><td>{}</td><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td></tr>",
            escape_html(&issue.group_path.join(" › ")), escape_html(&issue.item), escape_html(&issue.source_id),
            escape_html(&issue.field), label(action), label(&format!("keepassIssue.{}", issue.code))));
    }
    if report.issues.is_empty() {
        html.push_str(&format!(
            "<tr><td colspan=\"6\">{}</td></tr>",
            label("reportNoIssues")
        ));
    }
    html.push_str("</tbody></table></div></body></html>");
    html
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/keepass")
            .join(name)
    }
    fn password() -> Zeroizing<String> {
        Zeroizing::new("demopass".into())
    }
    fn test_db(path: &Path, oversized: bool) {
        let mut db = Database::new();
        db.config.kdf_config = keepass::config::KdfConfig::Aes { rounds: 10 };
        db.root_mut().name = "Source".into();
        db.root_mut().tags.push("inherited".into());
        let mut group = db.root_mut().add_group().id();
        db.group_mut(group).unwrap().name = "Nested / folder".into();
        {
            let mut g = db.group_mut(group).unwrap();
            let mut entry = g.add_entry();
            entry.set_unprotected("Title", "Service");
            entry.set_unprotected("UserName", "alice");
            entry.set_protected("Password", "test-secret");
            entry.set_unprotected("URL", "https://example.test");
            entry.set_unprotected("Notes", "Note");
            entry.set_protected("Extra", "custom-secret");
            entry.tags.push("own".into());
            entry.add_attachment(
                "test.bin",
                keepass::db::Value::protected(if oversized {
                    vec![42; MAX_ATTACHMENT_BYTES + 1]
                } else {
                    vec![0, 255, 42]
                }),
            );
            let old = (*entry).clone();
            entry.history.as_mut().unwrap().add_entry(old);
        }
        group = db.root_mut().add_group().id();
        db.group_mut(group).unwrap().name = "Bin".into();
        db.meta.recyclebin_uuid = Some(group.uuid());
        db.meta.recyclebin_enabled = Some(true);
        db.group_mut(group)
            .unwrap()
            .add_entry()
            .set_unprotected("Title", "Archived");
        db.save(
            &mut std::fs::File::create(path).unwrap(),
            DatabaseKey::new().with_password("demopass"),
        )
        .unwrap();
    }
    #[test]
    fn reads_real_kdbx_versions_and_keys() {
        for name in [
            "test_db_kdbx3_with_attachments.kdbx",
            "test_db_kdbx4_with_password_aes.kdbx",
            "test_db_kdbx41_with_password_aes.kdbx",
        ] {
            let plan = parse(&fixture(name), password(), None, "Imported".into()).unwrap();
            assert!(plan.report.entries > 0, "{name}");
            if name.contains("attachments") {
                assert!(plan.report.attachments > 0);
            }
        }
        let key = fixture("test_db_kdbx4_with_keyfile_v2.keyx");
        let db = fixture("test_db_kdbx4_with_keyfile_v2.kdbx");
        assert!(parse(&db, password(), Some(&key), "Import".into()).is_ok());
        assert!(parse(&db, password(), None, "Import".into()).is_err());
        let key = fixture("test_key.key");
        assert!(parse(
            &fixture("test_db_kdbx4_with_keyfile.kdbx"),
            Zeroizing::new(String::new()),
            Some(&key),
            "Import".into()
        )
        .is_ok());
    }
    #[test]
    fn mapping_preserves_structure_fields_tags_trash_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test.kdbx");
        test_db(&file, false);
        let plan = parse(&file, password(), None, "Imported".into()).unwrap();
        assert!(plan.report.can_confirm);
        assert_eq!(plan.report.entries, 2);
        assert_eq!(plan.report.groups, 4);
        assert_eq!(plan.report.archived, 1);
        assert_eq!(plan.report.history_versions, 1);
        assert_eq!(plan.report.attachments, 1);
        let (_, data, archived) = plan
            .records
            .iter()
            .find(|(_, d, _)| d.title == "Service")
            .unwrap();
        assert!(!archived);
        assert_eq!(data.fields["login"], "alice");
        assert_eq!(data.fields["password"], "test-secret");
        assert_eq!(data.notes, "Note");
        assert_eq!(data.fields["custom:Extra"], "custom-secret");
        assert_eq!(data.tags, ["inherited", "own"]);
        let imported_file: Attachment =
            serde_json::from_value(data.extra["attachments"][0].clone()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("file.bin");
        imported_file.save_to(&output).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), [0, 255, 42]);
        let parent = data.extra["group_id"].as_str().unwrap();
        assert!(plan
            .records
            .iter()
            .any(|(id, d, _)| id == parent && d.title == "Nested / folder"));
        assert!(plan
            .records
            .iter()
            .any(|(_, d, archived)| d.title == "Archived" && *archived));
        assert!(parse(&file, Zeroizing::new("wrong".into()), None, "Import".into()).is_err());
        test_db(&file, true);
        let plan = parse(&file, password(), None, "Import".into()).unwrap();
        assert!(!plan.report.can_confirm);
        assert!(plan
            .report
            .issues
            .iter()
            .any(|i| i.code == "attachment_size" && i.blocking));
    }
    #[test]
    fn imports_icons_times_expiration_references_and_totp_from_kdbx() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("metadata.kdbx");
        let mut db = Database::new();
        db.config.kdf_config = keepass::config::KdfConfig::Aes { rounds: 10 };
        db.root_mut().set_icon_builtin(48);
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=").unwrap();
        let source = db.root_mut().add_entry().id();
        {
            let mut entry = db.entry_mut(source).unwrap();
            entry.set_unprotected("Title", "Source");
            entry.set_protected("Password", "source-password");
            entry.times.creation = Some("2020-01-02T03:04:05".parse().unwrap());
            entry.times.last_modification = Some("2022-02-03T04:05:06".parse().unwrap());
            entry.times.expiry = "2030-03-04T05:06:07".parse().unwrap();
            entry.times.expires = Some(true);
            entry.set_icon_custom_new(png.clone());
            entry.set_protected("TimeOtp-Secret-Base32", "JBSWY3DPEHPK3PXP");
            entry.set_unprotected("TimeOtp-Period", "60");
            entry.set_unprotected("TimeOtp-Length", "8");
            entry.set_unprotected("TimeOtp-Algorithm", "HMAC-SHA-256");
        }
        let linked = db.root_mut().add_entry().id();
        {
            let mut entry = db.entry_mut(linked).unwrap();
            entry.set_unprotected("Title", "Linked");
            entry.set_protected(
                "Password",
                format!("{{REF:P@I:{}}}", source.uuid().simple()),
            );
            entry.set_unprotected("UserName", "{S:Email}");
            entry.set_unprotected("Email", "name@example.test");
            entry.set_icon_builtin(1);
            entry.times.expires = Some(false);
        }
        db.save(
            &mut std::fs::File::create(&file).unwrap(),
            DatabaseKey::new().with_password("demopass"),
        )
        .unwrap();
        let plan = parse(&file, password(), None, "Imported".into()).unwrap();
        assert!(plan.report.can_confirm);
        assert!(plan.records.iter().any(|(_, d, _)| d.record_type == "group"
            && d.extra.get("keepass_icon_id") == Some(&json!(48))));
        let source_record = &plan
            .records
            .iter()
            .find(|(_, d, _)| d.title == "Source")
            .unwrap()
            .1;
        assert_eq!(source_record.extra["created_at"], 1577934245i64);
        assert_eq!(source_record.extra["modified_at"], 1643861106i64);
        assert_eq!(source_record.fields["expires"], "2030-03-04T05:06:07+00:00");
        assert_eq!(source_record.fields["never_expires"], "false");
        assert_eq!(
            source_record.extra["icon"],
            format!("data:image/png;base64,{}", STANDARD.encode(&png))
        );
        assert!(source_record.fields["totp"].contains("period=60"));
        assert!(source_record.fields["totp"].contains("algorithm=SHA256"));
        let linked_record = &plan
            .records
            .iter()
            .find(|(_, d, _)| d.title == "Linked")
            .unwrap()
            .1;
        assert_eq!(linked_record.fields["password"], "source-password");
        assert_eq!(linked_record.fields["login"], "name@example.test");
        assert_eq!(linked_record.fields["never_expires"], "true");
        assert_eq!(linked_record.extra["keepass_icon_id"], 1);
        assert!(linked_record.extra["keepass_references"]["Password"]
            .as_str()
            .unwrap()
            .starts_with("{REF:"));
        assert!(!serde_json::to_string(&plan.report)
            .unwrap()
            .contains("source-password"));
        assert!(plan
            .report
            .issues
            .iter()
            .any(|i| i.code == "references_resolved"));
        {
            let mut entry = db.entry_mut(linked).unwrap();
            entry.set_protected("Password", "{REF:P@T:Missing}");
        }
        db.save(
            &mut std::fs::File::create(&file).unwrap(),
            DatabaseKey::new().with_password("demopass"),
        )
        .unwrap();
        let plan = parse(&file, password(), None, "Imported".into()).unwrap();
        assert!(!plan.report.can_confirm);
        assert!(plan
            .report
            .issues
            .iter()
            .any(|i| i.code == "references_invalid" && i.blocking));
    }

    #[test]
    fn rejects_corruption_truncation_and_hostile_kdf_before_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.kdbx");
        let mut bytes = std::fs::read(fixture("test_db_kdbx3_with_attachments.kdbx")).unwrap();
        // KDBX3 outer header: byte field ID, LE u16 length, field data.
        let mut pos = 12;
        loop {
            let id = bytes[pos];
            let len = u16::from_le_bytes([bytes[pos + 1], bytes[pos + 2]]) as usize;
            pos += 3;
            if id == 6 {
                bytes[pos..pos + 8].copy_from_slice(&u64::MAX.to_le_bytes());
                break;
            }
            assert_ne!(id, 0);
            pos += len;
        }
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            parse(&path, password(), None, "Import".into())
                .err()
                .unwrap()
                .to_string(),
            "KEEPASS_RESOURCE_LIMIT"
        );
        for bytes in [&b"invalid"[..], &bytes[..12], &bytes[..100]] {
            std::fs::write(&path, bytes).unwrap();
            assert!(parse(&path, password(), None, "Import".into()).is_err());
        }
        let file = std::fs::File::create(&path).unwrap();
        file.set_len((MAX_FILE + 1) as u64).unwrap();
        assert!(parse(&path, password(), None, "Import".into()).is_err());
    }

    #[test]
    fn rejects_deep_xml_before_recursive_deserialization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep.kdbx");
        let mut db = Database::new();
        db.config.kdf_config = keepass::config::KdfConfig::Aes { rounds: 10 };
        let mut parent = db.root().id();
        for _ in 0..140 {
            parent = db.group_mut(parent).unwrap().add_group().id();
        }
        db.save(
            &mut std::fs::File::create(&path).unwrap(),
            DatabaseKey::new().with_password("demopass"),
        )
        .unwrap();
        assert_eq!(
            parse(&path, password(), None, "Import".into())
                .err()
                .unwrap()
                .to_string(),
            "KEEPASS_RESOURCE_LIMIT"
        );
    }

    #[test]
    fn html_report_names_specific_fields_and_escapes_untrusted_content() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.kdbx");
        test_db(&file, false);
        let mut report = parse(&file, password(), None, "Imported".into())
            .unwrap()
            .report;
        let historical = report
            .issues
            .iter()
            .find(|i| i.field == "History[1].Password")
            .unwrap();
        assert_eq!(historical.item, "Service");
        assert_eq!(historical.group_path, ["Source", "Nested / folder"]);
        assert!(Uuid::parse_str(&historical.source_id).is_ok());
        assert!(report
            .issues
            .iter()
            .any(|i| i.field == "History[1].Attachments.test.bin"));
        let mut malicious = historical.clone();
        malicious.item = "<script>alert(1)</script>".into();
        malicious.field = "<img src=x onerror=alert(2)>".into();
        report.issues.push(malicious);
        let labels = BTreeMap::from([
            ("language".into(), "ru".into()),
            ("reportTitle".into(), "Отчёт <KeePass>".into()),
        ]);
        let html = render_report(&report, &labels);
        assert!(html.contains("<table>"));
        assert!(html.contains("History[1].Password"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
        assert!(!html.contains("<img "));
        assert!(!html.contains("test-secret"));
        assert!(!html.contains("custom-secret"));
        assert!(html.contains("default-src 'none'"));
    }

    #[tokio::test]
    async fn local_import_is_atomic_and_resumes_after_unlock_without_a_server() {
        let dir = tempfile::tempdir().unwrap();
        let client_dir = dir.path().join("client");
        let file = dir.path().join("local-source.kdbx");
        test_db(&file, false);
        let vault_password = || Zeroizing::new("local import vault password".into());
        let mut c = Client::new(client_dir.clone()).unwrap();
        let profile = c
            .create_local("Local import", vault_password())
            .await
            .unwrap();
        let profile = profile["profile"].as_str().unwrap().to_owned();
        c.settings(900).await.unwrap();
        c.create_group("Existing".into(), None).await.unwrap();
        let cancelled = c
            .prepare_keepass_import(file.clone(), password(), None, "Cancelled".into())
            .await
            .unwrap();
        assert!(c.list().await.unwrap().is_empty());
        c.cancel_keepass_import(&cancelled.ticket).await.unwrap();
        test_db(&file, true);
        let blocked = c
            .prepare_keepass_import(file.clone(), password(), None, "Blocked".into())
            .await
            .unwrap();
        assert!(!blocked.can_confirm);
        assert!(c.commit_keepass_import(&blocked.ticket).await.is_err());
        c.cancel_keepass_import(&blocked.ticket).await.unwrap();
        test_db(&file, false);
        let preview = c
            .prepare_keepass_import(file, password(), None, "Imported".into())
            .await
            .unwrap();
        c.lock();
        drop(c);
        let mut c = Client::new(client_dir).unwrap();
        c.unlock_offline(&profile, vault_password()).await.unwrap();
        assert_eq!(
            c.keepass_import_status().await.unwrap().unwrap().ticket,
            preview.ticket
        );
        assert!(c.commit_keepass_import("wrong-ticket").await.is_err());
        // A duplicate version forces a failure after the first insert. Both the
        // earlier insert and journal removal must roll back with the transaction.
        let a = c.unlocked().unwrap();
        let mut prepared = load(a).await.unwrap().unwrap();
        prepared
            .request
            .versions
            .push(prepared.request.versions[0].clone());
        store(a, &mut prepared).await.unwrap();
        assert!(c.commit_keepass_import(&preview.ticket).await.is_err());
        assert!(c.list().await.unwrap().is_empty());
        assert_eq!(c.groups().await.unwrap().len(), 1);
        assert!(c.keepass_last_report().await.unwrap().is_none());
        let a = c.unlocked().unwrap();
        let mut prepared = load(a).await.unwrap().unwrap();
        prepared.request.versions.pop();
        store(a, &mut prepared).await.unwrap();
        c.commit_keepass_import(&preview.ticket).await.unwrap();
        assert!(c.keepass_import_status().await.unwrap().is_none());
        assert!(c.keepass_last_report().await.unwrap().is_none());
        let entries = c.list().await.unwrap();
        assert_eq!(entries.len(), preview.entries);
        assert_eq!(c.groups().await.unwrap().len(), preview.groups + 1);
        assert!(entries.iter().any(|r| r.archived));
        let entry = entries.iter().find(|r| r.data.title == "Service").unwrap();
        assert_eq!(entry.data.fields["password"], "test-secret");
        assert_eq!(entry.data.extra["attachments"][0]["size"], 3);
        assert!(c.commit_keepass_import(&preview.ticket).await.is_err());
        assert_eq!(c.list().await.unwrap().len(), preview.entries);
        c.lock();
        c.unlock_offline(&profile, vault_password()).await.unwrap();
        assert!(c.keepass_last_report().await.unwrap().is_none());
        assert_eq!(c.list().await.unwrap().len(), preview.entries);
    }

    #[tokio::test]
    async fn preview_cancel_block_and_restart_retry_after_server_commit() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let dir = tempfile::tempdir().unwrap();
        let url = sqlite_database_url(&dir.path().join("server.sqlite3")).unwrap();
        let fail_once = Arc::new(AtomicBool::new(true));
        let fail = fail_once.clone();
        let app = neruvalo_server::application(&url, dir.path().join("outbox"))
            .await
            .unwrap()
            .layer(axum::middleware::from_fn(
                move |req: axum::extract::Request, next: axum::middleware::Next| {
                    let fail = fail.clone();
                    async move {
                        let import = req.uri().path() == "/api/v1/vault/import";
                        let result = next.run(req).await;
                        if import
                            && result.status().is_success()
                            && fail.swap(false, Ordering::SeqCst)
                        {
                            use axum::response::IntoResponse;
                            (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                axum::Json(json!({"error":"interrupted response"})),
                            )
                                .into_response()
                        } else {
                            result
                        }
                    }
                },
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client_dir = dir.path().join("client");
        let mut c = Client::new(client_dir.clone()).unwrap();
        let vault_password = || Zeroizing::new("correct horse import password".into());
        let begin = c
            .register_begin(
                &server,
                "importer",
                "importer@example.test",
                vault_password(),
                false,
            )
            .await
            .unwrap();
        let email = std::fs::read_to_string(
            dir.path()
                .join("outbox")
                .join(format!("{}.txt", begin["ticket"].as_str().unwrap())),
        )
        .unwrap();
        let code = email
            .lines()
            .find_map(|l| l.strip_prefix("Confirmation code: "))
            .unwrap();
        c.register_finish(&server, code).await.unwrap();
        c.login(&server, "importer", vault_password())
            .await
            .unwrap();
        c.settings(900).await.unwrap();
        c.save(
            None,
            0,
            RecordData {
                record_type: "note".into(),
                schema_version: 1,
                title: "Existing".into(),
                fields: BTreeMap::new(),
                notes: String::new(),
                folder: String::new(),
                tags: vec![],
                extra: BTreeMap::new(),
            },
            false,
        )
        .await
        .unwrap();
        let file = dir.path().join("source.kdbx");
        test_db(&file, false);
        let preview = c
            .prepare_keepass_import(file.clone(), password(), None, "Imported".into())
            .await
            .unwrap();
        assert_eq!(preview.entries, 2);
        assert_eq!(c.list().await.unwrap().len(), 1);
        assert!(c.groups().await.unwrap().is_empty());
        // The durable local journal contains neither the report nor source fields in plaintext.
        let a = c.unlocked().unwrap();
        let journal: String = sqlx::query("SELECT value FROM meta WHERE name=$1")
            .bind(JOURNAL)
            .fetch_one(&a.cache)
            .await
            .unwrap()
            .get("value");
        assert!(!journal.contains("test-secret"));
        assert!(!journal.contains("Imported"));
        let envelope: Envelope = serde_json::from_str(&journal).unwrap();
        let journal_value: Value =
            serde_json::from_slice(&crypto::open(a._root.as_ref(), &envelope, CONTEXT).unwrap())
                .unwrap();
        for forbidden in ["report", "issues", "folder", "entries", "groups"] {
            assert!(journal_value.get(forbidden).is_none(), "{forbidden}");
        }
        assert_eq!(journal_value["ticket"], preview.ticket);
        assert!(
            sqlx::query("SELECT value FROM meta WHERE name='keepass_import:last_report'")
                .fetch_optional(&a.cache)
                .await
                .unwrap()
                .is_none()
        );
        let mut stale = load(a).await.unwrap().unwrap();
        let mut latest = load(a).await.unwrap().unwrap();
        store(a, &mut latest).await.unwrap();
        assert!(store(a, &mut stale).await.is_err());
        c.cancel_keepass_import(&preview.ticket).await.unwrap();
        assert!(c.keepass_import_status().await.unwrap().is_none());
        test_db(&file, true);
        let blocked = c
            .prepare_keepass_import(file.clone(), password(), None, "Blocked".into())
            .await
            .unwrap();
        assert!(!blocked.can_confirm);
        assert!(c.commit_keepass_import(&blocked.ticket).await.is_err());
        assert_eq!(c.list().await.unwrap().len(), 1);
        c.cancel_keepass_import(&blocked.ticket).await.unwrap();
        test_db(&file, false);
        let preview = c
            .prepare_keepass_import(file, password(), None, "Imported".into())
            .await
            .unwrap();
        assert!(c.commit_keepass_import("wrong ticket").await.is_err());
        assert!(c.commit_keepass_import(&preview.ticket).await.is_err());
        assert!(c.keepass_import_status().await.unwrap().unwrap().dispatched);
        assert!(c.cancel_keepass_import(&preview.ticket).await.is_err());
        drop(c);
        let mut c = Client::new(client_dir).unwrap();
        c.login(&server, "importer", vault_password())
            .await
            .unwrap();
        assert_eq!(c.list().await.unwrap().len(), 3);
        assert_eq!(c.groups().await.unwrap().len(), 4);
        let pending = c.keepass_import_status().await.unwrap().unwrap();
        assert_eq!(pending.ticket, preview.ticket);
        c.commit_keepass_import(&pending.ticket).await.unwrap();
        assert!(c.keepass_import_status().await.unwrap().is_none());
        assert!(c.keepass_last_report().await.unwrap().is_none());
        assert!(c
            .keepass_report_html(&preview.ticket, &BTreeMap::new())
            .await
            .is_err());
        let records = c.list().await.unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(records.iter().filter(|r| r.archived).count(), 1);
        let imported = records.iter().find(|r| r.data.title == "Service").unwrap();
        assert_eq!(imported.data.fields["custom:Extra"], "custom-secret");
        assert_eq!(imported.data.extra["attachments"][0]["name"], "test.bin");
        handle.abort();
    }
}
