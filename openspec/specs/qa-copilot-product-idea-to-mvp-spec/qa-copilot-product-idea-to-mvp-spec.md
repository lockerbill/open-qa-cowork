# QA Copilot — Product Idea to MVP Specification

**Generated:** 2026-06-27  
**Source:** Chat export about QA Copilot browser extension idea  
**Audience:** AI coding agents, founders, product builders, QA leads, engineering teams  
**Primary output:** MVP-ready product and technical specification

---

## 1. Executive Summary

QA Copilot is a browser-extension-based AI assistant for manual QA testers working on web apps and SPAs. It pairs with a human tester during exploratory testing, understands the current page, suggests what to test, records manual QA activity, captures evidence, generates bug reports, and converts real human-tested flows into Playwright regression tests.

The product should **not** initially position itself as a fully autonomous testing agent. The stronger wedge is:

> **An AI pair tester for manual QA teams that turns exploratory testing into better documentation, bug reports, and reusable automation.**

This positioning avoids the crowded “AI tests your whole app automatically” category and focuses on a practical workflow that current open-source tools do not fully cover.

---

## 2. Problem Statement

Manual QA testers spend significant time:

- Deciding what to test on complex screens.
- Repeating exploratory flows.
- Writing test cases after the fact.
- Capturing screenshots, console logs, network failures, and reproduction steps.
- Filing structured bug reports.
- Translating manual flows into automation.
- Communicating test coverage to product and engineering teams.

Existing tools cover pieces of this workflow, but there is no dominant open-source solution that combines:

1. Browser extension side panel.
2. Human manual QA session capture.
3. AI page understanding.
4. Conversational test guidance.
5. Evidence collection.
6. Bug report generation.
7. Playwright test generation.

---

## 3. Product Vision

QA Copilot helps human QA testers test better, document faster, and gradually convert manual testing into automation.

The core loop:

```text
Observe page → QA asks questions → QA tests manually → AI records → AI creates test cases/bug reports → AI generates Playwright tests → QA reviews
```

The AI should act as a **pair tester**, not an uncontrolled autonomous agent.

---

## 4. Target Users

### 4.1 Primary Users

#### Manual QA Testers

Manual QA testers performing exploratory testing, regression testing, release testing, and UAT support.

They need help with:

- Test planning.
- Session capture.
- Evidence collection.
- Bug reports.
- Converting repeatable flows into automation.

#### Small Software Teams Without Dedicated Automation Engineers

Teams that rely on manual QA but want to build automation incrementally.

#### Product Owners and Business Analysts

Users doing UAT who need prompts like:

- “What should I test on this screen?”
- “Create acceptance test scenarios.”
- “Summarize what I tested.”

#### Automation Engineers

Engineers can use the tool to:

- Discover selectors.
- Generate first-draft Playwright tests.
- Improve testability.
- Turn QA flows into regression candidates.

---

## 5. Market and Open-Source Landscape

### 5.1 Existing Categories

| Category | Existing OSS Strength | Gap for QA Copilot |
|---|---|---|
| Playwright automation | Very strong | Not human QA workflow focused |
| AI browser agents | Strong and growing | Usually autonomous task execution, not QA pairing |
| Natural-language E2E testing | Emerging | Mostly developer/test-code oriented |
| Exploratory testing extensions | Exists | Mostly non-AI, note/screenshot/report focused |
| Test recording/codegen | Mature | Not AI-assisted QA reasoning |
| Self-healing regression testing | Emerging | Usually suite-level, not manual session copilot |

### 5.2 Relevant Open-Source Projects

#### Microsoft Playwright — `microsoft/playwright`

**Overlap:** Browser automation, codegen, locator generation, trace/video/screenshot capture, CI integration.

**Missing:** QA side panel, conversational assistant, manual exploratory session intelligence, bug report workflow.

**Recommendation:** Use as the core automation engine.

