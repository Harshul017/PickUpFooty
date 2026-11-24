import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { startTestDatabase, type TestDatabase } from "../helpers/db.js";
import { createMatch, createUser, seatPlayer } from "../helpers/fixtures.js";

type LineupModule = typeof import("../../src/modules/matches/lineup.js");

/**
 * Putting confirmed players into positions on the pitch.
 */
describe("lineup", () => {
  let testDb: TestDatabase;
  let db: Kysely<DB>;
  let lineup: LineupModule;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    ({ db } = await import("../../src/lib/db.js"));
    lineup = await import("../../src/modules/matches/lineup.js");
  });

  afterAll(async () => {
    await db?.destroy();
    await testDb?.stop();
  });

  /** A 5-a-side match with the host and one confirmed player. */
  async function match5v5() {
    const host = await createUser(db);
    const m = await createMatch(db, { hostId: host.id, joinMode: "OPEN", capacity: 10 });
    const player = await createUser(db);
    await seatPlayer(db, m.id, player.id);
    return { host, match: m, player };
  }

  describe("reading the pitch", () => {
    it("falls back to a formation that fits the match size", async () => {
      const { match, host, player } = await match5v5();

      const result = await lineup.getLineup(match.id);

      expect(result.formation?.playersPerSide).toBe(5);
      expect(result.slots).toHaveLength(10); // five positions per side
      expect(result.slots.every((s) => s.player === null)).toBe(true);
      expect(result.unassigned.map((p) => p.userId).sort()).toEqual([host.id, player.id].sort());
    });

    it("has no positions at all when no formation fits the match size", async () => {
      const host = await createUser(db);
      // Four a side: there is no template for it.
      const odd = await createMatch(db, { hostId: host.id, joinMode: "OPEN", capacity: 8 });

      const result = await lineup.getLineup(odd.id);

      expect(result.formation).toBeNull();
      expect(result.slots).toEqual([]);
      expect(result.unassigned).toHaveLength(1);
    });
  });

  describe("taking a position", () => {
    it("lets a player claim an empty one and shows them standing in it", async () => {
      const { match, player } = await match5v5();

      await lineup.placeInSlot({
        matchId: match.id,
        actorId: player.id,
        userId: player.id,
        team: "A",
        slotCode: "GK",
      });

      const result = await lineup.getLineup(match.id);
      const gk = result.slots.find((s) => s.team === "A" && s.slotCode === "GK");
      expect(gk?.player?.userId).toBe(player.id);
      expect(result.unassigned.map((p) => p.userId)).not.toContain(player.id);
    });

    it("refuses a position someone else is already in", async () => {
      const { match, player, host } = await match5v5();
      await lineup.placeInSlot({
        matchId: match.id,
        actorId: player.id,
        userId: player.id,
        team: "A",
        slotCode: "GK",
      });

      await expect(
        lineup.placeInSlot({
          matchId: match.id,
          actorId: host.id,
          userId: host.id,
          team: "A",
          slotCode: "GK",
        })
      ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    });

    it("frees the old position when a player moves", async () => {
      const { match, player } = await match5v5();
      const place = (slotCode: string) =>
        lineup.placeInSlot({
          matchId: match.id,
          actorId: player.id,
          userId: player.id,
          team: "A",
          slotCode,
        });
      await place("GK");

      await place("FWD1");

      const result = await lineup.getLineup(match.id);
      expect(result.slots.find((s) => s.team === "A" && s.slotCode === "GK")?.player).toBeNull();
      expect(result.slots.find((s) => s.team === "A" && s.slotCode === "FWD1")?.player?.userId).toBe(
        player.id
      );
    });

    it("lets the same position be filled on each side", async () => {
      const { match, player, host } = await match5v5();

      await lineup.placeInSlot({
        matchId: match.id,
        actorId: player.id,
        userId: player.id,
        team: "A",
        slotCode: "GK",
      });
      await lineup.placeInSlot({
        matchId: match.id,
        actorId: host.id,
        userId: host.id,
        team: "B",
        slotCode: "GK",
      });

      const result = await lineup.getLineup(match.id);
      expect(result.slots.filter((s) => s.slotCode === "GK" && s.player !== null)).toHaveLength(2);
    });

    it("rejects a position the formation does not have", async () => {
      const { match, player } = await match5v5();

      await expect(
        lineup.placeInSlot({
          matchId: match.id,
          actorId: player.id,
          userId: player.id,
          team: "A",
          slotCode: "SWEEPER",
        })
      ).rejects.toMatchObject({ code: "UNKNOWN_SLOT" });
    });

    it("rejects someone who is not in the match", async () => {
      const { match } = await match5v5();
      const stranger = await createUser(db);

      await expect(
        lineup.placeInSlot({
          matchId: match.id,
          actorId: stranger.id,
          userId: stranger.id,
          team: "A",
          slotCode: "GK",
        })
      ).rejects.toMatchObject({ code: "NOT_IN_MATCH" });
    });
  });

  describe("who may move whom", () => {
    it("lets the organizer place another player", async () => {
      const { match, host, player } = await match5v5();

      await lineup.placeInSlot({
        matchId: match.id,
        actorId: host.id,
        userId: player.id,
        team: "B",
        slotCode: "MID1",
      });

      const result = await lineup.getLineup(match.id);
      expect(result.slots.find((s) => s.team === "B" && s.slotCode === "MID1")?.player?.userId).toBe(
        player.id
      );
    });

    it("stops a player moving somebody else", async () => {
      const { match, player } = await match5v5();
      const other = await createUser(db);
      await seatPlayer(db, match.id, other.id);

      await expect(
        lineup.placeInSlot({
          matchId: match.id,
          actorId: player.id,
          userId: other.id,
          team: "A",
          slotCode: "GK",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("lets a player step off the pitch without leaving the match", async () => {
      const { match, player } = await match5v5();
      await lineup.placeInSlot({
        matchId: match.id,
        actorId: player.id,
        userId: player.id,
        team: "A",
        slotCode: "GK",
      });

      await lineup.clearSlot(match.id, player.id, player.id);

      const result = await lineup.getLineup(match.id);
      expect(result.slots.every((s) => s.player === null)).toBe(true);
      expect(result.unassigned.map((p) => p.userId)).toContain(player.id);
    });
  });

  describe("choosing the formation", () => {
    async function templateFor(playersPerSide: number) {
      return db
        .selectFrom("formation_templates")
        .select("id")
        .where("players_per_side", "=", playersPerSide)
        .executeTakeFirstOrThrow();
    }

    it("stops anyone but the organizer changing it", async () => {
      const { match, player } = await match5v5();
      const template = await templateFor(5);

      await expect(lineup.setFormation(match.id, player.id, template.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("rejects a formation built for a different match size", async () => {
      const { match, host } = await match5v5();
      const elevenASide = await templateFor(11);

      await expect(lineup.setFormation(match.id, host.id, elevenASide.id)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("clears the pitch when the shape changes, keeping everyone in the match", async () => {
      const { match, host, player } = await match5v5();
      await lineup.placeInSlot({
        matchId: match.id,
        actorId: player.id,
        userId: player.id,
        team: "A",
        slotCode: "GK",
      });
      const template = await templateFor(5);

      await lineup.setFormation(match.id, host.id, template.id);

      const result = await lineup.getLineup(match.id);
      expect(result.slots.every((s) => s.player === null)).toBe(true);
      expect(result.unassigned.map((p) => p.userId)).toContain(player.id);
    });
  });
});
