# Coach and client application audit

Date: 26 October 2026. Scope: `coach.html`, `index.html`, and their shared JavaScript, CSS, and service worker. The previous assigned-food day-type editor is preserved.

This is a source audit and an implemented hardening pass with isolated browser fixtures. It is not a production penetration test or certification that every deployed workflow is defect-free. No production account or record was accessed or modified, and Firebase configuration, rules, CI, and error reporting were preserved.

## Changes implemented

| Area | Finding and change | Evidence |
|---|---|---|
| Startup | An unavailable Firebase SDK left `db` null; `enablePersistence` threw and aborted client initialization. Guarded the optional persistence call. | Both pages loaded with external SDK requests blocked, without uncaught errors. |
| Cold food search | The client opened search without awaiting the catalog, then called array methods on a null catalog. Search now waits, displays loading, and ignores a closed search. | Browser cold-load search test. |
| Food retry | Failed loads cached an empty array/promise indefinitely. Failed/invalid/empty loads can now retry; page-level caches also release failed promises. | Mock failure/recovery regression. |
| Catalog separation | One global food cache could return the wrong catalog when called with another URL. Cache and in-flight promises are now keyed by URL. | Distinct-URL and concurrent-read regression. |
| Network resilience | A hung catalog request had no deadline. Added AbortController timeout and bounded retries; only valid food arrays are cached. | Source inspection and invalid-response/retry regression. Real network timeout duration was not measured. |
| Client performance | Formatting/render helpers started unnecessary catalog loads, and opening Nutrition waited for the catalog before loading plans. Removed those incidental loads and the plan-screen dependency. | Source inspection and tab/browser checks. |
| Coach performance | Zero-delay batches eventually created every catalog row. Now renders 60 rows initially, with an explicit accessible load-more button. Full-catalog filtering remains available. | Browser verifies 60 rows, then 120 after load-more. Built-in catalog contains 3,068 rows: about 98% fewer initial rows. This is a DOM count improvement, not a measured page-speed percentage. |
| Search stability | Background coach catalog refresh discarded the active category/query. Refresh now reapplies filters; failed Firestore refresh can retry. | Source inspection; local search workflow checks. |
| Search cancellation | Clearing search left the old debounce active; closing client search retained observers. Clear cancels pending search; close and result replacement disconnect old observers. | Browser clears before debounce and verifies restored results. |
| Nutrition races | A single in-flight flag queued the old request's arguments when the selected day changed. Reads now coalesce by UID/date, fetch independent queries concurrently, build a complete day locally, and discard a result for a signed-out account. | Regression resolves days out of order and switches account before completion. |
| Coach races | Old assigned-food or macro responses could overwrite a newer client selection. Added monotonically increasing request guards, including error responses. | Browser resolves a stale assigned-food request after clearing client selection; macro guard inspected. |
| Profile ownership | Profile cache had no UID owner check. All three writers now stamp the owner; startup ignores unowned, foreign, and cached blocked/pending/rejected profiles. | Writer/reader source inspection. Real authentication transition still needs integration testing. |
| Sign-out state | Nutrition/custom-food state survived sign-out and could be reused by the next user. Both paths now use one session cleanup owner, clearing listeners, account data, custom foods, and profile cache. | Browser sign-out fixture checks cache and custom-food removal. |
| Session loss | Client auth observer had no cleanup for a user becoming signed out. Added cleanup for that transition and guards against an outdated auto-login fetch. | Source inspection; sign-out/browser checks. External session-expiry integration remains unverified. |
| Failed sign-out | UI reset continued even when Firebase sign-out failed. The app now reports failure and preserves the session and a usable button. | Browser mock rejects sign-out and verifies the UID remains active. |
| Calendar dates | Photo schedule code converted local midnight to UTC before taking the date, shifting dates in UTC+8. Uses a shared calendar-date formatter. | UTC+8 date regression, including next scheduled weekday. |
| Serving default | Foods whose first unit was grams/ml opened at 1g/ml rather than the standard serving. Detail now starts at the food's stored serving size. | Browser opens food detail and compares serving grams with its catalog serving. |
| Quantity editing | Empty, zero, negative, and non-finite quantities could be silently converted or saved. Require a positive finite value, restore Save after missing-document/failure paths, and invalidate nutrition caches after a successful edit. | Regression checks invalid quantities and correct proportional macro scaling. |
| Destructive actions | Twelve native browser confirmations and a separate client-only overlay had inconsistent accessibility. Replaced them with one shared native modal dialog and preserved the existing confirmation API. | Both apps: Cancel, Escape, confirm, initial focus, focus wrapping, and repeated-open suppression. |
| Toast feedback | A previous toast's timer could hide the next toast early. One shared timer now replaces the old timer; status is announced through a polite atomic live region. | Timer regression and browser shared UI checks. |
| Mobile layout | Food calorie labels overlapped quick-add controls at phone width. Changed mobile grid sizing and increased the quick-add target. Assigned-food headings can wrap long food names, status, and day controls. | Browser bounding-box assertion at 390px and screenshots. |
| Keyboard access | Food search/list rows were click-only. Added button semantics, accessible names, focusability, and Enter/Space activation. Search clear/close controls have names. | Client keyboard activation and shared focus checks; coach markup and workflow inspection. |
| Text rendering | Changed nutrition renderers inserted food/category names directly into markup or handler attributes. Use contextual HTML/attribute escaping and data attributes in these paths. | Browser fixture includes quotes, ampersands, and angle brackets; verifies no injected element. This is not a complete stored-XSS audit. |
| Navigation | Coach's first navigation replaced the initial dashboard history entry. Preserve it before pushing the new page. Validate page/tab destinations and update titles/active navigation accessibility state. | All six coach pages and all six client tabs exercised with fixtures; history logic inspected. |
| Shared accessibility | Strengthened visible focus against inline outline resets, added a shared scrollbar baseline/forced-color handling, and disable smooth scrolling for reduced motion. | Browser reduced-motion checks and computed-style inspection. Legacy per-screen drift remains below. |
| Offline worker | Cached static hits left failed background refresh promises unhandled; unsuccessful responses could replace good cache entries. Register and handle refresh work, and cache only successful responses. | Offline cached-hit and unsuccessful-response regressions. |
| Font caching | Cross-origin early return made the worker's font-cache branch unreachable. Permit only the existing Google font hosts through that gate. | Regression verifies the font request reaches its handler. |
| Update delivery | New HTML depends on new shared helpers. Added matching versioned JS/CSS URLs and precache entries, and bumped worker cache to v7 to avoid pairing new HTML with old cached helpers. | Syntax/worker regressions and browser loading of versioned assets. Installed-PWA upgrade remains a live test. |
| Dead code | Removed identical duplicate `jsAttrSafe`, declaration-only `renderPtClientList`, `clearNutrBuilder`, `loadClientNutritionSummary`, and `macroPBar`, plus the superseded client confirmation markup/style/function. Removed the obsolete coach batching timer and duplicate sign-out cleanup. | Reference inspection and syntax/browser tests. Other uncertain legacy code was retained. |