#### Microsoft Playwright MCP — `microsoft/playwright-mcp`

**Overlap:** Lets LLMs inspect and control pages through Playwright using structured page snapshots.

**Missing:** QA product UX, browser extension, manual session capture, bug lifecycle.

**Recommendation:** Study for page context and AI browser-control patterns.

#### TestZeus Hercules — `test-zeus-ai/testzeus-hercules`

**Overlap:** AI test automation, Gherkin-style input, UI/API/security/accessibility/visual validation.

**Missing:** Manual QA browser-extension pairing and exploratory session capture.

#### Promptwright — `testronai/promptwright`

**Overlap:** Natural language to browser workflows and Playwright/Cypress/Selenium scripts.

**Missing:** Browser extension side panel, QA evidence workflow, human exploratory session capture.

**Recommendation:** Study prompt and script-generation approaches.

#### Shortest — `antiwork/shortest`

**Overlap:** Natural-language E2E tests built on Playwright.

**Missing:** Human manual QA workflow, evidence capture, browser extension.

#### Browser Use — `browser-use/browser-use`

**Overlap:** AI browser automation framework.

**Missing:** QA lifecycle product layer.

#### Vibetest Use — `browser-use/vibetest-use`

**Overlap:** Uses Browser Use agents to test websites for UI bugs, broken links, and accessibility issues.

**Missing:** Manual QA copilot workflow and session-to-test pipeline.

#### Skyvern — `Skyvern-AI/skyvern`

**Overlap:** LLM/computer-vision browser workflows.

**Missing:** QA-specific test case and evidence lifecycle.

#### Agent Q — `Top-Q/agent-q`

**Overlap:** AI UI testing with Playwright and dynamic code generation.

**Missing:** Browser extension and manual QA session workflow.

**Useful idea:** Cache/reuse generated successful code.

#### Passmark — `bug0inc/passmark`

**Overlap:** AI browser regression testing, natural-language steps, auto-healing, caching.

**Missing:** Manual QA extension and bug evidence workflow.

**Recommendation:** Study later for self-healing regression features.

#### Exploratory Testing Chrome Extension — `morvader/ExploratoryTestingChromeExtension`

**Overlap:** Browser extension, exploratory sessions, notes, screenshots, bug reports, URL tracking, exports.

**Missing:** AI page understanding, Playwright generation, AI-assisted test cases.

**Recommendation:** Strong reference for manual QA extension UX.

#### E2T Exploratory Testing Tool — `xblanc33/e2t`

**Overlap:** Exploratory testing campaigns and expeditions.

**Missing:** AI, automation generation, Playwright runner.

#### Azure DevOps Test & Feedback Extension

**Overlap:** Browser extension, exploratory testing, screenshots/videos, bug creation, test case creation, evidence capture.

**Missing:** AI-first workflow, Playwright generation, open product flexibility.

**Strategic lesson:** Manual QA browser extension + evidence capture is a validated workflow.

### 5.3 Competitive Gap

The strongest gap is:

> **Browser extension + AI copilot + manual QA session capture + Playwright generation + bug evidence workflow.**

No major open-source project clearly combines all of these into one QA-first product.

---

## 6. Product Positioning

### 6.1 Avoid This Positioning

Do not lead with:

> “AI automatically tests your entire web app.”

This is too broad, difficult to trust, and overlaps heavily with existing AI browser agents.

Do not lead with:

> “AI Playwright test generator.”

This overlaps with Playwright codegen and natural-language E2E frameworks.

### 6.2 Recommended Positioning

> **QA Copilot is an AI pair tester for manual QA teams. It watches exploratory testing in the browser, helps QA decide what to test, captures evidence, writes bug reports, and converts human-tested flows into Playwright regression tests.**

### 6.3 MVP Promise

The MVP should promise:

- Better manual test coverage.
- Faster test documentation.
- Faster bug reports.
- Reusable Playwright drafts from real QA flows.
- Safer human-in-the-loop automation.

