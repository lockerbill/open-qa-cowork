# QA Copilot — MVP 1

An AI pair-tester for manual QA, delivered as a Chrome extension. It analyzes the
current page, records exploratory testing flows, and generates manual test cases,
Jira-ready bug reports, and Playwright `.spec.ts` drafts. See the full product
spec in [`specs/qa-copilot-product-idea-to-mvp-spec.md`](specs/qa-copilot-product-idea-to-mvp-spec.md)
and the implementation plan that produced this code in
`.claude/plans/` (design decisions are summarized below).

## Architecture

| Package | Purpose |
| --- | --- |
| `packages/shared` | Domain types, the selector-priority ladder, redaction, and deterministic Playwright templating. Pure + unit-tested. |
| `apps/extension` | MV3 Chrome extension: React side panel, content script (DOM scanner / recorder / SPA route + console/network capture), background service worker. |
| `apps/server` | Thin Node/Express proxy: provider-agnostic LLM gateway (Anthropic, OpenAI, or a local OpenAI-compatible model), redaction guard, generation endpoints. No database (MVP 1). |

State lives in `chrome.storage.local` and file exports — there is no DB, queue,
or object storage in MVP 1 (those are MVP 3 in the spec).

## Prerequisites

- Node ≥ 20, pnpm 11
- An Anthropic or OpenAI API key, **or** a local OpenAI-compatible LLM server (Ollama, LM Studio, llama.cpp, vLLM...) — generation endpoints require a real LLM

## Setup

```bash
pnpm install

# Configure the server
cp apps/server/.env.example apps/server/.env
# edit apps/server/.env and set ANTHROPIC_API_KEY
#   (or LLM_PROVIDER=openai + OPENAI_API_KEY,
#    or LLM_PROVIDER=local + LOCAL_BASE_URL=http://localhost:11434/v1 + LOCAL_MODEL=llama3.1)
```

## Run

```bash
# 1. Start the backend (http://localhost:8787)
pnpm --filter @qa-copilot/server dev

# 2. Build the extension
pnpm --filter @qa-copilot/extension build
```

Then load the extension in Chrome:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/dist`.
3. Open any `http://localhost` app, click the QA Copilot icon to open the side panel.
4. For other origins (e.g. a staging site), open the extension **Options** page and
   add the origin under *Allowlisted origins* — this requests the host permission and
   registers the content script for that origin only (no broad `<all_urls>`).

## Use

- **Page tab** — *Scan page* builds a compact page model; *What should I test?*
  asks the LLM for page-aware suggestions.
- **Session tab** — *Start recording*, interact with the app, *Stop*. The timeline
  shows ordered actions (password/secret values are never captured). *Export JSON*.
- **Generate tab** — generate test cases, a bug report (with a note describing the
  expected behavior), and a Playwright draft. Each artifact is labeled **DRAFT**
  and can be exported as Markdown / `.spec.ts`.

## Test & verify

```bash
pnpm -r test          # unit + server tests (41+)
pnpm -r build         # typecheck + build all packages
pnpm -r lint

# Extension end-to-end (loads the real unpacked extension in Chromium):
pnpm --filter @qa-copilot/extension build
pnpm --filter @qa-copilot/extension exec playwright install chromium   # first time
pnpm --filter @qa-copilot/extension test:e2e
```

The E2E suite proves the core loop end-to-end: the content script scans a fixture
SPA into a redacted page model, records a flow (asserting no password value leaks),
and tracks an SPA `pushState` navigation.

## Security defaults (spec §11)

- Password/token/secret/PII fields are detected and their values are never stored.
- Request/response bodies are never captured; network query strings + headers are redacted.
- The server re-redacts emails/cards/tokens before any LLM call (defense in depth).
- Page content is wrapped as untrusted data in prompts (prompt-injection safe).
- Only localhost + explicitly allowlisted origins are in scope.
