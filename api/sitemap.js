// api/sitemap.js — Vercel serverless function
// Fetches a sitemap.xml (from a URL, or /sitemap.xml of a site) and reports:
// is it valid XML, how many URLs it lists, whether entries carry lastmod,
// and the first few URLs it contains. Sitemap indexes are listed, not expanded.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 2000000;

function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ error: 'Please enter a website URL or a sitemap URL.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL.' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ error: 'Only public websites can be checked.' });
  }

  const sitemapUrl = /sitemap[^/]*\.xml$/i.test(target.pathname) ? target.toString() : target.origin + '/sitemap.xml';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(sitemapUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/xml,text/xml,*/*' },
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach that website (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + '). Check the URL and try again.' });
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 404) {
    return res.status(200).json({ url: sitemapUrl, found: false, status: 404, note: 'No sitemap.xml found at this address.' });
  }
  if (r.status >= 400) {
    return res.status(502).json({ error: 'That address returned HTTP ' + r.status + '. Check the URL and try again.' });
  }

  const text = (await r.text()).slice(0, MAX_BYTES);
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const isUrlset = /<urlset[\s>]/i.test(text);
  const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
  const urlCount = isIndex ? locs.length : (text.match(/<url>[\s\S]*?<\/url>/gi) || []).length;
  const lastmodCount = (text.match(/<lastmod>/gi) || []).length;

  return res.status(200).json({
    url: sitemapUrl,
    found: true,
    status: r.status,
    sizeKb: Math.round(Buffer.byteLength(text, 'utf8') / 1024),
    isIndex,
    isUrlset,
    validXml: isIndex || isUrlset,
    urlCount,
    sitemapCount: isIndex ? locs.length : 0,
    lastmodCount,
    sampleUrls: locs.slice(0, 10),
    note: !isIndex && !isUrlset ? 'This does not look like a sitemap — no <urlset> or <sitemapindex> tag found.' : null,
  });
};
