import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { createMigrator } from "../../src/db/migrate.js";

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  connectionUri: string;
  stop: () => Promise<void>;
}

/**
 * Start a throwaway Postgres 16 and run the project's real migrations on
 * it, so tests exercise the exact constraints production has.
 *
 * Also points DATABASE_URL at it. src/lib/db.ts reads that when first
 * imported, so test files must import app modules dynamically (after this
 * resolves). Vitest isolates modules per file, so each file gets its own
 * pool. Redis and JWT settings get dummy defaults because env.ts requires
 * them; services never connect to Redis.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionUri = container.getConnectionUri();

  const migrationDb = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: connectionUri }) }),
  });
  try {
    const { error, results } = await createMigrator(migrationDb).migrateToLatest();
    if (error) throw error;
    const failed = results?.find((r) => r.status !== "Success");
    if (failed) throw new Error(`Migration ${failed.migrationName} failed`);
  } finally {
    await migrationDb.destroy();
  }

  process.env.DATABASE_URL = connectionUri;
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
  process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";

  return { container, connectionUri, stop: () => container.stop().then(() => undefined) };
}
