# Server generation pipeline

The server is a thin Express application that exposes the generation and chat routes used by the extension. The core idea is simple: validate the request, build a prompt, redaction-guard the data, send it to the configured provider, then format the response for the UI.

## Routes

Defined in `apps/server/src/app.ts`:

- `GET /health` — reports the active provider.
- `POST /api/page/analyze` — returns JSON with a page summary, risks, and suggested tests.
- `POST /api/generate/test-cases` — returns Markdown test cases.
- `POST /api/generate/bug-report` — returns a Jira-style Markdown bug report.
- `POST /api/generate/playwright` — returns a TypeScript spec, generated deterministically first and optionally enriched by the model.
- `POST /api/chat` — returns raw chat text for the general chat tab.

## Prompt behavior

Prompt templates live in `apps/server/src/prompts/index.ts`.

Important rules enforced there:

- page and session content are wrapped as untrusted data
- page analysis must respond with JSON only
- test cases and bug reports are framed as structured Markdown outputs
- Playwright enrichment may improve comments and assertions, but must not change selectors
- chat uses a generic assistant persona rather than the QA-specific prompt

## Provider selection

`apps/server/src/llm/index.ts` chooses one of four providers from configuration:

- Anthropic
- OpenAI
- OpenRouter
- local OpenAI-compatible server

The selected provider is wrapped in a logging decorator so model metadata and redacted payloads can be traced without exposing secrets.

## Configuration and failure modes

Server config comes from environment variables in `apps/server/src/config.ts`. The active provider and its credentials are validated lazily by the provider implementations, which return a 503-style error if required settings are missing.

The `local` provider deserves special attention:

- it uses an OpenAI-compatible endpoint such as Ollama, LM Studio, llama.cpp, or vLLM
- `LOCAL_MAX_TOKENS` acts as a floor rather than a replacement for per-route caps
- optional thinking tokens can be disabled for reasoning models

## Change watchouts

- If you add a route, add request schemas in `apps/server/src/http/schemas.ts` and prompt builders in `apps/server/src/prompts/index.ts`.
- If you change prompt structure, keep the extension preview/export paths in sync.
- If you change provider behavior, update the provider-specific tests under `apps/server/src/llm/`.
- If you touch redaction, verify the defense-in-depth guard in `apps/server/src/redaction/guard.ts` still runs before provider calls.

## Source references

- `apps/server/src/app.ts`
- `apps/server/src/config.ts`
- `apps/server/src/prompts/index.ts`
- `apps/server/src/llm/index.ts`
- `apps/server/src/llm/types.ts`
- `apps/server/src/redaction/guard.ts`
- `apps/server/src/logging/logger.ts`
