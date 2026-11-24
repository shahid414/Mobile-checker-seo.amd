// api/render.js — Vercel serverless function
// Real mobile-browser check: renders the target URL in headless Chromium at a
// 390x844 mobile viewport and measures what static HTML analysis cannot see:
// actual horizontal overflow (which element, how wide, how far past the
// viewport), visible tap targets, smallest rendered font size, and CLS.
// Uses @sparticuz/chromium + playwright-core, the serverless-compatible
// Chromium build. Runs on a tight internal budget (8s) so it fits Vercel's
// 10s Hobby limit; slow pages fall back to the static check instead of
// timing out the whole test.

const chromium = require('@sparticuz/chromium');
const { chromium: pw } = require('playwright-core');

const VW = 390;
const VH = 844;
const BUDGET_MS = 8000; // leave headroom under Vercel's 10s Hobby limit
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// SSRF guard: only public http(s) hosts, no localhost / private ranges.
function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

const MEASURE_FN = (vw) => {
  const docW = document.documentElement.scrollWidth;
  const bodyW = document.body.scrollWidth;
  const items = [];
  const seen = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    // Intentionally hidden off-screen elements (honeypot inputs etc.)
    if (r.left < -1000 || r.right < -1000) return;
    const overRight = r.right - vw;
    const overLeft = -r.left;
    if (overRight > 1 || overLeft > 1) {
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (el.className && typeof el.className === 'string' && el.className.trim()) {
        sel += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      const key = sel + '|' + Math.round(r.left) + '|' + Math.round(r.width);
      if (seen.has(key)) return;
      seen.add(key);
      // Off-canvas (e.g. a closed mobile menu) is normal, not a content
      // overflow — an element counts as off-canvas when it (or a fixed
      // ancestor) sits entirely outside the viewport.
      let offCanvas = false;
      let n = el;
      while (n && n !== document.body) {
        const pcs = getComputedStyle(n);
        if (pcs.position === 'fixed') {
          const pr = n.getBoundingClientRect();
          if (pr.left >= vw || pr.right <= 0 || pr.top >= window.innerHeight || pr.bottom <= 0) offCanvas = true;
        }
        n = n.parentElement;
      }
      items.push({
        sel,
        tag: el.tagName,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        overflowPx: Math.round(Math.max(overRight, overLeft)),
        position: cs.position,
        offCanvas,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
      });
    }
  });
  items.sort((a, b) => b.overflowPx - a.overflowPx);
  const contentOverflow = items.filter((i) => !i.offCanvas);
  const offCanvas = items.filter((i) => i.offCanvas);

  // Visible, in-viewport tap targets smaller than 48px.
  const smallTaps = [];
  document.querySelectorAll('a, button, input, select, textarea, [role="button"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > vw) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (Math.min(r.width, r.height) < 48) {
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (el.className && typeof el.className === 'string' && el.className.trim()) {
        sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      smallTaps.push({
        sel,
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      });
    }
  });

  // Smallest rendered font size among visible leaf text.
  let smallest = null;
  let smallestEl = '';
  document.querySelectorAll('body *').forEach((el) => {
    if (el.children.length === 0 && (el.textContent || '').trim()) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const fs = parseFloat(cs.fontSize);
      if (fs && (smallest === null || fs < smallest)) {
        smallest = fs;
        smallestEl = el.tagName.toLowerCase() + ' "' + el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50) + '"';
      }
    }
  });

  return {
    viewportWidth: vw,
    docScrollWidth: docW,
    bodyScrollWidth: bodyW,
    hasOverflow: bodyW > vw,
    overflowPx: Math.max(0, bodyW - vw),
    contentOverflow: contentOverflow.slice(0, 8),
    contentOverflowCount: contentOverflow.length,
    offCanvas: offCanvas.slice(0, 3),
    offCanvasCount: offCanvas.length,
    smallTaps: smallTaps.slice(0, 8),
    smallTapCount: smallTaps.length,
    smallestFont: smallest,
    smallestFontEl: smallestEl,
    cls: (window.__shifts || []).reduce((a, b) => a + b, 0),
  };
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ available: false, error: 'Please enter a URL to test.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ available: false, error: 'That does not look like a valid URL.' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ available: false, error: 'Only public websites can be tested.' });
  }

  const started = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - started);
  let browser = null;

  const run = (async () => {
    browser = await pw.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const ctx = await browser.newContext({
      viewport: { width: VW, height: VH },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
      userAgent: MOBILE_UA,
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__shifts = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) window.__shifts.push(e.value);
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch (e) {}
    });
    const gotoTimeout = Math.max(1000, Math.min(6000, remaining() - 2000));
    const resp = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
    if (!resp || resp.status() >= 400) {
      throw new Error('http-' + (resp ? resp.status() : 'no-response'));
    }
    // Let JavaScript run and the page settle; never exceed the budget.
    const settle = Math.max(0, Math.min(2000, remaining() - 500));
    if (settle > 0) await page.waitForTimeout(settle);
    const measured = await page.evaluate(MEASURE_FN, VW);
    return {
      available: true,
      url: target.toString(),
      status: resp.status(),
      loadMs: Date.now() - started,
      method: 'rendered-chromium',
      viewport: { width: VW, height: VH, deviceScaleFactor: 1 },
      ...measured,
    };
  })();

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ available: false, error: 'Rendered check timed out — the page took too long to render.' }), BUDGET_MS)
  );

  let result;
  try {
    result = await Promise.race([run, timeout]);
  } catch (e) {
    result = { available: false, error: 'Rendered check could not run (' + (e.message || 'browser error') + ').' };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
  return res.status(200).json(result);
};
