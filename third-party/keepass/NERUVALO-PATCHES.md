# keepass 0.17.0

Source: https://crates.io/crates/keepass/0.17.0 (MIT; see LICENSE).
Vendored source is pinned to permit import resource limits before allocation/KDF work.

Local changes:
- Minimal host library manifest, no upstream utilities/test targets; removed the
  unused deprecated block-modes dependency.
- KDF bounds: AES 5,000,000 rounds; Argon2 256 MiB, 10 iterations,
  8 lanes, memory × iterations at most 512 MiB.
- Gzip expansion capped at 64 MiB; cumulative KDBX3 attachment pool capped at 64 MiB.
- XML scan before recursive deserialization: depth 128, 1,000,000 events.

Other import bounds and application-specific mapping live in client-core/src/keepass_import.rs.
No changes to cryptographic algorithms or database contents. Update this file when rebasing.
