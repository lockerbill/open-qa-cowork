# auto-run-orchestration

Service-worker run controller: state machine, step loop, typed messaging, navigation handling, MV3-restart persistence, guard layer (origin lock, mode gate, destructive policy, credential vault, loop detection, budgets), and history compression. (Source detail: auto-test-mode-spec.md §5, §7, §9.)

## ADDED Requirements

### Requirement: Shared auto types are the single source of truth
`packages/shared/src/auto/` SHALL define the types both server and extension import: `Observation`/`ObservedElement`/`PageInfo`, the `Action` zod discriminated union (`click`, `fill`, `select`, `press`, `scroll`, `navigate`, `wait`, `assert`, `report_defect`, `finish` — exactly these, no free-form JS action), `StepRequest`/`StepResponse`/`HistoryEntry`, `RunConfig`/`RunStatus`/`TraceStep`/`RunResult`, and `DestructivePolicy` with the default destructive patterns. The zod schemas SHALL be used for provider-output validation on the server and defensive re-validation in the service worker.

#### Scenario: Action schema rejects unknown action types
- **WHEN** a candidate action with an unlisted `type` (e.g., `execute_js`) is validated against `zAction`
- **THEN** validation fails

### Requirement: Run controller owns the step loop as a state machine
The service worker SHALL own the run loop as a state machine (`idle → starting → observing → deciding → guarding → (awaiting_confirmation) → executing → post_step → …loop… → finalizing → done`), with `paused` reachable from any active state. Resuming SHALL always return to `observing` (re-observe, since the human may have changed the page). Each iteration SHALL: observe (retrying once after re-injecting the content script on no-response), check budgets, assemble the `StepRequest` (goal fixed at run start, compressed history, current observation, mode, placeholder names), call `/auto/step`, run the guard verdict, execute, append a `TraceStep`, push state to the side panel, and update loop detection. A `finish` action SHALL finalize the run with the model's outcome. On `stale_epoch` from the executor the controller SHALL re-observe and re-decide once per step without consuming a step.

#### Scenario: Goal is immutable during a run
- **WHEN** page content suggests a different goal mid-run
- **THEN** every `StepRequest` still carries the goal fixed at run start

#### Scenario: Stale epoch triggers a single re-decide
- **WHEN** `AUTO_EXECUTE` returns `stale_epoch`
- **THEN** the controller re-observes and re-requests a decision once, and the step counter does not increment for the retry

#### Scenario: Finish finalizes
- **WHEN** the model emits `finish` with outcome `pass`
- **THEN** the run transitions to `finished` and the `RunResult` records the outcome and reason

### Requirement: Typed AUTO_* message protocol scoped by runId
All auto-mode messaging SHALL use typed messages via the existing messaging utility: SW→CS `AUTO_OBSERVE`, `AUTO_EXECUTE`, `AUTO_SHOW_OVERLAY`, `AUTO_HIDE_OVERLAY`; CS→SW `AUTO_USER_STOP`, `AUTO_USER_INTERVENED`; Panel→SW `AUTO_START`, `AUTO_PAUSE`, `AUTO_RESUME`, `AUTO_STOP`, `AUTO_CONFIRMATION`, `AUTO_GET_STATE`; SW→Panel `AUTO_STATE` pushed on every change. Every message SHALL carry `runId`; messages with a stale `runId` SHALL be dropped and logged.

#### Scenario: Stale runId dropped
- **WHEN** a message arrives carrying a `runId` that is not the active run
- **THEN** it is ignored and a log entry is written

### Requirement: Navigation handling with origin containment
On a navigated action result or `webNavigation.onCommitted` for the run's tab, the controller SHALL wait for tab load completion, then re-handshake with the content script (ping with retry/backoff up to 5 s, programmatic re-injection if unreachable). If the tab lands on an origin outside `originAllowlist`, the run SHALL pause with detail `left_allowed_origin: <url>` and offer Resume or Stop; the controller SHALL never drive actions on a non-allowlisted origin.

#### Scenario: Cross-page click continues the run
- **WHEN** a click navigates to another same-origin page
- **THEN** the controller re-injects/re-handshakes, obtains a fresh observation, and the loop continues

#### Scenario: OAuth redirect pauses the run
- **WHEN** the tab navigates to an origin not in the allowlist
- **THEN** the run pauses with `left_allowed_origin` detail and no further actions are executed there

