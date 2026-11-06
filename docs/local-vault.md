# Local vaults

The start screen offers **Create local vault** and **Restore from backup**.
A local vault needs a name and a master password of at least twelve characters.
It does not register an account, send email, or contact GateVeriq. Saved local
profiles appear alongside cached server profiles in the profile selector.

Local vaults support records, encrypted groups, nested folders, version history,
subtree archive/restore, clipboard controls, and a locally stored lock timeout.
They remain writable without a network. Server profiles unlocked offline remain
read-only. Sharing and synchronization require a server profile.

## Storage and backups

Profiles have an explicit `kind` (`local` or `server`); older profiles default to
`server`. Local vaults use independent random root and account keys. The root is
wrapped with a password key derived using the existing Argon2id configuration.
Version payloads use the existing encrypted and signed version format and are
stored in SQLite. A local write is a transaction, including an entire subtree
archive operation. No master password or record contents are stored in plaintext.
The profile name and structural metadata such as opaque IDs, revisions and
timestamps are not secret.

In Settings, **Save encrypted backup** asks for the local master password and a
new destination filename. The backup includes the profile and all encrypted
versions, including folders, archive state and history. An additional authenticated
envelope protects the complete backup with a fresh salt and the same master
password. Existing files are never overwritten. Keep both the backup and password;
this local format does not have the server account recovery certificate flow.

Restore validates the envelope, key identities, version signatures and revision
chains before publishing a new profile. It creates a separate vault and never
replaces an existing one. Backup files are limited to 64 MiB.

## Connecting to a server

From local vault Settings choose **Connect to a server**. Sign in to an existing
account or register and confirm email, then sign in. A dialog asks for the local
master password and confirms importing its contents into the selected account.
The Settings of a signed-in server account also offer importing any saved local
vault, so a cancelled or interrupted transfer can be resumed.

The client decrypts and re-encrypts each local version on the device using the
destination account keys and cryptographic contexts. New record, folder and version
IDs keep the imported data separate from existing server entries. Group references
are remapped, and history, timestamps and archive flags are preserved. Neither the
local password nor plaintext records are sent to the server.

The client persists the ID mapping and encrypted versions in an authenticated,
encrypted journal in the source vault's SQLite metadata. The journal is scoped to
the destination account. Repeating an import reuses these IDs and ciphertexts.
Further local versions can be added by another import into the same account.

`POST /api/v1/vault/import` requires a normal authenticated server session. It
validates signatures and revision chains, accepts already imported versions only
when they match, and commits the complete import in one transaction. The operation
is idempotent, including a lost response after commit. Existing unrelated server
records are kept. If an imported record has since been edited on the server,
incompatible local changes cause a conflict rather than overwriting that edit.
Imports are limited to 10,000 versions and a 32 MiB encrypted request.

After import, the client synchronizes and verifies every imported version by
signature, ciphertext equality and successful decryption. The server profile is
then ready for normal synchronization. The source local profile and its data
remain untouched and available, including after any failure. This retained source
is an independent copy, not an additional continuously synchronized profile.

Both desktop and server must include the import endpoint. A server upgrade is
needed to import into an older installation. Existing server profiles and their
offline mode do not require conversion.
