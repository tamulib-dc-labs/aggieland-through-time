import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const BASE_PATH = process.env.CANOPY_BASE_PATH || '';

// ── 1. Patch hardcoded API paths in canopy-custom-components.js ──────────────
//    Only needed when deploying under a sub-path.

if (BASE_PATH) {
  const jsFile = join(process.cwd(), 'site', 'scripts', 'canopy-custom-components.js');
  let src = readFileSync(jsFile, 'utf8');

  const jsReplacements = [
    [/fetch\("\/api\/navplace\.json"\)/g,        `fetch("${BASE_PATH}/api/navplace.json")`],
    [/fetch\("\/api\/search-records\.json"\)/g,  `fetch("${BASE_PATH}/api/search-records.json")`],
    [/fetch\("\/api\/search-index\.json"\)/g,    `fetch("${BASE_PATH}/api/search-index.json")`],
    [/h\.href="\/scripts\/canopy-map\.css"/g,    `h.href="${BASE_PATH}/scripts/canopy-map.css"`],
  ];

  let jsCount = 0;
  for (const [pattern, replacement] of jsReplacements) {
    const before = src;
    src = src.replace(pattern, replacement);
    if (src !== before) jsCount++;
  }
  writeFileSync(jsFile, src);
  console.log(`[patch] Patched ${jsCount} hardcoded path(s) in canopy-custom-components.js with base path "${BASE_PATH}".`);

  // ── Fix double base-path application in canopy-search-form.js ────────────────
  // The canopy package's withBase()/L() function is called twice on every search
  // result href: once in loadRecords() and again in renderList(). Without an
  // idempotency guard, a second call doubles the base path segment
  // (e.g. /aggieland-through-time/aggieland-through-time/works/...).
  // We add the guard here because the runtime JS ships without it.
  const sfFile = join(process.cwd(), 'site', 'scripts', 'canopy-search-form.js');
  let sfSrc = readFileSync(sfFile, 'utf8');
  const SF_OLD = 'if(/^https?:/i.test(n))return n;let d=n.replace(/^\\/+/,"");return`${l}/${d}`';
  const SF_NEW = 'if(/^https?:/i.test(n))return n;if(n===l||n.startsWith(l+"/"))return n;let d=n.replace(/^\\/+/,"");return`${l}/${d}`';
  const sfPatched = sfSrc.split(SF_OLD).join(SF_NEW);
  const sfFixed = sfPatched !== sfSrc;
  writeFileSync(sfFile, sfPatched);
  console.log(sfFixed
    ? '[patch] Fixed withBase() idempotency in canopy-search-form.js (prevents doubled base path in typeahead).'
    : '[patch] WARNING: could not locate withBase() pattern in canopy-search-form.js — typeahead URLs may be doubled.');
} else {
  console.log('[patch] No CANOPY_BASE_PATH set — skipping JS path patch (dev mode).');
}

// ── 2. Cache-bust the site stylesheet ─────────────────────────────────────────
//    Canopy links /styles/styles.css with no version, and the CDN in front of
//    the site caches it for hours, so after a deploy visitors could get new
//    HTML with old CSS. Append a hash of the stylesheet's contents to every
//    page's link so the URL changes whenever the CSS does.

//    Production builds only (CANOPY_BASE_PATH set): `npm run dev` also runs
//    this script, and the dev server needs its pages left as Canopy wrote them.

const siteDir = join(process.cwd(), 'site');
const cssFile = join(siteDir, 'styles', 'styles.css');
if (!BASE_PATH) {
  console.log('[patch] No CANOPY_BASE_PATH set — skipping stylesheet versioning (dev mode).');
} else if (existsSync(cssFile)) {
  const cssHash = createHash('sha256').update(readFileSync(cssFile)).digest('hex').slice(0, 10);
  const linkPattern = /(href="[^"]*\/styles\/styles\.css)(\?v=[^"]*)?"/g;

  const htmlFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.html')) htmlFiles.push(p);
    }
  };
  walk(siteDir);

  let pageCount = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(file, 'utf8');
    const patched = html.replace(linkPattern, `$1?v=${cssHash}"`);
    if (patched !== html) {
      writeFileSync(file, patched);
      pageCount++;
    }
  }
  console.log(`[patch] Versioned styles.css (?v=${cssHash}) in ${pageCount} page(s).`);
} else {
  console.log('[patch] No site/styles/styles.css found — skipping stylesheet versioning.');
}
