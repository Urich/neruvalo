import { useEffect } from "react";
// Supply a localized explanation when a control has no specific reason.
export function useDisabledHints(fallback: string) {
  useEffect(() => {
    // Do not alter React's DOM ownership: annotate the controls themselves.
    const annotate = () => document.querySelectorAll<HTMLButtonElement>('button:disabled').forEach(button => {
      if (!button.title || button.title === button.dataset.fallbackHint) { button.title = fallback; button.dataset.fallbackHint = fallback; }
    });
    annotate();
    const observer = new MutationObserver(annotate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, [fallback]);
}
