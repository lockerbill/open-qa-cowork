# Tasks: add-jira-issue-export

## Phase 0 — Artifact reconciliation
- [x] 0.1 Move the `jira-integration` spec from the change root into `specs/jira-integration/spec.md`; delete the stray `mnt/user-data/outputs/` tree; verify both specs appear in `openspec instructions apply --json`
- [x] 0.2 `specs/jira-integration/spec.md`: drop the `openqa-auto` label and the auto-mode clause (no auto mode exists in `apps/extension/src`)
- [x] 0.3 `specs/bug-reporting/spec.md`: recast the MODIFIED "Bug report artifact" delta — which modified a requirement that was never implemented — as an ADDED tracker-link requirement keyed by `artifactId`
- [x] 0.4 `proposal.md`: correct the consumed-artifact claim and the `packages/shared` impact line
- [x] 0.5 `design.md`: Decision 3 placement rationale, §Module layout, Flow step 4, auto-mode security note
- [x] 0.6 `tasks.md`: retarget 1.1–1.3, 2.3, 3.2 and 4.4 to match the decisions above

## Phase 1 — Foundations
- [x] 1.1 Add `TrackerLink` and `JiraConfig` as plain interfaces to `packages/shared/src/types.ts` (no zod — the package stays dependency-free); export from `index.ts`
- [x] 1.2 Implement `markdownToAdf()` in `apps/extension/src/integrations/jira/adf.ts` using the `marked` lexer (headings, paragraphs, lists, code blocks, inline marks, links, tables; plain-text fallback, never throws)
- [x] 1.3 Unit tests for ADF conversion against fixtures authored from the report shape in `apps/server/src/prompts/index.ts` (no fixture corpus exists yet — this task creates it)

## Phase 2 — Jira client (service worker)
- [x] 2.1 `AuthStrategy` interface + `BasicTokenAuth` (email + API token)
- [x] 2.2 `JiraClient`: `myself()`, `getCreateMeta()`, `createIssue()`, `addAttachments()` with 429 Retry-After handling and typed errors
- [x] 2.3 `JIRA_*` SW message handlers wired into the existing switch in `background/index.ts`, with hand-written payload validation (the extension has no zod dependency). Names follow the file's SCREAMING_SNAKE convention rather than design.md's illustrative `jira/*`. Storage primitives (`JIRA_CONFIG_KEY`, `JIRA_LINKS_KEY`) landed here since the handlers need them; 3.3 and 4.4 wire the UI to them.
- [x] 2.4 Added `Authorization` header + credential config keys to `redactText` in `packages/shared/src/redaction.ts`; eslint `no-restricted-imports` guard on `apps/server/src/prompts/**` **and** `apps/extension/src/sidepanel/backend.ts` — the latter is the file that actually builds gateway requests, so it is where the isolation bites (verified firing by temporarily adding a banned import)

## Phase 3 — Settings & permissions
- [x] 3.1 Manifest: `optional_host_permissions` — **already present** at `manifest.config.ts:43` as `['https://*/*', 'http://*/*']`, a superset of design.md's proposed `https://*.atlassian.net/*`. No change needed; verified in the built `dist/manifest.json`
- [x] 3.2 Jira settings section in `apps/extension/src/options/Options.tsx`: site URL, email, token, default project/issue type, severity→priority mapping
- [x] 3.3 On save: normalize origin, `chrome.permissions.request`, then "Test connection" via `myself()`; store verified config under `JIRA_CONFIG_KEY`. Test-and-persist is one action, matching the spec scenario in which a successful test ends with the config persisted

## Phase 4 — Composer & export flow
- [x] 4.1 `mapping.ts`: report markdown → `CreateIssuePayload` (summary truncation to 255, `openqa` label, priority mapping). Summary/severity are recovered from the markdown, since the gateway returns text rather than a structured report
- [x] 4.2 `IssueComposer`: prefilled fields, dynamic required fields from createmeta, per-field Jira validation errors with input preserved
- [x] 4.3 Create issue → upload attachments (screenshots from `session.evidence`, session.json, Playwright spec when present) with size pre-check and partial-failure warning + retry
- [x] 4.4 Persist `TrackerLink` at `JIRA_LINKS_KEY[artifactId]`; `ArtifactView` resolves it and renders "Open PROJ-123" as the primary action; "Create another issue" behind an overflow toggle

## Phase 5 — Verification & release
- [x] 5.1 E2E against a mock Jira server asserting ADF payload + multipart attachments (incl. `X-Atlassian-Token: no-check`). 6 tests in `e2e/jira-export.spec.ts` against `e2e/jira-mock.mjs`; caught a production bug (see note below)
- [ ] 5.2 Manual smoke test on a free Jira Cloud sandbox (happy path, 401, missing permission, oversized attachment) — **requires a real Atlassian account; cannot be completed here**
- [x] 5.3 README: Jira setup guide + troubleshooting table (401/403/404/413/429)
- [x] 5.4 Chrome Web Store: permission justification text, data-use disclosures and release notes in `docs/chrome-web-store-jira-release.md`
- [ ] 5.5 Demo GIF (report card → composer → issue in Jira) — **requires a real Jira sandbox to record**

## Notes

**Permission bug found by 5.1.** `chrome.permissions.request()` throws
"This function must be called during a user gesture" when called from a service
worker. The original handler called it there and swallowed the throw as
"permission declined", so connecting Jira would have failed 100% of the time with
a misleading message. Fixed by splitting the concern: `requestJiraOrigin()` in
`auth.ts` runs in the options page's click handler, and the worker only calls
`chrome.permissions.contains()`. A unit test now guards that the worker never
calls `request()`.

**Pre-existing bug, not fixed here.** `addAllowlistOrigin()` in
`background/index.ts:392` has the same defect — it calls
`chrome.permissions.request()` from the service worker, so "Add & grant" in the
allowlist settings likely fails the same way. Out of scope for this change;
worth a follow-up.
