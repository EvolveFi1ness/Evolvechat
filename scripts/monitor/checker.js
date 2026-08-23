// ─────────────────────────────────────────────────────────────
//  EvolveChat monitoring — check engine
//  HTTP/API/PAGE checks + SSL inspection + SSRF guards.
//  Runs inside GitHub Actions; never crashes the run.
// ─────────────────────────────────────────────────────────────
'use strict';
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

// ── SSRF protection ─────────────────────────────────────────
// Only public http(s) targets. Blocks localhost, private ranges,
// link-local (incl. cloud metadata 169.254.169.254), 0.0.0.0,
// non-standard ports, file/ftp/gopher schemes.
const ALLOWED_PORTS = new Set([80, 443, 8443]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                                  // 0.0.0.0/8
    if (a === 10) return true;                                 // 10/8
    if (a === 127) return true;                                // loopback
    if (a === 169 && b === 254) return true;                   // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12
    if (a === 192 && b === 168) return true;                   // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked protocol "${u.protocol.replace(':', '')}" — only http/https allowed`);
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) throw new Error(`Blocked port ${port}`);

  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch (_) {
    throw new Error(`DNS lookup failed for "${u.hostname}"`);
  }
  if (!addrs.length) throw new Error(`No DNS records for "${u.hostname}"`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Blocked non-public address ${address}`);
  }
  return u;
}

// ── SSL certificate inspection ──────────────────────────────
function sslInspect(hostname, timeoutMs = 8000) {
  return new Promise(resolve => {
    try {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: timeoutMs, rejectUnauthorized: false }, () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || !cert.valid_to) return resolve(null);
          const validTo = new Date(cert.valid_to);
          resolve({
            valid: !socket.authorized ? false : true,
            authorized: socket.authorized,
            issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'Unknown',
            subjectCN: cert.subject && cert.subject.CN ? cert.subject.CN : hostname,
            validTo: validTo.toISOString(),
            daysRemaining: Math.floor((validTo.getTime() - Date.now()) / 86400000)
          });
        } catch (_) { resolve(null); }
      });
      socket.on('error', () => resolve(null));
      socket.on('timeout', () => { try { socket.destroy(); } catch (_) {} resolve(null); });
    } catch (_) { resolve(null); }
  });
}

// ── Core check ──────────────────────────────────────────────
// monitor = { id, name, url, type, timeoutSec, expectedStatus:[..], expectedText }
// returns result object (never throws)
async function runCheck(monitor) {
  const started = Date.now();
  const timeoutMs = Math.max(2, Math.min(60, Number(monitor.timeoutSec) || 10)) * 1000;
  const expectedStatuses = Array.isArray(monitor.expectedStatus) && monitor.expectedStatus.length
    ? monitor.expectedStatus.map(Number)
    : [200];

  const base = {
    monitorId: monitor.id,
    monitorName: monitor.name || '',
    url: monitor.url || '',
    timestamp: new Date()
  };

  let urlObj;
  try { urlObj = await assertPublicUrl(monitor.url); } catch (e) {
    return { ...base, success: false, status: 0, responseTime: Date.now() - started, error: `SSRF guard: ${e.message}`, ssl: null };
  }

  // SSL info in parallel with the request (https only)
  const sslPromise = urlObj.protocol === 'https:' ? sslInspect(urlObj.hostname, Math.min(timeoutMs, 8000)) : Promise.resolve(null);

  let controller;
  try {
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    const res = await fetch(urlObj.href, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'EvolveChat-Monitor/1.0 (+uptime checks)',
        'Accept': '*/*',
        'Cache-Control': 'no-store'
      }
    });
    clearTimeout(timer);
    const responseTime = Date.now() - t0;

    let bodySnippet = '';
    if (monitor.expectedText) {
      try {
        const bodyPromise = res.text();
        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Body read timeout')), Math.min(timeoutMs, 15000)));
        bodySnippet = (await Promise.race([bodyPromise, timeoutPromise])).slice(0, 512000);
      } catch (_) {}
    } else {
      try { await res.arrayBuffer(); } catch (_) {} // drain
    }

    const statusOk = expectedStatuses.includes(res.status);
    const textOk = !monitor.expectedText || bodySnippet.includes(String(monitor.expectedText));
    const finalUrl = res.url || urlObj.href;

    // Redirect must not have landed on a private address
    if (finalUrl && finalUrl !== urlObj.href) {
      try { await assertPublicUrl(finalUrl); } catch (e) {
        const ssl = await sslPromise.catch(() => null);
        return { ...base, success: false, status: res.status, responseTime, error: `SSRF guard on redirect: ${e.message}`, ssl };
      }
    }

    const success = statusOk && textOk;
    const error = success ? '' : (!statusOk
      ? `HTTP ${res.status} (expected ${expectedStatuses.join('|')})`
      : `Expected text not found: "${String(monitor.expectedText).slice(0, 60)}"`);

    const ssl = await sslPromise.catch(() => null);
    return { ...base, success, status: res.status, responseTime, error, ssl, finalUrl };
  } catch (e) {
    const responseTime = Date.now() - started;
    const aborted = e && (e.name === 'AbortError' || String(e.message || '').includes('abort'));
    const ssl = await sslPromise.catch(() => null);
    return {
      ...base,
      success: false,
      status: 0,
      responseTime,
      error: aborted ? `Timeout after ${timeoutMs / 1000}s` : `Network error: ${(e && e.cause && e.cause.code) || (e && e.message) || 'unknown'}`
    , ssl};
  }
}

module.exports = { runCheck, sslInspect, assertPublicUrl, isPrivateIp };
