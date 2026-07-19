import { randomBytes } from 'node:crypto';

/** Generate a prefixed, URL-safe id, e.g. genId('ws') → 'ws_9f3a...'. */
export function genId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
