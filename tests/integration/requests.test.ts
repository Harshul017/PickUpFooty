import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import {
  createMatch,
  createUser,
  expireNow,
  fillMatch,
  getMatchState,
  getRequest,
  leaveMatch,
} from "../helpers/fixtures.js";

type RequestsService = typeof import("../../src/modules/requests/service.js");

const MIN = 60_000;

/**
 * The join-request service against the real migrated schema, so the
 * partial unique index, exclusion constraint and capacity CHECK are the
 * real ones.
 */
describe("join requests", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let svc: RequestsService;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    // Imported after DATABASE_URL points at the container.
    ({ db } = await import("../../src/lib/db.js"));
    svc = await import("../../src/modules/requests/service.js");
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  async function setup(opts: Partial<Parameters<typeof createMatch>[1]> = {}) {
    const host = await createUser(db);
    const player = await createUser(db, { rating: 1300 });
    const match = await createMatch(db, { hostId: host.id, ...opts });
    return { host, player, match };
  }

  describe("creating a request", () => {
    it("creates a PENDING request that expires 45 minutes after it was sent", async () => {
      const { player, match } = await setup({ startsInMin: 24 * 60 });
      const request = await svc.createRequest({
        matchId: match.id,
        userId: player.id,
        note: "Can play GK",
      });

      expect(request.status).toBe("PENDING");
      expect(request.note).toBe("Can play GK");
      const lifetime =
        new Date(request.expires_at).getTime() - new Date(request.requested_at).getTime();
      expect(lifetime).toBe(45 * MIN);
    });

    it("caps expiry at T-60 when kickoff is close", async () => {
      const { player, match } = await setup({ startsInMin: 100 });
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      expect(new Date(request.expires_at).getTime()).toBe(match.startsAt.getTime() - 60 * MIN);
    });

    it("rejects requests for OPEN matches with 400", async () => {
      const { player, match } = await setup({ joinMode: "OPEN" });
      await expect(
        svc.createRequest({ matchId: match.id, userId: player.id })
      ).rejects.toMatchObject({ status: 400 });
    });

    it("rejects a second PENDING request for the same match with 409", async () => {
      const { player, match } = await setup();
      await svc.createRequest({ matchId: match.id, userId: player.id });
      await expect(
        svc.createRequest({ matchId: match.id, userId: player.id })
      ).rejects.toMatchObject({ status: 409, code: "REQUEST_ALREADY_PENDING" });
    });

    it("allows a new request once the previous one was decided", async () => {
      const { host, player, match } = await setup();
      const first = await svc.createRequest({ matchId: match.id, userId: player.id });
      await svc.rejectRequest(first.id, host.id);
      const second = await svc.createRequest({ matchId: match.id, userId: player.id });
      expect(second.status).toBe("PENDING");
    });

    it("rejects players already in the match (the host is JOINED)", async () => {
      const { host, match } = await setup();
      await expect(
        svc.createRequest({ matchId: match.id, userId: host.id })
      ).rejects.toMatchObject({ status: 409, code: "ALREADY_IN_MATCH" });
    });

    it("rejects requests after the T-90 cutoff", async () => {
      const { player, match } = await setup({ startsInMin: 89 });
      await expect(
        svc.createRequest({ matchId: match.id, userId: player.id })
      ).rejects.toMatchObject({ status: 409, code: "REQUESTS_CLOSED" });
    });

    it("rejects requests for a match that isn't OPEN", async () => {
      const { player, match } = await setup();
      await db.updateTable("matches").set({ status: "CANCELLED" }).where("id", "=", match.id).execute();
      await expect(
        svc.createRequest({ matchId: match.id, userId: player.id })
      ).rejects.toMatchObject({ status: 409, code: "MATCH_NOT_OPEN" });
    });

    it("rejects banned players", async () => {
      const { player, match } = await setup();
      await db
        .insertInto("bans")
        .values({
          user_id: player.id,
          starts_at: new Date(),
          ends_at: new Date(Date.now() + 24 * 60 * MIN),
          reason: "test",
        })
        .execute();
      await expect(
        svc.createRequest({ matchId: match.id, userId: player.id })
      ).rejects.toMatchObject({ status: 403, code: "BANNED" });
    });

    it("returns 404 for an unknown match", async () => {
      const player = await createUser(db);
      await expect(
        svc.createRequest({ matchId: crypto.randomUUID(), userId: player.id })
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("listing requests", () => {
    it("shows the host live PENDING requests, oldest first, with name and rating", async () => {
      const { host, match } = await setup();
      const a = await createUser(db, { rating: 1000 });
      const b = await createUser(db, { rating: 1450 });
      const c = await createUser(db);
      const reqA = await svc.createRequest({ matchId: match.id, userId: a.id });
      const reqB = await svc.createRequest({ matchId: match.id, userId: b.id });
      const reqC = await svc.createRequest({ matchId: match.id, userId: c.id });
      await expireNow(db, reqC.id); // expired but not yet swept: must not show

      const list = await svc.listPendingRequests(match.id, host.id);

      expect(list.map((r) => r.id)).toEqual([reqA.id, reqB.id]);
      expect(list[0]).toMatchObject({ user_id: a.id, name: a.name, rating: 1000 });
      expect(list[1]).toMatchObject({ user_id: b.id, name: b.name, rating: 1450 });
    });

    it("is host only", async () => {
      const { player, match } = await setup();
      await expect(svc.listPendingRequests(match.id, player.id)).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe("accepting", () => {
    it("happy path: request -> accept -> JOINED, filled increments", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      const before = await getMatchState(db, match.id);

      const result = await svc.acceptRequest(request.id, host.id);

      expect(result).toEqual({ status: "JOINED" });
      const after = await getMatchState(db, match.id);
      expect(after.filled).toBe(before.filled + 1);
      expect(after.joinedCount).toBe(after.filled);
      expect(after.players).toContainEqual(
        expect.objectContaining({ user_id: player.id, status: "JOINED" })
      );
      const stored = await getRequest(db, request.id);
      expect(stored.status).toBe("ACCEPTED");
      expect(stored.decided_at).not.toBeNull();
    });

    it("copies the match's time range onto the player's row", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await svc.acceptRequest(request.id, host.id);

      const row = await db
        .selectFrom("match_players")
        .innerJoin("matches", "matches.id", "match_players.match_id")
        .select(["match_players.during as player_during", "matches.during as match_during"])
        .where("match_players.match_id", "=", match.id)
        .where("match_players.user_id", "=", player.id)
        .executeTakeFirstOrThrow();
      expect(row.player_during).toBe(row.match_during);
    });

    it("fails after expiry with no state change", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await expireNow(db, request.id);
      const before = await getMatchState(db, match.id);

      await expect(svc.acceptRequest(request.id, host.id)).rejects.toMatchObject({
        status: 409,
        code: "REQUEST_NOT_PENDING",
      });

      expect(await getMatchState(db, match.id)).toEqual(before);
      expect((await getRequest(db, request.id)).status).toBe("PENDING");
    });

    it("waitlists the player when the match is already full", async () => {
      const { host, player, match } = await setup({ capacity: 8 });
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await fillMatch(db, match.id, 0);

      const result = await svc.acceptRequest(request.id, host.id);

      expect(result).toEqual({ status: "WAITLISTED", position: 1 });
      const state = await getMatchState(db, match.id);
      expect(state.filled).toBe(state.capacity);
      expect(state.joinedCount).toBe(state.capacity);
      expect(state.players).toContainEqual(
        expect.objectContaining({ user_id: player.id, status: "WAITLISTED", waitlist_position: 1 })
      );
      expect((await getRequest(db, request.id)).status).toBe("ACCEPTED");
    });

    it("keeps the player's other pending requests when they are only waitlisted", async () => {
      const player = await createUser(db);
      const hostA = await createUser(db);
      const hostB = await createUser(db);
      const startsAt = new Date(Date.now() + 5 * 60 * MIN);
      const matchA = await createMatch(db, { hostId: hostA.id, startsAt, capacity: 8 });
      const matchB = await createMatch(db, {
        hostId: hostB.id,
        startsAt: new Date(startsAt.getTime() + 30 * MIN),
      });
      const reqA = await svc.createRequest({ matchId: matchA.id, userId: player.id });
      const reqB = await svc.createRequest({ matchId: matchB.id, userId: player.id });
      await fillMatch(db, matchA.id, 0);

      const result = await svc.acceptRequest(reqA.id, hostA.id);

      expect(result.status).toBe("WAITLISTED");
      expect((await getRequest(db, reqB.id)).status).toBe("PENDING");
    });

    it("withdraws the player's other pending requests that overlap in time", async () => {
      const player = await createUser(db);
      const hostA = await createUser(db);
      const hostB = await createUser(db);
      const hostC = await createUser(db);
      const startsAt = new Date(Date.now() + 5 * 60 * MIN);
      const matchA = await createMatch(db, { hostId: hostA.id, startsAt });
      // Starts 30 min into A: overlaps.
      const matchB = await createMatch(db, {
        hostId: hostB.id,
        startsAt: new Date(startsAt.getTime() + 30 * MIN),
      });
      // Starts exactly when A ends: ranges are half-open, so no overlap.
      const matchC = await createMatch(db, { hostId: hostC.id, startsAt: matchA.endsAt });

      const reqA = await svc.createRequest({ matchId: matchA.id, userId: player.id });
      const reqB = await svc.createRequest({ matchId: matchB.id, userId: player.id });
      const reqC = await svc.createRequest({ matchId: matchC.id, userId: player.id });

      await svc.acceptRequest(reqA.id, hostA.id);

      expect((await getRequest(db, reqA.id)).status).toBe("ACCEPTED");
      const b = await getRequest(db, reqB.id);
      expect(b.status).toBe("WITHDRAWN");
      expect(b.decided_at).not.toBeNull();
      expect((await getRequest(db, reqC.id)).status).toBe("PENDING");
    });

    it("maps the player-overlap constraint to 409 and rolls the accept back", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      // Player gets into an overlapping match some other way (open join),
      // so their request is still PENDING when the host accepts.
      const otherHost = await createUser(db);
      const other = await createMatch(db, {
        hostId: otherHost.id,
        startsAt: match.startsAt,
        joinMode: "OPEN",
      });
      const { joinOpenMatch } = await import("../../src/modules/matches/join.js");
      await joinOpenMatch(other.id, player.id);
      const before = await getMatchState(db, match.id);

      await expect(svc.acceptRequest(request.id, host.id)).rejects.toMatchObject({
        status: 409,
        code: "PLAYER_OVERLAP",
      });

      expect(await getMatchState(db, match.id)).toEqual(before);
      expect((await getRequest(db, request.id)).status).toBe("PENDING");
    });

    it("lets a player who left the match be accepted again", async () => {
      const { host, player, match } = await setup();
      const first = await svc.createRequest({ matchId: match.id, userId: player.id });
      await svc.acceptRequest(first.id, host.id);
      await leaveMatch(db, match.id, player.id);

      const second = await svc.createRequest({ matchId: match.id, userId: player.id });
      expect(await svc.acceptRequest(second.id, host.id)).toEqual({ status: "JOINED" });

      const state = await getMatchState(db, match.id);
      expect(state.joinedCount).toBe(state.filled);
      expect(state.players.filter((p) => p.user_id === player.id)).toEqual([
        expect.objectContaining({ status: "JOINED" }),
      ]);
    });

    it("is host only", async () => {
      const { player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await expect(svc.acceptRequest(request.id, player.id)).rejects.toMatchObject({
        status: 403,
      });
      expect((await getRequest(db, request.id)).status).toBe("PENDING");
    });

    it("returns 404 for an unknown request", async () => {
      const host = await createUser(db);
      await expect(svc.acceptRequest(crypto.randomUUID(), host.id)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe("rejecting and withdrawing", () => {
    it("reject moves PENDING to REJECTED; deciding again fails", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });

      const rejected = await svc.rejectRequest(request.id, host.id);
      expect(rejected.status).toBe("REJECTED");

      await expect(svc.rejectRequest(request.id, host.id)).rejects.toMatchObject({
        status: 409,
        code: "REQUEST_NOT_PENDING",
      });
      await expect(svc.acceptRequest(request.id, host.id)).rejects.toMatchObject({
        status: 409,
      });
      expect((await getRequest(db, request.id)).status).toBe("REJECTED");
    });

    it("only the host can reject", async () => {
      const { player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await expect(svc.rejectRequest(request.id, player.id)).rejects.toMatchObject({
        status: 403,
      });
    });

    it("withdraw moves PENDING to WITHDRAWN; deciding again fails", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });

      const withdrawn = await svc.withdrawRequest(request.id, player.id);
      expect(withdrawn.status).toBe("WITHDRAWN");

      await expect(svc.withdrawRequest(request.id, player.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(svc.acceptRequest(request.id, host.id)).rejects.toMatchObject({
        status: 409,
      });
      expect((await getRequest(db, request.id)).status).toBe("WITHDRAWN");
    });

    it("only the requester can withdraw", async () => {
      const { host, player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });
      await expect(svc.withdrawRequest(request.id, host.id)).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe("expiry job update", () => {
    it("does nothing before expires_at, then expires the request", async () => {
      const { player, match } = await setup();
      const request = await svc.createRequest({ matchId: match.id, userId: player.id });

      expect(await svc.expireRequest(request.id)).toBe(false);
      expect((await getRequest(db, request.id)).status).toBe("PENDING");

      await expireNow(db, request.id);
      expect(await svc.expireRequest(request.id)).toBe(true);
      expect((await getRequest(db, request.id)).status).toBe("EXPIRED");

      // A duplicate or retried job is a no-op.
      expect(await svc.expireRequest(request.id)).toBe(false);
    });
  });
});
