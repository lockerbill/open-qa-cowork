import type { AuthState, ResolveMatch } from './messages.js';

/**
 * Apply a URL→environment resolve result to the auth context, returning a new
 * AuthState. Pure (no chrome APIs) so the merge rules are unit-testable.
 *
 * Rules:
 * - A `manual` override is never overwritten by auto-detection — returned as-is.
 * - A non-null match populates project/environment and marks the source `auto`.
 * - A null match clears any auto context back to null (workspace-default
 *   provider resolution still applies when no project is sent).
 */
export function applyResolveMatch(auth: AuthState, match: ResolveMatch | null): AuthState {
  if (auth.contextSource === 'manual') return auth;
  if (match) {
    return {
      ...auth,
      currentProjectId: match.project.id,
      currentProjectName: match.project.name,
      currentEnvironmentId: match.environment.id,
      currentEnvironmentName: match.environment.displayName,
      contextSource: 'auto',
    };
  }
  return {
    ...auth,
    currentProjectId: null,
    currentProjectName: null,
    currentEnvironmentId: null,
    currentEnvironmentName: null,
    contextSource: null,
  };
}