### Requirement: Run state survives MV3 service-worker restarts
The controller SHALL persist `{runId, config, status, trace, historyCompact, budgets}` to `chrome.storage.session` after every state transition. On service-worker wake, a run found in `running` state SHALL transition to `paused` with detail `service_worker_restarted` and surface a Resume button; v1 SHALL NOT attempt transparent auto-resume.

#### Scenario: SW killed between steps
- **WHEN** the service worker is terminated mid-run and later wakes
- **THEN** the run appears as `paused` (`service_worker_restarted`) with its trace intact and a Resume button

### Requirement: Guard layer vets every action before execution
The guard SHALL run ordered checks (first hit wins), with every refusal recorded as `result:'refused'` plus a reason visible to the model in history: (1) origin lock — `navigate` targets must be in `originAllowlist`; (2) mode gate — in `observe_only` only `scroll`, `wait`, `assert`, `report_defect`, `finish`, `press Escape`, and clicks on link/tab/`aria-expanded` elements are executable; (3) destructive-action policy — element text + aria-label + title matched against policy patterns: allow-and-tag in `autonomous`, require confirmation in `confirm`, with metadata-less elements treated as destructive in confirm mode; (4) credential hygiene — see the vault requirement; (5) loop detection; (6) budgets.

#### Scenario: Off-origin navigate refused
- **WHEN** the model emits `navigate` to an origin outside the allowlist
- **THEN** the action is refused with reason `navigation outside allowed origin` and recorded in history

#### Scenario: Fill refused in observe-only mode
- **WHEN** mode is `observe_only` and the model emits `fill`
- **THEN** the action is refused with reason `observe-only mode`

#### Scenario: Destructive click needs confirmation
- **WHEN** mode is `confirm` and the model emits a click on an element whose text matches a destructive pattern (e.g., "Delete")
- **THEN** the run enters `awaiting_confirmation`; approval executes, rejection records `rejected_by_user` with the user's note, and a 120 s timeout counts as rejection

#### Scenario: Destructive click tagged in autonomous mode
- **WHEN** mode is `autonomous` and a destructive-matching click executes
- **THEN** the `TraceStep` is tagged `destructive: true`

### Requirement: Credential vault substitutes placeholders without leaking values
Credential values SHALL live only in `chrome.storage.session` (set from the side panel, cleared on browser close). `StepRequest.placeholders` SHALL list placeholder names only. On `fill`: a secret target whose value is not exclusively a known `{{PLACEHOLDER}}` SHALL be refused (`secret fields accept placeholders only`); an unknown placeholder SHALL be refused with the available names listed; on success the SW substitutes the real value before `AUTO_EXECUTE`, and the `TraceStep` stores the tokenized value. Secret values MUST never enter any prompt, log, or trace.

#### Scenario: Literal secret refused
- **WHEN** the model emits `fill` on an `isSecret` element with value `hunter2`
- **THEN** the action is refused with `secret fields accept placeholders only`

#### Scenario: Placeholder substituted, trace tokenized
- **WHEN** the model fills a password field with `{{TEST_USER_PASSWORD}}` and the vault holds that name
- **THEN** the real value is applied to the page, and the trace, history, and all prompts contain only the token

### Requirement: Loop detection and budgets bound every run
The controller SHALL maintain rolling hashes of `(urlAfter, action.type, index, value?)`: the same hash 3× injects a history note nudging a different approach or `finish(blocked)`; 5× finalizes the run as `stopped_by_budget` (`action loop`); 3 consecutive `failed` results inject the same nudge. `maxSteps` (default 25, hard cap 60), `maxWallClockMs` (default 10 min), and `maxLlmCalls` (default maxSteps + 10) SHALL be checked every iteration; exceeding any finalizes as `stopped_by_budget` while still producing the partial trace and report.

#### Scenario: Action loop terminated
- **WHEN** the same action hash occurs 5 times
- **THEN** the run finalizes as `stopped_by_budget` with reason `action loop`, retaining the partial trace

#### Scenario: Step budget exhausted
- **WHEN** `maxSteps` is reached before `finish`
- **THEN** the run finalizes as `stopped_by_budget` and the partial trace and result are available

### Requirement: History is compressed deterministically
`StepRequest.history` SHALL contain compact `HistoryEntry` records only (never past observations). When history exceeds 20 entries, the last 12 SHALL remain verbatim and older entries SHALL be summarized deterministically (no LLM call) into one synthetic line per 5 steps, targeting a full `StepRequest` under ~6k tokens at default settings.

#### Scenario: Long run stays under token target
- **WHEN** a run reaches 40 history entries
- **THEN** the assembled history keeps the last 12 verbatim, summarizes the rest, and the `StepRequest` fits the token target
