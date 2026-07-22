# Tasks: Automating Test Execution with LLM

> Current focus: **M1 — Vendor + PageDriver (no LLM)** (auto-test-mode-spec.md §14).
> M1 acceptance: a hardcoded action list drives the fixture SPA login flow end-to-end, and the recorder session contains the actions with durable selectors.
> Groups 9 is deferred scaffolding for later milestones (M2–M5); expand via `/opsx:update` when M1 lands.

## 1. Shared auto types (`packages/shared/src/auto/`)

- [x] 1.1 Create `observation.ts` with `PageInfo`, `ObservedElement`, `Observation` per §5.1 (including `epoch`, `consoleErrors`, `failedRequests`, `navigationOccurred`)
- [x] 1.2 Create `action.ts` with the zod discriminated union `zAction` (click/fill/select/press/scroll/navigate/wait/assert/report_defect/finish) and `Action` type per §5.2; stub `actionToolDefs()` (implementation lands in M3)
- [x] 1.3 Create `run.ts` (`RunConfig`, `RunStatus`, `TraceStep`, `RunResult`) and `policy.ts` (`DestructivePolicy`, `DEFAULT_DESTRUCTIVE_PATTERNS`) per §5.4–5.5; export everything from `index.ts` (also `step.ts` — `HistoryEntry` is referenced by `TraceStep`)
- [x] 1.4 Unit tests: `zAction` valid/invalid matrix (missing index, out-of-range values, unknown type like `execute_js` rejected)

## 2. Vendor page-agent (pinned commit `da1db959…`)

- [x] 2.1 Fetch `alibaba/page-agent` at the pinned base commit and copy the six files per §4.1 into `apps/extension/src/vendor/page-agent/` (`dom_tree.js`, `dom_tree.d.ts` merged from index.d.ts + type.ts, `dom.ts`, `get-page-info.ts`, `actions.ts`, `utils.ts`, `patches/react.ts`), keeping upstream copyright headers and `@edit` comments
- [x] 2.2 Add `LICENSE-page-agent` (MIT, Alibaba), `LICENSE-browser-use` (MIT, Gregor Zunic), and `VENDORED.md` recording upstream repo, pinned commit, package version v1.12.2, file provenance table, and the quarterly sync process (§4.3)
- [x] 2.3 Edit: delete any `executeJavascript` pathway and verify no `eval`/`new Function` remains in vendored files (§4.2.1), marking edits `// @openqa-edit`
- [x] 2.4 Edit: insert optional `redactNode?: (node) => node` callback into `dom.ts` `flatTreeToString`, invoked per element/text node before text/attribute emission, defaulting to identity (§4.2.2)
- [x] 2.5 Edit: export the internals we rely on (`clickElement`, `inputTextElement`, `selectOptionElement`, `scrollIntoViewIfNeeded`, `scrollVertically`, `getFlatTree`, `flatTreeToString`, `getSelectorMap`) with `// @openqa-edit relied upon; pinned to base commit` (§4.2.3)
- [x] 2.6 Edit: make highlight rendering optional — `doHighlightElements: false` default, capability retained behind `debugHighlights` (§4.2.4)
- [x] 2.7 Verify the vendored files compile within the extension build (tsconfig/bundler wiring for the mixed .js/.ts vendor directory)

## 3. Boundary and CI gates

- [x] 3.1 Add ESLint `no-restricted-imports` rule: only `content/auto/page-driver.ts` may import from `vendor/page-agent/` (§3); add a lint test/fixture proving a violation fails
- [x] 3.2 Add CI static grep: build fails if `vendor/page-agent` matches `/\beval\s*\(|new Function\s*\(/` (§4.2.1)

## 4. Observation builder + redaction (`content/auto/`)

