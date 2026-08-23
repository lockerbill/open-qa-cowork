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

These legacy routes are unauthenticated and stateless. They stay because they are the signed-out fallback: `apps/extension/src/sidepanel/backend.ts` calls the workspace gateway first and drops back to these whenever the user is signed out, the token is stale, or the workspace has no provider configured.

## Platform routes

Mounted only when the platform is configured (`DATABASE_URL`, `JWT_SECRET`, `MASTER_ENCRYPTION_KEY`). All are authenticated and RBAC-checked.

Called by the extension today:

| Route | Module |
| --- | --- |
| `POST /api/auth/register` | `modules/auth/routes.ts` |
| `POST /api/auth/login` | `modules/auth/routes.ts` |
| `GET /api/workspaces` | `modules/workspaces/routes.ts` |
| `GET /api/workspaces/:workspaceId/projects` | `modules/projects/routes.ts` |
| `GET /api/workspaces/:workspaceId/projects/:projectId/environments` | `modules/projects/routes.ts` |
| `GET /api/workspaces/:workspaceId/resolve` | `modules/projects/routes.ts` |
| `GET /api/workspaces/:workspaceId/llm-providers` | `modules/providers/routes.ts` |
| `POST /api/workspaces/:workspaceId/llm-providers` | `modules/providers/routes.ts` |
| `POST /api/workspaces/:workspaceId/llm-providers/:providerId/validate` | `modules/providers/routes.ts` |
| `POST /api/workspaces/:workspaceId/llm-providers/:providerId/set-default` | `modules/providers/routes.ts` |
| `POST /api/workspaces/:workspaceId/ai/tasks/*` | `modules/ai-tasks/routes.ts` |
| `POST /api/workspaces/:workspaceId/auto/step` | `modules/auto/routes.ts` |

**No in-repo client yet.** The routes below are implemented and covered by tests, but nothing in this repository calls them — there is no admin UI. They are not dead code and should not be deleted; they are the surface an admin client or a curl-driven setup script would use.

| Route | Module |
| --- | --- |
| `GET /api/auth/me` | `modules/auth/routes.ts` |
| `POST /api/workspaces` | `modules/workspaces/routes.ts` |
| `GET /api/workspaces/:workspaceId` | `modules/workspaces/routes.ts` |
| `POST /api/workspaces/:workspaceId/members/invite` | `modules/workspaces/routes.ts` |
| `POST /api/workspaces/:workspaceId/members/accept` | `modules/workspaces/routes.ts` |
| `POST /api/workspaces/:workspaceId/members/decline` | `modules/workspaces/routes.ts` |
| `POST /api/workspaces/:workspaceId/projects` | `modules/projects/routes.ts` |
| `GET /api/workspaces/:workspaceId/projects/:projectId` | `modules/projects/routes.ts` |
| `PATCH /api/workspaces/:workspaceId/projects/:projectId` | `modules/projects/routes.ts` |
| `POST /api/workspaces/:workspaceId/projects/:projectId/environments` | `modules/projects/routes.ts` |
| `PATCH /api/workspaces/:workspaceId/llm-providers/:providerId` | `modules/providers/routes.ts` |
| `POST /api/workspaces/:workspaceId/llm-providers/:providerId/rotate-secret` | `modules/providers/routes.ts` |
| `DELETE /api/workspaces/:workspaceId/llm-providers/:providerId` | `modules/providers/routes.ts` |

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
