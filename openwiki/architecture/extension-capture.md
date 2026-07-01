# Extension capture architecture

The extension is a Manifest V3 Chrome extension built with Vite, React, and `@crxjs/vite-plugin`. Its job is to collect page/session context safely, keep local state synchronized, and expose tester-facing actions through the side panel.

## Major parts

- `apps/extension/manifest.config.ts` defines the MV3 manifest, service worker, side panel, options page, content script, localhost host permissions, optional host permissions, and web-accessible `injected.js`.
- `apps/extension/src/sidepanel/App.tsx` renders the Page, Session, Generate, and Chat tabs.
- `apps/extension/src/background/index.ts` owns state, tab refresh behavior, screenshot capture, allowlisting, and message routing.
- `apps/extension/src/content/scanner.ts` turns the live page into a `PageModel`.
- `apps/extension/src/content/recorder.ts` turns user actions into ordered `ActionEvent` records.
- `apps/extension/public/injected.js` is the main-world script used for signals that isolated content scripts cannot observe reliably, such as page history, fetch/XHR, and console patching.

## Permissions and allowlisting

The manifest intentionally avoids broad static `<all_urls>` access. Localhost and `127.0.0.1` are statically available for development and E2E. Other HTTP/HTTPS origins are added by the user through the options page or the side-panel allowlist banner, using optional host permissions and runtime content-script registration.

This design is documented in `manifest.config.ts`, `README.md`, and `docs/runbook.md` and is part of the product's security posture.

## State and synchronization

State is local to the extension:

- settings, page model, and session are persisted in `chrome.storage.local` (`apps/extension/src/shared/storage.ts`)
- message types are centralized in `apps/extension/src/shared/messages.ts`
- the background worker broadcasts `qa-copilot:state-changed` when page/session state changes
- the side panel refreshes its state after broadcasts

The background worker uses `runExclusive()` and `updateSession()` to serialize read-modify-write operations against `chrome.storage.local`. Do not bypass these helpers for session mutations; recent history explicitly fixed lost-update and stale-tab behavior around this area.

## Capture boundaries

The scanner and recorder deliberately avoid raw DOM dumps and sensitive values:

- `scanner.ts` collects summaries, forms, interactables, tables, dialogs, validation messages, and selector candidates
- `recorder.ts` records clicks, inputs, selections, checkboxes/radios, navigation, submits, contenteditable blur events, and selected custom-widget interactions
- `element-extract.ts` is where live DOM details are normalized into shared selector/redaction-friendly inputs
- sensitive inputs record metadata such as `valueType: 'sensitive'`, not the raw value

## Change watchouts

- If a signal depends on the page's own JavaScript environment, inspect `public/injected.js`; the isolated content script may not see it.
- If changing recording behavior, update `recorder.test.ts`, `element-extract.test.ts`, and likely shared Playwright/selector tests.
- If changing allowlist or content-script injection, inspect `manifest.config.ts`, `background/index.ts`, and `vite.config.ts` together.
- If changing screenshots, note the current `captureVisibleTab` caveat in `background/index.ts` and `docs/runbook.md`.
