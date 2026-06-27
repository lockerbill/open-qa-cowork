# Dogfood checklist (spec §16 — Milestone 7)

Run QA Copilot against 3–5 real SPAs and record findings here. The goal is to
measure page-summary quality, generated-artifact usefulness, and to collect QA
feedback before widening scope.

## How to run a dogfood session

1. Start the server (`pnpm --filter @qa-copilot/server dev`) with a real LLM key.
2. Build + load the extension (`apps/extension/dist`).
3. Add the target origin via the Options page (grants host permission).
4. Scan → ask "what should I test?" → record a real flow → generate all three artifacts.

## Per-app scorecard

| App / URL | Scanner: % interactable elements detected | Page summary accurate? | Test cases useful (1–5) | Bug report repro correct? | Playwright draft compiles? | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| _example staging app_ | | | | | | |
| | | | | | | |
| | | | | | | |

## Target metrics (spec §17)

- Scanner detects > 90% of visible interactable elements.
- Generated bug reports include correct reproduction steps in > 80% of sessions.
- Generated Playwright drafts compile in > 90% of cases (`tsc --noEmit` on the export).
- Zero password/token captures; redaction suite passes 100%.

## Feedback log

- _date — tester — observation — action item_
