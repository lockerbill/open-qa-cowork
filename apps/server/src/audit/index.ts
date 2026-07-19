import { auditLogs } from '../db/schema.js';
import { genId } from '../db/id.js';
import type { Database } from '../db/client.js';

export interface AuditEvent {
  workspaceId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append an audit event. Never include secret values in `metadata` — this row
 * is queryable by workspace admins.
 */
export async function writeAudit(db: Database, event: AuditEvent): Promise<void> {
  await db.insert(auditLogs).values({
    id: genId('audit'),
    workspaceId: event.workspaceId ?? null,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    metadata: event.metadata ?? null,
  });
}
