#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  EvolveChat monitoring worker — main entry
//  Runs from GitHub Actions cron (every 5 min). Responsibilities:
//   1. Load config + monitors from Firestore (existing database)
//   2. Run due checks concurrently, record results
//   3. Status logic: UP / DEGRADED / DOWN / PAUSED (+recovery)
//   4. Open/close incidents with downtime duration
//   5. Telegram alerts (down/recovery/ssl/slow) via Bot API
//   6. Telegram commands (/status /monitors /check /incidents)
//   7. Retention cleanup (checks 30d · incidents 1y · notif logs 7d)
//
//  Required env:  FIREBASE_SERVICE_ACCOUNT_B64  (base64 of service-account JSON)
//  Optional env:  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (comma-separated allowlist)
// ─────────────────────────────────────────────────────────────
'use strict';

let db = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is not set');
  const admin = require('firebase-admin');
  const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
} catch (e) {
  console.error('[monitor] Fatal init error:', e.message);
  process.exit(1);
}

const { runCheck } = require('./checker');

const SETTINGS_DOC = db.collection('monitorConfig').doc('settings');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHATS = String(process.env.TELEGRAM_CHAT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Small helpers ────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, label, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      console.warn(`[monitor] ${label} failed (attempt ${i + 1}/${tries}): ${e.message}`);
      await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60), sec = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h}h ${mm}m`;
  }
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

function tgEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getSettings() {
  const snap = await retry(() => SETTINGS_DOC.get(), 'load settings');
  const defaults = {
    failureThreshold: 3,
    slowResponseMs: 2000,
    sslAlertDays: [30, 14, 7, 1],
    alerts: { enabled: true, down: true, recovery: true, ssl: true, slow: false },
    tgOffset: 0,
    lastCleanupAt: null,
    seeded: false
  };
  if (!snap.exists) {
    await retry(() => SETTINGS_DOC.set(defaults), 'create settings');
    return defaults;
  }
  const d = snap.data() || {};
  return { ...defaults, ...d, alerts: { ...defaults.alerts, ...(d.alerts || {}) } };
}

async function seedDefaultMonitors() {
  const existing = await retry(() => db.collection('monitors').limit(1).get(), 'seed check');
  if (!existing.empty) return;
  const BASE = 'https://evolvefi1ness.github.io/Evolvechat/';
  const seeds = [
    { name: 'EvolveChat Website', url: BASE, type: 'HTTP', intervalMin: 5 },
    { name: 'Coach Dashboard', url: BASE + 'coach.html', type: 'PAGE', expectedText: 'EVOLVE', intervalMin: 5 },
    { name: 'Workouts Data', url: BASE + 'data/workouts.json', type: 'API', intervalMin: 15 }
  ];
  const batch = db.batch();
  for (const s of seeds) {
    batch.set(db.collection('monitors').doc(), {
      ...s,
      timeoutSec: 10,
      expectedStatus: [200],
      expectedText: s.expectedText || '',
      enabled: true,
      status: 'UNKNOWN',
      consecutiveFailures: 0,
      lastResponseTime: null,
      lastCheckAt: null,
      lastSuccessAt: null,
      openIncidentId: null,
      lastSslAlertLevel: 366,
      checkRequested: false,
      createdAt: new Date()
    });
  }
  await retry(() => batch.commit(), 'seed monitors');
  console.log('[monitor] Seeded default monitors');
}

// ── Telegram ─────────────────────────────────────────────────
async function tgApi(method, payload) {
  if (!BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  return res.json().catch(() => null);
}

async function sendTelegram(chatId, text) {
  try {
    const out = await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    await db.collection('monitorNotifications').add({
      type: 'telegram', chatId: String(chatId), ok: !!(out && out.ok),
      error: out && !out.ok ? String(out.description || '').slice(0, 300) : '', sentAt: new Date()
    });
    return !!(out && out.ok);
  } catch (e) {
    console.warn('[monitor] telegram send failed:', e.message);
    try {
      await db.collection('monitorNotifications').add({ type: 'telegram', chatId: String(chatId), ok: false, error: e.message.slice(0, 300), sentAt: new Date() });
    } catch (_) {}
    return false;
  }
}

function alertTargets(settings) {
  return (settings.alerts && settings.alerts.enabled && ALLOWED_CHATS.length) ? ALLOWED_CHATS : [];
}

async function alertDown(monitor, result, settings) {
  if (!settings.alerts.down) return;
  const t = new Date(result.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Manila' });
  const text =
`🚨 <b>EVOLVECHAT DOWN</b>

