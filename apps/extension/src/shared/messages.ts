import type {
  ActionEvent,
  ConsoleEntry,
  NetworkFailure,
  PageModel,
  TestSession,
} from '@qa-copilot/shared';

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  backendUrl: string;
  /** Environment label attached to sessions/bug reports. */
  environment: string;
  /** Origins the user has explicitly allowlisted (spec §15). */
  allowlist: string[];
  /** Safety: advise/confirm before destructive actions (spec §11.3). */
  noDestructiveMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:8787',
  environment: 'staging',
  allowlist: [],
  noDestructiveMode: true,
};

/** Workspace roles allowed to manage providers/projects (owner/admin). */
export const MANAGE_ROLES: readonly string[] = ['owner', 'admin'];

/** How the current project/environment context was selected. */
export type ContextSource = 'auto' | 'manual' | null;

/**
 * Signed-in session for the multi-user platform. The JWT is stored in
 * chrome.storage.local; the extension never holds an LLM API key. The
 * project/environment fields are the working context for gateway AI tasks —
 * `auto` is filled by URL resolution, `manual` by an explicit user override.
 */
export interface AuthState {
  token: string | null;
  userEmail: string | null;
  currentWorkspaceId: string | null;
  currentWorkspaceName: string | null;
  currentWorkspaceRole: string | null;
  currentProjectId: string | null;
  currentProjectName: string | null;
  currentEnvironmentId: string | null;
  currentEnvironmentName: string | null;
  contextSource: ContextSource;
}

export const EMPTY_AUTH: AuthState = {
  token: null,
  userEmail: null,
  currentWorkspaceId: null,
  currentWorkspaceName: null,
  currentWorkspaceRole: null,
  currentProjectId: null,
  currentProjectName: null,
  currentEnvironmentId: null,
  currentEnvironmentName: null,
  contextSource: null,
};

/** Project/environment matched to a tab URL by the backend `resolve` endpoint. */
export interface ResolveMatch {
  project: { id: string; name: string };
  environment: { id: string; displayName: string };
}

/** Auth context the side panel renders — the token is never projected. */
export interface AuthProjection {
  signedIn: boolean;
  role: string | null;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  contextSource: ContextSource;
}

// --- Messages from the side panel / options to the background --------------

export type PanelToBackground =
  | { type: 'GET_STATE' }
  | { type: 'SCAN_ACTIVE_TAB' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'CLEAR_SESSION' }
  | { type: 'CAPTURE_SCREENSHOT' }
  | { type: 'OPEN_EXTENSION_SETTINGS' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Settings }
  | { type: 'ADD_ALLOWLIST_ORIGIN'; origin: string }
  | { type: 'RESOLVE_ACTIVE_TAB' }
  | {
      type: 'SET_CONTEXT';
      projectId: string | null;
      projectName: string | null;
      environmentId: string | null;
      environmentName: string | null;
    }
  | { type: 'CLEAR_CONTEXT_OVERRIDE' };

// --- Messages from the content script to the background --------------------

export type ContentToBackground =
  | { type: 'PAGE_MODEL'; model: PageModel }
  | { type: 'ACTION_EVENT'; event: ActionEvent }
  | { type: 'ROUTE_CHANGE'; url: string; title: string }
  | { type: 'CONSOLE_ERROR'; entry: ConsoleEntry }
  | { type: 'NETWORK_FAILURE'; failure: NetworkFailure };

// --- Messages from the background to the content script --------------------

export type BackgroundToContent =
  | { type: 'SCAN_PAGE' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' };

/** Snapshot the side panel renders. */
export interface PanelState {
  pageModel: PageModel | null;
  session: TestSession;
  recording: boolean;
  activeOrigin: string | null;
  allowed: boolean;
  auth: AuthProjection;
}

/** Broadcast event name the background emits when state changes. */
export const STATE_CHANGED = 'qa-copilot:state-changed' as const;
