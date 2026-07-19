# Chrome Web Store submission — Jira export release

Copy for the listing fields when publishing the release that adds Jira export.

## Permission justifications

The manifest's `optional_host_permissions` (`https://*/*`, `http://*/*`) predate
this release, but the Jira feature is the first thing that requests a `https://`
origin at runtime, so reviewers will ask about it. Use the wording below.

### Host permissions (optional, requested at runtime)

> QA Copilot never requests host access at install time. When a user chooses to
> connect their own Jira Cloud site in extension settings, the extension requests
> permission for **that single origin only** (e.g. `https://acme.atlassian.net/*`)
> at the moment they click "Test connection". The broad optional patterns exist
> because Jira Cloud sites are per-customer subdomains and Jira also supports
> custom domains, so the specific origin is not knowable in advance. The same
> mechanism lets a QA engineer add the staging origin of the application they are
> testing. No host permission is ever granted without an explicit Chrome prompt.

### `storage`

> Stores the user's settings, the recorded test session, and — if they connect
> Jira — their Jira site URL and API token. Credentials are kept in
> `chrome.storage.local` (never `chrome.storage.sync`) so they stay on the one
> machine and are transmitted only to the user's own Jira site.

### Remote code

> None. The extension bundles all of its code; nothing is fetched and evaluated
> at runtime.

## Data-use disclosures

- **Does the extension collect personally identifiable information?** Yes —
  authentication information (the user's own Jira API token), stored locally on
  the user's device and sent only to the Jira site they configured.
- **Sold to third parties?** No.
- **Used or transferred for purposes unrelated to the item's core
  functionality?** No.
- **Used or transferred to determine creditworthiness or for lending?** No.

## Release notes

> **Jira export.** Turn a generated bug report into a Jira Cloud issue without
> leaving the browser. Connect your Jira site in settings, then use "Create Jira
> issue" on any bug report: QA Copilot pre-fills a composer you review before
> anything is written, converts the report to Atlassian Document Format so
> headings, repro steps, tables and code blocks survive intact, and attaches your
> screenshots, the session export, and the generated Playwright spec. Once
> exported, the report links straight to the issue so you do not file it twice.
>
> Your Jira API token is stored only in this browser profile and is never sent to
> the QA Copilot backend or included in any AI prompt.

## Still to do before submitting

- [ ] Demo GIF: report card → "Create Jira issue" → composer → created issue in
      Jira. Needs a real Jira sandbox, so it has to be recorded by hand.
- [ ] Bump `version` in `apps/extension/manifest.config.ts`.
- [ ] Run the manual smoke checklist (tasks.md 5.2) against a free Jira Cloud
      site before publishing.
