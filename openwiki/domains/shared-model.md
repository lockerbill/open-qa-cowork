# Shared domain model

`packages/shared` defines the canonical data model and the pure helpers used by both the extension and the server. This is one of the most important parts of the repository because it encodes what the product considers a page, a session, an event, and an exported artifact.

## Core concepts

### Page model

A scanned page is represented as a `PageModel` with a `summary`, a list of `elements`, and a capture timestamp.

The summary contains:

- URL and route
- page title
- headings
- forms
- buttons
- links
- tables
- modals
- validation messages
- console errors
- network failures

The element list contains individually addressable interactable elements with selector candidates and sensitivity metadata.

### Session model

A `TestSession` stores the manual QA recording:

- session metadata such as browser, environment, base URL, and current URL
- ordered `ActionEvent` records
- `EvidenceItem` entries such as screenshots
- accumulated console errors and network failures

### Generated artifacts

Generated output is not modelled as a shared type. The generate routes return `{ artifactId, content, format }` directly, where `content` is a string and `format` is `markdown`, `json`, or `typescript`. The extension renders that string and never re-parses it into a structured record.

## Pure helper layers

The shared package exports deterministic utilities that are intended to be used without browser APIs:

- `selector.ts` ranks Playwright locator candidates from strong to fragile
- `redaction.ts` identifies sensitive fields and masks secrets in free text
- `playwright.ts` turns a session into a deterministic Playwright spec draft
- `sessionMarkdown.ts` exports the session as Markdown

These helpers are intentionally framework-free so they can be tested in isolation.

## Why the model is shaped this way

The repository is optimized for practical manual QA. The model therefore emphasizes:

- readable summaries for testers
- stable selectors for future automation
- explicit sensitivity markers for security
- exported artifacts that are easy to preview, copy, or attach to ticketing systems

## Important source files

- `packages/shared/src/types.ts`
- `packages/shared/src/selector.ts`
- `packages/shared/src/redaction.ts`
- `packages/shared/src/playwright.ts`
- `packages/shared/src/sessionMarkdown.ts`
- `packages/shared/src/index.ts`

## Change watchouts

- If you add a field to the page or session model, update the downstream extension and server code that serializes it.
- If you change selector ranking, expect Playwright draft tests to need updates.
- If you change redaction rules, update both unit tests and any docs that mention what is captured.
