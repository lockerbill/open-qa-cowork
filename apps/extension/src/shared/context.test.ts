import { describe, it, expect } from 'vitest';
import { applyResolveMatch } from './context.js';
import { EMPTY_AUTH, type AuthState, type ResolveMatch } from './messages.js';

const signedIn: AuthState = {
  ...EMPTY_AUTH,
  token: 'tok',
  currentWorkspaceId: 'ws1',
  currentWorkspaceRole: 'admin',
};

const match: ResolveMatch = {
  project: { id: 'proj1', name: 'Checkout' },
  environment: { id: 'env1', displayName: 'Staging' },
};

describe('applyResolveMatch', () => {
  it('populates project/environment and marks source auto on a match', () => {
    const next = applyResolveMatch(signedIn, match);
    expect(next.currentProjectId).toBe('proj1');
    expect(next.currentProjectName).toBe('Checkout');
    expect(next.currentEnvironmentId).toBe('env1');
    expect(next.currentEnvironmentName).toBe('Staging');
    expect(next.contextSource).toBe('auto');
  });

  it('clears auto context to null on no match', () => {
    const auto = applyResolveMatch(signedIn, match);
    const cleared = applyResolveMatch(auto, null);
    expect(cleared.currentProjectId).toBeNull();
    expect(cleared.currentEnvironmentId).toBeNull();
    expect(cleared.contextSource).toBeNull();
  });

  it('never overwrites a manual override — on a match', () => {
    const manual: AuthState = {
      ...signedIn,
      currentProjectId: 'manualProj',
      currentProjectName: 'Manual',
      currentEnvironmentId: 'manualEnv',
      currentEnvironmentName: 'Prod',
      contextSource: 'manual',
    };
    expect(applyResolveMatch(manual, match)).toBe(manual);
  });

  it('never overwrites a manual override — on no match', () => {
    const manual: AuthState = { ...signedIn, contextSource: 'manual', currentProjectId: 'm' };
    const next = applyResolveMatch(manual, null);
    expect(next).toBe(manual);
    expect(next.currentProjectId).toBe('m');
  });

  it('does not mutate the input auth object', () => {
    const before = { ...signedIn };
    applyResolveMatch(signedIn, match);
    expect(signedIn).toEqual(before);
  });
});
