import type { PanelState, PanelToBackground, Settings } from '../shared/messages.js';

/** Typed wrapper around chrome.runtime.sendMessage for panel -> background. */
export function sendToBackground<T = unknown>(message: PanelToBackground): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export const getState = () => sendToBackground<PanelState>({ type: 'GET_STATE' });
export const getSettings = () => sendToBackground<Settings>({ type: 'GET_SETTINGS' });
export const saveSettings = (settings: Settings) =>
  sendToBackground({ type: 'SAVE_SETTINGS', settings });
export const scanActiveTab = () => sendToBackground({ type: 'SCAN_ACTIVE_TAB' });
export const startRecording = () => sendToBackground({ type: 'START_RECORDING' });
export const stopRecording = () => sendToBackground({ type: 'STOP_RECORDING' });
export const clearSession = () => sendToBackground({ type: 'CLEAR_SESSION' });
export const captureScreenshot = () =>
  sendToBackground<{ ok: boolean; error?: string }>({ type: 'CAPTURE_SCREENSHOT' });
export const openExtensionSettings = () =>
  sendToBackground({ type: 'OPEN_EXTENSION_SETTINGS' });
export const addAllowlistOrigin = (origin: string) =>
  sendToBackground<{ ok: boolean }>({ type: 'ADD_ALLOWLIST_ORIGIN', origin });
export const resolveActiveTab = () =>
  sendToBackground<{ ok: boolean }>({ type: 'RESOLVE_ACTIVE_TAB' });
export const setContext = (c: {
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
}) => sendToBackground<{ ok: boolean }>({ type: 'SET_CONTEXT', ...c });
export const clearContextOverride = () =>
  sendToBackground<{ ok: boolean }>({ type: 'CLEAR_CONTEXT_OVERRIDE' });
