import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  createMatch,
  createUser,
  fillMatch,
  getMatchState,
  leaveMatch,
} from "../helpers/fixtures.js";

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

  describe("rejoining after leaving", () => {
    it("brings a CANCELLED row back to JOINED and keeps conduct records", async () => {
      const match = await openMatch();
      const player = await createUser(db);
      await joinOpenMatch(match.id, player.id);
      await leaveMatch(db, match.id, player.id);
      await db
        .insertInto("conduct_events")
        .values({ user_id: player.id, match_id: match.id, type: "LATE_CANCEL" })
        .execute();
      const before = await getMatchState(db, match.id);

      expect(await joinOpenMatch(match.id, player.id)).toEqual({ status: "JOINED" });

      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled + 1);
      expect(after.joinedCount).toBe(after.filled);
      const rows = after.players.filter((p) => p.user_id === player.id);
      expect(rows).toEqual([expect.objectContaining({ status: "JOINED" })]);

      const conduct = await db
        .selectFrom("conduct_events")
        .select("type")
        .where("user_id", "=", player.id)
        .where("match_id", "=", match.id)
        .execute();
      expect(conduct).toEqual([{ type: "LATE_CANCEL" }]);
    });

    it("brings a CANCELLED row back as WAITLISTED when the match is full", async () => {
      const match = await openMatch({ capacity: 8 });
      const player = await createUser(db);
      await joinOpenMatch(match.id, player.id);
      await leaveMatch(db, match.id, player.id);
      await fillMatch(db, match.id, 0);

      expect(await joinOpenMatch(match.id, player.id)).toEqual({
        status: "WAITLISTED",
        position: 1,
      });
      const row = await db
        .selectFrom("match_players")
        .select(["status", "during", "waitlist_position"])
        .where("match_id", "=", match.id)
        .where("user_id", "=", player.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: "WAITLISTED", during: null, waitlist_position: 1 });
    });

    it("still rejects joining twice, without taking a second spot", async () => {
      const match = await openMatch();
      const player = await createUser(db);
      await joinOpenMatch(match.id, player.id);
      const before = await getMatchState(db, match.id);

      await expect(joinOpenMatch(match.id, player.id)).rejects.toMatchObject({
        status: 409,
        code: "ALREADY_IN_MATCH",
      });
      expect(await getMatchState(db, match.id)).toEqual(before);
    });
  });
});
