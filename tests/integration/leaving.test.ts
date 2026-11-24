import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  activeDemeritPoints,
  createMatch,
  createUser,
  getMatchState,
  seatPlayer,
  waitlistPlayer,
} from "../helpers/fixtures.js";

type LeaveModule = typeof import("../../src/modules/matches/leave.js");
type JoinModule = typeof import("../../src/modules/matches/join.js");

/**
 * Leaving a match: the penalty ladder on real data, and the freed spot
 * being handed down the waitlist.
 */
describe("leaving a match", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let leaveMatch: LeaveModule["leaveMatch"];
  let joinOpenMatch: JoinModule["joinOpenMatch"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ leaveMatch } = await import("../../src/modules/matches/leave.js"));
    ({ joinOpenMatch } = await import("../../src/modules/matches/join.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /** A match plus one seated player, starting `startsInMin` from now. */
  async function matchWithPlayer(startsInMin: number, capacity = 10) {
    const host = await createUser(db);
    const match = await createMatch(db, {
      hostId: host.id,
      joinMode: "OPEN",
      capacity,
      startsInMin,
    });
    const player = await createUser(db);
    await seatPlayer(db, match.id, player.id);
    return { host, match, player };
  }

  /** Seat `playerId` in a fresh match starting soon, then walk out late. */
  async function cancelLate(playerId: string) {
    const host = await createUser(db);
    const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", startsInMin: 45 });
    await seatPlayer(db, match.id, playerId);
    return leaveMatch(match.id, playerId);
  }

  /** The penalties handed out over `times` late cancellations in a row. */
  async function cancelLateTimes(playerId: string, times: number) {
    const results: Awaited<ReturnType<typeof cancelLate>>[] = [];
    for (let i = 0; i < times; i++) {
      results.push(await cancelLate(playerId));
    }
    return results;
  }

  describe("penalties", () => {
    it("charges nothing when there is still more than an hour to kickoff", async () => {
      const { match, player } = await matchWithPlayer(180);

      const result = await leaveMatch(match.id, player.id);

      expect(result.penalty).toBeNull();
      expect(result.banEndsAt).toBeNull();
      expect(await activeDemeritPoints(db, player.id)).toBe(0);

      const state = await getMatchState(db, match.id);
      expect(state.filled).toBe(1); // the host alone
      expect(state.heldCount).toBe(state.filled);
    });

    it("warns on the first late cancel, without a demerit point", async () => {
      const { match, player } = await matchWithPlayer(45);

      const result = await leaveMatch(match.id, player.id);

      expect(result.penalty).toBe("WARNING");
      expect(result.banEndsAt).toBeNull();
      expect(await activeDemeritPoints(db, player.id)).toBe(0);
    });

    it("escalates to a demerit on the second and a ban on the third", async () => {
      const player = await createUser(db);

      const results = await cancelLateTimes(player.id, 3);

      expect(results.map((r) => r.penalty)).toEqual(["WARNING", "DEMERIT", "BAN"]);
      expect(results.at(-1)?.banEndsAt).toBeInstanceOf(Date);
      expect(await activeDemeritPoints(db, player.id)).toBe(2);
    });

    it("blocks a banned player from joining anything else", async () => {
      const player = await createUser(db);
      await cancelLateTimes(player.id, 3);

      const host = await createUser(db);
      const fresh = await createMatch(db, { hostId: host.id, joinMode: "OPEN" });

      await expect(joinOpenMatch(fresh.id, player.id)).rejects.toMatchObject({ code: "BANNED" });
    });

    it("ignores late cancels that have aged out of the 30-day window", async () => {
      const player = await createUser(db);
      await cancelLateTimes(player.id, 2);

      // Backdate everything on record past the lookback window.
      await db
        .updateTable("conduct_events")
        .set({ created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
        .where("user_id", "=", player.id)
        .execute();
      await db
        .updateTable("demerits")
        .set({ expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where("user_id", "=", player.id)
        .execute();

      const next = await cancelLate(player.id);
      expect(next.penalty).toBe("WARNING");
    });
  });

  describe("who may leave", () => {
    it("refuses the organizer, who has to cancel the match instead", async () => {
      const { match, host } = await matchWithPlayer(180);

      await expect(leaveMatch(match.id, host.id)).rejects.toMatchObject({
        code: "HOST_CANNOT_LEAVE",
      });
    });

    it("refuses someone who was never in the match", async () => {
      const { match } = await matchWithPlayer(180);
      const stranger = await createUser(db);

      await expect(leaveMatch(match.id, stranger.id)).rejects.toMatchObject({
        code: "NOT_IN_MATCH",
      });
    });

    it("refuses a second leave from the same player", async () => {
      const { match, player } = await matchWithPlayer(180);
      await leaveMatch(match.id, player.id);

      await expect(leaveMatch(match.id, player.id)).rejects.toMatchObject({
        code: "NOT_IN_MATCH",
      });
    });

    it("lets a waitlisted player drop out free, without touching the spots", async () => {
      const { match } = await matchWithPlayer(45);
      const waiting = await createUser(db);
      await waitlistPlayer(db, match.id, waiting.id);
      const before = await getMatchState(db, match.id);

      const result = await leaveMatch(match.id, waiting.id);

      expect(result.penalty).toBeNull();
      expect(result.heldSpot).toBe(false);
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled);
      expect(after.waitlistedCount).toBe(0);
    });
  });

  describe("passing the spot on", () => {
    it("offers the freed spot to the first player in line, keeping it taken", async () => {
      const { match, player } = await matchWithPlayer(45);
      const first = await createUser(db);
      const second = await createUser(db);
      await waitlistPlayer(db, match.id, first.id);
      await waitlistPlayer(db, match.id, second.id);
      const before = await getMatchState(db, match.id);

      const result = await leaveMatch(match.id, player.id);

      expect(result.offer?.userId).toBe(first.id);
      expect(result.offer?.expiresAt).toBeInstanceOf(Date);

      const after = await getMatchState(db, match.id);
      // The spot moved from the leaver to the offered player; it was never
      // free in between, so `filled` does not move either.
      expect(after.filled).toBe(before.filled);
      expect(after.heldCount).toBe(after.filled);
      expect(after.offeredCount).toBe(1);
      expect(after.players.find((p) => p.user_id === second.id)?.status).toBe("WAITLISTED");
    });

    it("gives the spot back to the match when nobody is waiting", async () => {
      const { match, player } = await matchWithPlayer(45);
      const before = await getMatchState(db, match.id);

      const result = await leaveMatch(match.id, player.id);

      expect(result.offer).toBeNull();
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled - 1);
      expect(after.heldCount).toBe(after.filled);
    });

    it("stops offering once the waitlist freezes near kickoff", async () => {
      const { match, player } = await matchWithPlayer(20);
      const waiting = await createUser(db);
      await waitlistPlayer(db, match.id, waiting.id);
      const before = await getMatchState(db, match.id);

      const result = await leaveMatch(match.id, player.id);

      expect(result.offer).toBeNull();
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled - 1);
      expect(after.players.find((p) => p.user_id === waiting.id)?.status).toBe("WAITLISTED");
    });

    it("charges nothing to a player who walks away from an offer", async () => {
      const { match, player } = await matchWithPlayer(45);
      const waiting = await createUser(db);
      await waitlistPlayer(db, match.id, waiting.id);
      await leaveMatch(match.id, player.id); // hands the spot to `waiting`

      const result = await leaveMatch(match.id, waiting.id);

      // They never confirmed, so this is declining an offer rather than
      // abandoning a commitment.
      expect(result.penalty).toBeNull();
      expect(result.heldSpot).toBe(true);
      const after = await getMatchState(db, match.id);
      expect(after.heldCount).toBe(after.filled);
    });
  });
});