- [x] 4.1 Create `redact-node.ts` wrapping the existing shared redaction detectors: secret-field detection (`input[type=password]`, sensitive `autocomplete` values, existing name/id detector) → `isSecret` + `«secret»`; PII detectors over emitted text/attributes → existing token format; 120-char text cap (§6.3)
- [x] 4.2 Create `observation-builder.ts`: vendored `getFlatTree` with `viewportExpansion: 400`, `data-openqa-ignore` blacklist, React root patch; >150 interactive elements → re-run with `viewportExpansion: 0` + truncation note in footer (§6.2)
- [x] 4.3 Build `selectorMap` via vendored `getSelectorMap`; serialize via `flatTreeToString` with the `redactNode` hook; assemble header/footer (Current Page / page info / scroll markers) per §6.2.4
- [x] 4.4 Detect `activeDialog` (topmost visible `dialog[open]`/`[role=dialog]`/`[role=alertdialog]`) and prepend the dialog warning line (§6.2.5)
- [x] 4.5 Stamp incrementing `epoch`; return `{ observation, elements }` with per-element metadata for future guard checks (§5.1 amendment)

## 5. Executor, settle, selector recording, step capture (`content/auto/`)

- [x] 5.1 Create `settle.ts`: mutation-quiet 400 ms (ignoring our overlay) ∧ tracked-request counter zero ∧ `readyState === 'complete'`, hard cap 5 s → `settled:false` (§6.5)
- [x] 5.2 Create `step-capture.ts`: fetch/XHR patch (in-flight counter + 4xx/5xx/network-failure buffer), `console.error`/`onerror`/`unhandledrejection` capture at document_start, per-step drain; reuse the existing suggest-mode capture if present (§6.5)
- [x] 5.3 Create `selector-recorder.ts` wrapping the existing selector-priority ladder against a live element (§6.4.6)
- [x] 5.4 Create `executor.ts` gates: epoch mismatch → `stale_epoch`; missing index → `index_not_found`; `!isConnected` → `element_detached`; `scrollIntoViewIfNeeded` + style/rect check → `not_visible`; `elementFromPoint` hit test → `covered` with covering tag/text in detail (§6.4.1–5)
- [x] 5.5 Executor dispatch: record durable selector + `elementText` BEFORE dispatch; `click`/`fill` (with post-fill value verification → `value_not_applied`)/`select` (missing option → `option_not_found` + first 10 options)/`press`/`scroll`/`wait` via vendored primitives; `assert`/`report_defect`/`finish` → immediate `{ok:true, settled:true}`; navigation during action → `{ok:true, navigated:true, settled:false}` (§6.4.7–8)
- [x] 5.6 Mirror executed actions into the existing session recorder as `source:'auto'` events carrying `durableSelector`, `elementText`, `intent`; tag dispatched synthetic events with a marker property and make the recorder skip marked events (dedupe) (§6.4.9)

## 6. PageDriver assembly + stop overlay

- [x] 6.1 Create `page-driver.ts` implementing the `PageDriver` interface (`observe`, `execute`, `showStopOverlay`, `hideStopOverlay`, `dispose`) as the sole vendor-importing module, owning `selectorMap`, `epoch`, and capture buffers (§6.1)
- [x] 6.2 Create `stop-overlay.ts`: fixed top-right pill, `z-index: 2147483646`, `data-openqa-ignore`; Stop click → `AUTO_USER_STOP`; trusted keydown/mousedown outside overlay → `AUTO_USER_INTERVENED`; no input blocking (§6.6)

## 7. M1 test suites

- [x] 7.1 Vendor smoke suite in the existing real-browser harness (NOT jsdom): extraction on fixture pages (buttons, links, inputs, select, contenteditable, dialog, React-root, aria-hidden, offscreen); assert element counts, index stability within a snapshot, `data-openqa-ignore` exclusion (§13.1)
- [x] 7.2 Redaction parity tests: PII/secret input table → identical tokens via suggest path and `redact-node`; password value never appears in `serialized` (§13.1)
- [x] 7.3 Settle unit tests with fake timers: mutation-quiet, fetch-counter, timeout paths (§13.1)
- [x] 7.4 Executor gate tests: stale epoch, missing index, detached, not visible, covered (with covering-element detail), fill verification failure, option-not-found detail

