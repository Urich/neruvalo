# GateVeriq integration

Set all five variables on the Neruvalo server. With none set, the existing local
prototype runs without verification. A partial configuration prevents startup.

```powershell
$env:NERUVALO_GATE_ID = 'INTEGRATION_ID'
$env:NERUVALO_GATE_SECRET = 'INTEGRATION_SECRET'
$env:NERUVALO_GATE_INTERNAL = 'http://127.0.0.1:9081'
$env:NERUVALO_GATE_PUBLIC = 'http://127.0.0.1:9080'
$env:NERUVALO_PUBLIC_ORIGIN = 'http://127.0.0.1:8080'
```

Use the actual Neruvalo browser origin (including port). Create a website-mode
GateVeriq integration with that exact origin and actions `register,email_verify,login,unlock`.
Set `register`, `email_verify`, and `unlock` visual policies to `always`; set
`login` to `adaptive`, using `integration-visual-policy --id ID --action ACTION
--visual POLICY`. The internal API and integration secret belong on the backend.
Use HTTPS outside loopback development. Keep the internal listener private.

The desktop client embeds the Neruvalo server's verification page in a sandboxed
frame inside a modal dialog using the application's design. The dialog closes
after success, failure, or the three-minute timeout; Cancel or Escape cancels the
operation. The frame has no Tauri capabilities, popup, form, or top-navigation
permissions. Cancellation uses a separate command so it does not wait on the
busy client mutex. The standalone Rust
client retains the system-browser fallback. Backend polling uses the client's
configured HTTP proxy; the WebView uses system networking. Widget and worker are
vendored together from GateVeriq and served by Neruvalo. The WebView communicates
directly with the public GateVeriq URL. A real WebView run is still required to
validate GateVeriq browser screening on each supported platform.

Every registration start, email-code submission, and OPAQUE login start requires
one verification. Email verification uses the stricter allowed flow: images before
every code submission, including the first. The backend binds a random context to
the complete immutable request and consumes the permission before dispatch.
Changes to the request and repeated uses are rejected. Failures require a new
verification. Network failures after dispatch have an uncertain business result;
the client does not automatically replay the operation.

The browser and polling channel require a random bearer secret. The browser
receives it in the URL fragment, then removes it from browser history. Responses
are not cached. GateVeriq receives an opaque derived account identifier, never
email addresses, email codes, or OPAQUE messages. The backend checks the consumed
action, context and actual `pow_visual` method for registration and email checks.
Business outcomes are reported after code checks and OPAQUE finalization. A
client-side OPAQUE rejection finishes the server attempt as failed; abandoned
attempts expire without being counted as incorrect passwords.

Current prototype limits: pending verification is in memory and expires on
restart; outcome reporting has no durable retry queue. Account-wide failed-login
journal, warning emails after two failures, account lockout after three failures,
and link-plus-password unlock remain separate work. Certificate-based vault
recovery and offline unlocking retain their existing flows; neither is the
account-unlock flow described by the integration requirements.

Validation: `cargo test --locked --workspace --exclude neruvalo-desktop`,
`cargo clippy --locked --workspace --all-targets --exclude neruvalo-desktop -- -D warnings`.
The mock GateVeriq test covers bearer ownership, required images, immutable request
binding, single use, and privacy of outbound preparation. A real browser run with
GateVeriq is still required to validate the deployed origins and visual challenge.
