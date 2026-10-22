// Runs in <head>, before the first paint: applies the saved theme and keeps
// the sidebar opaque until the window's Mica backdrop is in place, so the
// translucent sidebar never shows a white flash at startup.
(() => {
  try {
    const p = JSON.parse(localStorage.getItem('finder-win:prefs') || '{}');
    if (p.theme === 'light' || p.theme === 'dark') document.documentElement.dataset.theme = p.theme;
    if (p.sidebarW) document.documentElement.style.setProperty('--sidebar-w', `${p.sidebarW}px`);
  } catch { /* storage unavailable */ }
  document.documentElement.classList.add('booting');
})();