The MVP should not promise:

- Full autonomous app crawling.
- Complete replacement of QA.
- Perfect generated tests.
- Self-healing test maintenance on day one.

---

## 7. Core User Journey

### 7.1 Example Scenario

A QA tester opens a staging app and clicks the QA Copilot extension.

The extension detects:

> “I see a Create Purchase Order page with 12 fields, 3 required fields, supplier autocomplete, item lines table, release schedule section, Save Draft, Submit, and Cancel actions.”

QA asks:

> “Create test cases for this page.”

QA Copilot generates test cases grouped by:

- Required field validation.
- Supplier selection.
- Line item entry.
- Release schedule.
- Save draft.
- Submit.
- Cancel.
- Error handling.
- Permissions.
- Accessibility.

QA manually performs a flow:

1. Opened Create PO page.
2. Selected supplier.
3. Added item line.
4. Added release line.
5. Clicked Submit.
6. Validation error appeared: “Release date is required.”

QA says:

> “Generate a bug report. Expected release date to default from requested delivery date.”

QA Copilot creates a Jira-ready bug report with:

- Steps to reproduce.
- Actual result.
- Expected result.
- Screenshot.
- Console logs.
- Network failures.
- Suggested Playwright reproduction.

Then QA says:

> “Create a regression test for this.”

QA Copilot generates a Playwright test draft for review.

---

## 8. MVP Scope

### 8.1 MVP 1 — Human QA Assistant + Recorder

This is the recommended first build.

#### Include

- Chrome extension side panel.
- Current page analysis.
- DOM element inventory.
- Manual QA chat.
- Generate manual test cases for current page.
- Record user actions.
- Convert recorded flow into Playwright test draft.
- Generate bug report with screenshot and steps.
- Export Markdown / JSON / Playwright TypeScript.
- Capture console errors.
- Capture failed network requests.
- Basic selector quality advisor.

#### Exclude

- Full autonomous crawling.
- Complex visual regression.
- Self-healing tests.
- Deep Jira/Azure DevOps integration.
- Multi-user team workspace.
- CI integration.
- Production-grade cloud runner.

### 8.2 MVP 2 — Controlled Page-Level Test Execution

Add after MVP 1 proves useful:

- Run generated Playwright tests locally.
- Capture pass/fail results.
- Capture screenshot/video/trace.
- Basic accessibility scan.
- Form validation auto-tests.
- Table sorting/filtering auto-tests.
- Button/link checks.
- Safe-mode approval for destructive actions.

### 8.3 MVP 3 — Team/Product Integration

Add:

- Project workspace.
- Saved test suites.
- Jira/Azure DevOps/GitHub integration.
- TestRail/Xray export.
- CI integration.
- Pull request generation for Playwright tests.
- Role-based access.
- Environment profiles.

### 8.4 MVP 4 — Smarter AI Agent

Add:

- Page exploration suggestions.
- Requirements-to-test-plan generation.
- Acceptance criteria comparison.
- Self-healing selectors.
- Visual regression.
- API contract awareness.
- Multi-page flow testing.

---

## 9. MVP Feature Requirements

### 9.1 Browser Extension Side Panel

#### Description

A Chrome extension side panel that appears beside the application under test and provides chat, page summary, session timeline, evidence, and export controls.

#### Requirements

- Open side panel from extension icon.
- Display current URL, page title, and route.
- Show detected page summary.
- Provide chat input.
- Show AI responses.
- Show current recording status.
- Let user start/stop session recording.
- Let user export outputs.

#### Acceptance Criteria

- User can open side panel on any allowed web app.
- User can ask “What should I test on this page?” and receive page-aware suggestions.
- User can start a recording session and see captured actions in the side panel.

---

### 9.2 Page Scanner

#### Description

Content script scans the current web page and creates a compact page model for AI reasoning.

#### Capture

