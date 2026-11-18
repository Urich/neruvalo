use crate::{normalize_login, valid_account_login};
use serde::{Deserialize, Serialize};

const CONTACT_PREFIX: &str = "neruvalo:share:v1:";
const MAX_CONTACT_BYTES: usize = 1024;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareContact {
    pub server_id: String,
    pub account_id: String,
    pub login: String,
    pub fingerprint: String,
}

impl ShareContact {
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        Ok(format!("{CONTACT_PREFIX}{}", serde_json::to_string(self)?))
    }

    pub fn decode(code: &str) -> Option<Self> {
        if code.len() > MAX_CONTACT_BYTES {
            return None;
        }
        let contact: Self = serde_json::from_str(code.strip_prefix(CONTACT_PREFIX)?).ok()?;
        (valid_account_login(&contact.login)
            && contact.login == normalize_login(&contact.login)
            && !contact.server_id.is_empty()
            && !contact.account_id.is_empty()
            && !contact.fingerprint.is_empty())
        .then_some(contact)
    }
}
