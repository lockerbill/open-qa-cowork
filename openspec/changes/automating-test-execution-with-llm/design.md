# Design: Auto Test Mode

> Full technical detail (types, file-by-file layout, prompt layout, test matrices) lives in [auto-test-mode-spec.md](auto-test-mode-spec.md). Section references below (§n) point into that document. This design summarizes the architecture and records the decisions.

## Context

OpenQA is a Chrome MV3 extension (`apps/extension`) plus a stateless Node server (`apps/server`) sharing types via `packages/shared`. Today the extension observes a page, sends a redacted page model to an LLM through the server, and returns *suggested* test cases; a human executes them while the session recorder captures actions into a timeline that feeds the JSON, Playwright-draft, and bug-report generators.

Auto Test Mode adds an agent loop on top of this: the LLM decides one action per step and the extension executes it. The loop must reuse the existing redaction utilities, selector-priority ladder, session recorder, provider registry, and generators.

## Goals / Non-Goals

**Goals:**
- Autonomous/semi-autonomous exploratory testing driven by any configured provider (cloud or local Ollama), with human supervision modes (`observe_only` / `confirm` / `autonomous`).
- Every executed action lands in the existing recorder timeline with a durable selector, so existing exporters work on auto runs unchanged.
- Defense-in-depth safety: schema-constrained actions, origin lock, destructive-action policy, credential vault, budgets, loop detection, kill switch.
- Deterministic, hermetic E2E testing via a stub decider implementing the `/auto/step` contract.

**Non-Goals (v1, §1.2):**
- Cross-origin iframes, multi-tab tasks, file uploads, drag-and-drop, canvas, hover-only menus.
- Screenshot/vision observations (schema reserves the field; M6).
- Parallel runs (one active run per browser profile).
- Transparent auto-resume after MV3 service-worker restart (pause + manual Resume instead).

## Architecture (§2)

Side panel (Auto tab) ⇄ service worker (`RunController` state machine, guard layer, credential vault) ⇄ content script (`PageDriver`: ObservationBuilder → redact → serialize; ActionExecutor + settle; SelectorRecorder; StopOverlay) — with the service worker calling `POST /auto/step` on the stateless server (prompt assembly, provider call, schema validation, returns exactly one `Action`).

Per step: SW requests `AUTO_OBSERVE` → assembles `StepRequest` (goal + compact history + redacted observation) → server returns `{action}` → guard layer verdict (execute / confirm / refuse) → `AUTO_EXECUTE` → `ActionResult` + settle → `TraceStep` appended, budgets and loop detection checked → next step or finalize. Navigations destroy the content script; the SW re-injects and re-observes. RefId maps never survive a step boundary.

## Decisions (§15 — do not relitigate)

