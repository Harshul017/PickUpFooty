import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { GlobalSetupContext } from "vitest/node";
import { createMigrator } from "../../src/db/migrate.js";

/**
 * One Postgres for the whole test run.
 *
 * A container per test file stopped scaling once there were a dozen of
 * them: Docker couldn't start them all inside the hook timeout, and every
 * file paid for its own migrations. Instead this starts a single
 * container, migrates one database, and leaves it as a template. Each
 * file then clones that template, which Postgres does by copying files on
 * disk — far faster than replaying migrations, and still a completely
 * separate database per file.
 */
export const TEMPLATE_DB = "pickupfooty_template";

declare module "vitest" {
  export interface ProvidedContext {
    postgresUri: string;
  }
}

/** The same server, pointed at a different database. */
export function uriForDatabase(baseUri: string, databaseName: string): string {
  const url = new URL(baseUri);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function run(uri: string, statement: string) {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const adminUri = container.getConnectionUri();

  await run(adminUri, `CREATE DATABASE ${TEMPLATE_DB}`);

  const templateDb = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: uriForDatabase(adminUri, TEMPLATE_DB) }),
    }),
  });
  try {
    const { error, results } = await createMigrator(templateDb).migrateToLatest();
    if (error) throw error;
    const failed = results?.find((r) => r.status !== "Success");
    if (failed) throw new Error(`Migration ${failed.migrationName} failed`);
  } finally {
    // Nothing may be connected to a template while it is being copied.
    await templateDb.destroy();
  }

  provide("postgresUri", adminUri);

  return async () => {
    await container.stop();
  };
}
