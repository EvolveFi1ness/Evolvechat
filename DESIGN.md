---
version: alpha
name: Evolve
description: A fitness coaching workspace with warm surfaces, clear training data, and restrained orange actions.
colors:
  primary: "#E8712E"
  background: "#F5F0E8"
  surface: "#FFFFFF"
  text: "#1A1712"
  secondary: "#6B6355"
  danger: "#DC2626"
typography:
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif"
  display:
    fontFamily: "DM Serif Display, Georgia, serif"
rounded:
  control: "8px"
  card: "16px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
---

# Evolve design context

## Overview

Evolve is a product workspace for coaches assigning workouts and meals, and clients logging training, nutrition, check-ins, and photos. Preserve the existing identity: a training console with clear meal and exercise groups, orange actions, and prominent numerical readouts. Daily mobile use and dense coach workflows take priority over decoration or a new brand direction.

The UI is English. Existing training-day and nutrition calendar logic uses Asia/Manila; the viewer's operating-system timezone must not silently change stored calendar dates. No Japan-market requirement is established in this project.

Runtime ownership is Model B: `design-tokens.css` owns shared tokens. The frontmatter mirrors its default light theme. Page-local `--gold`, `--bg*`, `--text*` aliases and later CSS overrides still exist; these are migration debt, not alternative shared standards. This document does not generate CSS.

## Colors

| Role | Canonical runtime variable | Shared consumers |
|---|---|---|
| Orange brand/action | `--evolve-orange` | Focus rings, shared confirmations |
| Page/surface | `--evolve-bg`, `--evolve-bg-raised` | Shared UI, dialogs |
| Primary/secondary text | `--evolve-text-primary`, `--evolve-text-secondary` | Shared controls, scrollbars |
| Destructive action | `--evolve-error` | Shared confirmation action |

Dark mode uses `html[data-theme="dark"]` and the corresponding runtime token overrides. Preserve status labels as well as color. Do not replace historical chart series colors without reviewing every chart consumer.

## Typography

Shared body text uses `--font-body`; shared display type uses `--font-display`. Existing Syne, Outfit, Anton, and IBM Plex Mono page-specific treatments remain until a separate migration verifies their consumers. Use ordinary sentence case for actions and tabular numbers for data where already established. Allow food names to wrap instead of hiding essential names or controls.

## Layout

Use the existing desktop sidebar and phone bottom navigation. Keep content clear of fixed navigation and respect safe-area insets. The shared spacing rhythm uses 4px multiples. Food catalogs render 60 rows at a time; searching always searches the full loaded catalog. The coach list uses an explicit load-more action; the client retains its existing incremental scrolling.

## Elevation & Depth

Use tonal surfaces and borders for normal content, and `--shadow-xl` for modal confirmation. Avoid adding decorative shadows to data rows. Native modal dialogs provide a dimmed backdrop and block background interaction.

## Shapes

Shared control radius is `--radius-sm` (8px); cards use `--radius-lg` (16px), and confirmations use `--radius-xl` (20px). Day badges and category chips retain their existing pill treatment.

## Components

Shared behavior is documented in [UX-CONTRACT.md](UX-CONTRACT.md). `shared.js` owns confirmation and toast behavior. Native select and date popups retain operating-system interaction and appearance. Focus must remain visible despite historical inline `outline:none` declarations. Shared scrollbars remain visible and adapt to forced colors; local scrollbar overrides are documented legacy drift. Reduced-motion mode also disables smooth scrolling.

## Do's and Don'ts

- Preserve established screens and data workflows during fixes.
- Explain saving failures, retain entered data, and restore usable controls.
- Confirm destructive actions with a named object and action verb.
- Keep buttons and numerical labels from overlapping at narrow widths.
- Do not infer dead code from a single static occurrence when dynamic references may exist.
- Do not describe this legacy application as fully accessible or fully tested from static checks alone.
