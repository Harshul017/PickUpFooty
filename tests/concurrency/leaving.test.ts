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

type LeaveModule = typeof import("../../src/modules/matches/leave.js");
type WaitlistModule = typeof import("../../src/modules/matches/waitlist.js");

const ROUNDS = 10;

/**
 * Races around a freed spot. Each scenario runs several rounds, because
 * two calls don't always overlap on the first try; the invariants have to
 * hold in every round whichever one wins.
 *
 * The invariant under test throughout is the one the whole design rests
 * on: matches.filled equals JOINED + OFFERED, always.
 */
describe("leaving concurrency", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let leaveMatch: LeaveModule["leaveMatch"];
  let confirmOffer: WaitlistModule["confirmOffer"];
  let expireOffer: WaitlistModule["expireOffer"];

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    ({ leaveMatch } = await import("../../src/modules/matches/leave.js"));
    ({ confirmOffer, expireOffer } = await import("../../src/modules/matches/waitlist.js"));
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  it("two players leaving at once offer the single waiting player exactly one spot", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const host = await createUser(db);
      const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", startsInMin: 45 });
      const a = await createUser(db);
      const b = await createUser(db);
      await seatPlayer(db, match.id, a.id);
      await seatPlayer(db, match.id, b.id);
      const waiting = await createUser(db);
      await waitlistPlayer(db, match.id, waiting.id);

      const before = await getMatchState(db, match.id);
      const results = await Promise.all([leaveMatch(match.id, a.id), leaveMatch(match.id, b.id)]);

      // One leaver hands their spot over, the other gives it back: the
      // waiting player must never be offered two spots at once.
      const offers = results.filter((r) => r.offer !== null);
      expect(offers).toHaveLength(1);
      expect(offers[0]?.offer?.userId).toBe(waiting.id);

      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled - 1);
      expect(after.heldCount).toBe(after.filled);
      expect(after.offeredCount).toBe(1);
      expect(after.waitlistedCount).toBe(0);
    }
  });

  it("a leave racing an offer expiry leaves the headcount consistent", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const host = await createUser(db);
      const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", startsInMin: 45 });
      const seated = await createUser(db);
      await seatPlayer(db, match.id, seated.id);
      const first = await createUser(db);
      const second = await createUser(db);
      await waitlistPlayer(db, match.id, first.id);
      await waitlistPlayer(db, match.id, second.id);

      // Someone else's spot is already out on a lapsed offer to `first`.
      const other = await createUser(db);
      await seatPlayer(db, match.id, other.id);
      await leaveMatch(match.id, other.id);
      await expireOfferNow(db, match.id, first.id);

      const before = await getMatchState(db, match.id);
      await Promise.all([leaveMatch(match.id, seated.id), expireOffer(match.id, first.id)]);

      const after = await getMatchState(db, match.id);
      expect(after.heldCount).toBe(after.filled);
      // One seat was given up and one lapsed offer reclaimed, against two
      // players still waiting, so both spots stay out on offer.
      expect(after.filled).toBe(before.filled);
      expect(after.offeredCount).toBeLessThanOrEqual(2);
      expect(after.players.filter((p) => p.status === "OFFERED").map((p) => p.user_id)).not.toContain(
        first.id
      );
    }
  });

  it("confirming while another player leaves never double-counts the spot", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const host = await createUser(db);
      const match = await createMatch(db, { hostId: host.id, joinMode: "OPEN", startsInMin: 45 });
      const a = await createUser(db);
      const b = await createUser(db);
      await seatPlayer(db, match.id, a.id);
      await seatPlayer(db, match.id, b.id);
      const waiting = await createUser(db);
      await waitlistPlayer(db, match.id, waiting.id);

      // `waiting` is holding a live offer from a's exit.
      await leaveMatch(match.id, a.id);

      await Promise.all([confirmOffer(match.id, waiting.id), leaveMatch(match.id, b.id)]);

      const after = await getMatchState(db, match.id);
      expect(after.heldCount).toBe(after.filled);
      expect(after.players.find((p) => p.user_id === waiting.id)?.status).toBe("JOINED");
      expect(after.filled).toBeLessThanOrEqual(after.capacity);
    }
  });
});
