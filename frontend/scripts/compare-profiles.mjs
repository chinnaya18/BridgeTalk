/**
 * Bug 5 — reproduce the incognito layout break with automated screenshots.
 *
 * WHY A FRESH CONTEXT IS A FAIR STAND-IN FOR INCOGNITO
 * ---------------------------------------------------
 * A fresh Playwright browser context has no cache, no cookies and no local
 * storage, which is exactly the state an incognito window starts in. It is not
 * identical — incognito also resets per-site zoom and blocks some storage APIs
 * — so this script additionally exercises zoom levels and widths.
 *
 * WHAT IT DOES
 * ------------
 *   warm  — one context visits every page twice, so the second visit has the
 *           fonts and assets cached, like a normal profile that has used the
 *           app before.
 *   cold  — a BRAND NEW context per page, with an empty cache, like incognito.
 *
 * Then it compares the two pixel buffers and reports the difference. A layout
 * that depends on a cached font or a stored preference shows up as a large
 * difference; a correct layout shows a near-zero one.
 *
 * Usage (both servers must already be running):
 *   node scripts/compare-profiles.mjs
 *   node scripts/compare-profiles.mjs --out shots-after
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const BASE = process.env.BRIDGETALK_URL ?? 'http://localhost:5173';
const API = process.env.BRIDGETALK_API ?? 'http://localhost:8000';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'screenshots';

const EMAIL = process.env.BRIDGETALK_EMAIL ?? 'deaf.demo@example.com';
const PASSWORD = process.env.BRIDGETALK_PASSWORD ?? 'bridgetalk123';

const WIDTHS = [1024, 1280, 1920];

/**
 * `--block-fonts` aborts every request to Google's font CDN.
 *
 * THIS IS THE DECISIVE EXPERIMENT FOR BUG 5.
 *
 * Waiting for `document.fonts.ready` and then screenshotting shows no
 * difference between a warm and a cold profile — because that wait is for
 * exactly the thing that causes the bug. The reported symptom happens in the
 * window BEFORE the webfont arrives, and on a restricted or flaky network it
 * never arrives at all.
 *
 * Blocking the CDN reproduces the worst case deterministically, and it is also
 * the state the fix has to survive: once the fonts are served from our own
 * origin, blocking Google's CDN must make no difference whatsoever.
 */
const BLOCK_FONTS = process.argv.includes('--block-fonts');
const ZOOMS = [0.8, 1, 1.25];

/** Sign in through the API and hand the token to the page before it loads. */
async function authenticate() {
  const response = await fetch(`${API}/api/auth/login/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not sign in as ${EMAIL} (HTTP ${response.status}). ` +
        'Is the backend running and the database seeded?',
    );
  }
  const body = await response.json();
  return { token: body.access_token, meetingCode: null };
}

