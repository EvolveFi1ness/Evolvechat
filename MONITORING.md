# EvolveChat — Website Monitoring & App Logs

Built-in uptime monitoring for EvolveChat and its endpoints. No n8n, no extra
services — it reuses the existing **GitHub Actions** deployment infrastructure
and the existing **Firestore** database. The dashboard lives in a dedicated
page: **`monitoring.html`**, which is kept **local-only** (never deployed to
GitHub Pages) and needs **no sign-in**. It also streams live app logs and
usage events from both apps (client `index.html` + coach `coach.html`) to help
find bugs.

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
        │  (local only, no     │     chart, incidents, settings + live
        │   sign-in)           │     app_logs & app_events from both apps
        │  · Monitoring tab    │
        │  · Logs / Events tabs│
        └──────────────────────┘
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
- **Logs:** live stream of `app_logs` written by both apps (`client` =
  index.html, `coach` = coach.html). Every console message, uncaught error and
  unhandled rejection lands here within seconds. Filter by app, level
  (error/warn/info/debug) or free-text search; click a row for full message,
  user uid, page URL and device info. This is the fastest way to see what
  broke and where.
- **Events:** live stream of tracked actions (page views and
  `AppLogger.track(...)` calls) from both apps.

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
  collections and app logs **publicly readable**, and monitors/config publicly
  writable, so the local dashboard keeps full functionality (add/edit/pause,
  settings). Anyone who probes Firebase directly could read uptime history and
  user logs or edit monitors — if that ever becomes a concern, restore the
  stricter rules (`allow read/write: if isCoach()`) and sign in instead.
- Raw checks / incidents / notification logs stay browser-read-only; only the
  Admin SDK worker writes them.
- `app_logs` / `app_events` remain append-only from the browser (own entries
  only) — no updates or deletes.
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
