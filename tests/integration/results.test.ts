import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  createMatch,
  createUser,
  getMatchState,
  getStats,
  seatPlayer,
  setTeam,
} from "../helpers/fixtures.js";

type ResultsModule = typeof import("../../src/modules/results/service.js");

/**
 * Submitting how a match actually went, and the checks that stop the
 * numbers being made up.
 */
describe("match results", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let submitResult: ResultsModule["submitResult"];
  let getResult: ResultsModule["getResult"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ submitResult, getResult } = await import("../../src/modules/results/service.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /**
   * A match that kicked off two hours ago and finished an hour ago, with
   * one outfield player on each side besides the host.
   */
  async function finishedMatch(opts: { startsInMin?: number } = {}) {
    const host = await createUser(db);
    const match = await createMatch(db, {
      hostId: host.id,
      joinMode: "OPEN",
      capacity: 10,
      startsInMin: opts.startsInMin ?? -120,
      durationMin: 60,
    });
    const a = await createUser(db);
    const b = await createUser(db);
    await seatPlayer(db, match.id, a.id);
    await seatPlayer(db, match.id, b.id);
    await setTeam(db, match.id, host.id, "A", "GK");
    await setTeam(db, match.id, a.id, "A", "FWD1");
    await setTeam(db, match.id, b.id, "B", "FWD1");
    return { host, match, a, b };
  }

  describe("submitting", () => {
    it("records the score, the stats and who played", async () => {
      const { host, match, a, b } = await finishedMatch();

      const result = await submitResult({
        matchId: match.id,
        hostId: host.id,
        scoreA: 2,
        scoreB: 1,
        players: [
          { userId: a.id, goals: 2, assists: 0 },
          { userId: b.id, goals: 1, assists: 0 },
          { userId: host.id, assists: 1 },
        ],
      });

      expect(result.scoreA).toBe(2);
      expect(result.disputeDeadline).toBeInstanceOf(Date);
      expect(result.disputeDeadline.getTime()).toBeGreaterThan(Date.now());

      const stats = await getStats(db, match.id);
      expect(stats).toHaveLength(3);
      expect(stats.find((s) => s.user_id === a.id)?.goals).toBe(2);
      expect(stats.find((s) => s.user_id === host.id)?.assists).toBe(1);

      const state = await getMatchState(db, match.id);
      expect(state.players.every((p) => p.status === "PLAYED")).toBe(true);
    });

    it("works out clean sheets from the score rather than trusting the host", async () => {
      const { host, match, a, b } = await finishedMatch();

      await submitResult({
        matchId: match.id,
        hostId: host.id,
        scoreA: 3,
        scoreB: 0,
        players: [{ userId: a.id, goals: 3 }],
      });

      const stats = await getStats(db, match.id);
      // Team A conceded nothing, so its players keep a clean sheet; B's
      // do not, whatever anyone claims.
      expect(stats.find((s) => s.user_id === host.id)?.clean_sheet).toBe(true);
      expect(stats.find((s) => s.user_id === a.id)?.clean_sheet).toBe(true);
      expect(stats.find((s) => s.user_id === b.id)?.clean_sheet).toBe(false);
    });

    it("marks no-shows and keeps them out of the stats", async () => {
      const { host, match, a, b } = await finishedMatch();

      await submitResult({
        matchId: match.id,
        hostId: host.id,
        scoreA: 1,
        scoreB: 0,
        players: [{ userId: a.id, goals: 1 }],
        noShows: [b.id],
      });

      const stats = await getStats(db, match.id);
      expect(stats.map((s) => s.user_id)).not.toContain(b.id);
      const state = await getMatchState(db, match.id);
      expect(state.players.find((p) => p.user_id === b.id)?.status).toBe("NO_SHOW");
      expect(state.players.find((p) => p.user_id === a.id)?.status).toBe("PLAYED");
    });
  });

  describe("rejecting nonsense", () => {
    it("refuses goals that do not add up to the score", async () => {
      const { host, match, a } = await finishedMatch();

      await expect(
        submitResult({
          matchId: match.id,
          hostId: host.id,
          scoreA: 5,
          scoreB: 0,
          players: [{ userId: a.id, goals: 2 }],
        })
      ).rejects.toMatchObject({ code: "GOALS_DO_NOT_MATCH_SCORE" });

      await expect(getResult(match.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses goals from a player who is not on a side", async () => {
      const { host, match } = await finishedMatch();
      const spare = await createUser(db);
      await seatPlayer(db, match.id, spare.id);

      await expect(
        submitResult({
          matchId: match.id,
          hostId: host.id,
          scoreA: 1,
          scoreB: 0,
          players: [{ userId: spare.id, goals: 1 }],
        })
      ).rejects.toMatchObject({ code: "SCORER_HAS_NO_TEAM" });
    });

    it("refuses stats for somebody who was never in the match", async () => {
      const { host, match } = await finishedMatch();
      const stranger = await createUser(db);

      await expect(
        submitResult({
          matchId: match.id,
          hostId: host.id,
          scoreA: 0,
          scoreB: 0,
          players: [{ userId: stranger.id }],
        })
      ).rejects.toMatchObject({ code: "PLAYER_NOT_IN_MATCH" });
    });

    it("refuses a result before the final whistle", async () => {
      const { host, match } = await finishedMatch({ startsInMin: 60 });

      await expect(
        submitResult({ matchId: match.id, hostId: host.id, scoreA: 0, scoreB: 0, players: [] })
      ).rejects.toMatchObject({ code: "MATCH_NOT_FINISHED" });
    });

    it("refuses anyone but the organizer", async () => {
      const { match, a } = await finishedMatch();

      await expect(
        submitResult({ matchId: match.id, hostId: a.id, scoreA: 0, scoreB: 0, players: [] })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a second submission, because that is a dispute not an edit", async () => {
      const { host, match } = await finishedMatch();
      await submitResult({ matchId: match.id, hostId: host.id, scoreA: 0, scoreB: 0, players: [] });

      await expect(
        submitResult({ matchId: match.id, hostId: host.id, scoreA: 9, scoreB: 9, players: [] })
      ).rejects.toMatchObject({ code: "RESULT_ALREADY_SUBMITTED" });

      const result = await getResult(match.id);
      expect(result.score_a).toBe(0);
    });
  });

  describe("reading it back", () => {
    it("returns the score with every player's line", async () => {
      const { host, match, a, b } = await finishedMatch();
      await submitResult({
        matchId: match.id,
        hostId: host.id,
        scoreA: 1,
        scoreB: 1,
        players: [
          { userId: a.id, goals: 1 },
          { userId: b.id, goals: 1, assists: 2 },
        ],
      });

      const result = await getResult(match.id);

      expect(result.status).toBe("SUBMITTED");
      expect(result.players).toHaveLength(3);
      expect(result.players.find((p) => p.userId === b.id)).toMatchObject({
        team: "B",
        goals: 1,
        assists: 2,
      });
    });
  });
});
