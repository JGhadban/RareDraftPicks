// Card size slider. Loaded in <head> so a saved size applies before first paint.
// Sets --card-scale on <html>; the card grids in styles.css / draft.css multiply their column width by it.
(function () {
  const KEY = 'cardScale';
  const MIN = 0.6, MAX = 1.8;
  const root = document.documentElement;

  function saved() {
    try { return parseFloat(localStorage.getItem(KEY)); } catch { return NaN; }
  }

  function apply(scale) {
    root.style.setProperty('--card-scale', String(scale));
  }

  const initial = saved();
  const start = initial >= MIN && initial <= MAX ? initial : 1;
  apply(start);

  document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('card-size');
    if (!input) return;
    input.value = String(start);
    input.addEventListener('input', () => {
      apply(input.value);
      try { localStorage.setItem(KEY, input.value); } catch {}
    });
    // Double-click resets to the default size.
    input.addEventListener('dblclick', () => {
      input.value = '1';
      apply(1);
      try { localStorage.removeItem(KEY); } catch {}
    });
  });
})();
