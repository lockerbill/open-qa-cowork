# OpenWiki quickstart

QA Copilot is a Chrome extension plus a thin Node/Express backend for manual QA workflows. It scans the current page into a structured model, records exploratory test sessions, and generates draft test cases, bug reports, Playwright specs, and free-form chat responses.

## What this repository contains

- `packages/shared` — pure domain logic shared by the extension and server: data types, selector ranking, redaction, deterministic Playwright spec generation, and Markdown session export.
- `apps/extension` — the Manifest V3 Chrome extension: side panel UI, content script scanner/recorder, background service worker, options page, and E2E tests.
- `apps/server` — the stateless LLM proxy: provider selection, request redaction, prompt building, JSON/Markdown artifact generation, logging, and HTTP routes.
- `docs/` and `specs/` — existing operational and product docs that explain the intended behavior and implementation constraints.

The project is centered on MVP 1: there is no database, queue, or persistent backend storage. Session state lives in `chrome.storage.local`, while generated artifacts are exported to files or copied as Markdown.

## Start here

1. Read the architecture overview: [Architecture](architecture/overview.md)
2. Read extension capture internals: [Extension capture architecture](architecture/extension-capture.md)
3. Read the main workflows: [Workflows](workflows/overview.md)
4. Read the shared domain model: [Domain model](domains/shared-model.md)
5. Read the server-side LLM and prompt surface: [Server generation pipeline](architecture/server-generation.md)
6. Read local operations and verification guidance: [Operations](operations.md)

## Important repository facts

- The extension only operates on localhost and explicitly allowlisted origins.
- Sensitive values are intentionally not stored; redaction is enforced in both the extension and the server.
- The chat feature added recently is stateless: it sends the current messages to the server and does not store chat history.
- The Playwright draft generation path is deterministic first, with optional LLM enrichment.
- Recent commits focused on local LLM support, OpenRouter support, logging, session export, and recorder improvements.

## Useful source files

- Root overview: `README.md`
- Product spec: `specs/qa-copilot-product-idea-to-mvp-spec.md`
- Operational runbook: `docs/runbook.md`
- Agent instructions: `AGENTS.md`, `CLAUDE.md`
- Extension entrypoint: `apps/extension/src/sidepanel/App.tsx`
- Background state manager: `apps/extension/src/background/index.ts`
- Page scanner: `apps/extension/src/content/scanner.ts`
- Session recorder: `apps/extension/src/content/recorder.ts`
- Shared domain types: `packages/shared/src/types.ts`
- Shared selector/redaction logic: `packages/shared/src/selector.ts`, `packages/shared/src/redaction.ts`
- Server routes: `apps/server/src/app.ts`
- Server config and providers: `apps/server/src/config.ts`, `apps/server/src/llm/index.ts`

## Change guidance for future agents

- If you change page scanning or recording, update the shared domain types and the extension tests together.
- If you change generation behavior, inspect both the server prompt builders and the extension client calls.
- If you touch provider configuration, update `apps/server/.env.example` and the runbook alongside the code.
- If you change storage or recording semantics, re-check the background service worker for race conditions.
- If you change security-sensitive paths, verify that redaction and prompt-injection protections still hold.
