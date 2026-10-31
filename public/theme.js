(() => {
  'use strict';
  const themes = [
    { id: 'sage', name: 'Zsályazöld', color: '#0c1519' },
    { id: 'blue', name: 'Pasztellkék', color: '#101923' },
    { id: 'coral', name: 'Korallpiros', color: '#201619' }
  ];
  let selected = 'sage';
  try { const saved = localStorage.getItem('nolege:theme'); if (themes.some(theme => theme.id === saved)) selected = saved; } catch {}
  function apply(id, save = false) {
    const theme = themes.find(theme => theme.id === id) || themes[0]; selected = theme.id;
    document.documentElement.dataset.theme = selected;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      const active = button.dataset.themeChoice === selected;
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('.theme-check').textContent = active ? '✓' : '';
    });
    if (save) { try { localStorage.setItem('nolege:theme', selected); } catch {} }
  }
  apply(selected);
  document.addEventListener('DOMContentLoaded', () => {
    for (const picker of document.querySelectorAll('[data-theme-switcher]')) {
      for (const theme of themes) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = `theme-choice swatch-${theme.id}`; button.dataset.themeChoice = theme.id;
        button.title = theme.name; button.setAttribute('aria-label', theme.name);
        const check = document.createElement('span'); check.className = 'theme-check'; check.setAttribute('aria-hidden', 'true');
        button.append(check); button.addEventListener('click', () => apply(theme.id, true)); picker.append(button);
      }
    }
    apply(selected);
  });
  window.addEventListener('storage', event => { if (event.key === 'nolege:theme') apply(event.newValue); });
})();
