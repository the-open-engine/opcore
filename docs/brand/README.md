# Opcore README banners

Editable HTML/CSS sources and rendered light/dark PNGs for the repository README.
The design follows [The Open Engine](https://theopenengine.com) and
[Zeroshot](https://zeroshot.sh), inspected on October 2, 2026: warm paper,
handwritten headings and diagrams, yellow notes, and the company mascot.

## Files

- `opcore-hero-light.html` and `opcore-hero-dark.html`: source layouts.
- `hero.css`: shared layout and theme tokens.
- `opcore-hero-light.png` and `opcore-hero-dark.png`: 2560 × 800 exports
  from a 1280 × 400 canvas at 2× scale.
- `assets/`: local fonts, font licenses, and the website mascot. Rendering needs
  no network requests.

## Design

Reenie Beanie is the handwriting face; Fraunces 600 is the company wordmark.
The light palette uses paper `#FAF7F1`, pen ink `#26221C`, and rust `#C2240C`.
Dark mode uses `#171411`, cream text, and the documentation theme's lighter rust
`#ED6B55` for readable accents. Notes retain yellow paper and dark ink in both themes.
The diagrams illustrate each product's feedback loop, rather than runtime status.

## Re-render

From the repository root, install rendering tools outside the product dependencies:

```sh
npm install --prefix /tmp/open-engine-banner-tools playwright@1.61.0
/tmp/open-engine-banner-tools/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/open-engine-banner-tools/node_modules node <<'JS'
const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 400 },
      deviceScaleFactor: 2,
    });
    for (const theme of ['light', 'dark']) {
      const stem = resolve(`docs/brand/opcore-hero-${theme}`);
      await page.goto(pathToFileURL(`${stem}.html`).href);
      await page.evaluate(() => document.fonts.ready);
      const ready = await page.evaluate(() =>
        [...document.fonts].every(font => font.status === 'loaded') &&
        [...document.images].every(image => image.complete && image.naturalWidth > 0)
      );
      if (!ready) throw new Error('Banner assets failed to load');
      await page.locator('.hero').screenshot({ path: `${stem}.png` });
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```

Review both exports at full resolution and README display width before committing.

## Asset provenance

- `assets/oec-mascot.png`: unchanged copy of
  `company/content/brand/logos/open-engine-mascot-website.png`, originally from
  <https://theopenengine.com/landing/oec-mascot.png>.
- Fonts: Google Fonts' Fraunces 600 (optical-size variable) and Reenie Beanie 400,
  downloaded October 2, 2026. Their SIL Open Font Licenses are bundled beside them.
  Upstream: [Fraunces](https://github.com/google/fonts/tree/main/ofl/fraunces),
  [Reenie Beanie](https://github.com/google/fonts/tree/main/ofl/reeniebeanie).

## Workflow diagrams

The hook loop and ASP diagrams include desktop and mobile layouts.
Editable SVG labels and shapes live in `diagram-sources/`. Run the exporter after
editing them:

```sh
python3 -m venv /tmp/open-engine-diagram-tools
/tmp/open-engine-diagram-tools/bin/pip install fonttools==4.63.0
/tmp/open-engine-diagram-tools/bin/python docs/brand/outline-diagrams.py
```

Exports land in `docs/assets/`. Text becomes vector paths, retaining accessible
labels, so GitHub needs no external fonts. Each SVG supports light and dark mode.
Review both themes after changes, including the mobile layouts where supplied.
Body text uses [Spline Sans](https://github.com/google/fonts/tree/main/ofl/splinesans),
with its SIL Open Font License bundled in `assets/`.

## Discord button

`social/buttons.html` is the source for the README's Discord call to action: a filled
rust button in the same style as the Zeroshot README's social row. Exports are 70 px
tall (35 px at 2×) and are displayed at `height="30"`.

Re-render both themes with the Playwright install above:

```sh
NODE_PATH=/tmp/open-engine-banner-tools/node_modules node <<'JS'
const { chromium } = require('playwright');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 160 }, deviceScaleFactor: 2 });
    for (const theme of ['light', 'dark']) {
      await page.goto(pathToFileURL(resolve('docs/brand/social/buttons.html')).href);
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await page.evaluate(() => document.fonts.ready);
      for (const id of ['discord-cta']) {
        await page.locator(`#${id}`).screenshot({
          path: resolve(`docs/brand/social/${id}-${theme}.png`),
          omitBackground: true,
        });
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```