- URL and route.
- Page title.
- Visible headings.
- Forms and fields.
- Labels and placeholders.
- Buttons and links.
- Tables and grids.
- Modals/dialogs.
- Toasts and validation messages.
- Disabled/hidden states.
- ARIA roles and accessible names.
- Selector candidates.
- Shadow DOM and iframe awareness where feasible.

#### Acceptance Criteria

- Scanner returns a compact JSON page summary.
- Scanner identifies interactable elements.
- Scanner avoids sending full raw DOM by default.
- Scanner masks sensitive input values.

---

### 9.3 SPA Route Observer

#### Description

Detect client-side route changes without full page reloads.

#### Requirements

- Observe History API changes: `pushState`, `replaceState`, `popstate`.
- Observe hash route changes.
- Rescan page after route changes.
- Add route change events to session timeline.

#### Acceptance Criteria

- Navigating inside an SPA updates page context.
- Session timeline records route transitions.

---

### 9.4 Event Recorder

#### Description

Record manual QA interactions and outcomes.

#### Capture

- Clicks.
- Text input with sensitive value masking.
- Select/dropdown changes.
- Checkbox/radio changes.
- File upload metadata only, not file contents by default.
- Navigation events.
- Form submissions.
- Visible validation messages after actions.
- Toasts and modals after actions.
- Screenshot checkpoints.

#### Acceptance Criteria

- User can record a flow and export ordered steps.
- Values from password/token/secret fields are not stored.
- The generated flow can be used as input to a Playwright test draft.

---

### 9.5 Console and Network Capture

#### Description

Collect technical evidence useful for bug reports.

#### Requirements

- Capture console errors and warnings.
- Capture failed network requests.
- Capture status code, method, URL path, timing, and error reason.
- Redact query parameters and headers by default.
- Do not capture sensitive request/response bodies by default.

#### Acceptance Criteria

- Bug report includes relevant console errors.
- Bug report includes failed network request summary.
- Sensitive data is redacted.

---

### 9.6 Screenshot Capture

#### Description

Capture screenshots as evidence.

#### Requirements

- Capture current visible tab.
- Attach screenshot to session timeline.
- Allow user-triggered screenshot.
- Allow automatic screenshot on bug report generation.
- Support basic masking rules later.

#### Acceptance Criteria

- User can generate a bug report with an attached screenshot.

---

### 9.7 Conversational QA Assistant

#### Description

AI chat interface that understands current page summary and session history.

#### Example Commands

- “What should I test on this page?”
- “Create boundary test cases for this form.”
- “Find risky areas on this screen.”
- “Generate regression tests from my last 5 minutes.”
- “Summarize what I tested.”
- “Create a bug report.”
- “Explain why this button is disabled.”
- “Run the happy path.”
- “Run invalid input tests.”
- “Check accessibility.”
- “Create Playwright tests for this flow.”

#### Acceptance Criteria

- AI uses page context and session events in responses.
- AI distinguishes facts observed from assumptions.
- AI asks for missing expected behavior when needed for bug reports.

---

### 9.8 Test Case Generator

#### Description

Generate manual test cases for the current page or recorded flow.

#### Output Formats

1. Manual test cases.
2. Gherkin.
3. JSON.
4. CSV-compatible structure.

#### Manual Test Case Fields

- ID.
- Title.
- Preconditions.
- Steps.
- Expected result.
- Test data.
- Priority.
- Risk level.
- Type: functional, negative, accessibility, UI/UX, data, permission.

#### Acceptance Criteria

- User can export page-level test cases in Markdown and JSON.
- Test cases reference detected page elements.
- Risk and priority are included.

---

### 9.9 Bug Report Generator

#### Description

Create structured bug reports from session evidence and QA comments.

#### Output Fields

- Title.
- Severity.
- Priority.
- Environment.
- Browser.
- URL.
- User role if known.
- Preconditions.
- Steps to reproduce.
- Actual result.
- Expected result.
- Screenshot references.
- Console errors.
- Network failures.
- Suggested root cause.
- Suggested Playwright reproduction.

