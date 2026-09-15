'use strict';

const root = document.documentElement;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const themeButton = document.querySelector('.theme-toggle');

function isDark() {
  return root.dataset.theme ? root.dataset.theme === 'dark' : systemTheme.matches;
}

function updateThemeLabel() {
  const label = isDark() ? 'Use light mode' : 'Use dark mode';
  themeButton.setAttribute('aria-label', label);
  themeButton.title = label;
}

themeButton.addEventListener('click', () => {
  root.dataset.theme = isDark() ? 'light' : 'dark';
  root.dataset.themeChoice = root.dataset.theme;
  try {
    localStorage.setItem('opcore-docs-theme', root.dataset.theme);
  } catch {
    // The toggle also works without persistent storage.
  }
  updateThemeLabel();
});
systemTheme.addEventListener('change', () => {
  if (root.dataset.themeChoice === 'system') {
    root.dataset.theme = systemTheme.matches ? 'dark' : 'light';
  }
  updateThemeLabel();
});
updateThemeLabel();

const menuButton = document.querySelector('.menu-toggle');
function closeMenu() {
  delete root.dataset.navOpen;
  menuButton.setAttribute('aria-expanded', 'false');
}
menuButton.addEventListener('click', () => {
  const open = root.dataset.navOpen !== 'true';
  root.dataset.navOpen = String(open);
  menuButton.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && root.dataset.navOpen === 'true') {
    closeMenu();
    menuButton.focus();
  }
});
document.querySelectorAll('#site-navigation a').forEach((link) => {
  link.addEventListener('click', closeMenu);
});

function addCopyButton(pre) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-code';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy code');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code').textContent);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select to copy';
    }
    window.setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  });
  pre.parentElement.classList.add('code-container');
  pre.parentElement.append(button);
}
if (navigator.clipboard) {
  document.querySelectorAll('.guide-content .example-wrap > pre').forEach(addCopyButton);
}
