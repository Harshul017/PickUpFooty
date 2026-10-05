import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import { createMatch, createUser, fillMatch, getMatchState, getRequest } from "../helpers/fixtures.js";

type RequestsService = typeof import("../../src/modules/requests/service.js");

const ROUNDS = 10;
const MIN = 60_000;

/**
 * Races on join requests against the real migrated schema. Each scenario
 * runs several rounds, since two calls don't always overlap on the first
 * try; the invariants must hold in every round regardless of who wins.
 */
describe("join request concurrency", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let svc: RequestsService;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    svc = await import("../../src/modules/requests/service.js");
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  it("two accepts racing for the last spot: exactly 1 JOINED, 1 WAITLISTED", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const host = await createUser(db);
      const match = await createMatch(db, { hostId: host.id, capacity: 8 });
      const p1 = await createUser(db);
      const p2 = await createUser(db);
      const r1 = await svc.createRequest({ matchId: match.id, userId: p1.id });
      const r2 = await svc.createRequest({ matchId: match.id, userId: p2.id });
      await fillMatch(db, match.id, 1);

      const results = await Promise.all([
        svc.acceptRequest(r1.id, host.id),
        svc.acceptRequest(r2.id, host.id),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual(["JOINED", "WAITLISTED"]);
      expect(results.find((r) => r.status === "WAITLISTED")).toEqual({
        status: "WAITLISTED",
        position: 1,
      });

      const state = await getMatchState(db, match.id);
      expect(state.filled).toBe(state.capacity);
      expect(state.joinedCount).toBe(state.filled);
      expect((await getRequest(db, r1.id)).status).toBe("ACCEPTED");
      expect((await getRequest(db, r2.id)).status).toBe("ACCEPTED");
    }
  });

  it("accept racing the expiry job: the request ends in exactly one final state", async () => {
    const outcomes = { ACCEPTED: 0, EXPIRED: 0 };

    for (let round = 0; round < ROUNDS * 3; round++) {
      const host = await createUser(db);
      const player = await createUser(db);
      const match = await createMatch(db, { hostId: host.id });
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      const before = await getMatchState(db, match.id);

      // Move expiry a few ms ahead on the database clock and fire both at
      // once. Accept's UPDATE lands a few ms after it starts, so spreading
      // the offset makes either side win in different rounds.
      const offsetMs = round * 2;
      await db
        .updateTable("join_requests")
        .set({ expires_at: sql<Date>`clock_timestamp() + ${`${offsetMs} milliseconds`}::interval` })
        .where("id", "=", request.id)
        .execute();

      const [accept, expire] = await Promise.allSettled([
        svc.acceptRequest(request.id, host.id),
        svc.expireRequest(request.id),
      ]);

      // If the accept lost only because time ran out but the job's
      // transaction started a moment too early, a retried job finishes
      // the work; that's what BullMQ retries and the sweeper are for.
      if ((await getRequest(db, request.id)).status === "PENDING") {
        await new Promise((resolve) => setTimeout(resolve, offsetMs + 20));
        expect(await svc.expireRequest(request.id)).toBe(true);
      }

      const final = await getRequest(db, request.id);
      const after = await getMatchState(db, match.id);
      const playerRow = after.players.find((p) => p.user_id === player.id);

      if (final.status === "ACCEPTED") {
        outcomes.ACCEPTED++;
        expect(accept).toMatchObject({ status: "fulfilled", value: { status: "JOINED" } });
        expect(expire).toMatchObject({ status: "fulfilled", value: false });
        expect(playerRow?.status).toBe("JOINED");
        expect(after.filled).toBe(before.filled + 1);
      } else {
        outcomes.EXPIRED++;
        expect(final.status).toBe("EXPIRED");
        expect(accept).toMatchObject({
          status: "rejected",
          reason: { status: 409, code: "REQUEST_NOT_PENDING" },
        });
        expect(playerRow).toBeUndefined();
        expect(after.filled).toBe(before.filled);
      }
      expect(after.joinedCount).toBe(after.filled);
    }

    // Not asserted (timing-dependent), but useful when reading test output.
    console.log("accept vs expiry outcomes:", outcomes);
  });

  it("two hosts accepting the same player into overlapping matches: one wins, no deadlock", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const player = await createUser(db);
      const hostA = await createUser(db);
      const hostB = await createUser(db);
      const startsAt = new Date(Date.now() + 6 * 60 * MIN);
      const matchA = await createMatch(db, { hostId: hostA.id, startsAt });
      const matchB = await createMatch(db, {
        hostId: hostB.id,
        startsAt: new Date(startsAt.getTime() + 15 * MIN),
      });
      const reqA = await svc.createRequest({ matchId: matchA.id, userId: player.id });
      const reqB = await svc.createRequest({ matchId: matchB.id, userId: player.id });

      const results = await Promise.allSettled([
        svc.acceptRequest(reqA.id, hostA.id),
        svc.acceptRequest(reqB.id, hostB.id),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // A clean 409, never a deadlock (40P01) surfacing as a 500.
      expect(lost[0]).toMatchObject({ reason: { status: 409 } });

      const statuses = [
        (await getRequest(db, reqA.id)).status,
        (await getRequest(db, reqB.id)).status,
      ].sort();
      expect(statuses).toEqual(["ACCEPTED", "WITHDRAWN"]);

      const joined = await db
        .selectFrom("match_players")
        .select("match_id")
        .where("user_id", "=", player.id)
        .where("status", "=", "JOINED")
        .execute();
      expect(joined).toHaveLength(1);
    }
  });
});
