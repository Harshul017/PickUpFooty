import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  activeDemeritPoints,
  closeDisputeWindow,
  countConduct,
  createMatch,
  createUser,
  getMatchState,
  getStats,
  seatPlayer,
  setTeam,
} from "../helpers/fixtures.js";

type ResultsModule = typeof import("../../src/modules/results/service.js");
type DisputesModule = typeof import("../../src/modules/results/disputes.js");

/**
 * The window between a result being claimed and a result being true.
 */
describe("disputes and finalisation", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let results: ResultsModule;
  let disputes: DisputesModule;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    results = await import("../../src/modules/results/service.js");
    disputes = await import("../../src/modules/results/disputes.js");
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /** A finished match with a submitted result, optionally with a no-show. */
  async function playedMatch(opts: { noShow?: boolean } = {}) {
    const host = await createUser(db);
    const match = await createMatch(db, {
      hostId: host.id,
      joinMode: "OPEN",
      capacity: 10,
      startsInMin: -120,
      durationMin: 60,
    });
    const a = await createUser(db);
    const b = await createUser(db);
    await seatPlayer(db, match.id, a.id);
    await seatPlayer(db, match.id, b.id);
    await setTeam(db, match.id, host.id, "A", "GK");
    await setTeam(db, match.id, a.id, "A", "FWD1");
    await setTeam(db, match.id, b.id, "B", "FWD1");

    await results.submitResult({
      matchId: match.id,
      hostId: host.id,
      scoreA: 1,
      scoreB: 0,
      players: [{ userId: a.id, goals: 1 }],
      noShows: opts.noShow ? [b.id] : [],
    });

    return { host, match, a, b };
  }

  describe("finalising", () => {
    it("does nothing while the window is still open", async () => {
      const { match } = await playedMatch();

      expect(await results.finalizeResult(match.id)).toBeNull();
      expect((await results.getResult(match.id)).status).toBe("SUBMITTED");
    });

    it("closes the result once the window has passed", async () => {
      const { match } = await playedMatch();
      await closeDisputeWindow(db, match.id);

      const finalized = await results.finalizeResult(match.id);

      expect(finalized?.matchId).toBe(match.id);
      const result = await results.getResult(match.id);
      expect(result.status).toBe("FINALIZED");
      expect(result.finalized_at).not.toBeNull();
    });

    it("charges a no-show a demerit point, but only when the result is beyond argument", async () => {
      const { match, b } = await playedMatch({ noShow: true });

      // Nothing yet: the result could still be overturned.
      expect(await activeDemeritPoints(db, b.id)).toBe(0);

      await closeDisputeWindow(db, match.id);
      const finalized = await results.finalizeResult(match.id);

      expect(finalized?.penalised).toEqual([{ userId: b.id, kind: "DEMERIT" }]);
      expect(await activeDemeritPoints(db, b.id)).toBe(1);
      expect(await countConduct(db, b.id, "NO_SHOW")).toBe(1);
    });

    it("is harmless to run twice, so a duplicate job charges nobody twice", async () => {
      const { match, b } = await playedMatch({ noShow: true });
      await closeDisputeWindow(db, match.id);

      const first = await results.finalizeResult(match.id);
      const second = await results.finalizeResult(match.id);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await activeDemeritPoints(db, b.id)).toBe(1);
      expect(await countConduct(db, b.id, "NO_SHOW")).toBe(1);
    });

    it("leaves a disputed result alone for a human", async () => {
      const { match, a } = await playedMatch();
      await disputes.raiseDispute(match.id, a.id, "I scored two, not one");
      await closeDisputeWindow(db, match.id);

      expect(await results.finalizeResult(match.id)).toBeNull();
      expect((await results.getResult(match.id)).status).toBe("DISPUTED");
    });
  });

  describe("raising one", () => {
    it("freezes the result when a player objects", async () => {
      const { match, a } = await playedMatch();

      const dispute = await disputes.raiseDispute(match.id, a.id, "Score is wrong");

      expect(dispute.status).toBe("OPEN");
      expect((await results.getResult(match.id)).status).toBe("DISPUTED");
    });

    it("lets a player marked absent object too", async () => {
      const { match, b } = await playedMatch({ noShow: true });

      const dispute = await disputes.raiseDispute(match.id, b.id, "I was there");

      expect(dispute.status).toBe("OPEN");
    });

    it("refuses someone who did not play", async () => {
      const { match } = await playedMatch();
      const stranger = await createUser(db);

      await expect(
        disputes.raiseDispute(match.id, stranger.id, "Looks wrong to me")
      ).rejects.toMatchObject({ code: "NOT_IN_MATCH" });
    });

    it("refuses once the window has closed", async () => {
      const { match, a } = await playedMatch();
      await closeDisputeWindow(db, match.id);

      await expect(disputes.raiseDispute(match.id, a.id, "Too late")).rejects.toMatchObject({
        code: "DISPUTE_WINDOW_CLOSED",
      });
    });

    it("refuses a second objection from the same player", async () => {
      const { match, a } = await playedMatch();
      await disputes.raiseDispute(match.id, a.id, "First");

      await expect(disputes.raiseDispute(match.id, a.id, "Again")).rejects.toMatchObject({
        code: "ALREADY_DISPUTED",
      });
    });
  });

  describe("settling one", () => {
    it("finalises the result when an admin dismisses the objection", async () => {
      const { match, a } = await playedMatch();
      const admin = await createUser(db, { role: "ADMIN" });
      await disputes.raiseDispute(match.id, a.id, "Score is wrong");

      const outcome = await disputes.resolveDispute({
        matchId: match.id,
        adminId: admin.id,
        outcome: "DISMISSED",
      });

      expect(outcome.resubmissionNeeded).toBe(false);
      expect((await results.getResult(match.id)).status).toBe("FINALIZED");
    });

    it("throws the result away when the objection is upheld, so it can be redone", async () => {
      const { host, match, a, b } = await playedMatch({ noShow: true });
      const admin = await createUser(db, { role: "ADMIN" });
      await disputes.raiseDispute(match.id, b.id, "I was there");

      const outcome = await disputes.resolveDispute({
        matchId: match.id,
        adminId: admin.id,
        outcome: "UPHELD",
      });

      expect(outcome.resubmissionNeeded).toBe(true);
      await expect(results.getResult(match.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await getStats(db, match.id)).toHaveLength(0);

      // Everyone is a confirmed player again, so the host can submit a
      // corrected result; and nobody was penalised for the version that
      // got thrown out.
      const state = await getMatchState(db, match.id);
      expect(state.players.every((p) => p.status === "JOINED")).toBe(true);
      expect(await activeDemeritPoints(db, b.id)).toBe(0);

      await expect(
        results.submitResult({
          matchId: match.id,
          hostId: host.id,
          scoreA: 1,
          scoreB: 0,
          players: [{ userId: a.id, goals: 1 }],
        })
      ).resolves.toMatchObject({ scoreA: 1 });
    });

    it("refuses when there is nothing to settle", async () => {
      const { match } = await playedMatch();
      const admin = await createUser(db, { role: "ADMIN" });

      await expect(
        disputes.resolveDispute({ matchId: match.id, adminId: admin.id, outcome: "DISMISSED" })
      ).rejects.toMatchObject({ code: "NO_OPEN_DISPUTE" });
    });
  });
});
