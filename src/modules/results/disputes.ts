import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";

export type DisputeOutcome = "DISMISSED" | "UPHELD";

/**
 * Object to a result before it becomes final.
 *
 * Only someone who was actually in the match may object, and only inside
 * the window. Raising a dispute freezes the result: the finalisation job
 * will no longer touch it, so it waits for a human either way.
 */
export async function raiseDispute(matchId: string, userId: string, reason: string) {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .selectFrom("match_results")
      .select(["match_id", "status", "dispute_deadline"])
      .where("match_id", "=", matchId)
      .forUpdate()
      .executeTakeFirst();

    if (!result) throw Errors.noResultYet();
    if (result.status === "FINALIZED") throw Errors.disputeWindowClosed();
    if (new Date(result.dispute_deadline as unknown as string) <= new Date()) {
      throw Errors.disputeWindowClosed();
    }

    const played = await trx
      .selectFrom("match_players")
      .select("user_id")
      .where("match_id", "=", matchId)
      .where("user_id", "=", userId)
      .where("status", "in", ["PLAYED", "NO_SHOW"])
      .executeTakeFirst();
    if (!played) throw Errors.notInMatch();

    const existing = await trx
      .selectFrom("disputes")
      .select("id")
      .where("match_id", "=", matchId)
      .where("raised_by", "=", userId)
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    if (existing) throw Errors.alreadyDisputed();

    const dispute = await trx
      .insertInto("disputes")
      .values({ match_id: matchId, raised_by: userId, reason, status: "OPEN" })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("match_results")
      .set({ status: "DISPUTED" })
      .where("match_id", "=", matchId)
      .execute();

    return dispute;
  });
}

/**
 * An admin settles it.
 *
 * Deliberately not the host: they submitted the result being argued
 * about, so letting them dismiss objections to it would make the window
 * decorative.
 *
 * Dismissed, the result stands and is finalised there and then — the
 * deadline has served its purpose and there is nothing left to wait for.
 * Upheld, the result and its stats are thrown away and everyone goes back
 * to being a confirmed player, so the host can submit a corrected one.
 */
export async function resolveDispute(input: {
  matchId: string;
  adminId: string;
  outcome: DisputeOutcome;
}) {
  const { matchId, adminId, outcome } = input;

  return db.transaction().execute(async (trx) => {
    const open = await trx
      .selectFrom("disputes")
      .select("id")
      .where("match_id", "=", matchId)
      .where("status", "=", "OPEN")
      .executeTakeFirst();
    if (!open) throw Errors.noOpenDispute();

    await trx
      .updateTable("disputes")
      .set({ status: "RESOLVED", resolved_by: adminId, resolved_at: sql<Date>`now()` })
      .where("match_id", "=", matchId)
      .where("status", "=", "OPEN")
      .execute();

    if (outcome === "DISMISSED") {
      await trx
        .updateTable("match_results")
        .set({ status: "FINALIZED", finalized_at: sql<Date>`now()` })
        .where("match_id", "=", matchId)
        .where("status", "=", "DISPUTED")
        .execute();
      return { outcome, resubmissionNeeded: false };
    }

    await trx.deleteFrom("player_match_stats").where("match_id", "=", matchId).execute();
    await trx.deleteFrom("match_results").where("match_id", "=", matchId).execute();
    await trx
      .updateTable("match_players")
      .set({ status: "JOINED" })
      .where("match_id", "=", matchId)
      .where("status", "in", ["PLAYED", "NO_SHOW"])
      .execute();

    return { outcome, resubmissionNeeded: true };
  });
}

/** Every objection raised about a match, for the admin reviewing it. */
export async function listDisputes(matchId: string) {
  return db
    .selectFrom("disputes")
    .innerJoin("users", "users.id", "disputes.raised_by")
    .select([
      "disputes.id as id",
      "disputes.raised_by as raisedBy",
      "users.name as raisedByName",
      "disputes.reason as reason",
      "disputes.status as status",
      "disputes.resolved_at as resolvedAt",
    ])
    .where("disputes.match_id", "=", matchId)
    .orderBy("disputes.id")
    .execute();
}
