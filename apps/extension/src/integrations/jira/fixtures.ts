/**
 * Test fixtures for the Jira export path.
 *
 * The repo has no recorded corpus of generator output, so this mirrors the
 * section list `bugReportSystem()` in `apps/server/src/prompts/index.ts` asks
 * the model to produce. Keep the two in step: if the prompt's sections change,
 * this fixture — and the ADF/mapping tests that lean on it — should change too.
 */

export const BUG_REPORT_MARKDOWN = `# Release date does not default from requested delivery date

**Severity:** critical
**Priority:** high

## Environment

| Field | Value |
| --- | --- |
| Environment | staging |
| Browser | Chrome 131 |
| URL | https://staging.example.com/orders/new |
| User Role | Order Manager |

## Preconditions

- Signed in as a user with the *Order Manager* role
- At least one product exists with \`stock > 0\`

## Steps to Reproduce

1. Open the **New Order** page
2. Set _Requested delivery date_ to 2026-08-01
3. Click \`Save\`

## Actual Result

The Release Date field stays empty and the form returns a 500. See
[the failing request](https://staging.example.com/api/orders) for the payload.

## Expected Result

Release Date should default to the requested delivery date.

## Evidence

\`\`\`json
{
  "status": 500,
  "error": "Cannot read properties of undefined (reading 'releaseDate')"
}
\`\`\`

Console error:

\`\`\`
TypeError: Cannot read properties of undefined
    at OrderForm.submit (order-form.js:214)
\`\`\`

## Suggested Root Cause

The form model initialises \`releaseDate\` before \`requestedDeliveryDate\` is bound.

---

## Assumptions

> Not directly observed — inferred from the stack trace.

- [x] The 500 and the empty field share a root cause
- [ ] Other roles are affected
`;
