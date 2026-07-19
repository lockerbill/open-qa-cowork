import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

/**
 * Stage 0 smoke test: proves the drizzle + pglite plumbing works end-to-end so
 * later stages can run their integration suites against an in-memory Postgres.
 */
describe('db plumbing (pglite)', () => {
  it('connects and round-trips a row', async () => {
    const client = new PGlite();
    const db = drizzle(client);
    await db.execute(sql`create table smoke (id int primary key, name text)`);
    await db.execute(sql`insert into smoke (id, name) values (1, 'alpha')`);
    const result = await db.execute<{ name: string }>(sql`select name from smoke where id = 1`);
    expect(result.rows[0]?.name).toBe('alpha');
    await client.close();
  });
});
