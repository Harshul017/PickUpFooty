import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  activeDemeritPoints,
  countConduct,
  createMatch,
  createUser,
  seatPlayer,
  setTeam,
} from "../helpers/fixtures.js";

type RatingsModule = typeof import("../../src/modules/results/ratings.js");
type ResultsModule = typeof import("../../src/modules/results/service.js");

/**
 * Rating the people you played with, and the corroboration rule that
 * keeps one person's grudge off somebody else's record.
 */
describe("peer ratings", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let ratings: RatingsModule;
  let results: ResultsModule;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ratings = await import("../../src/modules/results/ratings.js");
    results = await import("../../src/modules/results/service.js");
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /** A finished match with a submitted result and four players. */
  async function playedMatch() {
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
    const c = await createUser(db);
    for (const p of [a, b, c]) await seatPlayer(db, match.id, p.id);
    await setTeam(db, match.id, host.id, "A", "GK");
    await setTeam(db, match.id, a.id, "A", "FWD1");
    await setTeam(db, match.id, b.id, "B", "GK");
    await setTeam(db, match.id, c.id, "B", "FWD1");

    await results.submitResult({
      matchId: match.id,
      hostId: host.id,
      scoreA: 0,
      scoreB: 0,
      players: [],
    });

    return { host, match, a, b, c };
  }

  describe("submitting", () => {
    it("stores a score for each teammate", async () => {
      const { match, host, a, b } = await playedMatch();

      const outcome = await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [
          { userId: a.id, score: 5 },
          { userId: b.id, score: 3 },
        ],
      });

      expect(outcome.submitted).toBe(2);
      expect((await ratings.peerRatingSummary(match.id, a.id)).scores).toEqual([5]);
    });

    it("replaces an earlier score instead of stacking another one on top", async () => {
      const { match, host, a } = await playedMatch();
      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [{ userId: a.id, score: 5 }],
      });

      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [{ userId: a.id, score: 2 }],
      });

      const summary = await ratings.peerRatingSummary(match.id, a.id);
      expect(summary.count).toBe(1);
      expect(summary.scores).toEqual([2]);
    });

    it("refuses a rating from someone who was not on the pitch", async () => {
      const { match, a } = await playedMatch();
      const stranger = await createUser(db);

      await expect(
        ratings.submitPeerRatings({
          matchId: match.id,
          raterId: stranger.id,
          ratings: [{ userId: a.id, score: 1 }],
        })
      ).rejects.toMatchObject({ code: "NOT_IN_MATCH" });
    });

    it("refuses a rating for someone who was not on the pitch", async () => {
      const { match, host } = await playedMatch();
      const stranger = await createUser(db);

      await expect(
        ratings.submitPeerRatings({
          matchId: match.id,
          raterId: host.id,
          ratings: [{ userId: stranger.id, score: 5 }],
        })
      ).rejects.toMatchObject({ code: "PLAYER_NOT_IN_MATCH" });
    });

    it("refuses self-rating", async () => {
      const { match, host } = await playedMatch();

      await expect(
        ratings.submitPeerRatings({
          matchId: match.id,
          raterId: host.id,
          ratings: [{ userId: host.id, score: 5 }],
        })
      ).rejects.toMatchObject({ code: "CANNOT_RATE_SELF" });
    });

    it("closes 48 hours after the final whistle", async () => {
      const { match, host, a } = await playedMatch();
      // Drag the match three days into the past.
      await db
        .updateTable("matches")
        .set({
          during: sql<string>`tstzrange(now() - interval '3 days', now() - interval '3 days' + interval '1 hour')`,
        })
        .where("id", "=", match.id)
        .execute();

      await expect(
        ratings.submitPeerRatings({
          matchId: match.id,
          raterId: host.id,
          ratings: [{ userId: a.id, score: 5 }],
        })
      ).rejects.toMatchObject({ code: "RATING_WINDOW_CLOSED" });
    });
  });

  describe("reporting lateness", () => {
    it("ignores a single accusation", async () => {
      const { match, host, a } = await playedMatch();

      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [{ userId: a.id, score: 3, lateArrival: true }],
      });

      expect(await countConduct(db, a.id, "LATE_ARRIVAL")).toBe(0);
    });

    it("records it once a second player says the same thing", async () => {
      const { match, host, a, b } = await playedMatch();

      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [{ userId: a.id, score: 3, lateArrival: true }],
      });
      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: b.id,
        ratings: [{ userId: a.id, score: 4, lateArrival: true }],
      });

      expect(await countConduct(db, a.id, "LATE_ARRIVAL")).toBe(1);
      // Noted on their record, but lateness carries no demerit point.
      expect(await activeDemeritPoints(db, a.id)).toBe(0);
    });

    it("records it only once however many people pile on", async () => {
      const { match, host, a, b, c } = await playedMatch();

      for (const rater of [host, b, c]) {
        await ratings.submitPeerRatings({
          matchId: match.id,
          raterId: rater.id,
          ratings: [{ userId: a.id, score: 3, lateArrival: true }],
        });
      }

      expect(await countConduct(db, a.id, "LATE_ARRIVAL")).toBe(1);
    });
  });

  describe("summarising", () => {
    it("drops the highest and lowest once there are enough opinions", async () => {
      const { match, host, a, b, c } = await playedMatch();
      const scores = [1, 4, 5];
      const raters = [host, b, c];
      for (let i = 0; i < raters.length; i++) {
        await ratings.submitPeerRatings({
          matchId: match.id,
          raterId: raters[i]!.id,
          ratings: [{ userId: a.id, score: scores[i]! }],
        });
      }

      const summary = await ratings.peerRatingSummary(match.id, a.id);

      expect(summary.count).toBe(3);
      // 1 and 5 are discarded, leaving the one honest-looking score.
      expect(summary.average).toBe(4);
    });

    it("keeps a lone score intact rather than trimming it away to nothing", async () => {
      const { match, host, a } = await playedMatch();
      await ratings.submitPeerRatings({
        matchId: match.id,
        raterId: host.id,
        ratings: [{ userId: a.id, score: 5 }],
      });

      const summary = await ratings.peerRatingSummary(match.id, a.id);
      // `count` is what tells the caller how much to trust this; the
      // rating engine ignores anything under three opinions.
      expect(summary.count).toBe(1);
      expect(summary.average).toBe(5);
    });
  });
});