<b>Monitor:</b> ${tgEscape(monitor.name)}
<b>URL:</b> ${tgEscape(monitor.url)}
<b>Status:</b> ${tgEscape(result.status || result.error)}
<b>Response:</b> ${fmtNum(result.responseTime)} ms
<b>Failures:</b> ${monitor.consecutiveFailures} consecutive
<b>Time:</b> ${t}`;
  await Promise.allSettled(alertTargets(settings).map(c => sendTelegram(c, text)));
}

async function alertRecovery(monitor, incident, settings) {
  if (!settings.alerts.recovery) return;
  const down = incident && incident.startedAt ? (Date.now() - new Date(incident.startedAt).getTime()) : 0;
  const text =
`✅ <b>EVOLVECHAT RECOVERED</b>

<b>Monitor:</b> ${tgEscape(monitor.name)}
<b>Downtime:</b> ${fmtDuration(down)}
<b>Response:</b> ${fmtNum(monitor.lastResponseTime)} ms`;
  await Promise.allSettled(alertTargets(settings).map(c => sendTelegram(c, text)));
}

async function alertSlow(monitor, result, settings) {
  if (!settings.alerts.slow) return;
  const text =
`🐌 <b>EVOLVECHAT SLOW RESPONSE</b>

<b>Monitor:</b> ${tgEscape(monitor.name)}
<b>URL:</b> ${tgEscape(monitor.url)}
<b>Response:</b> ${fmtNum(result.responseTime)} ms (threshold ${fmtNum(settings.slowResponseMs)} ms)`;
  await Promise.allSettled(alertTargets(settings).map(c => sendTelegram(c, text)));
}

async function alertSslIfNeeded(monitor, settings) {
  if (!settings.alerts.ssl || !monitor.sslDaysRemaining && monitor.sslDaysRemaining !== 0) return;
  const days = monitor.sslDaysRemaining;
  const levels = (settings.sslAlertDays || [30, 14, 7, 1]).slice().sort((a, b) => b - a);
  const hit = levels.find(l => days <= l);
  // Reset alert level if cert was renewed (days remaining jumped above the last alerted level)
  const prevLevel = monitor.lastSslAlertLevel ?? 366;
  if (!hit || prevLevel <= hit) {
    // If cert renewed (days > all levels), clear the persisted level so future expiry re-alerts
    if (days > levels[0] && prevLevel < 366) {
      await monitor.ref.update({ lastSslAlertLevel: 366 }).catch(() => {});
    }
    return;
  }
  const text =
`🔒 <b>EVOLVECHAT SSL ALERT</b>

