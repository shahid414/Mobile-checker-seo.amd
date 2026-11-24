// api/check.js — Vercel serverless function
// Real mobile-friendliness check: fetches the target URL as a mobile browser
// and inspects the actual HTML/CSS it returns. No fake results, no API key.
// Honest limit: this is static HTML analysis (like SEOmator) — it reads the
// page code as a phone browser would; it does not execute JavaScript or
// render the page, so it cannot see tap targets that only exist after JS runs.

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 2000000; // 2 MB cap on what we read
const FETCH_TIMEOUT_MS = 6000;
const CSS_TIMEOUT_MS = 3000;
const MAX_CSS_FILES = 3;

// SSRF guard: only public http(s) hosts, no localhost / private ranges.
function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

async function fetchWithTimeout(url, ua, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, ms: Date.now() - start, html: text.slice(0, MAX_HTML_BYTES) };
  } finally {
    clearTimeout(timer);
  }
}

function countMatches(text, regex) {
  const m = text.match(regex);
  return m ? m.length : 0;
}

// Resolve up to 3 linked stylesheets and count @media rules inside them.
async function countCssMediaQueries(html, baseUrl) {
  let total = 0;
  const hrefs = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .slice(0, MAX_CSS_FILES);
  if (hrefs.length === 0) return 0;
  const jobs = hrefs.map(async (href) => {
    try {
      const abs = new URL(href, baseUrl).toString();
      const r = await fetchWithTimeout(abs, MOBILE_UA, CSS_TIMEOUT_MS);
      if (r.status >= 200 && r.status < 300) return countMatches(r.html, /@media/gi);
    } catch (e) {
      // A stylesheet that fails to load is not a mobile failure; ignore it.
    }
    return 0;
  });
  const counts = await Promise.all(jobs);
  for (const c of counts) total += c;
  return total;
}

function buildChecks(html, mobileFinalUrl, desktopFinalUrl) {
  const checks = [];

  // 1. Viewport tag (weight 30)
  const viewportMatch = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  const viewportContent = viewportMatch
    ? (viewportMatch[0].match(/content=["']([^"']*)["']/i) || [])[1] || ''
    : '';
  const hasDeviceWidth = /width\s*=\s*device-width/i.test(viewportContent);
  const hasFixedWidth = /width\s*=\s*\d{3,}/i.test(viewportContent);
  if (!viewportMatch) {
    checks.push({ id: 'viewport', label: 'Viewport tag', status: 'fail', detail: 'No viewport meta tag found — phones render this page at desktop width (980px) and shrink it.' });
  } else if (hasFixedWidth || !hasDeviceWidth) {
    checks.push({ id: 'viewport', label: 'Viewport tag', status: 'warn', detail: 'Viewport tag found but it does not use width=device-width: "' + viewportContent + '"' });
  } else {
    checks.push({ id: 'viewport', label: 'Viewport tag', status: 'pass', detail: 'width=device-width is set' + (viewportContent ? ' (' + viewportContent + ')' : '') });
  }

  // 2. Zoom allowed (weight 10)
  const maxScaleMatch = viewportContent.match(/maximum-scale\s*=\s*([0-9.]+)/i);
  const zoomLocked =
    /user-scalable\s*=\s*no/i.test(viewportContent) ||
    (maxScaleMatch !== null && parseFloat(maxScaleMatch[1]) < 2);
  if (!viewportMatch) {
    checks.push({ id: 'zoom', label: 'Pinch-to-zoom', status: 'fail', detail: 'No viewport tag, so zoom behaviour cannot be confirmed.' });
  } else if (zoomLocked) {
    checks.push({ id: 'zoom', label: 'Pinch-to-zoom', status: 'fail', detail: 'Zoom is locked (user-scalable=no or maximum-scale below 2) — visitors cannot enlarge text.' });
  } else {
    checks.push({ id: 'zoom', label: 'Pinch-to-zoom', status: 'pass', detail: 'Visitors can zoom in on the page.' });
  }

  // 3. Media queries (weight 20) — filled in by caller, placeholder here
  checks.push({ id: 'media', label: 'Responsive CSS (media queries)', status: 'pending', detail: '' });

  // 4. Font sizes (weight 15)
  const pxSizes = [...html.matchAll(/font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*px/gi)].map((m) => parseFloat(m[1]));
  if (pxSizes.length === 0) {
    checks.push({ id: 'font', label: 'Font size', status: 'pass', detail: 'No tiny fixed pixel font sizes found in the page code (sizes use rem/em or are set elsewhere).' });
  } else {
    const smallest = Math.min(...pxSizes);
    if (smallest < 12) {
      checks.push({ id: 'font', label: 'Font size', status: 'fail', detail: 'Text as small as ' + smallest + 'px found — too small to read on a phone without zooming.' });
    } else if (smallest < 16) {
      checks.push({ id: 'font', label: 'Font size', status: 'warn', detail: 'Smallest text found is ' + smallest + 'px — readable, but 16px or larger is safer on phones.' });
    } else {
      checks.push({ id: 'font', label: 'Font size', status: 'pass', detail: 'Smallest text found is ' + smallest + 'px — readable without zooming.' });
    }
  }

  // 5. Fixed-width layout risk / horizontal scroll (weight 15)
  const fixedWidth = /(?:width|min-width)\s*:\s*(?:9[0-9]{2}|1[0-9]{3,})\s*px/i.test(html);
  if (fixedWidth) {
    checks.push({ id: 'fixed', label: 'Horizontal scroll risk', status: 'fail', detail: 'Fixed widths of 900px or more found in the code — content can spill off a phone screen.' });
  } else {
    checks.push({ id: 'fixed', label: 'Horizontal scroll risk', status: 'pass', detail: 'No wide fixed widths found in the page code.' });
  }

  // 6. Title + H1 (weight 10)
  const hasTitle = /<title[^>]*>[^<]{3,}<\/title>/i.test(html);
  const hasH1 = /<h1[\s>]/i.test(html);
  if (hasTitle && hasH1) {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: 'pass', detail: 'The page has both a title and an H1 heading.' });
  } else if (hasTitle || hasH1) {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: 'warn', detail: hasTitle ? 'Title found, but no H1 heading.' : 'H1 found, but no title tag.' });
  } else {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: 'fail', detail: 'Neither a title tag nor an H1 heading was found.' });
  }

  // 7. Separate mobile site? (info only, not scored)
  let mobileHost = '';
  let desktopHost = '';
  try { mobileHost = new URL(mobileFinalUrl).hostname; } catch (e) {}
  try { desktopHost = new URL(desktopFinalUrl).hostname; } catch (e) {}
  if (mobileHost && desktopHost && mobileHost !== desktopHost) {
    checks.push({ id: 'redirect', label: 'Mobile redirect', status: 'warn', detail: 'Phones are sent to a different host (' + mobileHost + ') than desktop (' + desktopHost + ') — a separate mobile site.' });
  } else {
    checks.push({ id: 'redirect', label: 'Mobile redirect', status: 'pass', detail: 'Phones and desktop get the same site (no separate mobile host).' });
  }

  // 8. Tap targets — cannot be measured from static HTML; a real browser
  // render is required. Marked not-tested, never assumed to pass.
  checks.push({ id: 'taps', label: 'Tap target size', status: 'not-tested', detail: 'Not measured — tap targets can only be measured while a page renders in a real browser (Google Lighthouse covers this when available).' });

  // 9. Layout shift (CLS) — same limitation as tap targets.
  checks.push({ id: 'cls', label: 'Layout shift (CLS)', status: 'not-tested', detail: 'Not measured — layout shift can only be measured while a page renders (Google Lighthouse covers this when available).' });

  return checks;
}

