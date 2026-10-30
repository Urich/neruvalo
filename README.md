# Neruvalo

An open-source, self-hosted password and secrets manager built with Rust, React and Tauri.

**Status: early development prototype. Test data only. No production security audit.**

## Try the prototype

Work is on [`prototype/desktop-core`](https://github.com/Urich/neruvalo/tree/prototype/desktop-core). Changes are not merged into `main` without the repository owner's request.

- [Run the server, Windows desktop client or native CLI (Russian)](docs/prototype.ru.md)
- [Full product specification (Russian)](docs/specification.ru.md)

Implemented: real OPAQUE authentication, client-side authenticated encryption, signed record history, version conflicts, archive/restore, encrypted SQLite offline read-only cache and recovery certificates. The desktop UI includes all eight agreed secret types.

The server deliberately runs on loopback in development mode. Email verification uses a private local outbox. Production SMTP/CAPTCHA, sharing, imports/exports, Windows Hello and mobile clients are not implemented yet. See the prototype guide for the exact status.

## Architecture

- Shared Rust cryptographic and client core.
- React/TypeScript desktop UI packaged with Tauri; no remotely loaded application code.
- Rust/Axum server, SQLite or PostgreSQL through SQLx.
- SQLite local cache containing encrypted versions.
- Monorepo with independently versioned future components.

Software updates are installed by users. Backups are managed externally. Browser access and autofill extensions are deferred.

## Development

```bash
cargo test --locked --workspace --exclude neruvalo-desktop
cd apps/desktop
npm ci
npm test
npm run build
```

System dependencies are required for the Tauri shell; consult the [run guide](docs/prototype.ru.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Never commit real vault data, keys or recovery files.

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Implementation status and remaining specification work: [docs/implementation-status.ru.md](docs/implementation-status.ru.md). Prototype 0.4.0 uses protocol/database schema 2; use fresh test data and the packaged `start-desktop.cmd` for a separate cache.
