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

export const migrationsFolder = path.join(__dirname, "migrations");

/**
 * Kysely's built-in FileMigrationProvider imports files by their raw path,
 * which breaks on Windows ("C:\..." isn't a valid import URL). This version
 * converts each path to a file:// URL first, so it works on every OS.
 */
export class CrossPlatformMigrationProvider implements MigrationProvider {
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

/**
 * The project's migrator for any database handle. Exported so tests can
 * run the real migrations against a throwaway Postgres.
 */
export function createMigrator(db: Kysely<unknown>): Migrator {
  return new Migrator({
    db,
    provider: new CrossPlatformMigrationProvider(migrationsFolder),
  });
}

async function main() {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });
  const migrator = createMigrator(db);

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

// Only run when executed as a script (`npm run migrate`), not when imported.
// Windows paths are case-insensitive ("c:\" vs "C:\"), so compare loosely there.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isEntryPoint()) {
  main();
}
