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

// Short cleaned context around each regex match, so results can show WHERE
// a problem is (e.g. which rule sets a 9px font or a 1200px width).
function findContexts(html, regex, limit) {
  const out = [];
  for (const m of html.matchAll(regex)) {
    if (out.length >= limit) break;
    const start = Math.max(0, m.index - 60);
    let ctx = html.slice(start, m.index + m[0].length + 10).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (ctx.length > 110) ctx = '…' + ctx.slice(-110);
    if (ctx) out.push(ctx);
  }
  return out;
}

// Count of each distinct value found by a capture-group regex, e.g. font sizes.
function valueCounts(html, regex) {
  const counts = {};
  for (const m of html.matchAll(regex)) {
    const v = m[1];
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
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
  // Distribution of the small sizes, so the result names each one, not just the smallest.
  const smallCounts = valueCounts(html, /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*px/gi);
  const smallList = Object.keys(smallCounts)
    .map((k) => parseFloat(k))
    .filter((n) => n < 16)
    .sort((a, b) => a - b)
    .map((n) => n + 'px ×' + smallCounts[String(n)]);
  const smallContexts = findContexts(html, /font-size\s*:\s*(?:[0-9]|1[0-5])(?:\.[0-9]+)?\s*px/gi, 3);
  const fontFindings = [];
  if (smallList.length > 0) fontFindings.push('Small sizes found: ' + smallList.join(', '));
  for (const c of smallContexts) fontFindings.push(c);
  if (pxSizes.length === 0) {
    checks.push({ id: 'font', label: 'Font size', status: 'pass', detail: 'No tiny fixed pixel font sizes found in the page code (sizes use rem/em or are set elsewhere).' });
  } else {
    const smallest = Math.min(...pxSizes);
    if (smallest < 12) {
      checks.push({ id: 'font', label: 'Font size', status: 'fail', detail: 'Text as small as ' + smallest + 'px found — too small to read on a phone without zooming.', findings: fontFindings });
    } else if (smallest < 16) {
      checks.push({ id: 'font', label: 'Font size', status: 'warn', detail: 'Smallest text found is ' + smallest + 'px — readable, but 16px or larger is safer on phones.', findings: fontFindings });
    } else {
      checks.push({ id: 'font', label: 'Font size', status: 'pass', detail: 'Smallest text found is ' + smallest + 'px — readable without zooming.' });
    }
  }

  // 5. Fixed-width layout risk / horizontal scroll (weight 15)
  // Scan declaration blocks only: strip @media(...) conditions first so a
  // breakpoint like min-width:1024px is not mistaken for an element width,
  // and ignore max-width (a cap, not a forced width — it is responsive-safe).
  const declHtml = html.replace(/@media[^{]+\{/gi, '@media{');
  const wideMatches = [...declHtml.matchAll(/(?:^|[^-])((?:width|min-width)\s*:\s*(?:9[0-9]{2}|1[0-9]{3,})\s*px)/gi)];
  const nowrapCount = countMatches(html, /white-space\s*:\s*nowrap/gi);
  const fixedFindings = [];
  if (wideMatches.length > 0) {
    fixedFindings.push(wideMatches.length + ' wide fixed-width rule' + (wideMatches.length === 1 ? '' : 's') + ' found (900px or more)');
    for (const c of findContexts(declHtml, /(?:^|[^-])((?:width|min-width)\s*:\s*(?:9[0-9]{2}|1[0-9]{3,})\s*px)/gi, 5)) fixedFindings.push(c);
  }
  if (nowrapCount > 0) fixedFindings.push(nowrapCount + ' white-space: nowrap rule' + (nowrapCount === 1 ? '' : 's') + ' — text that cannot wrap can also spill off-screen');
  if (wideMatches.length > 0) {
    checks.push({ id: 'fixed', label: 'Horizontal scroll risk', status: 'fail', detail: 'Fixed widths of 900px or more found in the code — content can spill off a phone screen.', findings: fixedFindings });
  } else {
    checks.push({ id: 'fixed', label: 'Horizontal scroll risk', status: 'pass', detail: 'No wide fixed widths found in the page code.', findings: fixedFindings });
  }

  // 6. Title + H1 (weight 10)
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';
  const h1Matches = [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/gi)].map((m) => m[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const hasTitle = titleText.length >= 3;
  const hasH1 = h1Matches.length > 0;
  const seoFindings = [];
  if (titleText) seoFindings.push('Title (' + titleText.length + ' chars): "' + titleText.slice(0, 90) + (titleText.length > 90 ? '…' : '') + '"');
  if (h1Matches.length > 0) seoFindings.push(h1Matches.length + ' H1 heading' + (h1Matches.length === 1 ? '' : 's') + ' found' + (h1Matches.length > 1 ? ' — a page should have exactly one' : '') + ': "' + h1Matches[0].slice(0, 90) + (h1Matches[0].length > 90 ? '…' : '') + '"');
  if (hasTitle && hasH1) {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: h1Matches.length > 1 ? 'warn' : 'pass', detail: h1Matches.length > 1 ? 'The page has a title and H1, but more than one H1 heading.' : 'The page has both a title and an H1 heading.', findings: seoFindings });
  } else if (hasTitle || hasH1) {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: 'warn', detail: hasTitle ? 'Title found, but no H1 heading.' : 'H1 found, but no title tag.', findings: seoFindings });
  } else {
    checks.push({ id: 'seo', label: 'Title & H1 present', status: 'fail', detail: 'Neither a title tag nor an H1 heading was found.' });
  }

  // 7b. Images without dimensions — layout shift risk (info, not scored)
  const imgTags = [...html.matchAll(/<img[^>]*>/gi)].map((m) => m[0]);
  const noDimImgs = imgTags.filter((t) => !/\swidth\s*=|\sheight\s*=/.test(t));
  if (imgTags.length > 0) {
    const imgFindings = [];
    for (const t of noDimImgs.slice(0, 3)) {
      const src = (t.match(/(?:data-src|src)=["']([^"']*)["']/i) || [])[1];
      if (src) imgFindings.push(src.length > 90 ? '…' + src.slice(-90) : src);
    }
    checks.push({ id: 'imgdim', label: 'Images without dimensions', status: noDimImgs.length > 0 ? 'warn' : 'pass', detail: noDimImgs.length > 0 ? noDimImgs.length + ' of ' + imgTags.length + ' images have no width/height — the page can jump while images load (layout shift).' : 'All ' + imgTags.length + ' images state their width and height.', findings: imgFindings });
  }

  // 7c. Images without alt text (info, not scored)
  if (imgTags.length > 0) {
    const noAlt = imgTags.filter((t) => !/\salt\s*=/.test(t)).length;
    checks.push({ id: 'alt', label: 'Images without alt text', status: noAlt > 0 ? 'warn' : 'pass', detail: noAlt > 0 ? noAlt + ' of ' + imgTags.length + ' images have no alt text — screen readers and search engines cannot describe them.' : 'All ' + imgTags.length + ' images have alt text.' });
  }

  // 7d. Wide tables and fixed-size embeds (info, not scored)
  const tableCount = countMatches(html, /<table[\s>]/gi);
  const wideEmbeds = [...html.matchAll(/<(iframe|embed|video)[^>]*\swidth=["']?(\d+)/gi)].filter((m) => parseInt(m[2], 10) >= 600);
  const embedFindings = wideEmbeds.slice(0, 3).map((m) => '<' + m[1] + '> with width ' + m[2] + 'px');
  if (wideEmbeds.length > 0) {
    checks.push({ id: 'embeds', label: 'Wide tables & fixed embeds', status: 'fail', detail: wideEmbeds.length + ' embedded element' + (wideEmbeds.length === 1 ? '' : 's') + ' (iframe/video) fixed at 600px or wider — they can overflow a phone screen.', findings: embedFindings });
  } else if (tableCount > 0) {
    checks.push({ id: 'embeds', label: 'Wide tables & fixed embeds', status: 'warn', detail: tableCount + ' table' + (tableCount === 1 ? '' : 's') + ' found — check they scroll sideways or stack on phones instead of overflowing.' });
  } else {
    checks.push({ id: 'embeds', label: 'Wide tables & fixed embeds', status: 'pass', detail: 'No tables or wide fixed embeds found.' });
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
  // Distinct breakpoints used in @media rules only, so the result names them.
  const bpSet = new Set();
  for (const m of html.matchAll(/@media[^{]*\((?:max|min)-width\s*:\s*(\d+)\s*px/gi)) bpSet.add(parseInt(m[1], 10));
  const bps = [...bpSet].sort((a, b) => a - b);
  mediaCheck.findings = [];
  if (bps.length > 0) mediaCheck.findings.push('Breakpoints used in the page: ' + bps.map((b) => b + 'px').join(', '));
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
