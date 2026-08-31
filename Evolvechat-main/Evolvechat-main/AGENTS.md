# AGENTS.md — rules for autonomous repair agents

This file governs automated agents (including OpenCode runs triggered by Sentry autofix).

## Coding conventions
- Make the smallest change that correctly fixes the reported problem.
- Match the style of surrounding code. Do not reformat unrelated code.
- Keep public APIs stable unless the bug requires changing them.

## Prohibited changes
- Never modify, delete, or commit `.env` files or any file containing secrets/keys/tokens.
- Never modify Firebase project configuration values (api keys, project ids) unless that IS the bug.
- Never disable security checks, CI workflows, or error reporting.
- Never force-push, push directly to the base branch, or rewrite git history.
- Never delete large parts of functionality to make errors disappear.

## Validation
Before declaring a fix complete, run:
- `node --check <changed .js files>` — this project has no package.json scripts; syntax-check changed JS files instead

All validation must pass. If a validation script does not exist, note it and move on.

## Architecture notes
- Static web app served via Firebase Hosting (see firebase.json, deploy.yml).
- Client entry points: index.html (client app), coach.html (coach dashboard).
- Backend: Firestore (rules in firestore.rules) + Cloud Functions where present.
- Service worker: sw.js — cache version bumps matter.

## Scope discipline
- Fix only what the reported Sentry issue requires.
- If you cannot determine the root cause with confidence, reply AUTOFIX_FAILED instead of guessing.