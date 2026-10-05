import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { toTsRange, validCreationWindow } from "../../lib/time.js";

export interface CreateMatchInput {
  hostId: string;
  pitchId: string;
  formatId?: string;
  playersPerSide: number;
  subsPerSide?: number;
  startsAt: Date;
  durationMin: number;
  joinMode: "OPEN" | "APPROVAL";
  minRating?: number;
  maxRating?: number;
}

// Postgres unique_violation / exclusion_violation SQLSTATE.
const PG_EXCLUSION_VIOLATION = "23P01";

export async function createMatch(input: CreateMatchInput) {
  if (!validCreationWindow(input.startsAt)) {
    throw Errors.badRequest(
      "Matches must start at least 2 hours and at most 14 days from now"
    );
  }

  const pitch = await db
    .selectFrom("pitches")
    .selectAll()
    .where("id", "=", input.pitchId)
    .executeTakeFirst();
  if (!pitch) throw Errors.notFound("Pitch");
  if (input.playersPerSide > pitch.max_players_per_side) {
    throw Errors.badRequest(
      `This pitch supports at most ${pitch.max_players_per_side} players per side`
    );
  }

  const endsAt = new Date(input.startsAt.getTime() + input.durationMin * 60_000);
  const during = toTsRange(input.startsAt, endsAt);
  const subsPerSide = input.subsPerSide ?? 0;
  const capacity = 2 * input.playersPerSide + 2 * subsPerSide;

  try {
    return await db.transaction().execute(async (trx) => {
      // The organizer's own spot is taken atomically in the same
      // transaction as creating the match, using the same conditional
      // pattern every join uses (see modules/matches/join.ts once built).
      const match = await trx
        .insertInto("matches")
        .values({
          host_id: input.hostId,
          pitch_id: input.pitchId,
          format_id: input.formatId ?? null,
          formation_id: null,
          players_per_side: input.playersPerSide,
          subs_per_side: subsPerSide,
          capacity,
          filled: 1,
          join_mode: input.joinMode,
          min_rating: input.minRating ?? null,
          max_rating: input.maxRating ?? null,
          status: "OPEN",
          // Cast to the range type; the EXCLUDE constraint on
          // (pitch_id, during) is what actually prevents the clash.
          during: sql<string>`${during}::tstzrange`,
        })
        .returning(["id", "capacity", "filled", "status", "during"])
        .executeTakeFirstOrThrow();

      // The organizer's spot (filled = 1 above) must be a real row, so that
      // `filled` always equals the number of JOINED players. The exclusion
      // constraint also stops a host from creating two overlapping matches.
      await trx
        .insertInto("match_players")
        .values({
          match_id: match.id,
          user_id: input.hostId,
          team: null,
          slot_code: null,
          status: "JOINED",
          during: sql<string>`${during}::tstzrange`,
          waitlist_position: null,
          offer_expires_at: null,
        })
        .execute();

      return match;
    });
  } catch (err) {
    // Two different exclusion constraints can fire here; the constraint
    // name tells us which rule was broken.
    if (isPgError(err) && err.code === PG_EXCLUSION_VIOLATION) {
      if (err.constraint === "match_players_no_overlap") throw Errors.playerOverlap();
      throw Errors.pitchClash();
    }
    throw err;
  }
}

function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === "object" && err !== null && "code" in err;
}

export async function listUpcomingMatches(params: {
  cursor?: string;
  limit?: number;
  format?: string;
}) {
  let query = db
    .selectFrom("matches")
    .selectAll()
    .where("status", "=", "OPEN")
    .orderBy(sql`lower(during)`, "asc")
    .limit(params.limit ?? 20);

  if (params.format) {
    query = query.where("format_id", "=", params.format);
  }
  // Keyset pagination on the range's lower bound avoids the cost of large
  // OFFSETs; the cursor is the ISO start time of the last row on the
  // previous page.
  if (params.cursor) {
    query = query.where(sql<boolean>`lower(during) > ${params.cursor}::timestamptz`);
  }

  return query.execute();
}
