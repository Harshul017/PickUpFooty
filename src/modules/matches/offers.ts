import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { RULES, isWaitlistFrozen } from "../../lib/time.js";

export interface Offer {
  userId: string;
  expiresAt: Date;
}

/**
 * A spot in the match has just been vacated. Either hand it to the player
 * at the front of the waitlist as a timed offer, or give it back to the
 * match so anyone can take it.
 *
 * `matches.filled` is deliberately left alone when an offer is made: the
 * spot moves from the leaver to the offered player, and an OFFERED row
 * counts towards `filled` exactly like a JOINED one. That is what stops a
 * passer-by taking the spot while the first player in line is deciding.
 *
 * Must be called inside a transaction that already holds the match row
 * lock, so two players leaving at the same moment can't both be handed the
 * same waitlisted player.
 */
export async function releaseSpot(
  trx: Kysely<DB>,
  matchId: string,
  startsAt: Date
): Promise<Offer | null> {
  // Close to kickoff there is no point starting a ten-minute clock, so the
  // waitlist freezes and the spot simply goes back to the match.
  if (!isWaitlistFrozen(startsAt)) {
    const next = await trx
      .selectFrom("match_players")
      .select("user_id")
      .where("match_id", "=", matchId)
      .where("status", "=", "WAITLISTED")
      .orderBy("waitlist_position", "asc")
      .limit(1)
      .executeTakeFirst();

    if (next) {
      const offered = await trx
        .updateTable("match_players")
        .set({
          status: "OFFERED",
          // The deadline comes from the database clock, never the API
          // server's, so every later comparison against now() agrees.
          offer_expires_at: sql<Date>`now() + make_interval(mins => ${RULES.WAITLIST_OFFER_WINDOW_MIN})`,
          waitlist_position: null,
        })
        .where("match_id", "=", matchId)
        .where("user_id", "=", next.user_id)
        .where("status", "=", "WAITLISTED")
        .returning(["user_id", "offer_expires_at"])
        .executeTakeFirst();

      if (offered?.offer_expires_at) {
        return {
          userId: offered.user_id,
          expiresAt: new Date(offered.offer_expires_at as unknown as string),
        };
      }
    }
  }

  await trx
    .updateTable("matches")
    .set({ filled: (eb) => eb("filled", "-", 1) })
    .where("id", "=", matchId)
    .where((eb) => eb("filled", ">", 0))
    .execute();

  return null;
}
