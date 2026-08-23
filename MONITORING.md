# EvolveChat — Website Monitoring

Built-in uptime monitoring for EvolveChat and its endpoints. No n8n, no extra
services — it reuses the existing **GitHub Actions** deployment infrastructure
and the existing **Firestore** database. The dashboard lives in a dedicated
page: **`monitoring.html`**, which is kept **local-only** (never deployed to
GitHub Pages) and needs **no sign-in**.

Bug & log monitoring is handled separately by **Sentry**: both apps
(`index.html`, `coach.html`) auto-load the Sentry SDK once you paste a DSN
into `SENTRY_DSN` (search each file for "paste your Sentry DSN here").

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
                   │ reads live via Firestore (public read rules)
        ┌──────────┴───────────┐
        │ monitoring.html      │  ← status cards, monitor table, response
        │  (local only, no     │     chart, incidents, settings
        │   sign-in)           │
        └──────────────────────┘

Bugs & logs: Sentry (sentry.io) — paste a DSN into SENTRY_DSN in both apps.
```

- **Statuses:** `UP`, `DOWN` (after N consecutive failures, default 3),
  `DEGRADED` (success but slower than threshold), `PAUSED`.
- **Incidents** open automatically on DOWN and close on recovery with the
  exact downtime duration.
- **No fake data.** Before the first real check lands, the dashboard shows
  "No monitoring data yet" / "—".

## One-time setup

1. **Keep it local:** `monitoring.html` must stay on your machine — do NOT
   push/deploy it to GitHub Pages or any public host.
2. **Deploy rules + indexes** so the no-sign-in dashboard can read/write:
   ```
   firebase deploy --only firestore:rules firestore:indexes
   ```
   (Monitor-detail views also work without indexes — they auto-fall back to
   client-side sorting — but deploying them keeps it fast.)
3. **Create a Firebase service account** (worker identity):
   Firebase Console → Project settings → Service accounts →
   *Generate new private key* → download JSON.
4. Base64-encode it and add repo secrets (**Settings → Secrets and variables → Actions**):
   | Secret | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT_B64` | base64 of the service-account JSON |
   | `TELEGRAM_BOT_TOKEN` | from @BotFather (optional) |
   | `TELEGRAM_CHAT_ID` | your chat id, comma-separated list allowed (optional) |
5. Open the **Actions → Website Monitoring** workflow and press **Run workflow**
   once for an immediate first check (or wait ≤5 min for cron).

## Using the dashboard

Open **monitoring.html** locally (double-click, or serve the folder and visit
`/monitoring.html`) — it opens straight into the console, no password:

- **Monitoring:** overview cards (monitors, online/down/degraded, open
  incidents, avg response 24h, uptime 24h) computed from real check data only.
  Monitor table: status, URL, type, response time, 24h uptime, last check.
  Row actions: **Check now** (queues a run — executes on the next worker pass,
  never from the browser), **Pause/Resume**, **Edit**, **Delete**. Click a row
  for details: response-time chart, uptime windows (1h / 24h / 7d / 30d),
  recent checks, incident history, SSL certificate.
  **Settings:** failure threshold, slow-response threshold, Telegram toggles
  (down / recovery / SSL / slow).

Bug & log monitoring moved to **Sentry**: create a project at sentry.io
(Platform: JavaScript), then paste the DSN into `SENTRY_DSN` in both
`index.html` and `coach.html`. Every console error, uncaught exception and
unhandled rejection then reports automatically with stack traces, breadcrumbs
(the recent console log trail) and device info.

Default monitors are seeded automatically on the worker's first run using
real EvolveChat URLs only (homepage, coach dashboard, workouts data file).

## Adding a monitor

monitoring.html → **Monitoring** → **+ Add Monitor**

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

- `monitoring.html` has **no sign-in** — it is protected by staying **local
  only**. Never deploy or commit it to a public host.
- Because the page runs signed-out, the Firestore rules make the monitoring
  collections **publicly readable**, and monitors/config publicly writable,
  so the local dashboard keeps full functionality (add/edit/pause, settings).
  Anyone who probes Firebase directly could read uptime history or edit
  monitors — if that ever becomes a concern, restore the stricter rules
  (`allow read/write: if isCoach()`) and sign in instead.
- Raw checks / incidents / notification logs stay browser-read-only; only the
  Admin SDK worker writes them.
- Error/log monitoring happens in Sentry — no app logs are stored in
  Firestore anymore.
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
