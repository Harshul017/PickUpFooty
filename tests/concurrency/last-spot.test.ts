import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import { createMatch, createUser, getMatchState } from "../helpers/fixtures.js";

type JoinModule = typeof import("../../src/modules/matches/join.js");

/**
 * Proves the core claim of the design doc: with N spots and M > N
 * simultaneous join attempts, exactly N succeed and `matches.filled`
 * always equals the number of JOINED rows. Runs the real join flow against
 * a real, disposable Postgres migrated the same way production is.
 */
describe("last spot concurrency", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let joinOpenMatch: JoinModule["joinOpenMatch"];
  let matchId: string;
  let playerIds: string[];
  const OPEN_SPOTS = 10;
  const ATTEMPTS = 200;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ joinOpenMatch } = await import("../../src/modules/matches/join.js"));

    // The host holds one seat, so capacity is one more than the open spots.
    const host = await createUser(db);
    const match = await createMatch(db, {
      hostId: host.id,
      joinMode: "OPEN",
      capacity: OPEN_SPOTS + 1,
    });
    matchId = match.id;

    const players = await db
      .insertInto("users")
      .values(
        Array.from({ length: ATTEMPTS }, (_, i) => ({
          name: `Racer ${i}`,
          email: `${randomUUID()}@test.local`,
          phone: null,
          password_hash: "not-a-real-hash",
          role: "PLAYER" as const,
          area: null,
          preferred_position: null,
          preferred_foot: null,
        }))
      )
      .returning("id")
      .execute();
    playerIds = players.map((p) => p.id);
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  it("lets exactly OPEN_SPOTS players join out of many simultaneous attempts", async () => {
    const results = await Promise.allSettled(
      playerIds.map((id) => joinOpenMatch(matchId, id))
    );

    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toEqual([]);

    const values = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const joined = values.filter((v) => v.status === "JOINED").length;
    const positions = values.flatMap((v) => (v.status === "WAITLISTED" ? [v.position] : []));

    expect(joined).toBe(OPEN_SPOTS);
    expect(joined + positions.length).toBe(ATTEMPTS);
    // The waitlist is a clean 1..N line: no shared or skipped positions.
    expect([...positions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: ATTEMPTS - OPEN_SPOTS }, (_, i) => i + 1)
    );

    const state = await getMatchState(db, matchId);
    expect(state.filled).toBe(state.capacity);
    expect(state.joinedCount).toBe(state.filled);
  });
});
