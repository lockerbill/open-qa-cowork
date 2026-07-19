# Design: add-jira-issue-export

## Decision 1 — Extension-direct, not server-proxied

Jira calls go straight from the MV3 **background service worker** to the user's Jira Cloud site. We do NOT proxy through `apps/server`.

Rationale:
- Keeps the server a stateless LLM gateway (core architecture invariant; no credential storage, no new attack surface, nothing to deploy).
- Extension `fetch` with granted host permissions is exempt from CORS, so the Jira REST API works without a proxy.
- Local-first story stays intact: token lives and dies in the user's browser profile.

Consequence: the content script and side panel never call Jira directly; they message the service worker (`jira/testConnection`, `jira/getCreateMeta`, `jira/createIssue`, `jira/uploadAttachments`), matching the existing message-routing pattern.

## Decision 2 — Auth: API token (v1), OAuth 3LO (v2)

v1 uses **Basic auth = email + Atlassian API token**, base64-encoded in the `Authorization` header. This is the standard integration path for Jira Cloud REST v3, requires zero Atlassian-side app registration, and fits an open-source tool where every user connects their own site.

Designed-for v2: OAuth 2.0 (3LO) via `chrome.identity.launchWebAuthFlow` (see §Atlassian side). The `JiraClient` therefore takes an `AuthStrategy` interface (`getBaseUrl()`, `getHeaders()`) so 3LO/PAT slot in without touching call sites.

Token storage: `chrome.storage.local` (survives browser restart; API tokens are long-lived and re-entering per session would kill adoption). Documented trade-off in README: storage.local is readable by anyone with access to the OS profile — same threat model as any browser-stored credential. Never `chrome.storage.sync` (would replicate the token to other machines).

## Decision 3 — Description format: markdown → ADF

Jira Cloud API v3 requires descriptions in **Atlassian Document Format** (JSON), not markdown. New `apps/extension/src/integrations/jira/adf.ts`:

- Parse the report markdown with the `marked` lexer — already an `apps/extension` dependency, used by `src/sidepanel/preview.ts` — and map: heading, paragraph, ordered/bullet list, code block (with language), inline code, bold/italic, link, table → ADF nodes.
- Unknown/unmappable nodes degrade to plain-text paragraphs — never throw, never drop content.
- Pure function, unit-tested against fixtures authored from the report shape `apps/server/src/prompts/index.ts` asks the model to emit, so generator changes that break export are caught in CI. (The repo has no bug-report fixture corpus today; this change creates one.)

**Placement**: this deliberately does *not* live in `packages/shared`, despite being a pure transform. That package currently declares **no runtime dependencies at all**, and it is imported by `apps/server` — including `apps/server/src/prompts/index.ts`. Putting the ADF converter or the Jira config schema there would drag `marked` (and zod) into the server, and would place Jira code inside a package the prompt builders must import — which would gut the `no-restricted-imports` guard in §Security below, since that rule is only meaningful if `integrations/jira` is a path prompt builders never legitimately reach for. Shared gets the `TrackerLink` and `JiraConfig` **types** only, as plain interfaces with hand-written validation.

(v2 Data Center note: DC REST v2 takes wiki markup, not ADF — another reason the renderer sits behind an interface.)

## Decision 4 — Optional host permissions

Manifest adds:

```json
"optional_host_permissions": ["https://*.atlassian.net/*", "https://*/*"]
```

At settings-save time, request permission for **exactly the configured origin** via `chrome.permissions.request({ origins: [origin + "/*"] })`. The broad patterns are only what makes the runtime request grantable; nothing is requested at install. `https://*/*` covers custom domains (rare, but Jira supports them); the actual grant is always single-origin.

## Module layout

```
apps/extension/src/integrations/jira/
  client.ts        // JiraClient: myself, createMeta, createIssue, addAttachments
  auth.ts          // AuthStrategy: BasicTokenAuth (v1), OAuthAuth (v2 stub)
  adf.ts           // markdownToAdf() — uses `marked` (already an extension dep)
  mapping.ts       // report markdown -> CreateIssuePayload (uses adf.ts)
  messages.ts      // jira/* SW handlers, hand-validated (no zod in the extension)
apps/extension/src/sidepanel/
  IssueComposer.tsx
apps/extension/src/options/
  Options.tsx      // + Jira settings section (settings already live here)
apps/extension/src/shared/
  storage.ts       // + JIRA_CONFIG_KEY, JIRA_LINKS_KEY
packages/shared/src/
  types.ts         // + TrackerLink, JiraConfig (plain interfaces, no new deps)
```

## Flow

