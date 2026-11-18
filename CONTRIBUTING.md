# Contributing to Neruvalo

The project is currently in its prototype stage. Start with [the specification](docs/specification.ru.md).

- Open an issue for a proposed change and distinguish accepted requirements from implementation proposals.
- Keep changes focused and describe how they were verified.
- Never commit passwords, private keys, recovery certificates, tokens, vault exports or production databases.
- Cryptographic changes require documented formats, test vectors and review. Use maintained implementations rather than custom primitives.
- Contributions are made under the repository's AGPL-3.0-only license. No separate contributor agreement is currently required.
- Build and test instructions are in [the prototype guide](docs/prototype.ru.md).
- Commit implementation work to a feature branch. Do not commit to or merge into `main` unless Urich explicitly requests it.

Current phase: implementation and builds resumed by Urich on 2026-10-30. Work on `prototype/desktop-core`; keep `main` unchanged.

## Design and coding rules

Apply these rules across the project, including all Rust crates and the desktop TypeScript code.

- **Give each rule one source.** Reuse the existing definition of a limit, default, or protocol value. Define shared protocol rules in `neruvalo-protocol`. Put deployment-specific settings in configuration and validate them at startup. Use a named constant for a fixed value whose meaning or unit needs explanation. Limits that serve different purposes may have the same value and should have separate definitions.
- **Represent states and errors with types.** Use Rust enums or TypeScript discriminated unions when behavior depends on the variant. Convert typed errors to stable string codes at boundaries such as HTTP and Tauri. Preserve existing external codes when refactoring.
- **Organize modules by responsibility.** Group code that implements the same operation or enforces the same rules. Keep startup and route registration in the server's `lib.rs` and group related handlers and their logic in focused modules.
- **Use patterns where the code needs them.** Use an enum for a closed set of strategies and a trait or interface when implementations need to be substituted or extended. Use adapters at integration boundaries to translate external types, formats, and errors into project types.
- **Refactor incrementally.** Apply these rules to new and changed code and improve existing code in focused changes. Verify that refactors preserve protocol and storage compatibility, transaction behavior, and error handling unless the task explicitly changes them.
