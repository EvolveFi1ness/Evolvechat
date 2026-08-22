# EvolveChat — Website Monitoring

Built-in uptime monitoring for EvolveChat and its endpoints. No n8n, no extra
services — it reuses the existing **GitHub Actions** deployment infrastructure
and the existing **Firestore** database, with the dashboard embedded in the
Coach dashboard (`coach.html → Monitoring`).

---

## How it works

```
┌─────────────────────┐   every 5 min    ┌──────────────────────────────┐
│ GitHub Actions cron │ ───────────────▶ │ scripts/monitor/run-checks.js│
│ (monitoring.yml)    │                  │  · HTTP/API/PAGE checks      │
└─────────────────────┘                  │  · SSL certificate inspection│
                                         │  · SSRF-guarded fetch        │
         Firestore (existing project)    │  · incidents + recovery      │
┌──────────────────────────────────────┐ │  · Telegram alerts/commands  │
│ monitors · monitorChecks · incidents │◀│  · retention cleanup         │
│ monitorConfig · monitorNotifications │ │                              │
└──────────────────────────────────────┘ └──────────────────────────────┘
                   ▲
                   │ reads live via coach auth (firestore.rules: coach-only)
        ┌──────────┴───────────┐
        │ coach.html Monitoring│  ← status cards, monitor table,
        │ page                 │     response chart, incidents, settings
        └──────────────────────┘
```

- **Statuses:** `UP`, `DOWN` (after N consecutive failures, default 3),
  `DEGRADED` (success but slower than threshold), `PAUSED`.
- **Incidents** open automatically on DOWN and close on recovery with the
  exact downtime duration.
- **No fake data.** Before the first real check lands, the dashboard shows
  "No monitoring data yet" / "—".

## One-time setup

1. **Deploy rules + UI:** push to `main` (normal deploy). Then publish the
   updated security rules and query indexes:
   ```
   firebase deploy --only firestore:rules firestore:indexes
   ```
   (Monitor-detail views also work without indexes — they auto-fall back to
   client-side sorting — but deploying them keeps it fast.)
2. **Create a Firebase service account** (worker identity):
   Firebase Console → Project settings → Service accounts →
   *Generate new private key* → download JSON.
3. Base64-encode it and add repo secrets (**Settings → Secrets and variables → Actions**):
   | Secret | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT_B64` | base64 of the service-account JSON |
   | `TELEGRAM_BOT_TOKEN` | from @BotFather (optional) |
   | `TELEGRAM_CHAT_ID` | your chat id, comma-separated list allowed (optional) |
4. Open the **Actions → Website Monitoring** workflow and press **Run workflow**
   once for an immediate first check (or wait ≤5 min for cron).

## Using the dashboard

Coach dashboard → **Monitoring**:

- Overview cards: monitors, online/down/degraded, open incidents,
  avg response (24h) and uptime (24h) — computed from real check data only.
- Monitor table: status, URL, type, response time, 24h uptime, last check.
  Row actions: **Check now** (queues a run — executes on the next worker pass,
  never from the browser), **Pause/Resume**, **Edit**, **Delete**.
- Click a row for details: response-time chart, uptime windows
  (1h / 24h / 7d / 30d), recent checks, incident history, SSL certificate
  (issuer, expiry, days remaining).
- **Settings:** failure threshold, slow-response threshold, Telegram toggles
  (down / recovery / SSL / slow).

Default monitors are seeded automatically on the worker's first run using
real EvolveChat URLs only (homepage, coach dashboard, workouts data file).

## Adding a monitor

Monitoring → **+ Add Monitor**

| Field | Meaning |
|---|---|
| Name | Display name |
| URL | Public http(s) URL — localhost/private IPs/metadata endpoints are rejected |
| Type | HTTP (status code), API (status + optional body text), PAGE (content check) |
| Interval | 5–60 minutes |
| Timeout | 2–60 s |
| Expected Status | e.g. `200` or `200,301` |
| Expected Text | fails if not found in response body |

## Telegram

Alerts are sent by the worker directly via the Bot API.

Down alert example:

```
🚨 EVOLVECHAT DOWN
Monitor: EvolveChat Website
URL: https://…
Status: HTTP 500 (expected 200)
Response: 1,842 ms
Failures: 3 consecutive
Time: 20:43:10
```

Commands (authorized chat IDs only): `/status` `/monitors` `/check` `/incidents`.

## Scheduled checks & platform notes

- GitHub Actions cron minimum granularity is **5 minutes**; runs can be
  delayed a few minutes under load. Intervals below 5 min are therefore
  not offered.
- The worker runs server-side in Actions — **no browser needs to be open**.
- "Check Now" from the UI sets a flag the worker consumes on its next pass.

## Security

- Dashboard access reuses the existing coach authentication; Firestore rules
  restrict monitoring collections to coaches.
- Raw checks / incidents / notification logs are **read-only for clients**
  (only the Admin SDK worker writes them) — uptime history cannot be forged
  from the browser.
- Worker enforces SSRF guards: http/https only, public DNS-resolved IPs only,
  standard ports, redirects re-validated. Tokens live exclusively in GitHub
  secrets — never hardcoded, never in the database.

## Retention

| Data | Kept |
|---|---|
| Raw checks | 30 days |
| Incidents | 1 year |
| Notification logs | 7 days |

Cleanup runs automatically once per day inside the scheduled job.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No monitoring data yet" forever | Workflow didn't run: check Actions tab; verify `FIREBASE_SERVICE_ACCOUNT_B64` secret is set and valid |
| `permission-denied` in dashboard | Re-deploy updated `firestore.rules` |
| No Telegram messages | Verify bot token + chat id secrets; send the bot any message first so it can reply; check Settings toggles |
| Checks lag behind interval | Normal GitHub-hosted runner jitter (few minutes) |