1. Report card → "Create Jira issue" → side panel asks SW for create metadata (`GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes/{id}` — field list drives which composer inputs render; required unmapped fields render as blank inputs instead of failing at submit).
2. Composer opens pre-filled from `mapping.ts`. User edits, clicks Create.
3. SW: `POST /rest/api/3/issue` → on 201, immediately `POST /issue/{key}/attachments` (multipart, header `X-Atlassian-Token: no-check`) with screenshots (PNG blobs from the session store), `session.json`, `spec.playwright.ts`.
4. SW persists a `TrackerLink` at `JIRA_LINKS_KEY[artifactId]` in `chrome.storage.local`; side panel re-renders link state; toast with issue link + attachment summary.

   Why a link map rather than a field on the report: generated artifacts are not persisted today — the side panel holds them in component state (`App.tsx`), so there is no stored report to hang a `tracker` field on. Keying by the gateway-issued `artifactId` gets the full idempotency behaviour the spec requires without first building an artifact store. A regenerated report is a genuinely different artifact and correctly offers "Create" again.

Attachment failure after creation is non-fatal (issue link still shown, per spec). Jira Cloud default attachment cap is 10 MB/file (site-configurable) — check sizes client-side and skip+warn rather than 413.

## Security

- Token redaction: the existing log/trace sanitizer gets a rule for the `Authorization` header and the config key.
- Prompt isolation is structural: prompt builders import nothing from `integrations/jira` (enforced with an eslint `no-restricted-imports` rule, same trick as the credential vault).
- Issue creation is human-gesture-only. (There is no auto-mode agent in `apps/extension/src` today; when one lands it must not be given a Jira action verb.)

---

# Atlassian-side plan

## v1 (API token) — nothing to register, but document for users

Per-user setup (goes in README + a help link inside settings):
1. Create an API token at **id.atlassian.com → Security → API tokens**. Note: tokens created since late 2024 have a mandatory expiry (max 1 year) — the 401 error surface should mention "your token may have expired".
2. Jira permissions needed in the target project's permission scheme: **Browse Projects**, **Create Issues**, **Create Attachments**. Admins of locked-down projects must grant these to the QA user; the extension surfaces 403 with this checklist.
3. Attachments must be enabled on the Jira site (they are by default) and file-size limit ≥ the session export size.
4. Rate limits: Jira Cloud applies dynamic per-user limits; our single-issue + few-attachments burst is far below them, but the client honours `Retry-After` on 429 regardless.

## v2 (OAuth 3LO) — what you'll have to do on developer.atlassian.com

1. Create an app in the **Atlassian Developer Console** → "OAuth 2.0 integration".
2. Scopes (granular): `read:jira-work`, `write:jira-work`, `offline_access` (refresh tokens).
3. Callback URL: `https://<extension-id>.chromiumapp.org/` (the synthetic redirect `chrome.identity.launchWebAuthFlow` listens on). This pins the app to the published extension ID — so publish to the Web Store first and use the stable ID; add a second callback for the dev-mode ID.
4. Runtime flow: authorize at `auth.atlassian.com/authorize` → exchange code at `auth.atlassian.com/oauth/token` → `GET api.atlassian.com/oauth/token/accessible-resources` to get the **cloudId** → all API calls go to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` instead of the site URL.
5. Distribution: enable "Sharing" in the console so any Atlassian user can consent; optionally list on the Atlassian Marketplace later (requires security self-assessment / Marketplace review).
6. Secret handling problem to solve then: a Chrome extension can't keep a client secret. Options: register as a public client with PKCE if/when Atlassian supports it for 3LO, or add a tiny token-exchange endpoint — which would be the first stateful-ish duty for `apps/server`, so decide deliberately at v2 time.

## Jira Data Center / Server (v2, if requested)

- Auth: Personal Access Token, `Authorization: Bearer <PAT>`.
- API: REST **v2**, description as **wiki markup** (no ADF) — covered by the renderer interface in Decision 3.
- Network: DC is often behind a VPN; extension-direct calls work fine there (browser is already on the VPN), another point for Decision 1.

---

# Deployment checklist (our side)

1. `packages/shared`: types + `markdownToAdf` + unit tests (fixtures from bug-report generator).
2. `apps/extension`: manifest `optional_host_permissions` bump → **Chrome Web Store review**: include a justification string ("connects to the user's own Jira site, only after explicit opt-in") in the listing's permission justification field; optional permissions usually pass quickly but expect 1–3 days.
3. No `apps/server` deploy, no env vars, no infra change in v1.
4. Docs: README "Jira integration" section (token creation, required project permissions, troubleshooting table for 401/403/404/413/429).
5. E2E: extend the fixture SPA suite — mock Jira with an MSW/express stub asserting the ADF payload shape and the attachment multipart, plus one manual smoke test against a free Jira Cloud sandbox (`<anything>.atlassian.net`, free tier ≤ 10 users) before release.
6. Release note + demo GIF (report card → composer → issue in Jira).

## Risks

- **ADF fidelity**: tables and nested lists are the fiddly part; fixture-driven tests + plain-text fallback bound the blast radius.
- **createmeta variance**: heavily customized Jira projects with required custom fields; mitigated by rendering unknown required fields dynamically from createmeta.
- **Token expiry support-noise**: mitigated by explicit 401 messaging.
