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
| `apps/server` | Thin Node/Express proxy: provider-agnostic LLM gateway (Anthropic, OpenAI, OpenRouter, or a local OpenAI-compatible model), redaction guard, generation endpoints. No database (MVP 1). |

State lives in `chrome.storage.local` and file exports — there is no DB, queue,
or object storage in MVP 1 (those are MVP 3 in the spec).

## Prerequisites

- Node ≥ 20, pnpm 11
- An Anthropic, OpenAI, or OpenRouter API key, **or** a local OpenAI-compatible LLM server (Ollama, LM Studio, llama.cpp, vLLM...) — generation endpoints require a real LLM

## Setup

```bash
pnpm install

# Configure the server
cp apps/server/.env.example apps/server/.env
# edit apps/server/.env and set ANTHROPIC_API_KEY
#   (or LLM_PROVIDER=openai + OPENAI_API_KEY,
#    or LLM_PROVIDER=openrouter + OPENROUTER_API_KEY + OPENROUTER_MODEL=anthropic/claude-sonnet-4-6,
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

## Jira integration

Export a generated bug report to Jira Cloud as a fully-formed issue, with
evidence attached. Jira traffic goes **directly from the extension to your Jira
site** — the API token is stored in your browser profile and never reaches
`apps/server` or any LLM prompt.

### Setup

1. Create an API token at
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
   Tokens issued since late 2024 expire within a year.
2. Open the extension **Options → Jira** and fill in:
   - **Site URL** — e.g. `https://acme.atlassian.net`
   - **Account email** — your Atlassian login
   - **API token** — from step 1
   - **Default project key** (e.g. `QA`) and **issue type id** (e.g. `10004`)
   - **Severity → Jira priority** mapping
3. Click **Test connection**. Chrome asks for permission to access that one
   origin; the settings are saved only after the connection succeeds.
4. In the **Generate tab**, generate a bug report, then **Create Jira issue**.
   Review the pre-filled composer and click **Create** — nothing is written to
   Jira before that.

Your Jira account needs **Browse Projects**, **Create Issues**, and **Create
Attachments** on the target project. Screenshots, the session export, and the
Playwright draft (when present) are attached after the issue is created.

Once exported, the report card shows **Open PROJ-123** instead of the create
action. "Create another issue" is available behind the ⋯ menu.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401` — credentials rejected | Wrong email/token, or the token expired | Re-issue the token; use the Atlassian **account email**, not a username |
| `403` — permission denied | Account lacks project permissions | Ask a Jira admin for Browse Projects / Create Issues / Create Attachments |
| `403` on attachments only | Attachments disabled or not permitted | The issue is still created and linked; grant Create Attachments and retry |
| `404` — project not found | Wrong project key or issue type id | Check the key in Jira; find the issue type id via `/rest/api/3/issue/createmeta` |
| `413` / "exceeds the limit" | File over the site's attachment cap (10 MB default) | Oversized files are skipped and reported; the issue still gets the rest |
| `429` — rate limited | Jira throttling the account | Handled automatically with one `Retry-After` retry, then surfaced |
| "does not have permission to access…" | Host permission not granted | Click **Test connection** again and accept the Chrome prompt |
| Required field missing at submit | Project has required custom fields | The composer renders them from createmeta — fill them in and retry |

### Not in v1

OAuth 3LO (v1 uses API tokens), Jira Data Center/Server, two-way sync, bulk
export, and duplicate detection via JQL.

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
and tracks an SPA `pushState` navigation. A second suite drives the Jira export
against a mock Jira server (`e2e/jira-mock.mjs`), asserting the ADF payload shape,
the attachment multipart, and that the API token is never sent in the clear.

## Security defaults (spec §11)

- Password/token/secret/PII fields are detected and their values are never stored.
- Request/response bodies are never captured; network query strings + headers are redacted.
- The server re-redacts emails/cards/tokens before any LLM call (defense in depth).
- Page content is wrapped as untrusted data in prompts (prompt-injection safe).
- Only localhost + explicitly allowlisted origins are in scope.
- Jira credentials live in `chrome.storage.local` only (never `storage.sync`, which
  would replicate the token across machines) and are sent only to the configured
  Jira origin. An eslint `no-restricted-imports` rule structurally prevents the
  gateway client and the server's prompt builders from importing Jira code.
