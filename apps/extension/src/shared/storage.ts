import type { JiraConfig, PageModel, TestSession, TrackerLink } from '@qa-copilot/shared';
import { DEFAULT_SETTINGS, EMPTY_AUTH, type AuthState, type Settings } from './messages.js';

const SETTINGS_KEY = 'settings';
const SESSION_KEY = 'session';
const PAGE_MODEL_KEY = 'pageModel';
const AUTH_KEY = 'auth';
const JIRA_CONFIG_KEY = 'jiraConfig';
const JIRA_LINKS_KEY = 'jiraLinks';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function newSession(): TestSession {
  return {
    id: `session_${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'idle',
    events: [],
    evidence: [],
    consoleErrors: [],
    networkFailures: [],
  };
}

export async function getSession(): Promise<TestSession> {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return (stored[SESSION_KEY] as TestSession | undefined) ?? newSession();
}

export async function saveSession(session: TestSession): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function getAuth(): Promise<AuthState> {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return { ...EMPTY_AUTH, ...(stored[AUTH_KEY] as Partial<AuthState> | undefined) };
}

export async function saveAuth(auth: AuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.set({ [AUTH_KEY]: EMPTY_AUTH });
}

/** Read-modify-write the stored auth. Callers serialize via the background mutex. */
export async function updateAuth(mutate: (auth: AuthState) => void): Promise<AuthState> {
  const auth = await getAuth();
  mutate(auth);
  await saveAuth(auth);
  return auth;
}

export async function getPageModel(): Promise<PageModel | null> {
  const stored = await chrome.storage.local.get(PAGE_MODEL_KEY);
  return (stored[PAGE_MODEL_KEY] as PageModel | undefined) ?? null;
}

export async function savePageModel(model: PageModel | null): Promise<void> {
  await chrome.storage.local.set({ [PAGE_MODEL_KEY]: model });
}

/**
 * Jira connection settings. Deliberately `storage.local` and never
 * `storage.sync`: sync would replicate the API token to the user's other
 * machines (design.md Decision 2).
 */
export async function getJiraConfig(): Promise<JiraConfig | null> {
  const stored = await chrome.storage.local.get(JIRA_CONFIG_KEY);
  return (stored[JIRA_CONFIG_KEY] as JiraConfig | undefined) ?? null;
}

export async function saveJiraConfig(config: JiraConfig | null): Promise<void> {
  await chrome.storage.local.set({ [JIRA_CONFIG_KEY]: config });
}

/**
 * Tracker links keyed by the generating artifact's id. Generated artifacts are
 * not persisted, so this map is what makes "Open PROJ-123" survive a service
 * worker restart (design.md Flow step 4).
 */
export async function getTrackerLinks(): Promise<Record<string, TrackerLink>> {
  const stored = await chrome.storage.local.get(JIRA_LINKS_KEY);
  return (stored[JIRA_LINKS_KEY] as Record<string, TrackerLink> | undefined) ?? {};
}

export async function saveTrackerLink(artifactId: string, link: TrackerLink): Promise<void> {
  const links = await getTrackerLinks();
  links[artifactId] = link;
  await chrome.storage.local.set({ [JIRA_LINKS_KEY]: links });
}
