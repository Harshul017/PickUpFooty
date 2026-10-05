import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pg from "pg";
import {
  Kysely,
  Migrator,
  PostgresDialect,
  type Migration,
  type MigrationProvider,
} from "kysely";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Kysely's built-in FileMigrationProvider imports files by their raw path,
 * which breaks on Windows ("C:\..." isn't a valid import URL). This version
 * converts each path to a file:// URL first, so it works on every OS.
 */
class CrossPlatformMigrationProvider implements MigrationProvider {
  constructor(private readonly folder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await fs.readdir(this.folder))
      .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))
      .sort();

    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const url = pathToFileURL(path.join(this.folder, file)).href;
      migrations[file.replace(/\.(ts|js)$/, "")] = (await import(url)) as Migration;
    }
    return migrations;
  }
}

const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});

const migrator = new Migrator({
  db,
  provider: new CrossPlatformMigrationProvider(path.join(__dirname, "migrations")),
});

async function main() {
  const direction = process.argv[2] === "down" ? "down" : "up";
  const { error, results } =
    direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();

  for (const r of results ?? []) {
    console.log(`${r.status}: ${r.migrationName}`);
  }
  await db.destroy();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}

main();
