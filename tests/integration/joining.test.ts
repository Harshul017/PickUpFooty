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

  async function openMatch(
    opts: { capacity?: number; minRating?: number; maxRating?: number } = {}
  ) {
    const host = await createUser(db);
    return createMatch(db, { hostId: host.id, joinMode: "OPEN", ...opts });
  }

  describe("rating range", () => {
    it("rejects players below min_rating with 403 and takes no spot", async () => {
      const match = await openMatch({ minRating: 1300, maxRating: 1500 });
      const player = await createUser(db, { rating: 1150 });
      const before = await getMatchState(db, match.id);

      const err = await joinOpenMatch(match.id, player.id).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 403, code: "RATING_OUT_OF_RANGE" });
      expect((err as Error).message).toBe(
        "Your rating (1150) is outside this match's range (1300–1500)"
      );
      expect(await getMatchState(db, match.id)).toEqual(before);
    });

    it("rejects players above max_rating", async () => {
      const match = await openMatch({ maxRating: 1200 });
      const player = await createUser(db, { rating: 1450 });
      await expect(joinOpenMatch(match.id, player.id)).rejects.toMatchObject({
        status: 403,
        code: "RATING_OUT_OF_RANGE",
        message: "Your rating (1450) is outside this match's range (1200 or lower)",
      });
    });

    it("lets players inside the range join, bounds included", async () => {
      const match = await openMatch({ minRating: 1150, maxRating: 1300 });
      const atMin = await createUser(db, { rating: 1150 });
      const atMax = await createUser(db, { rating: 1300 });
      expect(await joinOpenMatch(match.id, atMin.id)).toEqual({ status: "JOINED" });
      expect(await joinOpenMatch(match.id, atMax.id)).toEqual({ status: "JOINED" });
    });
  });

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
