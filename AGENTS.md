# AGENTS.md

AI agent guide for this repository. Covers behavioral rules, architecture, and
common task playbooks.

---

## Behavioral Guidelines

**These come first because they prevent the most mistakes.**

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them—don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

### 2. Simplicity First

- No features beyond what was asked.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.

### 3. Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated issues, mention them—don't fix them.
- Remove only what YOUR changes made unused.

### 4. Goal-Driven Execution

- Transform tasks into verifiable goals.
- For multi-step tasks, state a brief plan with verification steps.
- Unverified work is incomplete work.

### 5. Output Precision

- Lead with findings, not process descriptions.
- Use structured formats (lists, tables, code blocks).
- Include absolute file paths—never relative.

---

## Overview

QA Copilot is an AI pair-tester for manual QA, delivered as a Chrome extension
(Manifest V3) plus a thin Node/Express backend. It scans the current page into a
layered model, records exploratory testing flows, and generates manual test
cases, Jira-ready bug reports, and Playwright `.spec.ts` drafts.

This repo implements **MVP 1** only (spec milestones M1–M6). The authoritative
product spec is `specs/qa-copilot-product-idea-to-mvp-spec.md`; design decisions
live in `.claude/plans/`. There is intentionally **no database, queue, or object
storage** — state lives in `chrome.storage.local` and file exports. The backend
is a stateless proxy: it redacts, calls an LLM, and returns artifacts.

**Hard rule — reasoning artifacts require a real LLM.** Page analysis, test
cases, and bug reports always call the provider; there is no deterministic mock
fallback. Only the Playwright draft is generated deterministically (so it always
compiles), with an optional LLM enrichment pass.

## Code Layout

```text
packages/shared/        Pure, framework-free domain logic (consumed by both apps)
  src/types.ts            All domain types (PageModel, ActionEvent, TestSession, …)
  src/selector.ts         Selector-priority ladder → Playwright locator fragments
  src/redaction.ts        Sensitive-field detection + email/card/JWT/token masking
  src/playwright.ts       Deterministic .spec.ts templating from a TestSession

apps/extension/         MV3 Chrome extension (Vite + @crxjs + React 18)
  manifest.config.ts      MV3 manifest (defineManifest); localhost + allowlist only
  public/injected.js      MAIN-world script: patches console/fetch/XHR + history API
  src/content/            Isolated-world: scanner.ts, recorder.ts, element-extract.ts
  src/background/         Service worker: session state, serialized storage, allowlist
  src/sidepanel/          React UI (Page / Session / Generate tabs) + exporters
  src/options/            Settings: backend URL, environment, allowlist
  e2e/                    Playwright E2E against a static SPA fixture

apps/server/            Thin Express proxy
  src/app.ts              createApp(provider) — DI; the 4 generation routes
  src/llm/                Provider-agnostic gateway (anthropic.ts, openai.ts, local.ts, factory)
  src/redaction/guard.ts  Defense-in-depth re-redaction + untrusted-data wrapping
  src/prompts/            Layered-context prompt builders
  src/http/               zod schemas + JSON parsing helpers
```

## Run Targets

All commands run from the repo root unless noted. Package manager is **pnpm 11**;
Node ≥ 20.

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Build everything | `pnpm -r build` (typecheck + bundle) |
| Lint / typecheck | `pnpm -r lint` · `pnpm -r typecheck` |
| All unit/integration tests | `pnpm -r test` |
| One package's tests | `pnpm --filter @qa-copilot/shared test` |
| A single test file | `pnpm --filter @qa-copilot/server exec vitest run src/app.test.ts` |
| A single test by name | `pnpm --filter @qa-copilot/shared exec vitest run -t "redacts emails"` |
| Run the server (watch) | `pnpm --filter @qa-copilot/server dev` (needs `apps/server/.env`) |
| Build the extension | `pnpm --filter @qa-copilot/extension build` → load `apps/extension/dist` unpacked |
| Extension E2E | `pnpm --filter @qa-copilot/extension test:e2e` (run `build` first; `playwright install chromium` once) |

