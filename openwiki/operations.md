# Operations and verification

This page summarizes the local development, configuration, and verification practices for QA Copilot. The canonical detailed runbook remains `docs/runbook.md`; this page is the OpenWiki map for future agents.

## Prerequisites

From `README.md`, `package.json`, and `docs/runbook.md`:

- Node 20 or newer
- pnpm 11 (`packageManager` is pinned in root `package.json`)
- Chrome or Chromium for the unpacked extension
- an Anthropic, OpenAI, or OpenRouter API key, or a local OpenAI-compatible model server

## First-time setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
```

Do not read or commit real `.env` files. Use `apps/server/.env.example` and `docs/runbook.md` for non-sensitive configuration guidance.

## Run locally

Backend:

```bash
pnpm --filter @qa-copilot/server dev
```

Extension build:

```bash
pnpm --filter @qa-copilot/extension build
```

Then load `apps/extension/dist` as an unpacked extension in Chrome. The default backend URL expected by the extension is `http://localhost:8787` (`apps/extension/src/shared/messages.ts`).

## LLM configuration

Provider selection is server-side in `apps/server/src/config.ts` and `apps/server/src/llm/index.ts`.

Supported providers:

- `anthropic`
- `openai`
- `openrouter`
- `local`

For local OpenAI-compatible servers, pay attention to served context length and `LOCAL_MAX_TOKENS`; the runbook explains why local models can truncate output even when the model nominally supports a larger window.

## Verification commands

From root package scripts and the runbook:

```bash
pnpm -r lint
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Extension E2E:

```bash
pnpm --filter @qa-copilot/extension build
pnpm --filter @qa-copilot/extension exec playwright install chromium
pnpm --filter @qa-copilot/extension test:e2e
```

Run the E2E suite when changing extension content scripts, background service worker behavior, manifest permissions, or injected page-world code.

## High-risk changes

- Redaction changes are release-critical. Verify `packages/shared/src/redaction*.test.ts` and server prompt/redaction behavior.
- Recording changes should verify `recorder.test.ts`, `element-extract.test.ts`, Playwright generation tests, and E2E where browser behavior matters.
- Provider changes should verify provider tests under `apps/server/src/llm/` and route tests in `apps/server/src/app.test.ts`.
- Manifest/permission changes should be tested in a real unpacked extension, not only with unit tests.

## Troubleshooting map

For detailed troubleshooting, use `docs/runbook.md`. Common source areas:

- side panel state or stale URL: `apps/extension/src/background/index.ts`
- content script not active on an origin: `apps/extension/manifest.config.ts`, options/allowlist flow, background injection helpers
- generation endpoint errors: `apps/server/src/config.ts`, provider implementation, server logs
- local model truncation: `apps/server/src/llm/local.ts`, `apps/server/src/llm/openai-compatible.ts`, runbook local LLM section
