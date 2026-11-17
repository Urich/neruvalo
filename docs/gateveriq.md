# GateVeriq integration

## Automatic local Docker setup (Linux)

Requires Docker Engine and Python 3.11+. No Compose or local GateVeriq source
checkout is needed. From the Neruvalo repository root:

```bash
python3 installer/setup-gateveriq-docker.py
```

The script pulls `ghcr.io/urich/gateveriq:v0.2.0`, creates the
`neruvalo-gateveriq` container with a persistent `neruvalo-gateveriq-data` volume,
and publishes ports 9080 and 9081 on host loopback. It creates a website
integration for Neruvalo's configured listener with actions `register,login`,
sets both visual policies to `adaptive`, updates `[gateveriq]` in
`neruvalo-server.toml`, and prints the integration ID and secret. Restart the
Neruvalo server afterward. Docker access uses sudo if required; run the script
as your normal user so the server config stays owned by you.

If an older GateVeriq instance already occupies the ports, leave it running and
choose free ports for the new instance:

```bash
python3 installer/setup-gateveriq-docker.py --public-port 19080 --internal-port 19081
```

Optional arguments: `--name`, `--server-config PATH`, `--origin URL`.
Use `--help` for details. The origin is the Neruvalo server address, not Vite's
port or GateVeriq's address. If a server config does not exist, the script uses
`neruvalo-server.example.toml` as its template.

Repeat runs reuse the managed container, data volume and saved integration.
Changing its ports or origin requires a different container name and free ports.
The script refuses to replace unrelated containers or reuse unrelated volumes.
It never deletes containers or volumes. Do not remove the data volume: it holds
the GateVeriq database, token key and saved integration credentials.

The server config is written with mode 0600. Before its first change, the script
saves a private `neruvalo-server.toml.before-gateveriq` backup; both are ignored
by Git. Credentials are also stored privately inside the persistent Docker volume.
The final console output contains the secret: keep that output private.

Script checks (with a simulated Docker CLI):
`python3 -B -m unittest discover -s installer/tests -v`.

## Manual configuration

Copy `neruvalo-server.example.toml` to `neruvalo-server.toml` and enable the
complete section on the Neruvalo server:

```toml
[gateveriq]
id = "INTEGRATION_ID"
secret = "INTEGRATION_SECRET"
internal = "http://127.0.0.1:9081"
public = "http://127.0.0.1:9080"
origin = "http://127.0.0.1:8787"
```

Run `cargo run --locked -p neruvalo-server -- --config neruvalo-server.toml`.
Without `--config`, the server automatically reads `neruvalo-server.toml` in its
working directory. A config file is authoritative: environment variables do not
override it. Missing fields, unknown keys, empty values and invalid origins fail
startup. Omit the entire `[gateveriq]` section to disable verification.
Keep the real config private; the root `neruvalo-server.toml` is gitignored.

Legacy environment-only launchers still work when no config file is present:
`NERUVALO_GATE_ID`, `NERUVALO_GATE_SECRET`, `NERUVALO_GATE_INTERNAL`,
`NERUVALO_GATE_PUBLIC`, `NERUVALO_PUBLIC_ORIGIN`. All five are required together.

Use the actual Neruvalo browser origin (including port). Create a website-mode
GateVeriq integration with that exact origin and actions `register,login`.
Set both visual policies to `adaptive`, using `integration-visual-policy --id ID
--action ACTION --visual adaptive`. Rerun `installer/setup-gateveriq.ps1` to update
an existing local integration; it reuses saved credentials.
The backend obtains a signed context from `/internal/v1/contexts` before
creating `/internal/v1/web/attempts`, as required by GateVeriq v0.2.0. A locally
generated random context is rejected as `INVALID_CONTEXT`.
The internal API and integration secret belong on the backend.
Use HTTPS outside loopback development. Keep the internal listener private.

The desktop client prepares a check after the user enters the server and login
(and email for registration). The GateVeriq checkbox appears below the password.
The submit button becomes available after verification. The slider puzzle opens in a modal
only when GateVeriq requests it; the same frame stays mounted during this
transition. The application language is passed as the widget locale.

Frames are sandboxed without Tauri capabilities, popups, forms or top navigation.
Frame messages are checked against both origin and source; only the backend can
accept the GateVeriq token. Prepared checks expire after at most three minutes (and no later than the
GateVeriq context deadline), are bound
to the action and login (plus email for registration), and are consumed before
dispatch. Changing these fields resets the check. Failures require a fresh check.
The password and OPAQUE message are created separately and are never sent to
GateVeriq. Offline unlocking requires no verification.

Email-code submission goes directly to the existing email confirmation handler,
which keeps its code validation, expiration and rate limit. It does not create a
second bot check. Both proof-of-work and visual verification tokens are accepted
when GateVeriq validates the action and context. GateVeriq decides when a slider
is necessary. Business outcomes are reported after registration start and
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
GateVeriq is still required to validate the deployed origins and slider challenge.

## Integration checks after the v0.2.0 refactor

The browser adapter vendors `widget.js`, `worker.js` and `slider.js` together.
It supports the slider puzzle, replacement tasks after a wrong position, and the
`pow`/`pow_visual` consume results. The inline frame receives the application's
resolved theme and uses the same CSS palette, including its shadow-root slider.
Its permission is refreshed according to the backend deadline, not a fixed timer.
Expired/spent permissions return `VERIFICATION_EXPIRED`; mismatched permissions
return `VERIFICATION_FAILED`, separately from OPAQUE's `AUTH_FAILED`.
Account names accept `[A-Za-z0-9_-]{3,40}` and are normalized to lowercase
for registration, login, recipient lookup and GateVeriq binding. Registration rejects invalid usernames and email addresses
before sending the OPAQUE request, so form errors do not spend a completed check.

An opt-in real-service test uses a temporary Neruvalo database and generated test
credentials. It prepares and solves PoW, consumes it through Neruvalo, registers,
confirms the local email code, then verifies and logs in through OPAQUE. Only
GateVeriq's diagnostic challenge/outcome history is retained. Requires adaptive
register/login policies and a source that is not already blocked by risk limits:

```bash
NERUVALO_TEST_GATE_CONFIG="$PWD/neruvalo-server.toml" \
  cargo test --locked -p neruvalo-client --test gateveriq -- --ignored
```

Slider UI, locale, theme propagation and deadline behavior are covered by
`verificationWidget.test.ts` and `VerificationInline.test.tsx`. A manual WebView
check is still required for real pointer/touch interaction and visual matching.
