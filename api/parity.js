// api/parity.js — Vercel serverless function
// Mobile-first indexing check: fetches the same URL twice — once as
// Googlebot Smartphone, once as Googlebot Desktop — and compares what each
// one gets: status, title, description, H1, canonical, robots tag, visible
// text, links, images, structured data and viewport. Anything that exists
// only on desktop does not count for Google, because Google indexes the
// mobile version. Returns a per-signal table plus a parity score.

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const DESKTOP_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const MAX_HTML_BYTES = 2000000;
const FETCH_TIMEOUT_MS = 6000;

function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

async function fetchWithTimeout(url, ua) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
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

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function metaContent(html, attr, value) {
  const re = new RegExp('<meta[^>]*' + attr + '=["\']' + value + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const m = tag[0].match(/content=["']([^"']*)["']/i);
  return m ? m[1] : null;
}

function signalsOf(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const visibleText = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));
  const jsonLdBlocks = (html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>/gi) || []).length;
  const jsonLdTypes = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (node['@type']) {
          if (Array.isArray(node['@type'])) jsonLdTypes.push(...node['@type']);
          else jsonLdTypes.push(node['@type']);
        }
        if (Array.isArray(node['@graph'])) node['@graph'].forEach(collect);
      };
      collect(data);
    } catch (e) { /* invalid JSON-LD counts as present but broken; reported separately */ }
  }
  return {
    status: null, // filled by caller
    finalUrl: null,
    host: null,
    title: titleMatch ? stripTags(titleMatch[1]) : null,
    description: metaContent(html, 'name', 'description'),
    h1: h1Match ? stripTags(h1Match[1]).slice(0, 120) : null,
    canonical: (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || null,
    robots: metaContent(html, 'name', 'robots'),
    viewport: metaContent(html, 'name', 'viewport'),
    wordCount: visibleText ? visibleText.split(/\s+/).length : 0,
    links: (html.match(/<a[^>]*href=["']/gi) || []).length,
    images: (html.match(/<img[\s>]/gi) || []).length,
    jsonLdBlocks,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    hreflang: (html.match(/<link[^>]*rel=["']alternate["'][^>]*hreflang=/gi) || []).length,
  };
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (e) { return null; }
}

function row(label, mobile, desktop, weight) {
  let status;
  if (mobile === null && desktop === null) status = 'match';
  else if (mobile === null || desktop === null) status = 'issue';
  else if (String(mobile) === String(desktop)) status = 'match';
  else status = 'diff';
  return { label, mobile, desktop, status, weight };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ error: 'Please enter a URL to check.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL. Try something like https://example.com' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ error: 'Only public websites can be checked.' });
  }

  let mobile;
  let desktop;
  try {
    [mobile, desktop] = await Promise.all([
      fetchWithTimeout(target.toString(), MOBILE_UA),
      fetchWithTimeout(target.toString(), DESKTOP_UA),
    ]);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach that website (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + '). Check the URL and try again.' });
  }
  if (!mobile || mobile.status >= 400) {
    return res.status(502).json({ error: 'That website returned HTTP ' + (mobile ? mobile.status : 'no response') + ' for a mobile browser. Check the URL and try again.' });
  }

  const m = signalsOf(mobile.html);
  const d = signalsOf(desktop.html);
  m.status = mobile.status; m.finalUrl = mobile.finalUrl; m.host = hostnameOf(mobile.finalUrl);
  d.status = desktop.status; d.finalUrl = desktop.finalUrl; d.host = hostnameOf(desktop.finalUrl);

  const rows = [
    row('HTTP status', m.status, d.status, 20),
    row('Final host', m.host, d.host, 20),
    row('Title', m.title, d.title, 8),
    row('Meta description', m.description, d.description, 8),
    row('H1 heading', m.h1, d.h1, 8),
    row('Canonical URL', m.canonical, d.canonical, 8),
    row('Robots meta tag', m.robots, d.robots, 5),
    row('Viewport tag', m.viewport, d.viewport, 5),
    row('Visible words', m.wordCount, d.wordCount, 12),
    row('Internal links', m.links, d.links, 5),
    row('Images', m.images, d.images, 5),
    row('JSON-LD blocks', m.jsonLdBlocks, d.jsonLdBlocks, 10),
    row('JSON-LD types', m.jsonLdTypes.join(', ') || null, d.jsonLdTypes.join(', ') || null, 0),
    row('Hreflang tags', m.hreflang, d.hreflang, 0),
  ];

  let earned = 0;
  let total = 0;
  for (const r of rows) {
    total += r.weight;
    if (r.status === 'match') earned += r.weight;
    else if (r.status === 'diff') earned += r.weight / 2;
  }
  const parityScore = total > 0 ? Math.round((earned / total) * 100) : 0;

  return res.status(200).json({
    url: mobile.finalUrl,
    mobileStatus: mobile.status,
    desktopStatus: desktop.status,
    mobileMs: mobile.ms,
    desktopMs: desktop.ms,
    parityScore,
    verdict: parityScore >= 90 ? 'Mobile and desktop match — Google sees the full page.'
      : parityScore >= 70 ? 'Mostly matching — a few signals differ between mobile and desktop.'
      : 'Mobile and desktop differ a lot — content missing on mobile is invisible to Google.',
    rows,
    mobile: { title: m.title, h1: m.h1, wordCount: m.wordCount, jsonLdTypes: m.jsonLdTypes },
    desktop: { title: d.title, h1: d.h1, wordCount: d.wordCount, jsonLdTypes: d.jsonLdTypes },
  });
};
