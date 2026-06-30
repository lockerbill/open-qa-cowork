import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * The application database handle. Production/dev use node-postgres; tests use a
 * pglite-backed instance (see db/testing.ts) cast to this type — both expose the
 * same drizzle query API, so services depend only on `Database`.
 */
export type Database = NodePgDatabase<typeof schema>;

/** Open a Postgres pool + drizzle instance from a connection string. */
export function createDb(connectionString: string): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