## Verification

There is no application `package.json` or existing application test script. The monitoring worker is a separate package and was not changed.

- `node scripts/audit/verify.cjs`: 8 passing test groups. Includes `node --check` on every inline script (15 coach, 17 client), shared JS, service worker, and audit JS files.
- `node scripts/audit/browser.cjs`: local Chrome/Playwright fixtures at 390px and 1366px, both themes, all primary pages/tabs, dialog states and keyboard interaction, catalog loading/clearing, food editing, stale response, invalid sign-out, sign-out cleanup, reduced motion, and uncaught-error capture. External traffic is blocked; Firebase reads/writes are mocked.
- Browser screenshots are generated under the OS temporary directory `evolve-audit-screenshots`; set `AUDIT_SCREENSHOTS` to keep them elsewhere. Visual inspection informed the mobile calorie/action fix.
- `premium-ui.json`, `DESIGN.md`, and `UX-CONTRACT.md` record canonical UI ownership and reproducible commands. Runtime CSS remains the token source; documentation does not generate CSS.
- Installed premium static auditor: strict run attempted, then bounded to 45 seconds; it did not complete. See `premium-audit.json`. This result is not a passing audit.
- Official DESIGN.md lint: attempted using `npx --offline --package @google/design.md designmd lint DESIGN.md`; the installed npx launcher references a missing npm module, so lint could not run. No package was installed and no dependency change was made.

