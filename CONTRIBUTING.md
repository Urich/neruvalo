# Contributing to Neruvalo

The project is currently in its prototype stage. Start with [the specification](docs/specification.ru.md).

- Open an issue for a proposed change and distinguish accepted requirements from implementation proposals.
- Keep changes focused and describe how they were verified.
- Never commit passwords, private keys, recovery certificates, tokens, vault exports or production databases.
- Cryptographic changes require documented formats, test vectors and review. Use maintained implementations rather than custom primitives.
- Contributions are made under the repository's AGPL-3.0-only license. No separate contributor agreement is currently required.
- Build and test instructions are in [the prototype guide](docs/prototype.ru.md).
- Commit implementation work to a feature branch. Do not commit to or merge into `main` unless Urich explicitly requests it.

During the current design iteration, do not run builds or create packages until Urich requests resuming them. Use `[skip ci]` on commits to avoid triggering automatic build workflows.
