import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { Errors } from "../../lib/errors.js";
import { isPgError, PG_EXCLUSION_VIOLATION } from "../../lib/pg.js";

export type JoinResult =
  | { status: "JOINED" }
  | { status: "WAITLISTED"; position: number };

/**
 * Put a player into a match: take a spot if one is free, otherwise add them
 * to the end of the waitlist. Shared by open joins and accepted requests.
 *
 * Must be called inside a transaction (`trx`), so a constraint violation
 * here rolls back everything the caller did before it, including the spot.
 * Pass `tryJoin: false` to go straight to the waitlist (e.g. past the
 * open-join cutoff).
 */
export async function takeSpotOrWaitlist(
  trx: Kysely<DB>,
  matchId: string,
  userId: string,
  opts: { tryJoin: boolean }
): Promise<JoinResult> {
  try {
    if (opts.tryJoin) {
      // Step 1: take a spot only if one is free. Zero rows back means
      // someone else took the last spot between our read and this write.
      const claimed = await trx
        .updateTable("matches")
        .set({
          filled: (eb) => eb("filled", "+", 1),
          version: (eb) => eb("version", "+", 1),
        })
        .where("id", "=", matchId)
        .where("status", "=", "OPEN")
        .where((eb) => eb("filled", "<", eb.ref("capacity")))
        .returning("id")
        .executeTakeFirst();

      if (claimed) {
        // Step 2: add the player. The exclusion constraint on
        // (user_id, during) WHERE status = 'JOINED' rejects this if the
        // player is already in another match at an overlapping time,
        // which rolls back step 1 automatically.
        await seat(trx, matchId, userId, { status: "JOINED" });

        return { status: "JOINED" };
      }
    }

    return await waitlist(trx, matchId, userId);
  } catch (err) {
    if (!isPgError(err)) throw err;
    if (err.code === PG_EXCLUSION_VIOLATION && err.constraint === "match_players_no_overlap") {
      throw Errors.playerOverlap();
    }
    throw err;
  }
}

async function waitlist(trx: Kysely<DB>, matchId: string, userId: string): Promise<JoinResult> {
  // Reading the last position and then inserting is a race: two requests
  // can both read 5 and both take position 6. Locking the match row makes
  // concurrent waitlist inserts for the same match run one at a time, so
  // each one sees the previous one's row. Other matches are unaffected.
  const match = await trx
    .selectFrom("matches")
    .select("status")
    .where("id", "=", matchId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  // The claim above also fails for a cancelled or finished match; that
  // must not quietly land the player on a waitlist that will never move.
  if (match.status !== "OPEN" && match.status !== "FULL") {
    throw Errors.matchNotOpen();
  }

  // MAX, not COUNT: once someone leaves the waitlist the positions have a
  // gap, and COUNT + 1 would hand out a position that's still taken.
  const { last } = await trx
    .selectFrom("match_players")
    .select((eb) => eb.fn.max("waitlist_position").as("last"))
    .where("match_id", "=", matchId)
    .where("status", "=", "WAITLISTED")
    .executeTakeFirstOrThrow();

  const position = (last ?? 0) + 1;

  await seat(trx, matchId, userId, { status: "WAITLISTED", position });

  return { status: "WAITLISTED", position };
}

/**
 * Write the player's match_players row. The primary key is (match, player),
 * so a player who left this match earlier still has a CANCELLED row; that
 * row is brought back instead of inserting a second one. Their conduct
 * history lives in other tables and is untouched. Any other existing row
 * (JOINED, WAITLISTED, ...) means they're already in, and nothing is written.
 */
async function seat(
  trx: Kysely<DB>,
  matchId: string,
  userId: string,
  spot: { status: "JOINED" } | { status: "WAITLISTED"; position: number }
): Promise<void> {
  const during =
    spot.status === "JOINED"
      ? sql<string>`(SELECT during FROM matches WHERE id = ${matchId})`
      : null;
  const waitlistPosition = spot.status === "WAITLISTED" ? spot.position : null;

  const row = await trx
    .insertInto("match_players")
    .values({
      match_id: matchId,
      user_id: userId,
      team: null,
      slot_code: null,
      status: spot.status,
      during,
      waitlist_position: waitlistPosition,
      offer_expires_at: null,
    })
    .onConflict((oc) =>
      oc
        .columns(["match_id", "user_id"])
        .doUpdateSet({
          status: spot.status,
          team: null,
          slot_code: null,
          during,
          waitlist_position: waitlistPosition,
          offer_expires_at: null,
          joined_at: sql<Date>`now()`,
        })
        .where("match_players.status", "=", "CANCELLED")
    )
    .returning("user_id")
    .executeTakeFirst();

  if (!row) throw Errors.alreadyInMatch();
}
