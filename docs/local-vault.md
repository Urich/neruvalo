# Local vaults

The start screen offers **Create local vault** and **Restore from backup**.
A new local vault needs a filename and a master password of at least twelve characters.
It does not register an account, send email, or contact GateVeriq. Saved local
profiles appear alongside cached server profiles in the profile selector.

Local vaults support records, encrypted groups, nested folders, version history,
subtree archive/restore, clipboard controls, and a locally stored lock timeout.
They remain writable without a network. Server profiles unlocked offline remain
read-only. Sharing and synchronization require a server profile.

## Choosing a local vault file

The local vault form starts with an editable filename/path field. Enter a filename
such as `personal.nvdb` to use the app's `vaults` directory, or enter an absolute
path. **New file…** uses a save-path dialog accepting a filename that does not exist yet;
**Choose file…** uses an open-file dialog for an existing vault without an overwrite
prompt. You can also type a new filename directly in the editable field. The dialogs
only choose a path; creation/opening happens after password entry in the form. The
form has one primary action, **Open** or **Create local vault**, according to file
existence. The resolved destination is shown below the
field. Relative paths are resolved by the native core, and invalid names or missing
explicit destination directories disable submission with an explanation.

The app checks whether the file exists. A missing file uses **Create local vault**,
a master password of at least twelve characters and confirmation. An existing
file uses **Open** and only that file's master password. Out-of-order results from
older path checks cannot change the mode for the current path. A create operation
uses exclusive file creation, so a file appearing after inspection is never
overwritten; the form refreshes its state and asks for an explicit open instead.
A disappearing file is never replaced by an empty database during opening.

New vaults are self-contained SQLite files (recommended extension `.nvdb`). The
existing wrapped-key profile is stored under `meta.local_profile`; passwords and
private keys are not stored in plaintext. The vault title is derived from the
filename. Schema/profile/protocol 3 require an embedded authoritative key profile,
a signed state manifest and explicit KDF parameters. Older dev formats are rejected
without migration or deletion. See [database integrity](database-integrity.md).
`.nvbackup` files continue to use **Restore from backup**.

Opening validates the profile/key identities, SQLite header and schema, record
payload formats and current metadata. It opens the selected database in place
using SQLite `mode=rw`, never create-if-missing. Incorrect passwords, missing
files and incompatible formats cannot register an empty replacement database.
Incompatible formats return to Unlock vault using the existing error handling.
Normal offline unlock likewise requires an existing database file.

After successful validation, an external vault is remembered as a local profile.
Its managed profile folder contains an encrypted key-profile copy and a
`local-location.json` pointer to the original database, bound to its account ID
and public signing key. No database is copied into that folder. Reopening the
same canonical path reuses the remembered profile. Local auto-lock settings remain
specific to that remembered profile. Every unlock rereads the authoritative key
profile from the selected database (schema 3 only), so remembered metadata
does not bypass an updated master-password envelope. A moved or disconnected vault
is not recreated automatically.

Changes, history and imported files are written to the selected database. Backups
and server transfer work as before. Close applications using a vault before moving
or copying it, so SQLite can finish/checkpoint any transient journal files.

## Storage and backups

Profiles have an explicit `kind` (`local` or `server`); older profiles default to
`server`. Local vaults use independent random root and account keys. The root is
wrapped with a password key derived using the existing Argon2id configuration.
Version payloads use the signed format with separate encrypted file blocks described
below and are stored in SQLite. A local write is a transaction, including an entire subtree
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
needed to import into an older installation. This file-block payload format requires updated clients and fresh test vaults;
old record payloads are rejected rather than migrated.


## Separate encrypted file blocks (payload 3, 15 November 2026)

This is a breaking change for both local and server vaults. Recreate test vaults
and use updated clients for owners and recipients. No database is deleted by the
application, and no automatic migration or legacy attachment decoder is provided.
The inner version payload is explicitly versioned as 3. The subsequent integrity
remediation also raises server API/database schema to 3; signatures are version 2.

