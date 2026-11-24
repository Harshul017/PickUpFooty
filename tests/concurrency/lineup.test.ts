import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import { createMatch, createUser, seatPlayer } from "../helpers/fixtures.js";

type LineupModule = typeof import("../../src/modules/matches/lineup.js");

const ROUNDS = 10;

/**
 * Two players tapping the same position at the same instant. The partial
 * unique index on (match, team, slot) is what settles it, so this is the
 * same pattern as the join race, one level down.
 */
describe("lineup concurrency", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let placeInSlot: LineupModule["placeInSlot"];
  let getLineup: LineupModule["getLineup"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ placeInSlot, getLineup } = await import("../../src/modules/matches/lineup.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  it("gives a contested position to exactly one player", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const host = await createUser(db);
      const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", capacity: 10 });
      const a = await createUser(db);
      const b = await createUser(db);
      await seatPlayer(db, match.id, a.id);
      await seatPlayer(db, match.id, b.id);

      const claim = (userId: string) =>
        placeInSlot({ matchId: match.id, actorId: userId, userId, team: "A", slotCode: "GK" });

      const results = await Promise.allSettled([claim(a.id), claim(b.id)]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "SLOT_TAKEN" });

      // And the pitch agrees: one keeper, not two.
      const lineup = await getLineup(match.id);
      const keepers = lineup.slots.filter(
        (s) => s.team === "A" && s.slotCode === "GK" && s.player !== null
      );
      expect(keepers).toHaveLength(1);
      expect(lineup.unassigned).toHaveLength(2); // the host and whoever lost
    }
  });
});