#### Acceptance Criteria

- User can generate a Jira-ready Markdown bug report.
- Report includes steps from recorded session.
- Report includes evidence summary.
- Report clearly labels AI assumptions.

---

### 9.10 Playwright Test Generator

#### Description

Convert recorded flows or generated scenarios into Playwright TypeScript draft tests.

#### Requirements

- Prefer stable selectors.
- Use role-based locators where possible.
- Use `data-testid` / `data-test` where available.
- Avoid brittle generated class selectors.
- Include TODO comments where selectors are fragile.
- Include assertions based on observed results.
- Generate deterministic code that can be reviewed by humans.

#### Selector Priority

1. `data-testid`.
2. `data-test`.
3. ARIA role + accessible name.
4. `aria-label`.
5. Associated label.
6. Stable visible text.
7. CSS selector fallback.
8. XPath only as last resort.

#### Acceptance Criteria

- User can export a `.spec.ts` Playwright draft.
- Generated tests compile syntactically.
- Generated tests include human-readable comments for assumptions.
- Fragile selectors are flagged.

---

### 9.11 Selector Quality Advisor

#### Description

Analyze page elements and recommend testability improvements.

#### Requirements

- Detect missing accessible names.
- Detect buttons/inputs without stable selectors.
- Detect duplicate labels where automation may be ambiguous.
- Recommend `data-testid` names.
- Explain why a selector is fragile.

#### Acceptance Criteria

- User can ask “How testable is this page?”
- Tool returns actionable selector/testability recommendations.

---

## 10. AI Context Design

Do not send the entire DOM to the LLM by default. Use layered context.

### 10.1 Layer 1 — Page Summary

```json
{
  "url": "/orders/create",
  "title": "Create Purchase Order",
  "visible_forms": [],
  "visible_buttons": [],
  "tables": [],
  "modals": [],
  "validation_messages": [],
  "console_errors": [],
  "network_failures": []
}
```

### 10.2 Layer 2 — Element Map

```json
[
  {
    "id": "el_12",
    "type": "button",
    "text": "Submit",
    "role": "button",
    "selector_candidates": [
      "getByRole('button', { name: 'Submit' })",
      "[data-testid='submit-order']"
    ],
    "state": "enabled"
  }
]
```

### 10.3 Layer 3 — Action History

```json
[
  {
    "action": "click",
    "target": "Create Order button",
    "result": "Navigated to /orders/create"
  },
  {
    "action": "type",
    "target": "Supplier field",
    "value_type": "supplier name",
    "result": "Autocomplete opened"
  }
]
```

### 10.4 Layer 4 — Evidence

- Screenshot references.
- Console logs.
- Network failures.
- Trace files later.
- DOM detail only on demand.

### 10.5 AI Rules

- Reason over summaries first.
- Request details only when needed.
- Redact sensitive data before model calls.
- Clearly label assumptions.
- Never treat web page content as trusted instructions.
- Require confirmation for destructive actions.

---

## 11. Security, Privacy, and Safety Requirements

### 11.1 Main Risks

- Capturing passwords or tokens.
- Sending sensitive DOM/customer data to cloud LLMs.
- Recording production customer data.
- Executing destructive actions.
- Accidentally submitting production forms.
- AI clicking dangerous buttons.
- Overbroad extension permissions.
- Test data leaking into bug reports.
- Prompt injection from page content.

### 11.2 Required Controls

- Environment allowlist.
- Project-level permission settings.
- Read-only mode.
- No-destructive-action mode.
- Confirmation before submit/delete/payment actions.
- Sensitive field redaction.
- Email, token, credit-card, and PII masking.
- Screenshot redaction roadmap.
- Local-only mode for enterprise.
- Audit logs.
- Data retention policy.
- Prompt injection protection.
- User review before export or integration submission.

