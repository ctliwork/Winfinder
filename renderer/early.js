// Runs in <head>, before the first paint: applies the saved theme and sidebar
// width so the first frame already looks right.
(() => {
  try {
    // Saved under the app's earlier name (finder-win) before: move it over once.
    const old = localStorage.getItem('finder-win:prefs');
    if (old !== null) {
      if (localStorage.getItem('winfinder:prefs') === null) localStorage.setItem('winfinder:prefs', old);
      localStorage.removeItem('finder-win:prefs');
    }
    const p = JSON.parse(localStorage.getItem('winfinder:prefs') || '{}');
    if (p.theme === 'light' || p.theme === 'dark') document.documentElement.dataset.theme = p.theme;
    if (p.sidebarW) document.documentElement.style.setProperty('--sidebar-w', `${p.sidebarW}px`);
  } catch { /* storage unavailable */ }
})();