Run browser checks after starting a local static server. Playwright and Chrome must be available; the bundled runtime supplied Playwright during this audit through `NODE_PATH`. Fixtures never use an existing browser profile.

## Remaining findings and required follow-up

| Priority | Finding | Implication / next action |
|---|---|---|
| P1 | Current Firestore member rules do not allow client `myEvents` writes, while client calendar handlers use that collection. Client photo scheduling also updates fields absent from the member update allowlist. | These client writes appear incompatible with the checked-in rules. Reconcile the intended authorization contract and validate against a Firestore emulator before changing rules. Frontend date formatting is fixed; deployed schedule persistence is not verified. |
| P1 | Authentication, authorization, upload/storage behavior, and full multi-client CRUD were tested only with fixtures here. | Validate with designated test accounts/emulators and the deployed rule set. No production credentials were requested or used. |
| P1 | Other legacy renderers still interpolate stored values into HTML and inline event handlers. | Migrate remaining paths with contextual escaping or DOM text APIs and targeted adversarial tests. The nutrition fixes do not establish whole-app XSS safety. |
| P2 | The two HTML entry points remain roughly 1MB and 0.85MB with extensive inline CSS/JS and page-level theme overrides. Multiple font families remain in use. | Modularize by feature and deduplicate CSS only after introducing full workflow coverage. Removing apparently unused CSS by grep alone can break dynamically rendered UI. No wholesale rewrite was attempted. |
| P2 | Native modal confirmation is hardened, but other existing drawers/detail/upload overlays have separate focus and dismissal behavior. Several unrelated icon-only controls and scrollbar overrides remain. | Continue keyboard/screen-reader migration across those overlays and compare narrow screens, zoom, forced colors, and real mobile browsers. Do not claim WCAG conformance from these checks. |
| P2 | Some Firestore queries use fixed limits, while monitoring/listener fan-out depends on the number of clients. | Profile a representative coach dataset before choosing pagination or subscription changes; fixture tests cannot establish production read cost or worst-case latency. |
| P2 | Client nutrition initialization and real-time listeners have additional slow/offline/error transitions beyond the covered race. | Exercise initial query failure, reconnect, account switching, and assigned-plan updates with emulator-backed tests. |
| P2 | Profile cache contains existing health/profile information in browser storage; most of its pre-existing field list remains unchanged. | Agree on offline retention and shared-device policy before changing the product's cache behavior further. Owner binding reduces account mixing but is not encryption or an authorization boundary. |
| P2 | Both browser PWA upgrade and offline navigation need testing with an installed prior version and real browser cache state. | Confirm old v6 assets migrate to v7, then test offline reload and reconnection. The worker VM tests cover individual cache branches. |
| P3 | Legacy orphaned plan/builder helpers and theme CSS need a deeper reachability inventory. | Further removal should follow runtime coverage; no large functionality blocks were deleted to silence errors. |
| Tooling | Premium static validator timed out; official design linter is unavailable because local npm tooling is broken. | Repair tooling and rerun. The project-owned regression/browser suite remains runnable with the documented dependencies. |

## Design drift

| Contract | Evidence | Resolution |
|---|---|---|
| Shared token ownership | `design-tokens.css` plus page-local historical aliases and font overrides | Preserved visual identity; shared additions use canonical tokens. Remaining alias/font cleanup recorded. |
| Consistent feedback and confirmation | Previously two toast functions and an inaccessible client-only overlay | Shared behavior now owns both apps; wrapper signatures and duration differences preserved. |
| Visible scrolling and keyboard focus | Inline outline resets and local hidden/narrow scrollbar rules | Shared baseline hardened; unrelated local scrollbar/overlay migration remains. |

No deployment or Git commit was performed. The supplied folder has no Git metadata; before-edit copies of the five application files were kept in the OS temporary directory for local comparison.