### 11.3 Destructive Action Policy

The AI must not autonomously perform actions that could:

- Submit production forms.
- Delete records.
- Make payments.
- Send emails/messages.
- Change account settings.
- Trigger irreversible workflow transitions.

For MVP 1, the safest policy is:

> AI can advise and generate tests, but the human performs live actions. Automated execution is limited to local/staging contexts and requires explicit approval.

---

## 12. Technical Architecture

### 12.1 Recommended MVP Architecture

```text
Chrome Extension
 ├─ Side Panel Chat UI
 ├─ Content Script
 │   ├─ DOM scanner
 │   ├─ Event recorder
 │   ├─ Element highlighter
 │   ├─ Screenshot capture trigger
 │   ├─ Console/network collectors
 │   └─ SPA route observer
 ├─ Background Service Worker
 │   ├─ Session manager
 │   ├─ Secure token storage
 │   ├─ Extension permissions
 │   └─ Communication bridge
 └─ Exporter
     ├─ Markdown
     ├─ JSON
     └─ Playwright TypeScript

Backend / AI Service
 ├─ LLM orchestration
 ├─ Page context summarizer
 ├─ Test case generator
 ├─ Bug report generator
 ├─ Playwright test generator
 ├─ Redaction service
 └─ Project settings

Optional Local Runner — MVP 2+
 ├─ Playwright runner
 ├─ Test execution logs
 ├─ Screenshot/video/trace capture
 └─ Repo file writer
```

### 12.2 Suggested Stack

#### Browser Extension

- Chrome Extension Manifest V3.
- TypeScript.
- React side panel.
- Content scripts.
- Background service worker.

#### Automation Runner

- Node.js.
- Playwright TypeScript.
- Optional Docker execution later.
- Trace/video/screenshot support.

#### Backend

Good options:

- .NET 10 API backend.
- PostgreSQL.
- Redis or Hangfire/Quartz.NET for jobs later.
- S3-compatible object storage for evidence later.
- LLM gateway supporting OpenAI/Anthropic/local models.

#### Recommended Split

```text
Extension: TypeScript + React
Runner: Node.js + Playwright
API backend: .NET 10
AI orchestration: .NET 10 service or Node/Python worker
Database: PostgreSQL
Queue: Hangfire or Quartz.NET
Storage: S3-compatible object storage
```

---

## 13. Data Model Draft

### 13.1 TestSession

```json
{
  "id": "session_123",
  "project_id": "project_1",
  "started_at": "2026-06-27T10:00:00Z",
  "ended_at": null,
  "environment": "staging",
  "browser": "Chrome",
  "base_url": "https://staging.example.com",
  "current_url": "https://staging.example.com/orders/create",
  "status": "recording"
}
```

### 13.2 PageSnapshot

```json
{
  "id": "page_123",
  "session_id": "session_123",
  "url": "/orders/create",
  "title": "Create Purchase Order",
  "summary": {},
  "elements": [],
  "captured_at": "2026-06-27T10:01:00Z"
}
```

### 13.3 ActionEvent

```json
{
  "id": "event_123",
  "session_id": "session_123",
  "type": "click",
  "target_element_id": "el_12",
  "target_label": "Submit",
  "selector_candidates": [],
  "timestamp": "2026-06-27T10:02:00Z",
  "result_summary": "Validation error appeared"
}
```

### 13.4 EvidenceItem

```json
{
  "id": "evidence_123",
  "session_id": "session_123",
  "type": "screenshot",
  "path": "evidence/session_123/screenshot_1.png",
  "metadata": {},
  "captured_at": "2026-06-27T10:03:00Z"
}
```

### 13.5 GeneratedArtifact

```json
{
  "id": "artifact_123",
  "session_id": "session_123",
  "type": "playwright_test",
  "format": "typescript",
  "content": "...",
  "created_at": "2026-06-27T10:05:00Z",
  "review_status": "draft"
}
```