1. **Vendor page-agent internals, don't npm-depend** (§4). The APIs we need are `@private`, the serialization format is prompt-load-bearing, redaction needs an in-serializer seam, and the eval pathway must not ship. Pinned to commit `da1db959558dcd49a6c489e76a23accfbda7b156` (`@page-agent/page-controller` v1.12.2); every local edit tagged `// @openqa-edit`; quarterly sync process in `VENDORED.md`. Alternative considered: depending on the npm package — rejected because private APIs could shift under us and we cannot inject redaction or strip eval from a dependency.
2. **The LLM never sees or emits CSS selectors.** It targets elements by opaque numeric index into a per-snapshot element map. Durable selectors are recorded by us at execution time (existing ladder) for Playwright export.
3. **Loop in the SW; decisions on the server; server stateless.** No API keys or LLM traffic from the browser; all run state in the extension service worker, persisted to `chrome.storage.session` per transition (MV3 restart → pause + Resume button).
4. **Redaction is per-node inside the observation builder**, wrapping the same shared detectors suggest mode uses — never a regex pass over an already-serialized string. Parity is unit-tested (§13.1).
5. **One action per step; no free-form JS action; no coordinate-based actions.** The server rejects multi-tool calls (takes the first, warns). CI greps the vendor directory for `eval(`/`new Function(` and fails the build on match.
6. **Fresh observation + fresh indices every step**; staleness handled by epoch rejection + re-observe (max once per step, doesn't consume a step).
7. **`confirm` is the default mode; `autonomous` requires explicit opt-in** (extra "I understand" checkbox). Destructive-action policy (§5.5, §9.3) matches element text/aria-label/title; confirm mode requires side-panel approval with 120 s timeout-as-reject.
8. **Settle** = mutation-quiet 400 ms ∧ network-idle (fetch/XHR patch counter) ∧ `readyState === 'complete'`, hard cap 5 s → `settled:false` is a reported outcome, not an error (§6.5). Page-agent's fixed post-action sleeps remain inside vendored primitives, but our settle governs step completion.
9. **Vendor boundary enforced by lint**: ESLint `no-restricted-imports` — only `content/auto/page-driver.ts` may import from `vendor/page-agent/`.
10. **Prompt-injection posture is layered** (§9): goal fixed at run start and never re-read from the page; page text wrapped in the existing untrusted-content delimiters; anti-injection clause in the system prompt; and even a fully hijacked model stays inside the action schema, origin lock, mode gate, and destructive policy — injected text can at worst waste budget in confirm mode.
11. **Credential hygiene**: secret fields accept only `{{PLACEHOLDER}}` tokens; values live in `chrome.storage.session` (cleared on browser close), substituted by the SW at execution time, and never enter any prompt, log, or trace.
12. **History compression is deterministic** (no LLM call): `HistoryEntry` only, last 12 verbatim, older entries summarized per 5 steps; target `StepRequest` under ~6k tokens for 8k-context local models (§7.5).

## Risks / Trade-offs

- [Vendored code drifts from upstream fixes] → pinned base commit + `@openqa-edit` markers keep diffs legible; documented quarterly sync process; vendor smoke suite re-run on sync (§4.3).
- [`dom_tree.js` needs real layout; jsdom can't test it] → vendor smoke suite runs in the existing real-browser test harness on fixture pages (§13.1).
- [MV3 SW can be killed mid-run] → state persisted to `chrome.storage.session` on every transition; on wake, a `running` run becomes `paused` (`service_worker_restarted`) with a Resume button; no transparent auto-resume in v1 (§7.1).
- [Local models emit malformed/multiple tool calls] → server-side zod validation with 422 → SW correction turn (max 2 per step, counted against `maxLlmCalls` not `maxSteps`); multi-tool responses take the first call (§8.3–8.5).
- [Synthetic clicks double-captured by the recorder] → dispatched events carry a marker property; the recorder skips marked events, keeping only the explicit `source:'auto'` entry (§6.4.9).
- [Element covered by overlay at click time] → hit-test gate returns `covered` with the covering element's tag/text — frequently the very bug the QA wants; the model can convert it to `report_defect` (§6.4.5).
- [Runaway loops / burned budget] → rolling action-hash loop detection (3× → injected nudge, 5× → finalize `stopped_by_budget`), plus `maxSteps` / `maxWallClockMs` / `maxLlmCalls` (§9.5–9.6).
- [Observation too large for small local models] → viewport expansion 400 px re-run at 0 when interactive-element count exceeds 150, truncation noted in the serialized footer; history compression (§6.2, §7.5).

## Migration Plan

Feature-flagged rollout: `autoTestMode` defaults ON in dev builds, OFF in the store build until M5 acceptance passes (§12). `/auto/step` sits behind the same enablement/config as existing LLM routes. No data migrations; auto runs persist as normal recorder sessions plus an attached `RunResult`. Rollback = flag off; no schema changes to existing stores.

Milestones (§14): M1 vendor + PageDriver (no LLM, hardcoded action list drives fixture login) → M2 orchestrator + stub decider → M3 server endpoint + real model observe-only → M4 guardrails + confirm mode + vault → M5 UI polish + generator integration + eval → M6 (optional) vision observations.

## Open Questions

- Exact module names/paths in the existing repo for the redaction utilities, selector ladder, recorder event schema, and untrusted-content prompt delimiters — the source spec instructs adapting to the nearest existing equivalent and noting deviations in the PR description (§ preamble note).
- Whether the existing console/network capture used by suggest mode can be reused directly for per-step drain semantics or needs a parallel capture path (§6.5 says reuse if present).