Opening a local vault or an offline server cache first checks the local schema,
all stored version payload/envelope headers, current record metadata and cached
shared copies. Current metadata warms the existing index cache rather than being
decrypted again for the first list. A local candidate session becomes active only
after these checks. Server login must complete a compatible sync; failed login
never leaves an unlocked session. Sync checks incoming version formats before
committing the snapshot. Unsupported vault formats end the native session and
return the desktop to Unlock vault with a localized error. Files remain encrypted
throughout this validation. Historical content is validated when read; discovering
an unsupported format later uses the same lock/error behavior. Import-file errors
such as unsupported KDBX versions remain separate. Existing databases are not
deleted, rewritten to a supported format or migrated by this gate.


Each file is encrypted immediately when picked or imported, using a fresh random
32-byte key and the existing XChaCha20-Poly1305 envelope implementation (random
24-byte nonce). Its authenticated additional data is the compact UTF-8 JSON array
`["neruvalo/file/v1", attachment_id, filename, plaintext_byte_length]`. Base64
strings use the existing URL-safe alphabet without padding. File names are single
safe path components, never destination paths. Empty files are supported.

The signed version's payload is:

```json
{
  "format_version": 3,
  "record": {"data": "existing Envelope", "owner_key": "existing Envelope"},
  "files": {"attachment UUID": "file Envelope"},
  "sharing": "existing optional sharing transaction metadata"
}
```

`record` is the existing encrypted version container and uses its existing
version-specific context and owner-key wrapping. Its encrypted JSON contains the
record fields and attachment descriptors `{id,name,size,data}`. Each descriptor's
internal `data` is a JSON string `{format_version:1,key:<base64url file key>}`.
File bytes are absent from this encrypted metadata. The independent envelopes
live in the outer `files` map. Descriptors and blocks must match exactly: missing,
duplicate or unused blocks are rejected. The complete outer payload is covered by
the existing version signature, checked before metadata decryption. Thus the
server learns opaque file IDs, block count and approximate lengths, but receives
neither file names, file keys nor plaintext bytes.

Reading, indexing, editing, moving and archiving a record decrypt only its record
container; they never open file envelopes. Saving another record version reuses
unchanged file envelopes and keys, without re-encrypting file bytes. History keeps
its own referenced blocks. Local backup/restore and transfer to another account
preserve the file envelopes while rewrapping/re-encrypting record metadata. This
is a separation of encryption blocks, not a streaming object store: ciphertexts
still travel inside each signed version in the existing SQLite/network payloads.
Full sync and the existing size limits still apply.

Shared-copy `payload` likewise becomes `{format_version:3,record:<Envelope>,files}`.
The copy's existing random root key encrypts only shared metadata and file keys;
its recipient sealed key box and signed transcript are unchanged. Making or
updating a copy passes encrypted file blocks through without decrypting them.
The recipient verifies the copy signature and decrypts metadata normally, but
opens a file envelope only when saving that attachment. A recipient of the entire
record necessarily receives the file keys too; this format adds no file-specific
access-control or retroactive revocation guarantee.

The desktop webview receives only `{id,name,size,data:<opaque random handle>}`.
Keys and encrypted file blocks remain in native session memory. Handles are
validated against all descriptor fields, deduplicated within the session and
discarded on lock/profile change. Draft saving resolves these handles natively;
the webview cannot supply raw file blocks or keys. A cancelled Save As dialog
never opens the file envelope. After destination selection, the native core
authenticates/decrypts the chosen block into a zeroizing buffer, verifies length,
and only then writes to the user-selected path. No preview, temporary plaintext
file or automatic opening is added.

The independent libsodium vector is in
[`test-vectors/attachment-v1.json`](test-vectors/attachment-v1.json). Tests cover
that vector, AAD changes, ciphertext corruption without destination truncation,
metadata access/editing with an unopened invalid file envelope, missing/extra
blocks, handle forgery and invalidation, history, backup/offline restore, local to
server transfer and recipient downloads. Cryptographic primitive implementations
are unchanged; this is a new composition and storage format requiring review.


## Database integrity (17 November 2026)

All historical signatures and chains, SQL/JSON headers, full manifest membership
and protected profile metadata are checked before opening. Local checkpoints detect
whole-file rollback on a device with a retained anchor. A new device saves its
first checkpoint on successful open. Reports remain in session memory only. See
[the current format, recovery rules, limits and measurements](database-integrity.md)
for the authoritative current behavior; earlier historical format notes are superseded.
