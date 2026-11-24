// api/ssl.js — Vercel serverless function
// Checks a site's HTTPS setup: first confirms the site actually loads over
// HTTPS, then reads its certificate details from Certificate Transparency
// logs (crt.sh, free, no key): issuer, valid-from / valid-to dates and days
// left. Raw TLS sockets are not used — they are blocked by some proxies —
// so the check works the same way a visitor's browser would see it.

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 2000000;

function isPublicHost(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1' || host === '[::1]') return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)/.test(host)) return false;
  return true;
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html,application/xhtml+xml,application/json,*/*' },
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, text: text.slice(0, MAX_BYTES) };
  } finally {
    clearTimeout(timer);
  }
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
  if (!isPublicHost(target.hostname)) {
    return res.status(400).json({ error: 'Only public websites can be checked.' });
  }
  if (target.protocol !== 'https:') {
    return res.status(200).json({
      url: target.toString(),
      hostname: target.hostname,
      https: false,
      valid: false,
      note: 'This site does not use HTTPS — the URL starts with http://, so there is no certificate to check.',
    });
  }

  // 1. Does the site actually load over HTTPS? (runs in parallel with the
  // certificate lookup below, so the whole check stays inside the 10s
  // serverless limit even when crt.sh is slow)
  let site;
  let ct;
  try {
    [site, ct] = await Promise.all([
      fetchText('https://' + target.hostname + '/', FETCH_TIMEOUT_MS),
      fetchText('https://crt.sh/?q=' + encodeURIComponent(target.hostname) + '&output=json&exclude=expired', 8000).catch(() => null),
    ]);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach https://' + target.hostname + ' (' + (e.name === 'AbortError' ? 'it took too long to respond' : 'connection failed') + ').' });
  }
  if (site.status >= 400) {
    return res.status(200).json({
      url: target.toString(),
      hostname: target.hostname,
      https: true,
      valid: false,
      note: 'The site loads over HTTPS but returned HTTP ' + site.status + ' on its homepage.',
    });
  }

  // 2. Certificate details from Certificate Transparency logs.
  const result = {
    url: target.toString(),
    hostname: target.hostname,
    https: true,
    valid: true,
    issuer: null,
    subject: null,
    validFrom: null,
    validTo: null,
    daysLeft: null,
    note: null,
  };
  try {
    if (ct && ct.status === 200) {
      const certs = JSON.parse(ct.text);
      const host = target.hostname.toLowerCase();
      const matchesHost = (c) => {
        if (!c) return false;
        if ((c.common_name || '').toLowerCase() === host) return true;
        const names = String(c.name_value || '').split('\n').map((s) => s.trim().toLowerCase());
        return names.includes(host) || names.includes('*.' + host.split('.').slice(1).join('.'));
      };
      const mine = (Array.isArray(certs) ? certs : [])
        .filter((c) => c && c.not_after && matchesHost(c))
        .sort((a, b) => new Date(b.not_after) - new Date(a.not_after));
      const cert = mine[0] || null;
      if (cert) {
        const validTo = new Date(cert.not_after);
        const validFrom = cert.not_before ? new Date(cert.not_before) : null;
        result.issuer = cert.issuer_name || null;
        result.subject = cert.common_name || null;
        result.validFrom = validFrom ? validFrom.toISOString().slice(0, 10) : null;
        result.validTo = validTo.toISOString().slice(0, 10);
        result.daysLeft = Math.round((validTo.getTime() - Date.now()) / 86400000);
        result.valid = result.daysLeft >= 0;
        if (result.daysLeft < 0) result.note = 'The newest certificate found has already expired.';
        else if (result.daysLeft <= 14) result.note = 'The certificate expires in ' + result.daysLeft + ' days — renew it soon.';
      } else {
        result.note = 'No certificate for this exact hostname was found in public transparency logs yet.';
      }
    } else {
      result.note = 'Certificate details were not available right now, but the site loads fine over HTTPS.';
    }
  } catch (e) {
    result.note = 'Certificate details were not available right now, but the site loads fine over HTTPS.';
  }
  return res.status(200).json(result);
};
