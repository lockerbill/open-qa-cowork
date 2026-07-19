# Workflows overview

This repository is organized around a small set of tester workflows. Each one starts in the extension, may use the shared domain helpers, and sometimes calls the server for LLM-backed output.

## 1. Scan the current page

The side panel's Page tab asks the content script to analyze the active tab and build a `PageModel`.

Key behavior:

- the scanner extracts a compact summary plus individual element metadata
- sensitive field values are never read or stored
- the background worker remembers the current page model so the side panel stays in sync
- allowlisted origins are required outside localhost

Sources:

- `apps/extension/src/content/scanner.ts`
- `apps/extension/src/content/element-extract.ts`
- `apps/extension/src/background/index.ts`
- `packages/shared/src/types.ts`

## 2. Record a manual session

The Session tab starts and stops recording in the background worker. The content script emits action events, navigation events, console errors, network failures, and evidence items.

Important implementation detail:

- state updates are serialized with `runExclusive()` so concurrent browser events do not clobber storage writes
- password-like values are replaced by sensitivity metadata rather than being persisted
- custom widgets such as date pickers and lookup components are supported in the recorder

Sources:

- `apps/extension/src/content/recorder.ts`
- `apps/extension/src/background/index.ts`
- `packages/shared/src/types.ts`

## 3. Generate artifacts

The Generate tab requests one of several server routes:

- page analysis suggestions
- manual test cases
- bug reports
- Playwright drafts

The UI lets the tester preview or export the generated result as Markdown or TypeScript.

Sources:

- `apps/extension/src/sidepanel/App.tsx`
- `apps/extension/src/sidepanel/backend.ts`
- `apps/server/src/app.ts`
- `apps/server/src/prompts/index.ts`

## 4. Chat with the server

The Chat tab is a general-purpose conversation surface added later than the original QA workflows. It does not persist chat history; it simply sends the current messages to the server and renders the response.

Sources:

- `apps/extension/src/sidepanel/ChatTab.tsx`
- `apps/server/src/app.ts`
- `apps/server/src/llm/types.ts`

## Workflow change guidance

- If you alter event capture, read both the recorder and the background worker before editing UI code.
- If you alter generation output, check the preview/export helpers in the extension and the prompt builders in the server.
- If you alter allowlisting or capture permissions, re-check the runbook and the extension background logic together.
