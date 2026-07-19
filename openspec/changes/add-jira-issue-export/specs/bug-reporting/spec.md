# bug-reporting Specification (delta)

## ADDED Requirements

### Requirement: Tracker link for a generated bug report

The system SHALL record the external tracker link for a generated bug report keyed by the report's `artifactId`, and SHALL persist that record in extension local storage separately from the report content, so the link outlives the in-memory artifact.

Note: generated artifacts are not themselves persisted today — the side panel holds them in component state for the lifetime of the panel. This requirement deliberately scopes persistence to the link record alone, which is sufficient because `artifactId` uniquely identifies the report the link belongs to.

#### Scenario: Link resolved for a linked report
- GIVEN a bug report with `artifactId` A was exported and linked to PROJ-123
- WHEN the side panel renders the artifact for `artifactId` A
- THEN the system resolves `TrackerLink { type: "jira", issueKey, url, createdAt }` from storage
- AND renders the link state instead of the create action

#### Scenario: Link survives a service worker restart
- GIVEN a bug report was linked to PROJ-123
- WHEN the extension service worker restarts while the side panel remains open
- THEN the resolved link state is unchanged

#### Scenario: Regenerated report is not treated as linked
- GIVEN a bug report linked to PROJ-123
- WHEN the user generates a new bug report and receives a different `artifactId`
- THEN the new report renders the create action rather than a link
- AND the existing link record for the previous `artifactId` is left intact
