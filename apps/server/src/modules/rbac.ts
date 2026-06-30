/** Workspace roles, highest privilege first. */
export const WORKSPACE_ROLES = ['owner', 'admin', 'qa_lead', 'tester', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles permitted to manage LLM provider configs + secrets (spec §8.3). */
export const PROVIDER_ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];

/** Roles permitted to run AI tasks — everyone except viewer (spec §8.3). */
export const AI_TASK_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'qa_lead', 'tester'];

/**
 * Roles permitted to create/update projects + environments (spec §8.3). Testers
 * run AI tasks but do not define project structure; flip this if product wants
 * testers to manage projects.
 */
export const PROJECT_ADMIN_ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'qa_lead'];
