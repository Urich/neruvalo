// Apply the saved palette before the application and its styles load.
(() => {
  let theme = "system";
  try {
    const saved = JSON.parse(localStorage.getItem("neruvalo.theme"));
    if (["light", "dark", "dark-green", "nord", "solarized"].includes(saved)) theme = saved;
  } catch { /* Use the system preference when storage is unavailable. */ }
  document.documentElement.dataset.theme = theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
})();
