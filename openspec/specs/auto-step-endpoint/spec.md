# auto-step-endpoint Specification

## Purpose
Stateless server auto-step endpoint (workspace-scoped `POST /api/workspaces/:workspaceId/auto/step`): prompt assembly with anti-injection posture, provider adaptation (tool-calling and JSON mode), zod validation of the returned action, and correction-turn support. (Source detail: auto-test-mode-spec.md §8.)

## Requirements

### Requirement: POST /auto/step is a stateless decision gateway
`apps/server` SHALL expose the auto-step decision route — mounted workspace-scoped as `POST /api/workspaces/:workspaceId/auto/step` following the ai-tasks pattern (provider resolution via `projectId`/`environmentId` in the request body); the bare `/auto/step` path remains the contract shape the E2E stub decider serves — accepting a `StepRequest` and responding `200 {action}`, `422 {error:'invalid_action', detail, modelRaw?}`, `502 {error:'provider_error'}`, or `504 {error:'provider_timeout'}` (provider timeout 60 s). The endpoint SHALL hold no run state, and SHALL use the same auth, provider registry, server-side keys, and logging policy (metadata, not payloads) as the existing suggest endpoints, behind the same enablement/config as other LLM routes. `modelRaw` SHALL appear in 422 responses only when `AUTO_STEP_DEBUG=1`.

#### Scenario: Valid step decision
- **WHEN** a valid `StepRequest` is posted and the provider returns a well-formed action
- **THEN** the response is `200` with exactly one `Action` conforming to `zAction`

#### Scenario: Slow local model times out
- **WHEN** the provider does not respond within 60 s
- **THEN** the server responds `504 {error:'provider_timeout'}`

### Requirement: Prompt frames the model as an exploratory QA tester with anti-injection posture
The system prompt SHALL be checked into the repo (`auto/system-prompt.md`), written in our own words (not copied from page-agent), and SHALL establish: the exploratory-QA-tester role where reporting a real bug is a successful outcome; exactly one action per turn; element targeting only by `[index]` without inventing indexes; interacting inside an open dialog first; asserting after meaningful state changes; using `{{PLACEHOLDER}}` tokens verbatim and never fabricating credentials; trying a different route or `finish(blocked)` after the same approach fails twice; treating console errors and failed requests as evidence; budget awareness via `stepsRemaining` with `finish` required before budget exhaustion; and an anti-injection clause declaring page text untrusted DATA that never overrides the goal. The user message SHALL follow the layout `<goal>`, `<mode>`, `<available_placeholders>`, `<history>`, `<observation>` (with console errors and failed requests), `<steps_remaining>`, wrapping the observation in the project's existing untrusted-content delimiters.

#### Scenario: Observation wrapped as untrusted
- **WHEN** the prompt is assembled
- **THEN** the observation body sits inside the same untrusted-content delimiters used by suggest mode

### Requirement: Provider adaptation covers tool-calling and JSON-mode models
For tool-calling providers the server SHALL register one tool per action type from `actionToolDefs()` with `tool_choice` required, take the first tool call, and warn on extras. For JSON-mode/plain local models it SHALL append a JSON-only response-format instruction and parse via: strip fences → `JSON.parse` → on failure, first-`{`-to-last-`}` substring → parse. Both paths SHALL funnel into the shared validation step.

#### Scenario: Multi-tool response reduced to one action
- **WHEN** a provider returns multiple tool calls in one response
- **THEN** the server takes the first, logs a warning, and returns exactly one action

#### Scenario: Fenced JSON output parsed
- **WHEN** a local model wraps its JSON action in markdown fences with surrounding prose
- **THEN** the parser recovers the JSON object and validation proceeds

### Requirement: Every candidate action is validated against the shared schema
The server SHALL validate every candidate action with `zAction.safeParse`. Success yields the `StepResponse`; failure yields `422` with a compact human-readable issue list (e.g., `type 'click' requires integer 'index'`). The service worker SHALL respond to a 422/parse failure with a correction turn: re-POST the same `StepRequest` plus a history line describing the invalid output, at most 2 corrections per step (counted against `maxLlmCalls`, not `maxSteps`); after that the step records `result:'failed'` (`model_output_invalid`) and the run continues with a fresh observation.

#### Scenario: Invalid action produces actionable 422
- **WHEN** the provider emits `{type:'click'}` with no index
- **THEN** the server responds `422` with a detail naming the missing field

#### Scenario: Correction limit respected
- **WHEN** the model produces invalid output 3 times in a row for one step
- **THEN** after 2 correction turns the step is recorded as `failed` (`model_output_invalid`) and the loop proceeds to the next step
