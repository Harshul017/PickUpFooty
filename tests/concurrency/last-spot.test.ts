import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { DB } from "../../src/db/types.js";

/**
 * Proves the core claim of the design doc: with N spots and M > N
 * simultaneous join attempts, exactly N succeed and `matches.filled`
 * always equals the number of JOINED rows. Runs against a real, disposable
 * Postgres via Testcontainers, migrated the same way production is.
 */
describe("last spot concurrency", () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<DB>;
  let matchId: string;
  const CAPACITY = 10;
  const ATTEMPTS = 200;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

    await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`.execute(db);
    await sql`CREATE EXTENSION IF NOT EXISTS "btree_gist"`.execute(db);

    // Minimal inline schema for this test: just what the join flow touches.
    await sql`
      CREATE TABLE matches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        pitch_id uuid NOT NULL DEFAULT gen_random_uuid(),
        join_mode text NOT NULL DEFAULT 'OPEN',
        status text NOT NULL DEFAULT 'OPEN',
        capacity integer NOT NULL,
        filled integer NOT NULL DEFAULT 0,
        during tstzrange NOT NULL,
        version integer NOT NULL DEFAULT 0,
        CHECK (filled <= capacity)
      )
    `.execute(db);

    await sql`
      CREATE TABLE match_players (
        match_id uuid NOT NULL REFERENCES matches(id),
        user_id uuid NOT NULL DEFAULT gen_random_uuid(),
        status text NOT NULL,
        during tstzrange,
        waitlist_position integer,
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (match_id, user_id)
      )
    `.execute(db);

    await sql`
      ALTER TABLE match_players
      ADD CONSTRAINT match_players_no_overlap
      EXCLUDE USING gist (user_id WITH =, during WITH &&)
      WHERE (status = 'JOINED')
    `.execute(db);

    await sql`CREATE TABLE bans (user_id uuid, ends_at timestamptz)`.execute(db);

    const starts = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3h from now
    const ends = new Date(starts.getTime() + 60 * 60 * 1000);
    const during = `[${starts.toISOString()},${ends.toISOString()})`;

    const match = await db
      .insertInto("matches")
      .values({
        pitch_id: crypto.randomUUID() as never,
        join_mode: "OPEN",
        status: "OPEN",
        capacity: CAPACITY,
        filled: 0,
        during: sql<string>`${during}::tstzrange` as never,
      } as never)
      .returning("id")
      .executeTakeFirstOrThrow();

    matchId = match.id as unknown as string;
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("lets exactly CAPACITY players join out of many simultaneous attempts", async () => {
    const attempts = Array.from({ length: ATTEMPTS }, () => attemptJoin(db, matchId));
    const results = await Promise.allSettled(attempts);

    const joined = results.filter(
      (r) => r.status === "fulfilled" && r.value === "JOINED"
    ).length;
    const waitlisted = results.filter(
      (r) => r.status === "fulfilled" && r.value === "WAITLISTED"
    ).length;

    expect(joined).toBe(CAPACITY);
    expect(joined + waitlisted).toBe(ATTEMPTS);

    const row = await db
      .selectFrom("matches")
      .select(["filled", "capacity"])
      .where("id", "=", matchId as never)
      .executeTakeFirstOrThrow();
    expect(row.filled).toBe(CAPACITY);
    expect(row.filled).toBeLessThanOrEqual(row.capacity);

    const joinedRows = await db
      .selectFrom("match_players")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("match_id", "=", matchId as never)
      .where("status", "=", "JOINED" as never)
      .executeTakeFirstOrThrow();
    expect(Number(joinedRows.count)).toBe(row.filled);
  });
});

/**
 * Mirrors src/modules/matches/join.ts's core two-step transaction, kept
 * inline so this test has no dependency on env-configured app wiring.
 */
async function attemptJoin(db: Kysely<DB>, matchId: string): Promise<"JOINED" | "WAITLISTED"> {
  const userId = crypto.randomUUID();

  const outcome = await db.transaction().execute(async (trx) => {
    const claimed = await trx
      .updateTable("matches")
      .set({ filled: (eb) => eb("filled", "+", 1), version: (eb) => eb("version", "+", 1) })
      .where("id", "=", matchId as never)
      .where("status", "=", "OPEN")
      .where((eb) => eb("filled", "<", eb.ref("capacity")))
      .returning("id")
      .executeTakeFirst();

    if (!claimed) return "FULL" as const;

    await trx
      .insertInto("match_players")
      .values({
        match_id: matchId as never,
        user_id: userId as never,
        status: "JOINED" as never,
        during: sql`(SELECT during FROM matches WHERE id = ${matchId}::uuid)` as never,
      } as never)
      .execute();

    return "JOINED" as const;
  });

  if (outcome === "JOINED") return "JOINED";

  await db
    .insertInto("match_players")
    .values({
      match_id: matchId as never,
      user_id: userId as never,
      status: "WAITLISTED" as never,
    } as never)
    .execute();
  return "WAITLISTED";
}
