import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { Errors } from "../../lib/errors.js";
import { isPgError, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION } from "../../lib/pg.js";

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
        // (user_id, during) WHERE status = 'JOINED' rejects this insert if
        // the player is already in another match at an overlapping time,
        // which rolls back step 1 automatically.
        await trx
          .insertInto("match_players")
          .values({
            match_id: matchId,
            user_id: userId,
            team: null,
            slot_code: null,
            status: "JOINED",
            during: sql<string>`(SELECT during FROM matches WHERE id = ${matchId})`,
            waitlist_position: null,
            offer_expires_at: null,
          })
          .execute();

        return { status: "JOINED" };
      }
    }

    return await waitlist(trx, matchId, userId);
  } catch (err) {
    if (!isPgError(err)) throw err;
    if (err.code === PG_EXCLUSION_VIOLATION && err.constraint === "match_players_no_overlap") {
      throw Errors.playerOverlap();
    }
    if (err.code === PG_UNIQUE_VIOLATION && err.constraint === "match_players_pk") {
      throw Errors.alreadyInMatch();
    }
    throw err;
  }
}

async function waitlist(trx: Kysely<DB>, matchId: string, userId: string): Promise<JoinResult> {
  // Counting and then inserting is a race: two requests can both count
  // 5 and both take position 6. Locking the match row makes concurrent
  // waitlist inserts for the same match run one at a time, so each one
  // sees the previous one's row. Other matches are unaffected.
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

  const { count } = await trx
    .selectFrom("match_players")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("match_id", "=", matchId)
    .where("status", "=", "WAITLISTED")
    .executeTakeFirstOrThrow();

  const position = Number(count) + 1;

  await trx
    .insertInto("match_players")
    .values({
      match_id: matchId,
      user_id: userId,
      team: null,
      slot_code: null,
      status: "WAITLISTED",
      during: null,
      waitlist_position: position,
      offer_expires_at: null,
    })
    .execute();

  return { status: "WAITLISTED", position };
}
