// Apply a saved preference before paint; default to the operating system theme.
(() => {
  const root = document.documentElement;
  root.classList.add('js');
  root.dataset.themeChoice = 'system';
  try {
    const theme = localStorage.getItem('opcore-docs-theme');
    if (theme === 'light' || theme === 'dark') {
      root.dataset.themeChoice = theme;
    }
  } catch {
    // Documentation still works when browser storage is disabled.
  }
  root.dataset.theme = root.dataset.themeChoice === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : root.dataset.themeChoice;
})();
