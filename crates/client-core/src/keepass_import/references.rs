use super::*;

pub(super) struct References {
    entries: BTreeMap<String, BTreeMap<String, String>>,
    remaining_work: std::cell::Cell<usize>,
}
impl References {
    pub(super) fn new(db: &Database) -> Self {
        Self {
            remaining_work: std::cell::Cell::new(2_000_000),
            entries: db
                .iter_all_entries()
                .map(|e| {
                    (
                        e.id().uuid().simple().to_string().to_ascii_uppercase(),
                        e.fields
                            .iter()
                            .map(|(k, v)| (k.clone(), v.get().clone()))
                            .collect(),
                    )
                })
                .collect(),
        }
    }
    fn charge(&self, work: usize) -> Result<()> {
        let remaining = self
            .remaining_work
            .get()
            .checked_sub(work)
            .ok_or_else(|| anyhow!("REFERENCE_LIMIT"))?;
        self.remaining_work.set(remaining);
        Ok(())
    }
    pub(super) fn field(&self, entry: &str, field: &str) -> Result<String> {
        self.expand(entry, field, &mut vec![], &mut 10000)
    }
    fn expand(
        &self,
        entry: &str,
        field: &str,
        stack: &mut Vec<(String, String)>,
        budget: &mut usize,
    ) -> Result<String> {
        let key = (entry.to_owned(), field.to_owned());
        ensure!(
            stack.len() < 20 && !stack.contains(&key) && *budget > 0,
            "REFERENCE_CYCLE_OR_LIMIT"
        );
        *budget -= 1;
        self.charge(1)?;
        stack.push(key);
        let fields = self
            .entries
            .get(entry)
            .ok_or_else(|| anyhow!("REFERENCE_MISSING"))?;
        let raw = fields.get(field).map(String::as_str).unwrap_or("");
        let mut output = String::new();
        let mut remaining = raw;
        while let Some(start) = remaining.find('{') {
            output.push_str(&remaining[..start]);
            let Some(end) = remaining[start..].find('}').map(|end| start + end) else {
                ensure!(
                    !remaining[start..].to_ascii_uppercase().starts_with("{REF:")
                        && !remaining[start..].to_ascii_uppercase().starts_with("{S:"),
                    "REFERENCE_INVALID"
                );
                output.push_str(&remaining[start..]);
                remaining = "";
                break;
            };
            let token = &remaining[start + 1..end];
            let upper = token.to_ascii_uppercase();
            let local = match upper.as_str() {
                "TITLE" => Some("Title"),
                "USERNAME" => Some("UserName"),
                "PASSWORD" => Some("Password"),
                "URL" => Some("URL"),
                "NOTES" => Some("Notes"),
                _ => None,
            };
            let value = if upper == "UUID" {
                Some(entry.to_owned())
            } else if let Some(field) = local {
                Some(self.expand(entry, field, stack, budget)?)
            } else if upper.starts_with("S:") {
                let target = &token[2..];
                ensure!(fields.contains_key(target), "REFERENCE_MISSING");
                Some(self.expand(entry, target, stack, budget)?)
            } else if upper.starts_with("REF:") {
                let (syntax, search) = token[4..]
                    .split_once(':')
                    .ok_or_else(|| anyhow!("REFERENCE_INVALID"))?;
                let syntax = syntax.to_ascii_uppercase();
                let bytes = syntax.as_bytes();
                ensure!(
                    bytes.len() == 3
                        && bytes[1] == b'@'
                        && !search.is_empty()
                        && !search.contains('{'),
                    "REFERENCE_INVALID"
                );
                let standard = |code: u8| -> Result<&str> {
                    Ok(match code {
                        b'T' => "Title",
                        b'U' => "UserName",
                        b'P' => "Password",
                        b'A' => "URL",
                        b'N' => "Notes",
                        _ => anyhow::bail!("REFERENCE_INVALID"),
                    })
                };
                self.charge(self.entries.len())?;
                let matches: Vec<_> = self
                    .entries
                    .iter()
                    .filter(|(id, values)| {
                        if bytes[2] == b'I' {
                            return Uuid::parse_str(search)
                                .is_ok_and(|u| u.simple().to_string().eq_ignore_ascii_case(id));
                        }
                        let search = search.to_lowercase();
                        if bytes[2] == b'O' {
                            return values.iter().any(|(k, v)| {
                                !["Title", "UserName", "Password", "URL", "Notes"]
                                    .contains(&k.as_str())
                                    && v.to_lowercase().contains(&search)
                            });
                        }
                        standard(bytes[2])
                            .ok()
                            .and_then(|k| values.get(k))
                            .is_some_and(|v| v.to_lowercase().contains(&search))
                    })
                    .collect();
                ensure!(matches.len() == 1, "REFERENCE_MISSING_OR_AMBIGUOUS");
                let (id, _) = matches[0];
                Some(if bytes[0] == b'I' {
                    id.clone()
                } else {
                    self.expand(id, standard(bytes[0])?, stack, budget)?
                })
            } else {
                None
            };
            if let Some(value) = value {
                output.push_str(&value);
            } else {
                output.push_str(&remaining[start..=end]);
            }
            ensure!(output.len() <= 256 * 1024, "REFERENCE_LIMIT");
            remaining = &remaining[end + 1..];
        }
        output.push_str(remaining);
        ensure!(output.len() <= 256 * 1024, "REFERENCE_LIMIT");
        stack.pop();
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_chains_and_rejects_cycles_missing_and_ambiguous_targets() {
        let id1 = "11111111111111111111111111111111";
        let id2 = "22222222222222222222222222222222";
        let mut db = Database::new();
        let first = db.root_mut().add_entry().id();
        {
            let mut e = db.entry_mut(first).unwrap();
            e.set_unprotected("Title", "Source");
            e.set_protected("Secret", "pass");
            e.set_protected("Password", "{S:Secret}");
        }
        let mut r = References::new(&db);
        let actual = first.uuid().simple().to_string().to_uppercase();
        let first = r.entries.remove(&actual).unwrap();
        r.entries.insert(id1.into(), first);
        r.entries.insert(
            id2.into(),
            BTreeMap::from([("Password".into(), format!("prefix-{{REF:P@I:{id1}}}"))]),
        );
        assert_eq!(r.field(id2, "Password").unwrap(), "prefix-pass");
        r.entries
            .get_mut(id1)
            .unwrap()
            .insert("Secret".into(), format!("{{REF:P@I:{id2}}}"));
        assert!(r.field(id2, "Password").is_err());
        r.entries
            .get_mut(id2)
            .unwrap()
            .insert("Password".into(), "{S:Missing}".into());
        assert!(r.field(id2, "Password").is_err());
        r.entries
            .get_mut(id2)
            .unwrap()
            .insert("Title".into(), "Source".into());
        r.entries
            .get_mut(id2)
            .unwrap()
            .insert("Password".into(), "{REF:P@T:Source}".into());
        assert!(r.field(id2, "Password").is_err());
    }
}
