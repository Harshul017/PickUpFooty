import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { isPgError, PG_EXCLUSION_VIOLATION } from "../../lib/pg.js";
import { releaseSpot, type Offer } from "./offers.js";

export interface OfferOutcome {
  /** The player's own result. */
  status: "JOINED" | "DECLINED" | "EXPIRED";
  /** Set when the spot moved on to the next player in line. */
  offer: Offer | null;
}

/**
 * Lock the match and read the player's live offer, or throw.
 *
 * "Live" is judged by the database clock: an offer whose deadline has
 * passed is already dead, whether or not the expiry job has got round to
 * marking it. That is what keeps the job a convenience rather than the
 * thing correctness depends on.
 */
async function lockLiveOffer(trx: Kysely<DB>, matchId: string, userId: string) {
  const match = await trx
    .selectFrom("matches")
    .select(["id", "status", sql<string>`lower(during)`.as("starts_at")])
    .where("id", "=", matchId)
    .forUpdate()
    .executeTakeFirst();

  if (!match) throw Errors.notFound("Match");
  if (match.status !== "OPEN" && match.status !== "FULL") throw Errors.matchNotOpen();

  const offer = await trx
    .selectFrom("match_players")
    .select("status")
    .where("match_id", "=", matchId)
    .where("user_id", "=", userId)
    .where("status", "=", "OFFERED")
    .where("offer_expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();

  if (!offer) throw Errors.noLiveOffer();

  return { startsAt: new Date(match.starts_at) };
}

/**
 * Take the spot that was offered. The row is already counted in
 * `matches.filled`, so this only has to change the state and stamp the
 * match's time range on it.
 */
export async function confirmOffer(matchId: string, userId: string): Promise<OfferOutcome> {
  return db.transaction().execute(async (trx) => {
    await lockLiveOffer(trx, matchId, userId);

    try {
      await trx
        .updateTable("match_players")
        .set({
          status: "JOINED",
          offer_expires_at: null,
          during: sql<string>`(SELECT during FROM matches WHERE id = ${matchId})`,
        })
        .where("match_id", "=", matchId)
        .where("user_id", "=", userId)
        .where("status", "=", "OFFERED")
        .execute();
    } catch (err) {
      // The player joined a clashing match while this offer was open. The
      // whole transaction rolls back, so the offer stays live: they can
      // still leave the other match and confirm, and if they don't, it
      // lapses on its own. Better than deciding for them.
      if (isPgError(err) && err.code === PG_EXCLUSION_VIOLATION) {
        throw Errors.playerOverlap();
      }
      throw err;
    }

    return { status: "JOINED", offer: null };
  });
}

/** Turn the offer down. The spot goes to whoever is next. */
export async function declineOffer(matchId: string, userId: string): Promise<OfferOutcome> {
  return db.transaction().execute(async (trx) => {
    const { startsAt } = await lockLiveOffer(trx, matchId, userId);

    await trx
      .updateTable("match_players")
      .set({ status: "CANCELLED", offer_expires_at: null, waitlist_position: null })
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .where("status", "=", "OFFERED")
      .execute();

    return { status: "DECLINED", offer: await releaseSpot(trx, matchId, startsAt) };
  });
}

/**
 * Reclaim one offer whose window has closed and pass the spot on.
 *
 * Safe to run twice, late, or never: the `offer_expires_at <= now()` guard
 * means a second run finds nothing to do, and every other query already
 * treats a lapsed offer as dead. Returns null when there was nothing to
 * reclaim, which is the normal case for a duplicate delivery.
 */
export async function expireOffer(matchId: string, userId: string): Promise<OfferOutcome | null> {
  return db.transaction().execute(async (trx) => {
    const match = await trx
      .selectFrom("matches")
      .select(["id", sql<string>`lower(during)`.as("starts_at")])
      .where("id", "=", matchId)
      .forUpdate()
      .executeTakeFirst();

    if (!match) return null;

    const lapsed = await trx
      .updateTable("match_players")
      .set({ status: "CANCELLED", offer_expires_at: null, waitlist_position: null })
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .where("status", "=", "OFFERED")
      .where("offer_expires_at", "<=", sql<Date>`now()`)
      .returning("user_id")
      .executeTakeFirst();

    if (!lapsed) return null;

    const offer = await releaseSpot(trx, matchId, new Date(match.starts_at));
    return { status: "EXPIRED", offer };
  });
}
