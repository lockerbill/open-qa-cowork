# auto-test-ui

Side panel Auto tab: run setup, live timeline with confirmation flow, result view, and integration with the existing session/Playwright/bug-report generators. (Source detail: auto-test-mode-spec.md §10, §11, §12.)

## ADDED Requirements

### Requirement: Setup view collects run configuration safely
The Auto tab setup view SHALL provide: a goal textarea; a "use a suggested test case" picker that prefills the goal from a suggest-mode test case (`Test: <title>. Steps: <numbered steps>. Expected: <expectations>`); a mode radio (Observe only / Confirm actions [default] / Autonomous) where Autonomous requires an extra "I understand" checkbox; a max-steps slider (5–60, default 25); an origin allowlist prefilled with the active tab's origin; a credentials editor (name → value rows stored to the session vault, values masked after entry); and Start. The Auto tab SHALL be gated by the `autoTestMode` feature flag (default ON in dev builds, OFF in the store build until M5 acceptance).

#### Scenario: Autonomous requires explicit opt-in
- **WHEN** the user selects Autonomous mode without checking "I understand"
- **THEN** the run cannot start

#### Scenario: Credentials masked after entry
- **WHEN** the user enters a credential value and moves focus away
- **THEN** the value displays masked and is stored only in `chrome.storage.session`

### Requirement: Run view shows live progress and handles confirmations
During a run the view SHALL show a status pill, budget bars (steps, time), and a live timeline of `TraceStep`s (`#n [icon] intent — action summary → result`; assert steps get pass/fail chips; defects get a red card). When status is `awaiting_confirmation` a modal SHALL present the action summary and target element text with Approve and Reject-with-note, plus a 120 s countdown after which the action is treated as rejected. Pause, Resume, and Stop controls SHALL be available.

#### Scenario: Confirmation modal round-trip
- **WHEN** the guard requests confirmation for a destructive click
- **THEN** the modal shows the action and element text, and the user's Approve/Reject (with optional note) verdict is returned to the service worker

#### Scenario: Confirmation timeout rejects
- **WHEN** the user does not respond to a confirmation within 120 s
- **THEN** the action is recorded as `rejected_by_user` and the run continues

### Requirement: Result view persists and exports through existing generators
After finalization the result view SHALL show the outcome banner, defect list, and assertion summary (n passed / n failed) plus per-run metrics (steps, LLM calls, corrections, refusals, confirmations, wall clock, outcome), and SHALL offer Export session JSON, Generate Playwright draft, and Generate bug report — all wired into the existing features. `RunResult` SHALL persist with the recorder session (same storage as recorded sessions) so runs are reviewable after the fact.

#### Scenario: Defect one-click bug report
- **WHEN** the user clicks Generate bug report on a defect card
- **THEN** the existing bug-report generator opens prefilled with `{summary, expected, actual, traceExcerpt}` from the defect

#### Scenario: Run reviewable later
- **WHEN** the browser session ends and the side panel is reopened
- **THEN** the persisted `RunResult` and its trace are still viewable with the session

### Requirement: Auto-sourced events are visible in the timeline and generator output
The session timeline UI SHALL show a small ⚙ badge on events tagged `source:'auto'`. The Playwright generator SHALL emit `// intent: …` comments above steps when `intent` is present (additive, behind the generator's existing options if any). The bug-report generator SHALL accept an optional `defect` prefill payload. Existing generator inputs SHALL otherwise remain unchanged so auto runs export with zero changes to generator contracts.

#### Scenario: Playwright draft carries intents
- **WHEN** a Playwright draft is generated from an auto run whose steps carry `intent`
- **THEN** each generated step is preceded by an `// intent: …` comment