async function firstMeetingCode(token) {
  const response = await fetch(`${API}/api/meetings/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const rows = await response.json();
  return rows[0]?.code ?? null;
}

/**
 * Capture one page.
 *
 * `fresh` controls whether a new context is used. The token is injected via an
 * init script so the page is authenticated without going through the login
 * form, which would itself differ between a warm and a cold profile.
 */
async function capture(browser, { path, token, width, zoom, fresh, warmUp }) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    // A cold context is the default; a warm one gets a priming visit below.
  });

  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('bridgetalk.token', value);
    } catch {
      /* storage blocked; the page will show the login screen, which is itself
         a difference worth seeing */
    }
  }, token);

  if (BLOCK_FONTS) {
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  }

  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);

  if (zoom !== 1) {
    await page.addInitScript((factor) => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.zoom = String(factor);
      });
    }, zoom);
  }

  // `networkidle` is NOT usable here. The app opens three WebSockets and keeps
  // them open, so the network never goes idle and every goto times out at 30s.
  // `domcontentloaded` plus an explicit font wait is both faster and more
  // precise about the thing a cold profile actually lacks.
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded');
    if (!BLOCK_FONTS) {
      try {
        await page.evaluate(() => document.fonts.ready);
      } catch {
        /* a navigation raced the evaluate; the timeout below still covers it */
      }
    }
    await page.waitForTimeout(fresh ? 600 : 900);
  };

  if (warmUp) {
    // Prime the cache the way a returning user's profile would be.
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await settle();
  }

  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await settle();

  const buffer = await page.screenshot({ fullPage: false });
  const marks = await fingerprint(page);
  await context.close();
  return { buffer, marks };
}

/**
 * Fraction of PIXELS that differ, plus a diff image.
 *
 * The first version of this compared PNG *encoded bytes*, which is useless:
 * PNG is compressed, so a one-pixel change can alter many bytes and any size
 * change reads as 100% different. That is exactly what it reported, and the
 * number meant nothing.
 */
function pixelDifference(bufferA, bufferB) {
  const a = PNG.sync.read(bufferA);
  const b = PNG.sync.read(bufferB);

  if (a.width !== b.width || a.height !== b.height) {
    return { fraction: 1, note: `size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`, diff: null };
  }

  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0.1,
    includeAA: false,
  });

  return {
    fraction: differing / (a.width * a.height),
    note: null,
    diff: PNG.sync.write(diff),
  };
}

/**
 * A LAYOUT FINGERPRINT, which is what the reported bug actually is.
 *
 * "The text and icons are misaligned" is a layout statement, not a colour one.
 * Reading the bounding boxes straight out of the DOM says precisely whether
 * anything moved, and — unlike a pixel diff — it says WHICH element moved and
 * by how much. It also reports whether the icon font is loaded, which is the
 * suspected cause.
 */
async function fingerprint(page) {
  return page.evaluate(() => {
    const round = (n) => Math.round(n);
    const boxes = {};

    // A stable, meaningful sample: the chrome, the headings, and every icon.
    const selectors = {
      topbar: 'header',
      heading: 'h1',
      firstButton: 'button',
      firstIcon: '.material-symbols-outlined',
    };

    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element) {
        boxes[name] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      boxes[name] = {
        x: round(rect.x), y: round(rect.y),
        w: round(rect.width), h: round(rect.height),
      };
    }

    // Every icon's box, so a font that loads late and resizes them is visible.
    const icons = [...document.querySelectorAll('.material-symbols-outlined')].map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return { w: round(rect.width), h: round(rect.height) };
      },
    );

    const iconElement = document.querySelector('.material-symbols-outlined');
    const bodyFont = getComputedStyle(document.body).fontFamily;

    return {
      boxes,
      iconCount: icons.length,
      // The tell: if the icon font has not loaded, the glyph boxes are the
      // wrong width and everything beside them shifts.
      iconBoxes: icons.slice(0, 12),
      iconFontLoaded: document.fonts.check('24px "Material Symbols Outlined"'),
      robotoLoaded: document.fonts.check('16px Roboto'),
      bodyFontFamily: bodyFont,
      iconFontFamily: iconElement ? getComputedStyle(iconElement).fontFamily : null,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      // A horizontal scrollbar at a desktop width means something overflowed.
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { token } = await authenticate();
  const code = await firstMeetingCode(token);

  const pages = [
    { name: 'home', path: '/' },
    { name: 'history', path: '/history' },
    { name: 'lobby', path: code ? `/lobby/${code}` : '/' },
    { name: 'meeting', path: code ? `/meeting/${code}` : '/' },
    { name: 'transcript', path: code ? `/history/${code}` : '/' },
  ];

  const browser = await chromium.launch();
  const results = [];

  for (const target of pages) {
    for (const width of WIDTHS) {
      // Per-capture isolation: one page that will not settle must not abort
      // the whole comparison, or a single slow route hides every other result.
      let warm;
      let cold;
      try {
        warm = await capture(browser, {
          path: target.path, token, width, zoom: 1, fresh: false, warmUp: true,
        });
        cold = await capture(browser, {
          path: target.path, token, width, zoom: 1, fresh: true, warmUp: false,
        });
      } catch (error) {
        results.push({
          page: target.name, width, zoom: 1, delta: null,
          error: error.message.split('\n')[0],
        });
        continue;
      }

      const { fraction, note, diff } = pixelDifference(warm.buffer, cold.buffer);
      const layoutSame =
        JSON.stringify(warm.marks.boxes) === JSON.stringify(cold.marks.boxes) &&
        JSON.stringify(warm.marks.iconBoxes) === JSON.stringify(cold.marks.iconBoxes);

      results.push({
        page: target.name, width, zoom: 1,
        delta: fraction, note, layoutSame,
        coldIconFont: cold.marks.iconFontLoaded,
        coldOverflow: cold.marks.horizontalOverflow,
        warmMarks: warm.marks, coldMarks: cold.marks,
      });

      await writeFile(`${OUT}/${target.name}-${width}-warm.png`, warm.buffer);
      await writeFile(`${OUT}/${target.name}-${width}-cold.png`, cold.buffer);
      if (diff && fraction > 0) {
        await writeFile(`${OUT}/${target.name}-${width}-diff.png`, diff);
      }
    }
  }

  // Zoom sweep, cold profile only — the state the bug was reported in.
  for (const target of pages) {
    for (const zoom of ZOOMS) {
      try {
        const shot = await capture(browser, {
          path: target.path, token, width: 1280, zoom, fresh: true, warmUp: false,
        });
        await writeFile(
          `${OUT}/${target.name}-zoom${String(zoom).replace('.', '')}.png`,
          shot.buffer,
        );
        if (shot.marks.horizontalOverflow) {
          console.log(`  (overflow: ${target.name} at zoom ${zoom})`);
        }
      } catch (error) {
        console.log(`  (zoom ${zoom} on ${target.name} failed: ${error.message.split('\n')[0]})`);
      }
    }
  }

  await browser.close();

  console.log('');
  console.log('  page          width   pixels differ   layout same   icon font (cold)   overflow');
  console.log('  ------------  ------  -------------   -----------   ----------------   --------');
  let worst = 0;
  let layoutBroken = 0;
  let fontMissing = 0;
  let overflowed = 0;

  for (const row of results) {
    if (row.delta === null) {
      console.log(`  ${row.page.padEnd(12)}  ${String(row.width).padEnd(6)}  ERROR  ${row.error}`);
      continue;
    }
    worst = Math.max(worst, row.delta);
    if (!row.layoutSame) layoutBroken += 1;
    if (!row.coldIconFont) fontMissing += 1;
    if (row.coldOverflow) overflowed += 1;

    console.log(
      `  ${row.page.padEnd(12)}  ${String(row.width).padEnd(6)}  ` +
        `${(row.delta * 100).toFixed(2).padStart(8)}%   ` +
        `${(row.layoutSame ? 'yes' : 'NO ').padEnd(11)}   ` +
        `${(row.coldIconFont ? 'loaded' : 'NOT LOADED').padEnd(16)}   ` +
        `${row.coldOverflow ? 'YES' : 'no'}` +
        (row.note ? `   (${row.note})` : ''),
    );
  }

  await writeFile(`${OUT}/report.json`, JSON.stringify(results, null, 2));

  console.log('');
  console.log(`  worst pixel difference : ${(worst * 100).toFixed(2)}%`);
  console.log(`  layouts that differ    : ${layoutBroken} of ${results.length}`);
  console.log(`  icon font not loaded   : ${fontMissing} of ${results.length} (cold profile)`);
  console.log(`  horizontal overflow    : ${overflowed} of ${results.length}`);
  console.log(`  screenshots + report.json in ${OUT}/`);
  if (BLOCK_FONTS) {
    console.log('  (font CDN was BLOCKED for this run)');
  }
  console.log('');

  // The gate is LAYOUT, not pixels. A pixel diff on a live video page is
  // meaningless — the camera frame changes between shots. A layout that moves
  // between a warm and a cold profile is the actual bug.
  process.exit(layoutBroken > 0 || fontMissing > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`\n  ${error.message}\n`);
  process.exit(2);
});
