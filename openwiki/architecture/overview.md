# Architecture overview

QA Copilot is split into three cooperating parts:

1. `packages/shared` holds the pure domain layer.
2. `apps/extension` provides the browser-facing capture and UI surface.
3. `apps/server` provides a provider-agnostic LLM gateway and generation API.

This separation is deliberate. The shared package stays framework-free so both apps can reuse the same model and export logic. The extension owns browser permissions, page inspection, and session state. The server owns external model calls, request shaping, and defense-in-depth redaction.

## High-level flow

- The content script scans the active page into a layered page model.
- The background worker stores page/session state in `chrome.storage.local` and keeps the side panel synchronized.
- The side panel lets a tester scan, record, preview, export, and generate artifacts.
- The server receives redacted page/session context and calls the configured LLM provider.
- Generated content returns as Markdown, JSON, or TypeScript depending on the route.

## Why this structure exists

The repository is optimized for manual QA assistance rather than a general automation platform. That shows up in the architecture:

- Session state is ephemeral and local to the extension.
- The backend is stateless because the product does not need persistence in MVP 1.
- The shared package contains deterministic helpers so artifacts can be reproduced and tested without browser or API dependencies.
- LLM calls are isolated behind a provider interface so Anthropic, OpenAI, OpenRouter, and local OpenAI-compatible servers can be swapped server-side.

## Main source references

- Root summary: `README.md`
- Agent guide: `AGENTS.md`
- Shared package entry: `packages/shared/src/index.ts`
- Shared data model: `packages/shared/src/types.ts`
- Extension side panel: `apps/extension/src/sidepanel/App.tsx`
- Extension background worker: `apps/extension/src/background/index.ts`
- Extension capture details: [Extension capture architecture](extension-capture.md)
- Server app: `apps/server/src/app.ts`
- Server provider factory: `apps/server/src/llm/index.ts`

## Change watchouts

- Keep browser-only code out of `packages/shared`.
- Keep provider selection server-side; the extension should not know which model is used.
- If you add persistence, it is a product-level change, not a small refactor, because many docs and workflows currently assume no database.
