# auto-page-driver Specification

## Purpose
Vendored page-agent DOM/action primitives plus the content-script `PageDriver`: redacted observation building, indexed element maps, safe action execution with settle detection and durable-selector recording, per-step console/network capture, and the stop overlay. (Source detail: auto-test-mode-spec.md §4, §6.)

## Requirements

### Requirement: Vendored page-agent code is pinned, licensed, and documented
The extension SHALL vendor the DOM-extraction and action-primitive files from `alibaba/page-agent` (pinned base commit `da1db959558dcd49a6c489e76a23accfbda7b156`, package `@page-agent/page-controller` v1.12.2) into `apps/extension/src/vendor/page-agent/`, including `VENDORED.md` (recording the upstream repo, pinned commit, package version, and sync process) and both MIT license files (page-agent and browser-use provenance). Upstream copyright headers MUST remain intact and every local edit MUST carry a `// @openqa-edit <reason>` marker.

#### Scenario: Vendor directory contents
- **WHEN** the vendor directory is inspected
- **THEN** it contains `dom_tree.js`, `dom_tree.d.ts`, `dom.ts`, `get-page-info.ts`, `actions.ts`, `utils.ts`, `patches/react.ts`, `VENDORED.md`, `LICENSE-page-agent`, and `LICENSE-browser-use`
- **AND** no files from upstream `PageController.ts`, `mask/`, `packages/core`, `packages/llms`, `packages/ui`, or `packages/extension` are present

#### Scenario: Local edits are marked
- **WHEN** a vendored file diverges from its upstream source at the pinned commit
- **THEN** each divergent hunk carries a `// @openqa-edit <reason>` comment

### Requirement: No dynamic code execution in vendored files
The vendored code SHALL NOT contain any `eval` or `new Function` pathway. The `executeJavascript` pathway MUST be removed, and CI MUST fail the build if `vendor/page-agent` matches `/\beval\s*\(|new Function\s*\(/`.

#### Scenario: CI grep gate
- **WHEN** CI runs on a tree where any file under `vendor/page-agent` matches `eval(` or `new Function(`
- **THEN** the build fails

### Requirement: Vendor imports are restricted to the PageDriver boundary
Only `apps/extension/src/content/auto/page-driver.ts` SHALL import from `vendor/page-agent/`. This boundary MUST be enforced by an ESLint `no-restricted-imports` rule.

#### Scenario: Non-boundary import is rejected
- **WHEN** any module other than `content/auto/page-driver.ts` imports from `vendor/page-agent/`
- **THEN** lint fails with the boundary-rule violation

### Requirement: Observation builder produces a redacted, indexed page snapshot
The `PageDriver.observe()` method SHALL build an `Observation` using the vendored flat-tree extraction with `viewportExpansion: 400`, a blacklist covering the extension's own overlay/panel elements (tagged `data-openqa-ignore`), and the vendored React root-marking patch. The serialized output SHALL use the vendored `flatTreeToString` format with a header (`Current Page`, page info, scroll markers) and footer, and SHALL include an active-dialog warning when a topmost `dialog[open]`, `[role=dialog]`, or `[role=alertdialog]` is visible. `observe()` SHALL return `{ observation, elements }` where `elements` carries per-element metadata (`index`, `tag`, `role`, `text`, `attributes`, `states`, `isSecret`) for the service worker's guard checks.

#### Scenario: Elements indexed for LLM targeting
- **WHEN** an observation is built on a page with interactive elements
- **THEN** each interactive element appears in `serialized` with a numeric `[index]` and in the returned `elements` metadata under the same index
- **AND** no CSS selectors appear in `serialized`

#### Scenario: Oversized snapshot falls back to viewport-only
- **WHEN** extraction with `viewportExpansion: 400` yields more than 150 interactive elements
- **THEN** extraction re-runs with `viewportExpansion: 0` and the serialized footer notes the truncation

#### Scenario: Extension UI excluded from observation
- **WHEN** the page contains elements tagged `data-openqa-ignore` (e.g., the stop overlay)
- **THEN** those elements do not appear in the observation

#### Scenario: Open dialog is flagged
- **WHEN** a visible dialog is the topmost dialog on the page
- **THEN** `activeDialog` carries its accessible name and the serialized body is prefixed with a dialog warning line

#### Scenario: Fresh epoch per observation
- **WHEN** a new observation is built
- **THEN** `epoch` increments and the previous snapshot's element indices are no longer valid

### Requirement: Per-node redaction reuses existing detectors before serialization
Redaction SHALL happen per-node inside the observation builder — never as a pass over the serialized string — via a `redactNode` callback inserted into the vendored `flatTreeToString`. It SHALL reuse the existing shared PII/secret detectors: secret fields (password inputs, sensitive `autocomplete` values, name/id matches of the existing secret-field detector) are marked `isSecret` with values replaced by the repo's existing secret token (e.g. `[REDACTED]`) and text never emitted; PII matches in any emitted text or attribute value are replaced with the existing token format; single text nodes are capped at 120 characters.