<b>Monitor:</b> ${tgEscape(monitor.name)}
<b>Certificate expires in ${days} day${days === 1 ? '' : 's'}</b>
<b>Issuer:</b> ${tgEscape(monitor.sslIssuer || 'Unknown')}
<b>Expires:</b> ${monitor.sslValidTo ? new Date(monitor.sslValidTo).toISOString().slice(0, 10) : '?'}`;
  const ok = await Promise.allSettled(alertTargets(settings).map(c => sendTelegram(c, text)));
  if (ok.some(r => r.status === 'fulfilled')) {
    // persist per-monitor so we don't re-alert every run
    await monitor.ref.update({ lastSslAlertLevel: hit }).catch(() => {});
  }
}

// ── Check processing ─────────────────────────────────────────
async function processMonitor(monitor, settings) {
  const ref = db.collection('monitors').doc(monitor.id);
  try {
    const result = await runCheck({ id: monitor.id, ...monitor });
    const now = new Date();

    // Record the raw check (retention-capped by cleanup job)
    await retry(() => db.collection('monitorChecks').add({
      monitorId: monitor.id,
      monitorName: monitor.name,
      success: result.success,
      degraded: result.success && result.responseTime > settings.slowResponseMs,
      httpStatus: result.status,
      responseTime: result.responseTime,
      error: (result.error || '').slice(0, 500),
      checkedAt: now
    }), 'record check');

    const prevStatus = monitor.status || 'UNKNOWN';
    const failures = result.success ? 0 : ((monitor.consecutiveFailures || 0) + 1);
    const wentDown = !result.success && failures >= (settings.failureThreshold || 3);
    const recovered = prevStatus === 'DOWN' && result.success;

    let status;
    if (wentDown) status = 'DOWN';
    else if (result.success && result.responseTime > settings.slowResponseMs) status = 'DEGRADED';
    else if (result.success) status = 'UP';
    else status = prevStatus; // failing but below threshold — keep current state

    const update = {
      status,
      consecutiveFailures: failures,
      lastCheckAt: now,
      lastResponseTime: result.responseTime,
      checkRequested: false
    };
    if (result.success) update.lastSuccessAt = now;

    // SSL bookkeeping
    if (result.ssl) {
      update.sslIssuer = result.ssl.issuer;
      update.sslValidTo = result.ssl.validTo;
      update.sslDaysRemaining = result.ssl.daysRemaining;
    }

    // Incident lifecycle
    if (wentDown && prevStatus !== 'DOWN') {
      const inc = await retry(() => db.collection('incidents').add({
        monitorId: monitor.id, monitorName: monitor.name, url: monitor.url,
        reason: result.error || `HTTP ${result.status}`, httpStatus: result.status,
        status: 'open', startedAt: now, resolvedAt: null, durationMs: null
      }), 'open incident');
      update.openIncidentId = inc.id;
      await alertDown({ ...monitor, consecutiveFailures: failures }, result, settings);
    }
    if (recovered && monitor.openIncidentId) {
      const incRef = db.collection('incidents').doc(monitor.openIncidentId);
      const incSnap = await incRef.get().catch(() => null);
      const startedAt = incSnap && incSnap.exists ? incSnap.data().startedAt : null;
      const durationMs = startedAt ? now.getTime() - new Date(startedAt).getTime() : null;
      await retry(() => incRef.update({ status: 'resolved', resolvedAt: now, durationMs, resolveReason: result.error ? '' : 'OK', recoveryResponseMs: result.responseTime }), 'close incident');
      update.openIncidentId = null;
      await alertRecovery(monitor, incSnap && incSnap.exists ? incSnap.data() : null, settings);
    }

    await retry(() => ref.update(update), 'update monitor');

    if (status === 'DEGRADED' && prevStatus !== 'DEGRADED') {
      await alertSlow(monitor, result, settings);
    }
    if (update.sslDaysRemaining != null) {
      await alertSslIfNeeded({ ...monitor, ...update, ref }, settings);
    }

    console.log(`[monitor] ${monitor.name}: ${status} ${result.responseTime}ms ${result.success ? '' : '— ' + result.error}`);
  } catch (e) {
    console.error(`[monitor] ${monitor.name} processing failed (continuing):`, e.message);
    // Never crash the whole run because one monitor misbehaved.
    await ref.update({
      checkRequested: false,
      lastCheckAt: new Date(),
      lastError: String(e.message || '').slice(0, 300)
    }).catch(() => {});
  }
}

async function runDueChecks(settings) {
  const snap = await retry(
    () => db.collection('monitors').where('enabled', '==', true).get(),
    'load monitors'
  );
  const now = Date.now();
  const due = [];
  snap.forEach(doc => {
    const m = doc.data();
    const intervalMs = Math.max(1, Number(m.intervalMin) || 5) * 60000;
    const last = m.lastCheckAt ? new Date(m.lastCheckAt.toDate ? m.lastCheckAt.toDate() : m.lastCheckAt).getTime() : 0;
    if (m.checkRequested || (now - last) >= intervalMs - 30000) { // 30s skew guard for cron jitter
      due.push({ id: doc.id, ref: doc.ref, ...m });
    }
  });
  if (!due.length) { console.log('[monitor] No monitors due'); return; }

  const CONCURRENCY = 5;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    await Promise.all(due.slice(i, i + CONCURRENCY).map(m => processMonitor(m, settings)));
  }
}

// ── Telegram commands ────────────────────────────────────────
function fmtUptimeFromStats(stats) {
  const total = stats.up + stats.down + stats.degraded;
  if (!total) return '—';
  return ((stats.up + stats.degraded) / total * 100).toFixed(2) + '%';
}

async function collectStatusStats() {
  const since24h = new Date(Date.now() - 86400000);
  const checks = await retry(() =>
    db.collection('monitorChecks')
      .where('checkedAt', '>=', since24h)
      .orderBy('checkedAt', 'desc').limit(5000).get(), 'stats checks');
  const stats = { up: 0, down: 0, degraded: 0 };
  let rtSum = 0, rtN = 0;
  checks.forEach(d => {
    const c = d.data();
    if (c.success) { stats[c.degraded ? 'degraded' : 'up']++; rtSum += c.responseTime || 0; rtN++; }
    else stats.down++;
  });
  const monSnap = await retry(() => db.collection('monitors').where('enabled', '==', true).get(), 'stats monitors');
  const live = { online: 0, down: 0, degraded: 0, paused: 0, total: 0 };
  monSnap.forEach(doc => {
    const m = doc.data(); live.total++;
    if (m.status === 'UP') live.online++;
    else if (m.status === 'DOWN') live.down++;
    else if (m.status === 'DEGRADED') live.degraded++;
    else if (m.status === 'PAUSED') live.paused++;
  });
  return { stats, live, avgRt: rtN ? Math.round(rtSum / rtN) : null, uptime: fmtUptimeFromStats(stats) };
}

async function handleTelegramCommands(settings) {
  if (!BOT_TOKEN || !ALLOWED_CHATS.length) return;
  try {
    const out = await tgApi('getUpdates', { offset: settings.tgOffset || 0, timeout: 0, limit: 20 });
    if (!out || !out.ok || !Array.isArray(out.result)) return;
    let maxUpdateId = settings.tgOffset || 0;
    for (const upd of out.result) {
      maxUpdateId = Math.max(maxUpdateId, upd.update_id + 1);
      const msg = upd.message;
      if (!msg || !msg.text || !msg.text.startsWith('/')) continue;
      const chatId = String(msg.chat.id);
      if (!ALLOWED_CHATS.includes(chatId)) continue; // unauthorized — ignore silently

      const cmd = msg.text.split(/\s+/)[0].split('@')[0].toLowerCase();
      if (cmd === '/status') {
        const { live, uptime, avgRt } = await collectStatusStats();
        await sendTelegram(chatId,
`🖥 <b>EVOLVECHAT MONITORING</b>

