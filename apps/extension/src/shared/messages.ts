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

// --- Messages from the side panel / options to the background --------------

export type PanelToBackground =
  | { type: 'GET_STATE' }
  | { type: 'SCAN_ACTIVE_TAB' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'CLEAR_SESSION' }
  | { type: 'CAPTURE_SCREENSHOT' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Settings }
  | { type: 'ADD_ALLOWLIST_ORIGIN'; origin: string };

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
}

/** Broadcast event name the background emits when state changes. */
export const STATE_CHANGED = 'qa-copilot:state-changed' as const;
