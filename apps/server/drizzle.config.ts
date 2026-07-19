import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — used by `pnpm db:generate` to emit SQL migrations from
 * `src/db/schema.ts` into `./drizzle`. The same migrations are applied to
 * Postgres in production (`db:migrate`) and to pglite in tests.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