---

## 14. API Draft

### 14.1 Analyze Page

`POST /api/page/analyze`

Request:

```json
{
  "project_id": "project_1",
  "url": "/orders/create",
  "page_summary": {},
  "element_map": []
}
```

Response:

```json
{
  "summary": "Create Purchase Order page with supplier, line items, and submit actions.",
  "risks": [],
  "suggested_tests": []
}
```

### 14.2 Generate Test Cases

`POST /api/generate/test-cases`

Request:

```json
{
  "page_snapshot_id": "page_123",
  "format": "manual_markdown",
  "focus": "functional_negative_accessibility"
}
```

Response:

```json
{
  "artifact_id": "artifact_123",
  "content": "..."
}
```

### 14.3 Generate Bug Report

`POST /api/generate/bug-report`

Request:

```json
{
  "session_id": "session_123",
  "user_note": "Expected release date to default from requested delivery date.",
  "include_screenshot": true,
  "include_console_errors": true,
  "include_network_failures": true
}
```

Response:

```json
{
  "artifact_id": "artifact_456",
  "content_markdown": "..."
}
```

### 14.4 Generate Playwright Test

`POST /api/generate/playwright`

Request:

```json
{
  "session_id": "session_123",
  "flow_event_ids": ["event_1", "event_2", "event_3"],
  "language": "typescript"
}
```

Response:

```json
{
  "artifact_id": "artifact_789",
  "filename": "create-purchase-order.spec.ts",
  "content": "...",
  "selector_warnings": []
}
```

---

## 15. Extension Permission Strategy

For MVP, use the minimum viable permissions.

### 15.1 Suggested Permissions

- `activeTab` for current page access after user gesture.
- `scripting` to inject content script where needed.
- `sidePanel` for Chrome side panel UI.
- `storage` for local settings/session cache.
- `tabs` only if strictly required for URL/title tracking.
- Host permissions should be allowlisted by project/environment.

### 15.2 Avoid Initially

- Broad `<all_urls>` by default.
- Capturing request/response bodies.
- Reading cookies unless absolutely necessary.
- Persistent recording without clear user indicator.

---

## 16. MVP Milestones

### Milestone 1 — Extension Shell

- Manifest V3 extension.
- React side panel.
- Content script handshake.
- Current URL/title display.
- Basic settings page.

### Milestone 2 — Page Model

- DOM scanner.
- Element map.
- Selector candidate generation.
- SPA route observer.
- Sensitive field masking.

### Milestone 3 — QA Chat

- Chat UI.
- Backend/LLM call.
- Page-aware test suggestions.
- Markdown response rendering.

### Milestone 4 — Session Recorder

- Start/stop recording.
- Capture clicks/input/selects/navigation.
- Session timeline UI.
- Export session JSON.

### Milestone 5 — Test Case and Bug Report Generation

- Generate manual test cases.
- Generate bug report.
- Include screenshot, console errors, and network failures.
- Export Markdown.

### Milestone 6 — Playwright Draft Generation

- Convert recorded flow to `.spec.ts`.
- Selector warnings.
- Export TypeScript file.

### Milestone 7 — Internal Dogfood

- Test on 3–5 real SPAs.
- Measure quality of page summaries.
- Measure generated test usefulness.
- Collect QA feedback.

---

## 17. Success Metrics

### 17.1 User Value Metrics

- Time to create test cases reduced by 50%+.
- Time to write bug reports reduced by 50%+.
- Number of useful regression candidates generated per session.
- QA satisfaction score.
- Percentage of generated Playwright drafts accepted after review.

### 17.2 Product Quality Metrics

- Page scanner detects >90% of visible interactable elements on test apps.
- Sensitive values redacted in 100% of known sensitive field cases.
- Generated bug reports include correct reproduction steps in >80% of sessions.
- Generated Playwright tests compile in >90% of cases.
- Selector warnings correctly identify fragile selectors.

