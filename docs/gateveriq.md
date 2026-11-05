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
GateVeriq integration with that exact origin and actions `register,login`.
Set both visual policies to `adaptive`, using `integration-visual-policy --id ID
--action ACTION --visual adaptive`. Rerun `installer/setup-gateveriq.ps1` to update
an existing local integration; it reuses saved credentials.
The internal API and integration secret belong on the backend.
Use HTTPS outside loopback development. Keep the internal listener private.

The desktop client prepares a check after the user enters the server and login
(and email for registration). The GateVeriq checkbox appears below the password.
The submit button becomes available after verification. Images open in a modal
only when GateVeriq requests them; the same frame stays mounted during this
transition. The application language is passed as the widget locale.

Frames are sandboxed without Tauri capabilities, popups, forms or top navigation.
Frame messages are checked against both origin and source; only the backend can
accept the GateVeriq token. Prepared checks expire after three minutes, are bound
to the action and login (plus email for registration), and are consumed before
dispatch. Changing these fields resets the check. Failures require a fresh check.
The password and OPAQUE message are created separately and are never sent to
GateVeriq. Offline unlocking requires no verification.

Email-code submission goes directly to the existing email confirmation handler,
which keeps its code validation, expiration and rate limit. It does not create a
second bot check. Both proof-of-work and visual verification tokens are accepted
when GateVeriq validates the action and context. GateVeriq decides when images
are necessary. Business outcomes are reported after registration start and
OPAQUE login finalization.

The standalone Rust client retains the system-browser fallback, whose checks
are bound to the complete original request. Backend requests use the configured
HTTP proxy; the WebView uses system networking. Widget and worker are vendored
from GateVeriq and served by Neruvalo. The frame communicates directly with the
public GateVeriq URL. The bearer secret is delivered in the URL fragment and
removed from browser history. Verification responses are not cached. Network
failures after dispatch have an uncertain business result; operations are not
automatically replayed.

Current prototype limits: pending verification is in memory and expires on
restart; outcome reporting has no durable retry queue. Account-wide failed-login
journal, warning emails after two failures, account lockout after three failures,
and link-plus-password unlock remain separate work. Certificate-based vault
recovery and offline unlocking retain their existing flows; neither is the
account-unlock flow described by the integration requirements.

Validation: `cargo test --locked --workspace --exclude neruvalo-desktop`,
`cargo clippy --locked --workspace --all-targets --exclude neruvalo-desktop -- -D warnings`.
The mock GateVeriq test covers bearer ownership, identity and request
binding, both verification methods, single use, email confirmation bypass, and
privacy of outbound preparation. A real browser run with
GateVeriq is still required to validate the deployed origins and visual challenge.
