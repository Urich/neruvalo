// Shadow DOM keeps host application styles from changing the slider layout.
// Inherited --gateveriq-* variables remain available for application themes.
export const sliderCSS = `
:host{--gv-background:var(--gateveriq-background,#fff);--gv-text:var(--gateveriq-text,#253342);--gv-muted:var(--gateveriq-muted,#6c7a89);--gv-border:var(--gateveriq-border,#e2e7ed);--gv-surface:var(--gateveriq-surface,#f2f5f8);--gv-accent:var(--gateveriq-accent,#3569e8);--gv-radius:var(--gateveriq-radius,14px);display:block;width:304px;max-width:100%;color-scheme:light;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
:host([data-theme=dark]){--gv-background:var(--gateveriq-background,#19212e);--gv-text:var(--gateveriq-text,#e6edf7);--gv-muted:var(--gateveriq-muted,#9baac0);--gv-border:var(--gateveriq-border,#334155);--gv-surface:var(--gateveriq-surface,#242f40);--gv-accent:var(--gateveriq-accent,#85acff);color-scheme:dark}
@media(prefers-color-scheme:dark){:host([data-theme=auto]){--gv-background:var(--gateveriq-background,#19212e);--gv-text:var(--gateveriq-text,#e6edf7);--gv-muted:var(--gateveriq-muted,#9baac0);--gv-border:var(--gateveriq-border,#334155);--gv-surface:var(--gateveriq-surface,#242f40);--gv-accent:var(--gateveriq-accent,#85acff);color-scheme:dark}}
*{box-sizing:border-box}
.card{padding:12px;border-radius:var(--gv-radius);background:var(--gv-background);color:var(--gv-text)}
.heading{margin:0 0 9px;font-size:12px;font-weight:600;letter-spacing:.01em}
.stage{display:block;width:100%;height:auto;border-radius:8px;background:var(--gv-surface);user-select:none}
.track{direction:ltr;position:relative;height:40px;margin-top:10px;border:1px solid var(--gv-border);border-radius:8px;background:var(--gv-surface);overflow:hidden;cursor:grab;touch-action:pan-y;user-select:none}
.track:active{cursor:grabbing}
.track:has(input:disabled){cursor:default}
.track-label{position:absolute;inset:0;display:grid;place-items:center;color:var(--gv-muted);font-size:11px;pointer-events:none}
.handle{position:absolute;left:var(--slider-progress,0%);transform:translateX(calc(0% - var(--slider-progress,0%)));inset-block:2px;width:34px;display:grid;place-items:center;border-radius:5px;background:var(--gv-background);border:1px solid var(--gv-border);color:var(--gv-accent);font-size:20px;box-shadow:0 1px 3px #0001;pointer-events:none}
input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none}
.track:has(input:focus-visible){border-color:var(--gv-accent);box-shadow:0 0 0 1px var(--gv-accent)}
.note{margin:9px 0 0;color:var(--gv-muted);font-size:11px}
.note:empty{margin:0}
.card[data-state=error] .note{color:var(--gv-text)}
.card[data-state=success]{display:flex;align-items:center;gap:8px;min-height:52px}
.success-icon{font-size:18px;color:var(--gv-accent)}
@media(forced-colors:active){.handle,.track{border:1px solid ButtonText}.handle{color:ButtonText}}
`;

export function sliderStage({width, height, piece_size: size, piece_y: top}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  canvas.width = width;
  canvas.height = height;
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) return null;

  function draw(background, piece, position) {
    context.drawImage(background, 0, 0, width, height);
    context.drawImage(piece, position, top, size, size);
  }

  return {canvas, draw};
}

export function sliderRoot(element, theme = 'auto', styleNonce) {
  const host = document.createElement('div');
  host.className = 'gateveriq-slider';
  const preset = typeof theme === 'string' ? theme : theme?.preset || 'auto';
  host.setAttribute('data-theme', ['light', 'dark', 'auto'].includes(preset) ? preset : 'auto');
  const properties = {background:'background', text:'text', muted:'muted', border:'border',
    surface:'surface', accent:'accent', radius:'radius'};
  if (theme && typeof theme === 'object') {
    for (const [key, property] of Object.entries(properties)) {
      const value = theme[key];
      const cssProperty = key === 'radius' ? 'border-radius' : 'color';
      if (typeof value === 'string' && globalThis.CSS?.supports(cssProperty, value)) {
        host.style.setProperty(`--gateveriq-${property}`, value);
      }
    }
  }
  const root = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  if (styleNonce) style.nonce = styleNonce;
  style.textContent = sliderCSS;
  root.append(style);
  element.replaceChildren(host);
  return root;
}

export function sliderState(element, message, state = 'busy') {
  const root = element.querySelector('.gateveriq-slider')?.shadowRoot;
  if (!root) return;
  const card = root.querySelector('.card');
  card?.setAttribute('data-state', state);
  card?.setAttribute('aria-busy', String(state === 'busy'));
  const note = root.querySelector('.note');
  if (note) note.textContent = message;
  const range = root.querySelector('input[type="range"]');
  if (range) range.disabled = true;
  if (state === 'success') {
    const icon = document.createElement('span'); icon.className = 'success-icon';
    icon.textContent = '✓'; icon.setAttribute('aria-hidden','true');
    const label = document.createElement('span'); label.textContent = message;
    card.replaceChildren(icon,label);
  }
}