### 17.3 Safety Metrics

- Zero unapproved destructive actions.
- Zero known password/token captures.
- Redaction test suite pass rate 100%.

---

## 18. Non-Goals for MVP 1

- Fully autonomous testing across an entire app.
- Full test management platform.
- Full Jira/Azure DevOps bidirectional sync.
- Production-grade self-hosting.
- Visual regression engine.
- Self-healing regression suite.
- Complete accessibility audit engine.
- Mobile app testing.
- Native desktop app testing.

---

## 19. Recommended Build Strategy

### 19.1 Do Not Fork One Project Into Everything

Use existing open-source projects as references and building blocks, but do not start by forking a large autonomous agent framework.

### 19.2 Use Playwright Directly

Playwright should be the automation and generated-test target.

### 19.3 Study Existing Projects

- Study `morvader/ExploratoryTestingChromeExtension` for QA session UX.
- Study `microsoft/playwright` for automation and locator strategy.
- Study `microsoft/playwright-mcp` for structured page snapshots for AI.
- Study `testronai/promptwright` for prompt-to-script patterns.
- Study `bug0inc/passmark` later for self-healing ideas.

### 19.4 Keep the Wedge Narrow

Build the workflow around:

```text
Manual QA session → AI guidance → evidence → bug report → Playwright draft
```

This is more defensible than a generic AI browser agent.

---

## 20. First AI-Agent Build Prompt

Use this prompt with an AI coding agent to start implementation:

```text
Build an MVP Chrome Extension called QA Copilot.

Goal:
Create a Manifest V3 Chrome extension with a side panel that helps manual QA testers analyze the current web page, record exploratory testing actions, generate manual test cases, generate bug reports, and export Playwright TypeScript draft tests.

Tech stack:
- TypeScript
- React for side panel
- Chrome Extension Manifest V3
- Content script for DOM scanning and event recording
- Background service worker for session state and message routing
- Node/TypeScript backend stub for AI endpoints, or mock AI responses for first local version

MVP features:
1. Side panel opens from extension icon.
2. Content script scans current page and returns compact page summary:
   - url, title, headings, forms, inputs, buttons, links, tables, dialogs, validation messages
   - interactable element map with selector candidates
3. SPA route observer detects pushState, replaceState, popstate, and hashchange.
4. Recorder captures clicks, text input with sensitive masking, selects, checkbox/radio changes, and navigation.
5. Session timeline displays recorded actions.
6. Generate test cases from current page summary. Use a deterministic mock generator first if no LLM key is configured.
7. Generate bug report from session timeline, screenshot placeholder, console errors, network failures, and user note.
8. Generate Playwright TypeScript draft from recorded actions.
9. Export artifacts as Markdown, JSON, and .spec.ts files.
10. Implement security defaults:
   - mask password/token/secret fields
   - do not capture request/response bodies
   - require user start/stop recording
   - label generated output as draft

Acceptance criteria:
- Extension loads in Chrome unpacked mode.
- Side panel shows current page summary.
- User can start recording, click/type on page, stop recording, and see timeline.
- User can export session JSON.
- User can generate a Markdown test case document.
- User can generate a Markdown bug report.
- User can generate a Playwright .spec.ts draft.
- Generated selectors prefer data-testid, data-test, role/name, aria-label, label, text, then CSS fallback.
- No sensitive input values from password fields are saved.
```

---

## 21. Human-Readable Summary

QA Copilot should start as a practical assistant for manual testers, not a magic autonomous QA replacement.

The first version should help a tester:

1. Open a web page.
2. Ask what should be tested.
3. Record their exploratory session.
4. Capture evidence.
5. Generate test cases.
6. Generate a bug report.
7. Convert useful flows into Playwright drafts.

The strongest product wedge is the combination of **manual QA workflow capture** plus **AI-generated test/evidence artifacts** inside the browser.

