import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { env } from "./env.js";
import type { DB } from "../db/types.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb() {
  await db.destroy();
}
