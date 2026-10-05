import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import { createMatch, createUser, fillMatch, getMatchState } from "../helpers/fixtures.js";

type JoinModule = typeof import("../../src/modules/matches/join.js");

/**
 * Open joins and the spot/waitlist logic they share with accepted requests,
 * against the real migrated schema.
 */
describe("joining a match", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let joinOpenMatch: JoinModule["joinOpenMatch"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ joinOpenMatch } = await import("../../src/modules/matches/join.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  async function openMatch(opts: { capacity?: number } = {}) {
    const host = await createUser(db);
    return createMatch(db, { hostId: host.id, joinMode: "OPEN", ...opts });
  }

  describe("waitlist positions", () => {
    it("hands out the next position after the last one, even with gaps", async () => {
      const match = await openMatch({ capacity: 8 });
      await fillMatch(db, match.id, 0);
      const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => createUser(db)));

      expect(await joinOpenMatch(match.id, a!.id)).toEqual({ status: "WAITLISTED", position: 1 });
      expect(await joinOpenMatch(match.id, b!.id)).toEqual({ status: "WAITLISTED", position: 2 });
      expect(await joinOpenMatch(match.id, c!.id)).toEqual({ status: "WAITLISTED", position: 3 });

      // Position 2 leaves the waitlist: 2 remain, but position 3 is taken.
      await db
        .updateTable("match_players")
        .set({ status: "CANCELLED", waitlist_position: null })
        .where("match_id", "=", match.id)
        .where("user_id", "=", b!.id)
        .execute();

      expect(await joinOpenMatch(match.id, d!.id)).toEqual({ status: "WAITLISTED", position: 4 });
    });
  });
});
