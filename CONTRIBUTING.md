# Contributing to Neruvalo

The project is currently in its prototype stage. Start with [the specification](docs/specification.ru.md).

- Open an issue for a proposed change and distinguish accepted requirements from implementation proposals.
- Keep changes focused and describe how they were verified.
- Never commit passwords, private keys, recovery certificates, tokens, vault exports or production databases.
- Cryptographic changes require documented formats, test vectors and review. Use maintained implementations rather than custom primitives.
- Contributions are made under the repository's AGPL-3.0-only license. No separate contributor agreement is currently required.
- Build and test instructions are in [the prototype guide](docs/prototype.ru.md).
- Commit implementation work to a feature branch. Do not commit to or merge into `main` unless Urich explicitly requests it.

Current phase: documentation and design only. After accepting version 0.2.0 on 2026-10-29, Urich paused code changes, builds, packaging and CI until another explicit implementation request. Record the next iteration in the specification and use `[skip ci]` for documentation commits.
