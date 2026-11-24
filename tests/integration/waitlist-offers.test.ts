import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  createMatch,
  createUser,
  expireOfferNow,
  getMatchState,
  seatPlayer,
  waitlistPlayer,
} from "../helpers/fixtures.js";

type WaitlistModule = typeof import("../../src/modules/matches/waitlist.js");
type LeaveModule = typeof import("../../src/modules/matches/leave.js");

/**
 * What a player can do with a freed spot they've been offered, and what
 * happens when they do nothing at all.
 */
describe("waitlist offers", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let confirmOffer: WaitlistModule["confirmOffer"];
  let declineOffer: WaitlistModule["declineOffer"];
  let expireOffer: WaitlistModule["expireOffer"];
  let leaveMatch: LeaveModule["leaveMatch"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ confirmOffer, declineOffer, expireOffer } = await import(
      "../../src/modules/matches/waitlist.js"
    ));
    ({ leaveMatch } = await import("../../src/modules/matches/leave.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /**
   * A match where `seated` walks out, handing their spot to the first of
   * `waiting` as a live offer. Built through the real leave flow rather
   * than by writing an OFFERED row by hand.
   */
  async function matchWithLiveOffer(waitingCount = 1) {
    const host = await createUser(db);
    const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", startsInMin: 45 });
    const seated = await createUser(db);
    await seatPlayer(db, match.id, seated.id);

    const waiting = [];
    for (let i = 0; i < waitingCount; i++) {
      const player = await createUser(db);
      await waitlistPlayer(db, match.id, player.id);
      waiting.push(player);
    }

    const result = await leaveMatch(match.id, seated.id);
    return { match, offered: waiting[0]!, waiting, leaveResult: result };
  }

  describe("confirming", () => {
    it("turns the offer into a seat without changing the headcount", async () => {
      const { match, offered } = await matchWithLiveOffer();
      const before = await getMatchState(db, match.id);

      const result = await confirmOffer(match.id, offered.id);

      expect(result.status).toBe("JOINED");
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled);
      expect(after.offeredCount).toBe(0);
      expect(after.heldCount).toBe(after.filled);
      expect(after.players.find((p) => p.user_id === offered.id)?.status).toBe("JOINED");
    });

    it("refuses once the ten minutes are up, even before the job has run", async () => {
      const { match, offered } = await matchWithLiveOffer();
      await expireOfferNow(db, match.id, offered.id);

      await expect(confirmOffer(match.id, offered.id)).rejects.toMatchObject({
        code: "NO_LIVE_OFFER",
      });
    });

    it("refuses a player who has no offer at all", async () => {
      const { match } = await matchWithLiveOffer();
      const stranger = await createUser(db);

      await expect(confirmOffer(match.id, stranger.id)).rejects.toMatchObject({
        code: "NO_LIVE_OFFER",
      });
    });

    it("refuses when the player picked up a clashing match meanwhile, leaving the offer open", async () => {
      const { match, offered } = await matchWithLiveOffer();

      // Same kickoff, so the two matches overlap.
      const otherHost = await createUser(db);
      const other = await createMatch(db, {
        hostId: otherHost.id,
        joinMode: "OPEN",
        startsInMin: 45,
      });
      await seatPlayer(db, other.id, offered.id);

      await expect(confirmOffer(match.id, offered.id)).rejects.toMatchObject({
        code: "PLAYER_OVERLAP",
      });

      // The whole transaction rolled back, so the offer is still theirs to
      // take if they free themselves up in time.
      const after = await getMatchState(db, match.id);
      expect(after.players.find((p) => p.user_id === offered.id)?.status).toBe("OFFERED");
      expect(after.heldCount).toBe(after.filled);
    });
  });

  describe("declining", () => {
    it("hands the spot straight to the next player in line", async () => {
      const { match, waiting } = await matchWithLiveOffer(2);
      const [first, second] = waiting;
      const before = await getMatchState(db, match.id);

      const result = await declineOffer(match.id, first!.id);

      expect(result.status).toBe("DECLINED");
      expect(result.offer?.userId).toBe(second!.id);

      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled);
      expect(after.players.find((p) => p.user_id === first!.id)?.status).toBe("CANCELLED");
      expect(after.players.find((p) => p.user_id === second!.id)?.status).toBe("OFFERED");
      expect(after.heldCount).toBe(after.filled);
    });

    it("gives the spot back to the match when the queue is empty", async () => {
      const { match, offered } = await matchWithLiveOffer();
      const before = await getMatchState(db, match.id);

      const result = await declineOffer(match.id, offered.id);

      expect(result.offer).toBeNull();
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled - 1);
      expect(after.heldCount).toBe(after.filled);
    });
  });

  describe("letting it lapse", () => {
    it("reclaims the spot and passes it down the queue", async () => {
      const { match, waiting } = await matchWithLiveOffer(2);
      const [first, second] = waiting;
      await expireOfferNow(db, match.id, first!.id);
      const before = await getMatchState(db, match.id);

      const outcome = await expireOffer(match.id, first!.id);

      expect(outcome?.status).toBe("EXPIRED");
      expect(outcome?.offer?.userId).toBe(second!.id);
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled);
      expect(after.heldCount).toBe(after.filled);
    });

    it("does nothing a second time, so a duplicate delivery is harmless", async () => {
      const { match, offered } = await matchWithLiveOffer();
      await expireOfferNow(db, match.id, offered.id);

      const first = await expireOffer(match.id, offered.id);
      const stateAfterFirst = await getMatchState(db, match.id);
      const second = await expireOffer(match.id, offered.id);
      const stateAfterSecond = await getMatchState(db, match.id);

      expect(first?.status).toBe("EXPIRED");
      expect(second).toBeNull();
      expect(stateAfterSecond.filled).toBe(stateAfterFirst.filled);
      expect(stateAfterSecond.players).toEqual(stateAfterFirst.players);
    });

    it("leaves a live offer alone when the job fires early", async () => {
      const { match, offered } = await matchWithLiveOffer();

      const outcome = await expireOffer(match.id, offered.id);

      expect(outcome).toBeNull();
      const after = await getMatchState(db, match.id);
      expect(after.players.find((p) => p.user_id === offered.id)?.status).toBe("OFFERED");
      expect(after.heldCount).toBe(after.filled);
    });
  });
});
