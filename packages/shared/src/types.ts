/**
 * Core domain types for QA Copilot, derived from spec §10 (AI context layers)
 * and §13 (data model). Shared by the extension and the server.
 */

// --- Layered page context (spec §10) ---------------------------------------

export type ElementType =
  | 'button'
  | 'link'
  | 'input'
  | 'select'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'form'
  | 'table'
  | 'dialog'
  | 'heading'
  | 'other';

export type ElementState = 'enabled' | 'disabled' | 'hidden' | 'readonly';

/** Layer 2 — a single interactable element. */
export interface ElementInfo {
  /** Synthetic stable id within a snapshot, e.g. "el_12". */
  id: string;
  type: ElementType;
  /** Visible text / accessible name. */
  text?: string;
  role?: string;
  name?: string;
  /** Playwright-style locator fragments, highest priority first (spec §9.10). */
  selectorCandidates: string[];
  state: ElementState;
  /** True when the field holds sensitive data (never captured). */
  sensitive?: boolean;
}

export interface FormFieldInfo {
  /** References an ElementInfo id. */
  id: string;
  label?: string;
  /** HTML input type (text, email, password, ...). */
  inputType: string;
  required: boolean;
  placeholder?: string;
  sensitive?: boolean;
}

export interface FormInfo {
  id: string;
  name?: string;
  fields: FormFieldInfo[];
  submitLabels: string[];
}

export interface TableInfo {
  id: string;
  caption?: string;
  columnHeaders: string[];
  rowCount: number;
}

export interface ConsoleEntry {
  level: 'error' | 'warning';
  message: string;
  timestamp: string;
}

export interface NetworkFailure {
  method: string;
  /** Path only — query string is stripped/redacted (spec §9.5). */
  urlPath: string;
  status: number;
  reason?: string;
  durationMs?: number;
  timestamp: string;
}

/** Layer 1 — compact page summary (spec §10.1). */
export interface PageSummary {
  url: string;
  route: string;
  title: string;
  headings: string[];
  forms: FormInfo[];
  buttons: string[];
  links: string[];
  tables: TableInfo[];
  modals: string[];
  validationMessages: string[];
  consoleErrors: ConsoleEntry[];
  networkFailures: NetworkFailure[];
}

export interface PageModel {
  summary: PageSummary;
  elements: ElementInfo[];
  /** ISO 8601. */
  capturedAt: string;
}

// --- Session / recording (spec §13) ----------------------------------------

export type ActionType =
  | 'click'
  | 'input'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'navigation'
  | 'submit'
  | 'screenshot';

/** Layer 3 — a recorded manual action (spec §13.3). */
export interface ActionEvent {
  id: string;
  sessionId: string;
  type: ActionType;
  targetElementId?: string;
  targetLabel?: string;
  /** Describes the value semantically (e.g. "supplier name") — never raw secrets. */
  valueType?: string;
  /** Literal value, present only for non-sensitive inputs. */
  value?: string;
  selectorCandidates?: string[];
  timestamp: string;
  /** Observed outcome, e.g. "Validation error appeared". */
  resultSummary?: string;
}

export type EvidenceType = 'screenshot' | 'console' | 'network';

/** spec §13.4 */
export interface EvidenceItem {
  id: string;
  sessionId: string;
  type: EvidenceType;
  /** Relative path or filename for an exported artifact. */
  path?: string;
  /** Inline screenshot data URL (MVP 1 keeps evidence in-extension). */
  dataUrl?: string;
  metadata?: Record<string, unknown>;
  capturedAt: string;
}

export type SessionStatus = 'idle' | 'recording' | 'stopped';

/** spec §13.1 */
export interface TestSession {
  id: string;
  projectId?: string;
  startedAt: string;
  endedAt?: string | null;
  environment?: string;
  browser?: string;
  baseUrl?: string;
  currentUrl?: string;
  status: SessionStatus;
  events: ActionEvent[];
  evidence: EvidenceItem[];
  consoleErrors: ConsoleEntry[];
  networkFailures: NetworkFailure[];
}

// --- Generated artifacts (spec §13.5, §9.8, §9.9) --------------------------

export type ArtifactType = 'test_cases' | 'bug_report' | 'playwright_test' | 'page_analysis';
export type ArtifactFormat = 'markdown' | 'json' | 'typescript';
export type ReviewStatus = 'draft' | 'reviewed';

export interface GeneratedArtifact {
  id: string;
  sessionId?: string;
  type: ArtifactType;
  format: ArtifactFormat;
  content: string;
  createdAt: string;
  reviewStatus: ReviewStatus;
}

export type TestCaseType =
  | 'functional'
  | 'negative'
  | 'accessibility'
  | 'ui_ux'
  | 'data'
  | 'permission';

export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type RiskLevel = 'low' | 'medium' | 'high';

/** spec §9.8 manual test case fields. */
export interface TestCase {
  id: string;
  title: string;
  preconditions: string[];
  steps: string[];
  expectedResult: string;
  testData?: string;
  priority: Priority;
  riskLevel: RiskLevel;
  type: TestCaseType;
}

/** spec §9.9 bug report fields. */
export interface BugReport {
  title: string;
  severity: string;
  priority: string;
  environment?: string;
  browser?: string;
  url?: string;
  userRole?: string;
  preconditions: string[];
  stepsToReproduce: string[];
  actualResult: string;
  expectedResult: string;
  screenshotRefs: string[];
  consoleErrors: string[];
  networkFailures: string[];
  suggestedRootCause?: string;
  suggestedPlaywright?: string;
  /** AI assumptions, clearly separated from observed facts (spec §9.9). */
  assumptions: string[];
}
