// Runs in <head>, before the first paint: applies the saved theme and sidebar
// width so the first frame already looks right.
(() => {
  try {
    const p = JSON.parse(localStorage.getItem('finder-win:prefs') || '{}');
    if (p.theme === 'light' || p.theme === 'dark') document.documentElement.dataset.theme = p.theme;
    if (p.sidebarW) document.documentElement.style.setProperty('--sidebar-w', `${p.sidebarW}px`);
  } catch { /* storage unavailable */ }
})();