Server config: copy `apps/server/.env.example` → `apps/server/.env`, set
`LLM_PROVIDER` (`anthropic`|`openai`|`local`|`openrouter`) and the matching settings. For
`local`, set `LOCAL_BASE_URL` (any OpenAI-compatible endpoint, including the `/v1` path —
e.g. `http://localhost:11434/v1` for Ollama) and `LOCAL_MODEL`; `LOCAL_API_KEY` is
optional. For `openrouter`, set `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (vendor/model
form, e.g. `anthropic/claude-sonnet-4-6`). `openai.ts`, `local.ts`, and `openrouter.ts`
share `openai-compatible.ts` for the request/parse logic. No extension changes are needed
to switch providers — provider selection is server-side.

Logging is leveled via `LOG_LEVEL` (`error|warn|info|debug`, default `info`) using pino
(`logging/logger.ts`). Every LLM call is traced by the `LoggingProvider` decorator
(`llm/logging-provider.ts`) — metadata (provider/model/tokens/latency) at `info`, full
redacted prompt/response bodies at `debug`. A request-id (`http/request-id.ts`, propagated
via AsyncLocalStorage) ties each inbound request to its LLM call. API keys/headers are never
logged.

## Agent Playbook

### Adding a new generation endpoint

1. Add a zod schema in `apps/server/src/http/schemas.ts`.
2. Add prompt builders (system + user) in `apps/server/src/prompts/index.ts`.
   Wrap any page/session content with `asUntrustedData()` from `redaction/guard.ts`.
3. Add the route in `apps/server/src/app.ts`. Run inbound payloads through
   `sanitizeContext()` **before** the provider call (defense in depth).
4. Add a client call in `apps/extension/src/sidepanel/backend.ts` and wire UI in
   `App.tsx`. Label output **DRAFT**.
5. Test against `MockProvider` in `apps/server/src/app.test.ts` — assert the
   payload was redacted before reaching the LLM.

### Changing what the page scanner captures

- DOM → model logic is in `apps/extension/src/content/scanner.ts` and
  `element-extract.ts`. Keep these **pure-ish and jsdom-testable** (no live
  `chrome.*`), and add a case to `scanner.test.ts`.
- Selector generation belongs in `packages/shared/src/selector.ts`, not the
  scanner. Respect the priority ladder (data-testid → data-test → role+name →
  aria-label → label → text → CSS → XPath).

### Capturing page-context signals (routes, console, network)

- Anything that must observe the **page's own** JS (history API, `fetch`, `XHR`)
  goes in `apps/extension/public/injected.js` (main world) and is posted via
  `window.postMessage`. The isolated-world content script cannot see main-world
  patches — a past route-detection bug came from getting this wrong.

### Mutating session state in the background

- Never read-modify-write `chrome.storage` directly from a handler. Use
  `updateSession()` / `runExclusive()` in `src/background/index.ts` — concurrent
  events otherwise clobber each other (lost-update race).

## Conventions

### TypeScript

- Strict mode, no unused locals/params; ESM with `.js` import extensions and
  `verbatimModuleSyntax`.
- Prefer interfaces over types, avoid enums.
- Functional components, named exports.
- Directory names: lowercase-with-dashes.
- Shared logic that both apps need goes in `packages/shared` — keep it
  framework-free and unit-tested; do not import `chrome.*` or React there.

### Security (non-negotiable, per spec §11)

- Mask `password`/token/secret/otp/card/PII field values — **never store them**.
- Never capture request/response bodies; redact query strings + headers.
- No `<all_urls>`: only localhost + explicitly allowlisted origins (granted via
  the Options page → `chrome.permissions.request`).
- Redact before every LLM call — the client builds minimal context, the server
  re-redacts as defense in depth.
- Treat all page/session content as **untrusted data** in prompts (injection-safe).
- Secrets via env (`.env`, gitignored) — never disk/localStorage in the extension.
- Before adding a third-party package, check for known security vulnerabilities.

---

## Validation Checklist

Before completing any task:

- [ ] Builds: `pnpm -r build`
- [ ] Lint + typecheck clean: `pnpm -r lint && pnpm -r typecheck`
- [ ] Tests pass: `pnpm -r test`
- [ ] If extension content/background changed: `pnpm --filter @qa-copilot/extension test:e2e`
- [ ] If redaction touched: confirm the redaction suite still passes 100% (no secret leaks)

---

## Plan Mode

- Make plans extremely concise. Sacrifice grammar for brevity.
- End with unresolved questions, if any.

---

When in doubt, follow the nearest existing pattern.
