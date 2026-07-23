# Proposal: Automating Test Execution with LLM (Auto Test Mode)

> Source of truth for full technical detail: [auto-test-mode-spec.md](auto-test-mode-spec.md)

## Why

OpenQA today only *suggests* test cases: it observes a page, sends a redacted page model to an LLM, and returns test ideas that a human must execute manually. Auto Test Mode closes the loop — the LLM observes the page, decides one action at a time (click, fill, select, assert, report defect, finish), and the extension executes it, performing exploratory testing autonomously or semi-autonomously under human supervision. This turns the existing observation + recorder + generator infrastructure into an end-to-end automated QA agent.

## What Changes

- **Vendor DOM/action primitives from `alibaba/page-agent`** (MIT, pinned commit) into `apps/extension/src/vendor/page-agent/`: battle-tested DOM extraction (`dom_tree.js`), LLM serialization (`flatTreeToString`), and action primitives (click/input/select/scroll). Unsafe pathways (`eval`/`executeJavascript`) are deleted; a per-node redaction seam is inserted; a lint rule restricts vendor imports to a single boundary file.
- **New `PageDriver` in the content script** (`apps/extension/src/content/auto/`): observation builder with per-node redaction (reusing existing PII/secret detectors), action executor with safety gates (epoch/staleness, visibility, hit-test) and settle detection, durable-selector recording at execution time, per-step console/network capture, and a stop overlay kill switch.
- **New run orchestrator in the service worker** (`apps/extension/src/background/auto/`): state machine owning the loop, typed `AUTO_*` message protocol, navigation re-handshake, MV3-restart persistence, guard layer (origin lock, mode gate, destructive-action policy, credential hygiene, loop detection, budgets), session-scoped credential vault, and compact history compression.
- **New stateless server auto-step endpoint** (`apps/server`, mounted workspace-scoped as `POST /api/workspaces/:workspaceId/auto/step` per the ai-tasks pattern): prompt assembly with anti-injection posture, provider adaptation (tool-calling and JSON-mode), zod validation of the returned action, correction-turn support.
- **Shared types in `packages/shared/src/auto/`**: `Observation`, `Action` (zod discriminated union — the LLM contract), `StepRequest`/`StepResponse`, `RunConfig`/`RunResult`/`TraceStep`, destructive-action policy defaults.
- **New Auto tab in the side panel**: run setup (goal, mode, budgets, origin allowlist, credentials), live timeline with confirmation flow, result view wired into existing exporters (session JSON, Playwright draft, bug report).
- Executed auto actions land in the **existing session recorder** timeline with durable selectors, so existing generators work on auto runs with zero changes to those generators.

Design principles that must not be violated: the LLM never sees CSS selectors (opaque numeric indexes only); all LLM traffic goes through `apps/server` (stateless); redaction happens per-node before serialization; the loop is owned by our service worker with guardrails between decision and execution; vendored code is isolated behind `PageDriver`.

## Capabilities

### New Capabilities

- `auto-page-driver`: Vendored page-agent DOM/action primitives plus the content-script `PageDriver` — redacted observation building, indexed element maps, safe action execution with settle detection and durable-selector recording, per-step console/network capture, stop overlay. (Milestone M1)
- `auto-run-orchestration`: Service-worker run controller — state machine, step loop, typed messaging, navigation handling, MV3-restart persistence, guard layer (origin lock, mode gate, destructive policy, credential vault, loop detection, budgets), history compression. (Milestones M2, M4)
- `auto-step-endpoint`: Stateless server endpoint `POST /auto/step` — prompt assembly, provider adaptation (tools + JSON mode), action validation, correction turns. (Milestone M3)
- `auto-test-ui`: Side panel Auto tab — run setup, live timeline, confirmation modal, result view, integration with existing session/Playwright/bug-report generators. (Milestones M4, M5)

### Modified Capabilities

_None — existing spec'd capabilities keep their requirements. Auto runs reuse the session recorder and generators through their existing contracts (auto events are tagged `source:'auto'`; the bug-report generator gains an optional prefill payload, and the Playwright generator an optional intent-comment enhancement, both additive)._

## Impact

- **`packages/shared`**: new `src/auto/` module (types + zod schemas + policy defaults); reuse of existing redaction utilities and provider config types.
- **`apps/extension`**: new `src/vendor/page-agent/` (vendored, ~2k lines), `src/content/auto/`, `src/background/auto/`, `src/sidepanel/auto/`; ESLint `no-restricted-imports` boundary rule; feature flag `autoTestMode` (ON in dev, OFF in store build until M5); small additive changes to session recorder (synthetic-event dedupe via dispatch bracket) and timeline UI (⚙ badge).
- **`apps/server`**: new route `auto-step.ts` + `src/auto/` (prompt, validation, provider adaptation); same auth/provider registry/logging policy as existing suggest endpoints; `AUTO_STEP_DEBUG` env flag.
- **CI**: static grep gate — build fails if `vendor/page-agent` matches `eval(`/`new Function(`.
- **Testing**: vendor smoke suite (real browser, not jsdom), redaction-parity tests, guard policy matrix, E2E scenarios against a new `#auto-playground` fixture route with a deterministic stub decider; later a non-CI model-quality eval harness.
- **Licensing**: MIT license files for page-agent and browser-use provenance shipped in the vendor directory; `VENDORED.md` documents pinned commit and sync process.
