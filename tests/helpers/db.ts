import { randomUUID } from "crypto";
import { inject } from "vitest";
import pg from "pg";
import { TEMPLATE_DB, uriForDatabase } from "./global-setup.js";

export interface TestDatabase {
  connectionUri: string;
  stop: () => Promise<void>;
}

/**
 * A database of this file's own, cloned from the already-migrated
 * template that global-setup.ts prepared. Schema is identical to
 * production's because it came from the real migrations; the clone just
 * avoids replaying them twelve times.
 *
 * Also points DATABASE_URL at it. src/lib/db.ts reads that when first
 * imported, so test files must import app modules dynamically (after this
 * resolves). Redis and JWT settings get dummy defaults because env.ts
 * requires them; services never connect to Redis.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const adminUri = inject("postgresUri");
  const name = `test_${randomUUID().replace(/-/g, "")}`;

  const admin = new pg.Client({ connectionString: adminUri });
  await admin.connect();
  try {
    // Several files clone at once; Postgres serialises them, but a clone
    // that arrives mid-copy is told the template is busy rather than
    // queued, so give it a moment and ask again.
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
        break;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } finally {
    await admin.end();
  }

  const connectionUri = uriForDatabase(adminUri, name);
  process.env.DATABASE_URL = connectionUri;
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
  process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";

  return {
    connectionUri,
    // The container is torn down once for the whole run, so a file only
    // has to let go of its own pool, which its afterAll already does.
    stop: async () => {},
  };
}
