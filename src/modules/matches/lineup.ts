import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { isPgError, PG_UNIQUE_VIOLATION } from "../../lib/pg.js";

export type Team = "A" | "B";

export interface LineupPlayer {
  userId: string;
  name: string;
  rating: number | null;
}

export interface LineupSlot {
  team: Team;
  slotCode: string;
  role: string;
  x: number;
  y: number;
  player: LineupPlayer | null;
}

export interface Lineup {
  formation: { id: string; name: string; playersPerSide: number } | null;
  slots: LineupSlot[];
  /** Confirmed players who aren't standing anywhere yet. */
  unassigned: LineupPlayer[];
}

const TEAMS: Team[] = ["A", "B"];

/**
 * Which formation this match is played in.
 *
 * A host who never picks one still gets a sensible pitch, because any
 * template matching the match's size will do. Resolving on read rather
 * than stamping a default at creation keeps a host's explicit choice
 * distinguishable from "nobody chose".
 */
async function resolveFormation(trx: Kysely<DB>, match: { formation_id: string | null; players_per_side: number }) {
  const query = trx
    .selectFrom("formation_templates")
    .select(["id", "name", "players_per_side"]);

  const template = match.formation_id
    ? await query.where("id", "=", match.formation_id).executeTakeFirst()
    : await query
        .where("players_per_side", "=", match.players_per_side)
        .orderBy("name")
        .executeTakeFirst();

  return template ?? null;
}

async function loadMatch(trx: Kysely<DB>, matchId: string) {
  const match = await trx
    .selectFrom("matches")
    .select(["id", "host_id", "status", "formation_id", "players_per_side"])
    .where("id", "=", matchId)
    .executeTakeFirst();
  if (!match) throw Errors.notFound("Match");
  return match;
}

/** The pitch as it stands: every position, who is in it, and who is spare. */
export async function getLineup(matchId: string): Promise<Lineup> {
  const match = await loadMatch(db, matchId);
  const formation = await resolveFormation(db, match);

  const players = await db
    .selectFrom("match_players")
    .innerJoin("users", "users.id", "match_players.user_id")
    .leftJoin("player_ratings", "player_ratings.user_id", "match_players.user_id")
    .select([
      "match_players.user_id as userId",
      "users.name as name",
      "player_ratings.rating as rating",
      "match_players.team as team",
      "match_players.slot_code as slotCode",
    ])
    .where("match_players.match_id", "=", matchId)
    .where("match_players.status", "=", "JOINED")
    .execute();

  if (!formation) {
    return {
      formation: null,
      slots: [],
      unassigned: players.map((p) => ({ userId: p.userId, name: p.name, rating: p.rating })),
    };
  }

  const templateSlots = await db
    .selectFrom("formation_slots")
    .select(["slot_code", "role", "x", "y"])
    .where("template_id", "=", formation.id)
    .orderBy("slot_code")
    .execute();

  const slots: LineupSlot[] = [];
  for (const team of TEAMS) {
    for (const slot of templateSlots) {
      const occupant = players.find((p) => p.team === team && p.slotCode === slot.slot_code);
      slots.push({
        team,
        slotCode: slot.slot_code,
        role: slot.role,
        x: slot.x,
        y: slot.y,
        player: occupant
          ? { userId: occupant.userId, name: occupant.name, rating: occupant.rating }
          : null,
      });
    }
  }

  return {
    formation: {
      id: formation.id,
      name: formation.name,
      playersPerSide: formation.players_per_side,
    },
    slots,
    unassigned: players
      .filter((p) => p.slotCode === null)
      .map((p) => ({ userId: p.userId, name: p.name, rating: p.rating })),
  };
}

/** Host picks the shape the teams play in. */
export async function setFormation(matchId: string, hostId: string, formationId: string) {
  return db.transaction().execute(async (trx) => {
    const match = await loadMatch(trx, matchId);
    if (match.host_id !== hostId) throw Errors.forbidden("Only the organizer can set the formation");
    if (match.status !== "OPEN" && match.status !== "FULL") throw Errors.matchNotOpen();

    const template = await trx
      .selectFrom("formation_templates")
      .select(["id", "players_per_side"])
      .where("id", "=", formationId)
      .executeTakeFirst();
    if (!template) throw Errors.notFound("Formation");
    if (template.players_per_side !== match.players_per_side) {
      throw Errors.badRequest(
        `That formation is for ${template.players_per_side}-a-side, but this match is ${match.players_per_side}`
      );
    }

    // Positions from the old formation may not exist in the new one, so
    // everyone steps off the pitch rather than being left in a slot that
    // no longer means anything. They stay in the match.
    await trx
      .updateTable("match_players")
      .set({ team: null, slot_code: null })
      .where("match_id", "=", matchId)
      .execute();

    await trx
      .updateTable("matches")
      .set({ formation_id: formationId })
      .where("id", "=", matchId)
      .execute();
  });
}

/**
 * Put a confirmed player in a position.
 *
 * `actorId` is whoever is asking: a player may only move themselves, the
 * host may move anyone. Beyond that the two cases are identical, so they
 * share this one path rather than drifting apart over time.
 */
export async function placeInSlot(input: {
  matchId: string;
  actorId: string;
  userId: string;
  team: Team;
  slotCode: string;
}) {
  const { matchId, actorId, userId, team, slotCode } = input;

  return db.transaction().execute(async (trx) => {
    const match = await loadMatch(trx, matchId);
    if (match.status !== "OPEN" && match.status !== "FULL") throw Errors.matchNotOpen();
    if (userId !== actorId && match.host_id !== actorId) {
      throw Errors.forbidden("Only the organizer can move another player");
    }

    const formation = await resolveFormation(trx, match);
    if (!formation) throw Errors.noFormation();

    const slot = await trx
      .selectFrom("formation_slots")
      .select("slot_code")
      .where("template_id", "=", formation.id)
      .where("slot_code", "=", slotCode)
      .executeTakeFirst();
    if (!slot) throw Errors.unknownSlot(slotCode);

    try {
      const moved = await trx
        .updateTable("match_players")
        .set({ team, slot_code: slotCode })
        .where("match_id", "=", matchId)
        .where("user_id", "=", userId)
        .where("status", "=", "JOINED")
        .returning("user_id")
        .executeTakeFirst();

      if (!moved) throw Errors.notInMatch();
    } catch (err) {
      // The partial unique index on (match, team, slot) is what decides
      // who gets a contested position; two players tapping the same one
      // at the same moment can't both land in it.
      if (isPgError(err) && err.code === PG_UNIQUE_VIOLATION) throw Errors.slotTaken();
      throw err;
    }

    return { matchId, userId, team, slotCode };
  });
}

/** Step off the pitch but stay in the match. */
export async function clearSlot(matchId: string, actorId: string, userId: string) {
  return db.transaction().execute(async (trx) => {
    const match = await loadMatch(trx, matchId);
    if (match.status !== "OPEN" && match.status !== "FULL") throw Errors.matchNotOpen();
    if (userId !== actorId && match.host_id !== actorId) {
      throw Errors.forbidden("Only the organizer can move another player");
    }

    const cleared = await trx
      .updateTable("match_players")
      .set({ team: null, slot_code: null })
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .where("status", "=", "JOINED")
      .returning("user_id")
      .executeTakeFirst();

    if (!cleared) throw Errors.notInMatch();
  });
}
