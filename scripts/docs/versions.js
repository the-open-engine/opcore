'use strict';

(() => {
  const control = document.querySelector('.docs-version');
  if (!control) return;
  const select = control.querySelector('select');
  const siteRoot = new URL(control.dataset.siteRoot, location.href);
  const versionName = /^(dev|v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))$/;

  async function loadVersions() {
    const response = await fetch(new URL('versions.json', siteRoot));
    if (!response.ok) return;
    const entries = await response.json();
    if (!Array.isArray(entries) || !entries.every(entry => versionName.test(entry.version))) return;
    select.replaceChildren();
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.version;
      option.textContent = entry.title + (entry.aliases.includes('stable') ? ' (stable)' : '');
      option.selected = entry.version === control.dataset.version;
      select.append(option);
    }
    select.hidden = false;
    control.querySelector('a').hidden = true;
  }

  select.addEventListener('change', async () => {
    if (!versionName.test(select.value)) return;
    select.disabled = true;
    const versionRoot = new URL(select.value + '/', siteRoot);
    let target = new URL(control.dataset.pagePath, versionRoot);
    try {
      const response = await fetch(target, { method: 'HEAD' });
      if (!response.ok) target = new URL('index.html', versionRoot);
    } catch {
      target = new URL('index.html', versionRoot);
    }
    target.search = location.search;
    target.hash = location.hash;
    location.assign(target.href);
  });

  loadVersions().catch(() => {
    // The static version list remains usable when fetch or JavaScript is unavailable.
  });
})();
