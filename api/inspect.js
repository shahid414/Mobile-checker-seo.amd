// api/inspect.js — Vercel serverless function
// Fetches a page (as a desktop browser) and extracts on-page SEO signals:
// title, description, canonical, viewport, robots meta, Open Graph / Twitter
// tags, headings, images + alt text, links, and JSON-LD structured data.
// Used by the meta-tag analyzer, schema validator, canonical checker,
// heading checker and image alt-text checker pages (each renders its slice).

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 2000000;
const FETCH_TIMEOUT_MS = 6000;

function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html,application/xhtml+xml' },
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

function extractHeadings(html) {
  const out = { h1: [], h2: [], h3: [] };
  const re = /<h([123])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2]).slice(0, 120);
    if (text) out['h' + m[1]].push(text);
  }
  return out;
}

function extractImages(html) {
  const tags = html.match(/<img[^>]*>/gi) || [];
  const withoutAlt = [];
  for (const tag of tags) {
    const alt = tag.match(/alt=["']([^"']*)["']/i);
    if (!alt || !alt[1].trim()) {
      const src = tag.match(/src=["']([^"']*)["']/i);
      if (src) withoutAlt.push(src[1].slice(0, 120));
    }
  }
  return { total: tags.length, withoutAlt: withoutAlt.slice(0, 10), withoutAltCount: withoutAlt.length };
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    try {
      const data = JSON.parse(raw);
      const types = [];
      const collect = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collect); return; }
        if (node['@type']) {
          if (Array.isArray(node['@type'])) types.push(...node['@type']);
          else types.push(node['@type']);
        }
        if (Array.isArray(node['@graph'])) node['@graph'].forEach(collect);
      };
      collect(data);
      blocks.push({ valid: true, types: [...new Set(types)] });
    } catch (e) {
      blocks.push({ valid: false, error: 'Invalid JSON: ' + (e.message || 'parse error').slice(0, 100) });
    }
  }
  return blocks;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ error: 'Please enter a URL to inspect.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL. Try something like https://example.com' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ error: 'Only public websites can be inspected.' });
  }

  let fetched;
  try {
    fetched = await fetchWithTimeout(target.toString(), FETCH_TIMEOUT_MS);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach that website (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + '). Check the URL and try again.' });
  }
  if (!fetched || fetched.status >= 400) {
    return res.status(502).json({ error: 'That website returned HTTP ' + (fetched ? fetched.status : 'no response') + '. Check the URL and try again.' });
  }

  const html = fetched.html;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : null;
  const visibleText = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));
  const internalLinks = (html.match(/<a[^>]*href=["'](\/|https?:\/\/[^"']*)["']/gi) || []).length;

  return res.status(200).json({
    url: fetched.finalUrl,
    status: fetched.status,
    loadMs: fetched.ms,
    htmlKb: Math.round(Buffer.byteLength(html, 'utf8') / 1024),
    title: title,
    titleLength: title ? title.length : 0,
    description: metaContent(html, 'name', 'description'),
    descriptionLength: (metaContent(html, 'name', 'description') || '').length,
    canonical: (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || null,
    viewport: metaContent(html, 'name', 'viewport'),
    robotsMeta: metaContent(html, 'name', 'robots'),
    og: {
      title: metaContent(html, 'property', 'og:title'),
      description: metaContent(html, 'property', 'og:description'),
      image: metaContent(html, 'property', 'og:image'),
      url: metaContent(html, 'property', 'og:url'),
      type: metaContent(html, 'property', 'og:type'),
    },
    twitterCard: metaContent(html, 'name', 'twitter:card'),
    twitterImage: metaContent(html, 'name', 'twitter:image'),
    hreflangCount: (html.match(/<link[^>]*rel=["']alternate["'][^>]*hreflang=/gi) || []).length,
    headings: extractHeadings(html),
    images: extractImages(html),
    links: internalLinks,
    wordCount: visibleText ? visibleText.split(/\s+/).length : 0,
    jsonLd: extractJsonLd(html),
  });
};
