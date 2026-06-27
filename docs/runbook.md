# Dev & Test Runbook

Operational guide for developing and testing QA Copilot locally. For
architecture and conventions, see [`AGENTS.md`](../AGENTS.md).

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | ≥ 20 | `engines.node` in root `package.json` |
| pnpm | 11 (`pnpm@11.4.0`) | `corepack enable` picks this up automatically |
| Chrome / Chromium | current | for loading the unpacked extension |
| LLM API key | — | Anthropic or OpenAI; only the **server** needs it |

First-time setup:

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # then edit, see below
```

`.env` (server, gitignored):

```ini
LLM_PROVIDER=anthropic            # anthropic | openai | local
ANTHROPIC_API_KEY=sk-ant-...      # or OPENAI_API_KEY=sk-... when provider=openai
ANTHROPIC_MODEL=claude-sonnet-4-6 # optional override
# Local OpenAI-compatible model (Ollama, LM Studio, llama.cpp, vLLM...) when provider=local:
# LOCAL_BASE_URL=http://localhost:11434/v1   # must include the /v1 path
# LOCAL_MODEL=llama3.1
# LOCAL_API_KEY=                             # usually blank
PORT=8787                         # must match the extension's default backend URL
```

---

## Daily Dev Loop

Two processes, two terminals.

**1. Backend (watch):**

```bash
pnpm --filter @qa-copilot/server dev
```

Serves `http://localhost:8787`. Sanity check:

```bash
curl http://localhost:8787/health        # → {"ok":true,"provider":"anthropic"}
```

If you see a `[warn] No API key set` line, generation endpoints will 5xx — fix
`.env` and restart.

**2. Extension:**

```bash
pnpm --filter @qa-copilot/extension build     # outputs apps/extension/dist
```

Then load it once in Chrome:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/dist`.
3. Open any `http://localhost` page → click the QA Copilot icon → side panel opens.
4. For a non-localhost origin, use the extension **Options** page → *Allowlisted
   origins* (this requests the host permission and registers the content script
   for that origin only).

> **HMR caveat:** `pnpm --filter @qa-copilot/extension dev` (Vite on `:5173`)
> gives HMR for the side panel/options UI, but changes to the **content script,
> background service worker, manifest, or `public/injected.js`** require a
> rebuild **and** clicking *Reload* on the extension card in `chrome://extensions`.
> When in doubt, rebuild and reload.

Run both together (backgrounds the server):

```bash
pnpm dev
```

---

## Testing

### Unit + integration (fast, no browser, no API key)

```bash
pnpm -r test                  # everything (44 tests: 30 shared, 10 server, 4 ext)
```

- `packages/shared` — selector ladder, redaction, Playwright templating (pure).
- `apps/extension` — scanner runs under **jsdom** (`vite.config.ts` → `test.environment`).
- `apps/server` — routes tested with a `MockProvider` (no real LLM call).

Scoped runs:

```bash
pnpm --filter @qa-copilot/shared test
pnpm --filter @qa-copilot/server exec vitest run src/app.test.ts          # one file
pnpm --filter @qa-copilot/shared exec vitest run -t "redacts emails"      # one test by name
pnpm --filter @qa-copilot/server exec vitest                              # watch mode
```

### End-to-end (real Chromium + unpacked extension)

Loads the built extension against a static SPA fixture served on `:5555`.

```bash
pnpm --filter @qa-copilot/extension build                          # required first
pnpm --filter @qa-copilot/extension exec playwright install chromium   # first time only
pnpm --filter @qa-copilot/extension test:e2e
```

What it proves: scan → redacted page model, record a flow, an SPA `pushState`
navigation is tracked, and **no password value leaks** into the session.

> The fixture server auto-starts via Playwright `webServer` (`reuseExistingServer`),
> so you don't launch `serve.mjs` yourself. E2E runs serially (`workers: 1`).

### Static checks

```bash
pnpm -r typecheck
pnpm -r lint
pnpm format            # prettier --write
```

---

## Pre-PR / Pre-commit Gate

Run in order; all must be green:

```bash
pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm -r build
# if content/background/manifest/injected.js changed:
pnpm --filter @qa-copilot/extension test:e2e
```

If redaction logic was touched, confirm the redaction suite
(`packages/shared/src/redaction*.test.ts`) is still 100% green — a failure here
means a potential secret leak, treat it as a release blocker.

---

## Manual Smoke (the full loop)

With server + extension running:

1. **Page tab** → *Scan page* → JSON page model appears; *What should I test?*
   returns page-aware suggestions (requires LLM key).
2. **Session tab** → *Start recording* → click/type on the app (incl. a password
   field) → *Stop*. Timeline shows ordered steps; *Export JSON* — verify the
   password value is **absent**.
3. **Generate tab** → generate test cases, a bug report, and a Playwright draft.
   Each is labeled **DRAFT**. Export the `.spec.ts` and confirm it parses:
   ```bash
   npx tsc --noEmit path/to/exported.spec.ts
   ```

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Side panel won't open on a site | Origin not allowlisted. Add it via Options (localhost works out of the box). |
| Content-script edits have no effect | Rebuild + *Reload* the extension card. Vite HMR doesn't cover content/background. |
| SPA navigation not recorded | Page-context signal must come from `public/injected.js` (main world), not the content script. |
| Recorded actions dropped under load | Background storage write must go through `updateSession()`/`runExclusive()` — direct `chrome.storage` writes race. |
| Generation endpoint 5xx | Missing/invalid API key in `apps/server/.env`, or wrong `LLM_PROVIDER`. Check the server log. |
| `curl /health` refused | Server not running, or `PORT` in `.env` ≠ extension backend URL (`8787`). |
| E2E can't find the extension | You didn't `build` before `test:e2e`; the suite loads `apps/extension/dist`. |
| `playwright` browser missing | `pnpm --filter @qa-copilot/extension exec playwright install chromium`. |

---

## Ports Reference

| Port | Used by |
| --- | --- |
| 8787 | Server (`PORT`, extension's default backend URL) |
| 5173 | Vite dev server / HMR (extension UI) |
| 5555 | E2E fixture SPA server |
