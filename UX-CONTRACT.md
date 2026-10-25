# Evolve UI behavior contract

Visual intent and token ownership are in [DESIGN.md](DESIGN.md). This contract records the shared behavior introduced or verified by the October 2026 audit; legacy screens still need incremental migration.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table Selection | Existing coach client-list controls | coach.html | Existing explicit client selection | Requires live multi-client verification |
| Select/Listbox | Native HTML select | Browser platform and page field handlers | Native; OS-owned popup geometry | Browser day-type selection and options |
| Date | Native date inputs and existing PH calendar helpers | Page-specific calendar rules; shared localDateKey | Native input; PH calendar strings | UTC+8 regression check |
| Form | Existing page handlers | Page validation and backend rules | Existing client/coach forms | Quantity validation and recovery tests |
| Scrollbar | design-tokens.css document baseline | Shared runtime tokens | Standards properties and WebKit fallback | Computed style; legacy overrides remain |
| Toast | shared.js showAppToast | shared.js | Success/info/error durations via page wrappers | Timer replacement and live-region check |
| CRUD | Existing page handlers plus shared showConfirmDialog | Firestore rules and operation handlers | Save in place; destructive confirmation | Mocked food edit/failure and dialog tests |

## Operations and navigation

- Routine edits save in place and show feedback after the write succeeds. A failed day-type save restores the previous selection. Quantity edits require a positive finite number; macros scale from the last stored serving.
- Destructive and discard actions await the shared confirmation dialog. Cancel and Escape perform no write. Repeated taps while a confirmation is open must not queue another operation.
- Confirmation initially focuses Cancel, wraps keyboard focus within its actions, and restores the trigger after closing. The native modal top layer makes the background inert.
- Page/tab navigation validates destinations, updates the page title and active navigation accessibility state, and preserves browser history. Coach Back returns to the previous page, including the initial dashboard.

## Loading, errors, and recovery

- Food database requests share a promise per URL. Different catalogs never share data. Failed/empty/invalid responses are not permanently cached; a later search can retry. Requests are bounded by an abort timeout with limited backoff retries.
- Client food search waits for the initial catalog before reading it. Clear cancels pending search and restores results immediately. Closing search disconnects incremental rendering observers.
- Coach catalog refresh preserves the selected category and query. Catalogs initially render 60 items and provide a way to reach the remainder.
- Nutrition day reads coalesce by account and date, fetch independent queries concurrently, and commit a complete day only for the current account. Coach assigned-food and macro responses ignore superseded client selections.
- Existing data is retained when a nutrition reload fails; error reporting remains enabled. Wider offline/conflict behavior is legacy and requires live integration coverage.

## Identity and stored data

- Cached profile data is owned by the authenticated UID. Unowned legacy caches and another user's cache cannot populate the home screen. Cached blocked/pending/rejected profiles cannot enter the cached home path.
- Both sign-out paths discard account-specific nutrition plans/logs/custom foods, profile state, and profile cache. Firestore remains responsible for authorization.
- This audit does not change Firebase project configuration, production records, permissions, or rules.

## Accessibility and verification

Native fields retain their platform keyboard model. Food-search results expose button semantics and support Enter/Space. Shared toasts have a polite atomic live region. New icon-only search controls have accessible names. Respect reduced motion and forced colors. Existing overlays and legacy controls outside the migrated flows still require a wider accessibility review.

Run `node scripts/audit/verify.cjs`. For isolated browser fixtures, serve the root locally and run `node scripts/audit/browser.cjs` with Playwright available. Those fixtures block external requests and mock Firebase; they are not proof of deployed authentication, authorization, storage upload, or Firestore integration.
