# Encrypted groups (desktop/core 0.2.0)

Groups are metadata objects in the existing signed, encrypted version stream. They are not an additional secret-entry type, a server-visible folder table, or an access-control container. The eight existing secret types retain their version-1 record format. HTTP protocol, encryption suite and SQL schema remain version 1.

## Group plaintext (encrypted before transport and caching)

```json
{
  "record_type": "group",
  "schema_version": 2,
  "title": "Bank",
  "fields": {},
  "notes": "",
  "folder": "",
  "tags": [],
  "parent_group_id": null
}
```

The existing outer `record_id` is the stable group ID. A subgroup sets `parent_group_id` to its parent's UUID. Group names follow the existing nonempty / 1024-byte title limit. The core validates parent existence in the active account, rejects cycles and caps persisted nesting at 64 levels. Group objects are excluded from `Client::list()` and exposed through `Client::groups()`. The desktop `create_group` command creates a group; ordinary `save` cannot turn a metadata object into a secret entry or vice versa. Rename, move, archive and delete actions for groups are intentionally not exposed in this iteration.

Both the name and parent reference are inside authenticated ciphertext. The server stores the same opaque payload, signature, revision and account authorization as other versioned objects. No group name or parent ID is added to open transport metadata. Empty groups survive restart, sync and offline unlock. Offline mutations fail with `OFFLINE_READ_ONLY`.

## Entry membership

An optional `group_id` extension is carried inside the encrypted version-1 secret entry. A UUID selects one group, explicit `null` selects the root. No extension means the legacy `folder` string still determines the projected position. Explicit null takes precedence over any retained old folder string.

The desktop sends its selected group separately to the Rust `save_in_group` operation. The core resolves the selection, checks membership and saves an ordinary new revision with the new reference. It retains fields, unknown extensions, the legacy folder string and all old versions. Creating or navigating groups does not grant sharing rights or duplicate secrets.

## Legacy paths

Reading old data is non-mutating. The UI projects old nonempty paths into virtual tree nodes identified locally as `legacy:<raw path>`. These strings are not group UUIDs and are never saved as entry membership IDs. Path spelling is preserved, including existing spaces and separators. Path projection bounds intermediate ancestors to 64 levels; an unusually deep original path can still be displayed without recursively expanding thousands of ancestors.

When attaching an entry or subgroup to such a node, the core materializes each required ancestor with its exact `legacy_path` extension. Its deterministic UUID is derived using the existing HKDF helper:

- Secret: the account root key.
- Context: UTF-8 `neruvalo-legacy-group-id-v1`, a zero byte, then the exact UTF-8 prefix path.
- First 16 derived bytes, with UUID version-8 / variant bits applied.

The secret-derived identifier prevents a server-side dictionary search over common path names. Two devices encountering the same path use the same ID. A concurrent-create revision conflict causes synchronization and reuse of the already saved matching object. Parent creation is idempotent; it is not a multi-object transaction. If a later step fails, already created empty ancestors remain safely stored and a retry reuses them. No historical entry version is rewritten. Materializing a path with 64 or more segments is rejected; its original data remains readable.

## Compatibility

New clients read existing format-1 entries and encrypted caches; the server needs no SQL migration or new HTTP endpoint to transport groups. The software versions are bumped to 0.2.0. Format-2 group support requires updated clients on devices using this vault. Version-0.1 clients do not understand these objects; forward compatibility of their UI with a vault containing groups is not promised. This is separate from preserving old data and the unchanged v1 protocol/SQL schema.

The end-to-end suite covers empty/nested groups, multi-device reuse of legacy ancestors, unchanged old history and fields, offline read-only behavior, lock rejection, and the absence of group names/legacy paths from server-side version bodies. It runs against SQLite and PostgreSQL in CI.

## Changes in 0.3.0

Archived groups are returned by the client as well as active groups, with an `archived` boolean. See [archive-protocol.md](archive-protocol.md) for atomic subtree updates, ancestor restoration and compatibility.
