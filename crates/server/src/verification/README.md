Vendored browser assets from GateVeriq v0.2.0, commit
f7b2b4f (current local upstream checkout): web/{widget.js,worker.js,slider.js}.
Keep all three files together when updating: widget.js imports slider.js and
resolves worker.js relatively. All are embedded and served by Neruvalo.

Neruvalo customizations in widget.js: activationLabel and configureMessages use
all eleven application languages, including slider labels and PoW states.
Preserve explicit locale resolution and localized success/error/loading states.
The current upstream visual protocol is slider_puzzle; image selection is obsolete.

Checkbox styling belongs to verification.html. It loads the application's shared
themes.css and maps its variables to --gateveriq-* for the slider shadow root.
The desktop passes its resolved theme and listens for slider-host insertion to
open the existing iframe in a modal without restarting verification.

Messages and errors for all application languages are shared in messages.json.
The server embeds this catalog into verification.html and the desktop imports
it into i18n. configureMessages configures the vendored widget from this catalog.
Preserve the localized PoW status texts and locale resolution when updating.
