// api/status.js — Vercel serverless function
// Follows a URL's redirect chain step by step (manual redirects, up to 10
// hops) and reports every hop: URL, HTTP status, where it redirects to, and
// how long each hop took. No redirect = a single hop.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 6000;
const MAX_HOPS = 10;

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
  if (!raw) return res.status(400).json({ error: 'Please enter a URL to check.' });

  let current;
  try {
    current = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL. Try something like https://example.com' });
  }
  if (!isPublicUrl(current)) {
    return res.status(400).json({ error: 'Only public websites can be checked.' });
  }

  const hops = [];
  const seen = new Set();
  let totalMs = 0;

  for (let i = 0; i < MAX_HOPS; i++) {
    const url = current.toString();
    if (seen.has(url)) {
      hops.push({ url, status: null, note: 'Redirect loop — this URL was already visited.' });
      break;
    }
    seen.add(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const start = Date.now();
    let r;
    try {
      r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });
    } catch (e) {
      clearTimeout(timer);
      return res.status(502).json({ error: 'Could not reach ' + url + ' (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + ').' });
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - start;
    totalMs += ms;
    const location = r.headers.get('location');
    hops.push({ url, status: r.status, location: location || null, ms });
    if (r.status >= 300 && r.status < 400 && location) {
      try {
        current = new URL(location, url);
      } catch (e) {
        hops.push({ url: location, status: null, note: 'Redirect target is not a valid URL.' });
        break;
      }
      if (!isPublicUrl(current)) {
        hops.push({ url: current.toString(), status: null, note: 'Redirect target is not a public URL.' });
        break;
      }
      continue;
    }
    break;
  }

  const last = hops[hops.length - 1];
  return res.status(200).json({
    url: raw,
    hops,
    hopCount: hops.length,
    finalUrl: last ? last.url : null,
    finalStatus: last ? last.status : null,
    totalMs,
    redirected: hops.length > 1,
    ok: last && last.status >= 200 && last.status < 300,
  });
};