🟢 Online: ${live.online}
🔴 Down: ${live.down}
🟡 Degraded: ${live.degraded}
⏸ Paused: ${live.paused}

Uptime (24h): ${uptime}
Avg response: ${avgRt != null ? fmtNum(avgRt) + ' ms' : 'no data yet'}`);
      } else if (cmd === '/monitors') {
        const snap = await db.collection('monitors').orderBy('name').get();
        const lines = [];
        snap.forEach(d => {
          const m = d.data();
          const dot = m.enabled === false ? '⏸' : (m.status === 'UP' ? '🟢' : m.status === 'DOWN' ? '🔴' : m.status === 'DEGRADED' ? '🟡' : '⚪️');
          lines.push(`${dot} <b>${m.name}</b> — ${m.url}\n   ${m.status || 'UNKNOWN'}${m.lastResponseTime != null ? ' · ' + fmtNum(m.lastResponseTime) + ' ms' : ''}`);
        });
        await sendTelegram(chatId, '🖥 <b>MONITORS</b>\n\n' + (lines.join('\n') || 'No monitors configured'));
      } else if (cmd === '/check') {
        const snap = await db.collection('monitors').where('enabled', '==', true).get();
        const batch = db.batch();
        snap.forEach(d => batch.update(d.ref, { checkRequested: true }));
        await batch.commit();
        await sendTelegram(chatId, '🔄 Check queued for all enabled monitors — results within ~5 minutes.');
      } else if (cmd === '/incidents') {
        const snap = await db.collection('incidents').orderBy('startedAt', 'desc').limit(5).get();
        const lines = [];
        snap.forEach(d => {
          const i = d.data();
          const when = new Date(i.startedAt.toDate ? i.startedAt.toDate() : i.startedAt).toLocaleString('en-GB', { timeZone: 'Asia/Manila' });
          lines.push(i.status === 'open'
            ? `🚨 <b>${i.monitorName}</b> — OPEN\n   ${i.reason} · since ${when}`
            : `✅ <b>${i.monitorName}</b>\n   ${i.reason} · ${fmtDuration(i.durationMs || 0)} · ${when}`);
        });
        await sendTelegram(chatId, '🚨 <b>RECENT INCIDENTS</b>\n\n' + (lines.join('\n\n') || 'No incidents 🎉'));
      }
    }
    if (maxUpdateId !== (settings.tgOffset || 0)) {
      await retry(() => SETTINGS_DOC.update({ tgOffset: maxUpdateId }), 'save tg offset');
    }
  } catch (e) {
    console.warn('[monitor] telegram command loop skipped:', e.message);
  }
}

// ── Retention cleanup (runs at most once/day) ────────────────
async function cleanupIfNeeded(settings) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (settings.lastCleanupAt === todayUtc) return;
  console.log('[monitor] Running retention cleanup…');
  const cutoffs = [
    ['monitorChecks', new Date(Date.now() - 30 * 86400000)],
    ['incidents', new Date(Date.now() - 365 * 86400000)],
    ['monitorNotifications', new Date(Date.now() - 7 * 86400000)]
  ];
  for (const [col, cutoff] of cutoffs) {
    let deleted = 0;
    try {
      // loop in batches until nothing old remains (bounded to avoid runaway)
      for (let round = 0; round < 40; round++) {
        const snap = await db.collection(col)
          .where(col === 'incidents' ? 'resolvedAt' : col === 'monitorNotifications' ? 'sentAt' : 'checkedAt', '<', cutoff)
          .limit(300).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
      }
    } catch (e) {
      console.warn(`[monitor] cleanup ${col} partial failure:`, e.message);
    }
    console.log(`[monitor] cleaned ${col}: ${deleted} docs`);
  }
  // Open incidents older than retention window are force-resolved as "expired"
  try {
    const staleOpen = await db.collection('incidents')
      .where('status', '==', 'open')
      .where('startedAt', '<', new Date(Date.now() - 365 * 86400000))
      .limit(100).get();
    if (!staleOpen.empty) {
      const batch = db.batch();
      staleOpen.forEach(d => batch.update(d.ref, { status: 'resolved', resolvedAt: new Date(), durationMs: 365 * 86400000, resolveReason: 'retention-expired' }));
      await batch.commit();
    }
  } catch (_) {}
  await retry(() => SETTINGS_DOC.update({ lastCleanupAt: todayUtc }), 'save cleanup stamp').catch(() => {});
}

// ── Main ─────────────────────────────────────────────────────
(async () => {
  const runStart = Date.now();
  try {
    const settings = await getSettings();
    if (!settings.seeded) { await seedDefaultMonitors(); await SETTINGS_DOC.update({ seeded: true }).catch(() => {}); }
    await runDueChecks(settings);
    await handleTelegramCommands(settings);
    await cleanupIfNeeded(settings);
  } catch (e) {
    console.error('[monitor] run failed:', e.message);
  }
  console.log(`[monitor] done in ${((Date.now() - runStart) / 1000).toFixed(1)}s`);
  process.exit(0);
})();
