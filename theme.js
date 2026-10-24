// Light/dark toggle. Loaded in <head> so a saved choice applies before first paint.
// With no saved choice the page follows the OS setting (prefers-color-scheme in styles.css).
(function () {
  const KEY = 'theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }

  function current() {
    return root.dataset.theme || (media.matches ? 'dark' : 'light');
  }

  function render() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const next = current() === 'dark' ? 'light' : 'dark';
    btn.textContent = next === 'dark' ? '☾ Dark' : '☀ Light';
    btn.title = `Switch to ${next} mode`;
  }

  const initial = saved();
  if (initial === 'light' || initial === 'dark') root.dataset.theme = initial;

  media.addEventListener('change', render);

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    render();
    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch {}
      render();
    });
  });
})();
