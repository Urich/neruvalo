Vendored browser assets from GateVeriq, commit
de89988f2f6611749cdbef5615b1457ca1679185 (2026-11-05).
Source: F:/usc/gateveriq/web/{widget.js,worker.js}.
Keep both files together when updating; the widget resolves its worker relatively.

Local customization in widget.js: activationLabel translates "I am human" into
all application languages. verifyWebsiteAttempt keeps the original locale for
activation; visual challenges retain GateVeriq's locale resolution. Preserve
these changes when updating the vendored widget. Checkbox styling belongs to
verification.html.

Messages and errors for all application languages are shared in messages.json.
The server embeds this catalog into verification.html and the desktop imports
it into i18n. configureMessages configures the vendored widget from this catalog.
Preserve the localized PoW status texts and locale resolution when updating.