const WEIGHTS = { viewport: 30, zoom: 10, media: 20, font: 15, fixed: 15, seo: 10 };

function scoreChecks(checks) {
  let score = 0;
  for (const c of checks) {
    const w = WEIGHTS[c.id] || 0;
    if (c.status === 'pass') score += w;
    else if (c.status === 'warn') score += w / 2;
  }
  return Math.round(score);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ error: 'Please enter a URL to test.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL. Try something like https://example.com' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ error: 'Only public websites can be tested.' });
  }

  let mobile;
  let desktop;
  try {
    [mobile, desktop] = await Promise.all([
      fetchWithTimeout(target.toString(), MOBILE_UA, FETCH_TIMEOUT_MS),
      fetchWithTimeout(target.toString(), DESKTOP_UA, FETCH_TIMEOUT_MS),
    ]);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach that website (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + '). Check the URL and try again.' });
  }

  if (!mobile || mobile.status >= 400) {
    return res.status(502).json({ error: 'That website returned HTTP ' + (mobile ? mobile.status : 'no response') + ' for a phone browser. Check the URL and try again.' });
  }

  const html = mobile.html;
  const checks = buildChecks(html, mobile.finalUrl, desktop ? desktop.finalUrl : '');
  // Attach the weight of each check so the frontend can show the scoring rules.
  for (const c of checks) c.weight = WEIGHTS[c.id] || 0;

  // Media queries: inline + linked stylesheets
  const inlineMedia = countMatches(html, /@media/gi);
  let cssMedia = 0;
  try {
    cssMedia = await countCssMediaQueries(html, mobile.finalUrl);
  } catch (e) {
    cssMedia = 0;
  }
  const totalMedia = inlineMedia + cssMedia;
  const mediaCheck = checks.find((c) => c.id === 'media');
  if (totalMedia > 0) {
    mediaCheck.status = 'pass';
    mediaCheck.detail = totalMedia + ' media quer' + (totalMedia === 1 ? 'y' : 'ies') + ' found (' + inlineMedia + ' in the page, ' + cssMedia + ' in stylesheets) — the layout adapts to screen sizes.';
  } else {
    mediaCheck.status = 'fail';
    mediaCheck.detail = 'No media queries found in the page or its stylesheets — the layout does not adapt to phone screens.';
  }

  const score = scoreChecks(checks);
  const viewport = checks.find((c) => c.id === 'viewport');
  let verdict;
  if (viewport.status === 'fail' || score < 50) verdict = 'Not mobile friendly';
  else if (score >= 80) verdict = 'Mobile friendly';
  else verdict = 'Needs work';

  return res.status(200).json({
    url: mobile.finalUrl,
    status: mobile.status,
    loadMs: mobile.ms,
    htmlKb: Math.round(Buffer.byteLength(html, 'utf8') / 1024),
    score,
    verdict,
    method: 'static-html',
    limits: ['Tap target size and layout shift (CLS) need a real browser render and are not measured by this static check.'],
    checks,
    counts: {
      images: countMatches(html, /<img[\s>]/gi),
      scripts: countMatches(html, /<script[\s>]/gi),
      links: countMatches(html, /<a[\s>]/gi),
    },
  });
};
