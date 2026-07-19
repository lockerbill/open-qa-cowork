# Change: add-jira-issue-export

## Why

When the extension (manual recording or auto test mode) generates a bug report, the QA engineer today has to copy the markdown, open Jira, create an issue, paste, reformat, and re-upload screenshots by hand. This loses evidence fidelity (console errors, failed requests, repro steps, Playwright draft) and adds minutes of friction per defect — exactly the kind of toil OpenQA exists to remove.

## What Changes

- Add a **"Create Jira issue"** button on every generated bug report card in the side panel.
- Add a **Jira connection settings** section (site URL, auth, default project / issue type) with a "Test connection" action.
- Add a **pre-filled issue composer** (summary, description, labels, priority) shown before submission — the human always reviews before anything is written to Jira.
- Create the issue via the Jira Cloud REST API v3 directly from the extension service worker; **attach evidence** (screenshots, session export JSON, generated Playwright spec) to the created issue.
- **Link back**: store the created issue key + URL keyed by the report's `artifactId`; the button becomes an "Open PROJ-123" link to prevent duplicates.
- New shared module: markdown → Atlassian Document Format (ADF) converter.

## What Does NOT Change

- `apps/server` stays a stateless LLM gateway. Jira credentials and Jira traffic never touch the server or any LLM prompt.
- Bug report generation itself is unchanged. Jira export is a pure consumer of what generation already produces: the markdown returned by the gateway (`GenerateResponse { artifactId, content, format }`) plus the evidence already held on the recorded session.

## Capabilities Affected

- **jira-integration** (new spec)
- **bug-reporting** (delta: a tracker link record, resolvable by `artifactId`, is persisted alongside generated reports)

## Impact

- `apps/extension`: new `src/integrations/jira/` (client, auth, ADF conversion, mapping, SW message handlers), composer UI in `src/sidepanel/`, Jira settings in `src/options/`, manifest `optional_host_permissions`, a `JIRA_CONFIG_KEY` + `JIRA_LINKS_KEY` in `src/shared/storage.ts`.
- `packages/shared`: `TrackerLink` and `JiraConfig` types only. The package has no runtime dependencies and keeps none — the ADF converter lives in the extension, where `marked` is already a dependency (see design.md Decision 3).
- `apps/server`: none.
- Chrome Web Store: new optional host permission triggers a review note (see design.md §Deployment).

## Out of Scope (v1)

- OAuth 2.0 (3LO) flow — planned v2, designed for but not built (see design.md).
- Jira Data Center / Server support — v2 (PAT auth + wiki-markup descriptions).
- Two-way sync (status updates, comments), bulk export, duplicate detection via JQL search.