## 8. M1 acceptance

- [x] 8.1 Extend the fixture SPA with the `#auto-playground` login form (rememberable placeholder creds) — minimum needed for M1 acceptance (§13.2)
- [x] 8.2 Acceptance harness: a hardcoded action list (no LLM, no server) drives the fixture login flow end-to-end through `PageDriver.observe`/`execute`
- [x] 8.3 Assert the recorder session contains the executed actions as `source:'auto'` events with durable selectors, each appearing exactly once (dedupe verified)
- [x] 8.4 Run full validation checklist (lint incl. boundary rule, CI grep, unit + smoke suites green)

### M1 implementation notes (deviations from the source spec, per its preamble)

- **In-flight request tracking lives in `public/injected.js` (main world)**, not a content-script-world fetch/XHR patch as §6.5 sketched — MV3 isolated worlds cannot see the page's own `fetch`/XHR (a documented past bug class in AGENTS.md). `injected.js` now additionally posts `request-start`/`request-end`; `step-capture.ts` maintains the counter.
- **Recorder dedupe uses a dispatch bracket** (`auto-dispatch.ts`: recorder skips ALL events while the executor is dispatching) instead of §6.4.9's per-event marker property: vendored primitives dispatch events internally where we can't tag them, and the browser fires the form-submission `submit` event as **trusted** even for synthetic clicks.
- **Redaction tokens follow the repo's existing format** (`[EMAIL]`, `[REDACTED]`, …) rather than the spec's `«…»` glyphs — §6.3's parity-with-suggest-mode requirement wins over the literal token text.
- **Auto types are exported at `@qa-copilot/shared/auto`**, not the main barrel: `action.ts` depends on zod at runtime, and barrel-exporting it dragged a zod chunk into the MV3 content script, breaking content-script loading (crxjs chunk graph). M1 content code imports types only.
- **`RunConfig.providerRef` is an optional opaque string** — the spec's `ProviderRef` shared type doesn't exist in this repo (provider selection is server-side / workspace-scoped); resolved in M3.
- **`step.ts` shipped with the M1 shared types** (not listed in tasks 1.1–1.3): `TraceStep.result` references `HistoryEntry`.
- **`#auto-playground` is a standalone fixture page** (`e2e/fixtures/auto-playground.html`) served by the existing fixture server, not a hash route inside `spa.html` — keeps existing specs untouched.
- **`ObservedElement.isSecret` is restricted to fillable elements** (input/textarea/select/contenteditable): a `<label for="password">` must not inherit the flag (it broke fill targeting in acceptance).
- **The observation builder feeds `[data-page-agent-not-interactive]` roots into the interactive blacklist** — upstream does this in `PageController`, which we deliberately don't vendor.

## 9. Later milestones (deferred — expand via /opsx:update after M1)

- [ ] 9.1 M2 — Orchestrator + stub decider: run controller state machine, `AUTO_*` messages, navigation handling, epoch/staleness loop, SW-restart persistence, stop-overlay wiring; E2E scenarios 1, 5, 6, 8, 9 (§7, §13.2, §14)
- [ ] 9.2 M3 — Server `POST /auto/step` + real model observe-only: prompt, provider adaptation, validation, correction turns, history compression (§8, §14)
- [ ] 9.3 M4 — Guardrails + confirm mode + credential vault: full guard layer, confirmation flow, defect/assertion plumbing into `RunResult`; E2E scenarios 2, 3, 4, 7; secret-absence instrumentation (§9, §14)
- [ ] 9.4 M5 — UI polish + generator integration + eval harness: result view, exports, bug-report prefill, Playwright intent comments, baseline eval scores (§10–§11, §13.3, §14)
