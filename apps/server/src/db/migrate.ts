import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';
import { loadConfig } from '../config.js';

/** Apply all pending SQL migrations in ./drizzle to the configured Postgres DB. */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — cannot run migrations');
  }
  const { db, pool } = createDb(config.databaseUrl);
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