#### Scenario: Password value never serialized
- **WHEN** a page contains `input[type=password]` with a value
- **THEN** the observation marks the element `isSecret` and neither `serialized` nor `elements` contains the value

#### Scenario: Redaction parity with suggest mode
- **WHEN** the same PII-bearing input string passes through the suggest-mode pipeline and through `redact-node`
- **THEN** both produce identical redaction tokens

### Requirement: Action executor gates execution and records durable selectors
`PageDriver.execute(action, epoch)` SHALL run ordered safety gates before dispatching any vendored primitive: epoch match (`stale_epoch`), index resolution (`index_not_found`), connectedness (`element_detached`), visibility after `scrollIntoViewIfNeeded` (`not_visible`), and a hit test where `elementFromPoint(center)` must be the element, a descendant, or an ancestor label (`covered`, with the covering element's tag and text in `detail`). Before dispatch, the executor MUST record a durable selector via the existing selector-priority ladder and capture `elementText`. Element actions dispatch via vendored primitives (`clickElement`, `inputTextElement` with post-fill value verification, `selectOptionElement` with `option_not_found` listing up to 10 available options, key events on `document.activeElement`, `scrollVertically`); `assert`, `report_defect`, and `finish` SHALL return `{ ok: true, settled: true }` without touching the page.

#### Scenario: Stale epoch rejected
- **WHEN** `execute` is called with an epoch older than the current observation
- **THEN** it returns `{ ok: false, reason: 'stale_epoch' }` without touching the page

#### Scenario: Covered element reported with evidence
- **WHEN** the hit test at the target's center resolves to an unrelated overlaying element
- **THEN** the result is `{ ok: false, reason: 'covered' }` with the covering element's tag and text in `detail`

#### Scenario: Selector recorded before destructive dispatch
- **WHEN** a click destroys the target node
- **THEN** the `ActionResult` still carries the `durableSelector` and `elementText` recorded before dispatch

#### Scenario: Fill verifies applied value
- **WHEN** a `fill` on an input completes but `el.value` does not equal the requested value
- **THEN** the result is `{ ok: false, reason: 'error', detail: 'value_not_applied' }`

#### Scenario: Navigation during action is success
- **WHEN** an executed action triggers a page navigation before settle completes
- **THEN** the result is `{ ok: true, navigated: true, settled: false }`

### Requirement: Settle detection bounds step completion
`settle(maxMs = 5000)` SHALL resolve when all of the following hold: no DOM mutations for 400 ms (ignoring mutations inside the extension's own overlay), zero in-flight tracked fetch/XHR requests, and `document.readyState === 'complete'`. On hard timeout it SHALL resolve with `settled: false` as a reported outcome, not an error.

#### Scenario: Infinite spinner hits timeout
- **WHEN** a page keeps mutating the DOM continuously past `maxMs`
- **THEN** settle resolves at the cap with `settled: false` and the step continues

### Requirement: Per-step console and network capture
The content script SHALL capture console errors (`console.error`, `window.onerror`, `unhandledrejection`) and failed requests (4xx/5xx/network errors from the fetch/XHR patch) into per-step buffers, drained into each observation (capped at 10 entries × 300 chars for errors, 10 for requests). If the extension already captures console/network for suggest mode, that capture MUST be reused with only per-step drain semantics added.

#### Scenario: Failed request surfaces in next observation
- **WHEN** a request returns a 500 during a step
- **THEN** the next observation's `failedRequests` contains its method, URL, and status

### Requirement: Executed actions mirror into the existing session recorder
Every executed action SHALL be written to the existing session recorder as a synthetic event tagged `source:'auto'`, carrying `durableSelector`, `elementText`, and `intent`, so it appears in the session timeline like a human action. The recorder MUST NOT double-capture the executor's synthetic dispatches: recorder capture is suppressed for the duration of each dispatch (a dispatch bracket — vendored primitives dispatch events internally where no marker can be attached, and the browser fires the resulting form `submit` as trusted), so each auto action appears exactly once.

#### Scenario: No double capture
- **WHEN** the executor dispatches a synthetic click that the recorder's DOM listeners also observe
- **THEN** the timeline contains exactly one entry for the action — the explicit `source:'auto'` entry

### Requirement: Stop overlay provides the kill switch and intervention signal
While a run is active the content script SHALL show a fixed top-right overlay pill (`⏸ Auto test running — Stop`, `z-index: 2147483646`, tagged `data-openqa-ignore`). Clicking Stop SHALL send `AUTO_USER_STOP`; any trusted (`isTrusted === true`) `keydown` or `mousedown` outside the overlay during an active run SHALL send `AUTO_USER_INTERVENED`. The overlay SHALL NOT block page input in v1.

#### Scenario: Human grabs the wheel
- **WHEN** the user presses a key on the page while a run is active
- **THEN** `AUTO_USER_INTERVENED` is sent and the run pauses without being killed
