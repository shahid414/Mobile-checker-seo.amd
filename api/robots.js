// api/robots.js — Vercel serverless function
// Fetches a site's /robots.txt and parses it: user-agent groups, Allow /
// Disallow rules, sitemap lines, and whether Googlebot is blocked.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 6000;

function isPublicUrl(u) {
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      current = { agent: value, allow: [], disallow: [] };
      groups.push(current);
    } else if (key === 'allow' && current) {
      current.allow.push(value);
    } else if (key === 'disallow' && current) {
      current.disallow.push(value);
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    } else if (key === 'crawl-delay' && current) {
      current.crawlDelay = value;
    }
  }
  return { groups, sitemaps };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const raw = (req.query && req.query.url) || '';
  if (!raw) return res.status(400).json({ error: 'Please enter a website URL.' });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch (e) {
    return res.status(400).json({ error: 'That does not look like a valid URL. Try something like https://example.com' });
  }
  if (!isPublicUrl(target)) {
    return res.status(400).json({ error: 'Only public websites can be tested.' });
  }

  const robotsUrl = target.origin + '/robots.txt';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(robotsUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/plain,*/*' },
      redirect: 'follow',
    });
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: 'Could not reach that website (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + '). Check the URL and try again.' });
  } finally {
    clearTimeout(timer);
  }

  if (r.status === 404) {
    return res.status(200).json({ url: robotsUrl, found: false, status: 404, groups: [], sitemaps: [], googlebotBlocked: false, note: 'No robots.txt file found — search engines will crawl the whole site.' });
  }
  if (r.status >= 400) {
    return res.status(502).json({ error: 'That website returned HTTP ' + r.status + ' for /robots.txt. Check the URL and try again.' });
  }

  const text = (await r.text()).slice(0, 200000);
  const parsed = parseRobots(text);
  const star = parsed.groups.find((g) => g.agent === '*');
  const googlebot = parsed.groups.find((g) => g.agent.toLowerCase() === 'googlebot');
  const blocksAll = (rules) => rules && rules.some((d) => d === '/' || d === '');
  const googlebotBlocked = googlebot
    ? blocksAll(googlebot.disallow) && googlebot.allow.length === 0
    : star
      ? blocksAll(star.disallow) && star.allow.length === 0
      : false;

  return res.status(200).json({
    url: robotsUrl,
    found: true,
    status: r.status,
    sizeKb: Math.round(Buffer.byteLength(text, 'utf8') / 1024),
    groups: parsed.groups,
    sitemaps: parsed.sitemaps,
    googlebotBlocked,
    raw: text.slice(0, 5000),
  });
};
