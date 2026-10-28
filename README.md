# Neruvalo

An open-source, self-hosted password and secrets manager.

**Status: design stage. There is no working application or server installer yet. Do not use this repository to store real secrets.**

## Planned capabilities

- Windows desktop client built with React, TypeScript, Tauri and a shared Rust core.
- Rust server with SQLite or PostgreSQL.
- Client-side encryption and OPAQUE authentication.
- Multiple accounts and servers in one client.
- Offline read-only access to a local encrypted SQLite cache.
- Owner-only version history and read-only shared copies that follow the original.
- Logins, payment cards, secure notes, bank accounts, API tokens, SSH keys, documents and cryptocurrency wallet secrets.
- KeePass and Bitwarden import; password-encrypted native export/import.
- Interactive Linux server installation script; Docker Compose is the proposed deployment method.
- Linux, Android and iOS clients planned after Windows.

Browser access and browser autofill extensions are deferred. Software updates are installed by users; backups are managed externally.

## Documentation

- [Project specification (Russian)](docs/specification.ru.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

This is a monorepo for the server, clients, protocol and shared cryptographic core. Components can have independent release versions.

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).
