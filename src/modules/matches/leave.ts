import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { isFreeCancelWindow } from "../../lib/time.js";
import { recordLateCancel } from "../discipline/service.js";
import type { PenaltyKind } from "../discipline/ladder.js";
import { releaseSpot, type Offer } from "./offers.js";

export interface LeaveResult {
  status: "CANCELLED";
  /** True when the player was holding a spot rather than waiting for one. */
  heldSpot: boolean;
  penalty: PenaltyKind | null;
  banEndsAt: Date | null;
  /** The waitlisted player who was handed the freed spot, if any. */
  offer: Offer | null;
}

/**
 * Leave a match.
 *
 * Three things have to happen together or not at all: the player's seat is
 * given up, any penalty is recorded, and the freed spot is passed to the
 * next player in line. One transaction covers all three, so a crash
 * halfway through can't leave a match holding a spot nobody owns, or
 * penalise a player whose exit was never recorded.
 */
export async function leaveMatch(matchId: string, userId: string): Promise<LeaveResult> {
  return db.transaction().execute(async (trx) => {
    // Locking the match first serialises everyone leaving the same match,
    // which is what lets the waitlist hand the spot to exactly one person.
    // Reading the player's row only makes sense once we hold it.
    const match = await trx
      .selectFrom("matches")
      .select(["id", "host_id", "status", sql<string>`lower(during)`.as("starts_at")])
      .where("id", "=", matchId)
      .forUpdate()
      .executeTakeFirst();

    if (!match) throw Errors.notFound("Match");
    if (match.status !== "OPEN" && match.status !== "FULL") throw Errors.matchNotOpen();
    if (match.host_id === userId) throw Errors.hostCannotLeave();

    const me = await trx
      .selectFrom("match_players")
      .select("status")
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    const leavable = me?.status === "JOINED" || me?.status === "OFFERED" || me?.status === "WAITLISTED";
    if (!leavable) throw Errors.notInMatch();

    await trx
      .updateTable("match_players")
      .set({
        status: "CANCELLED",
        during: null,
        waitlist_position: null,
        // Required by the paired check constraint: only an OFFERED row may
        // carry a deadline.
        offer_expires_at: null,
      })
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .execute();

    // Someone still waiting for a spot never had one, so there is nothing
    // to pass on and nothing to answer for.
    if (me.status === "WAITLISTED") {
      return { status: "CANCELLED", heldSpot: false, penalty: null, banEndsAt: null, offer: null };
    }

    const startsAt = new Date(match.starts_at);

    // An OFFERED player never confirmed, so they are walking away from an
    // offer rather than from a commitment. Only a seated player can be
    // late-cancelling.
    const penalised = me.status === "JOINED" && !isFreeCancelWindow(startsAt);
    const applied = penalised ? await recordLateCancel(trx, userId, matchId) : null;

    const offer = await releaseSpot(trx, matchId, startsAt);

    return {
      status: "CANCELLED",
      heldSpot: true,
      penalty: applied?.kind ?? null,
      banEndsAt: applied?.banEndsAt ?? null,
      offer,
    };
  });
}
