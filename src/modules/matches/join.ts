import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { isBeforeJoinCutoff } from "../../lib/time.js";
import { assertNotBanned } from "../discipline/service.js";
import { takeSpotOrWaitlist, type JoinResult } from "./spots.js";

export type { JoinResult } from "./spots.js";

/**
 * Join an OPEN match. This is the flow the concurrency tests target:
 * hundreds of simultaneous calls with one spot left must produce exactly
 * one JOINED result and the rest WAITLISTED, with `matches.filled` always
 * equal to the number of JOINED rows.
 */
export async function joinOpenMatch(matchId: string, userId: string): Promise<JoinResult> {
  await assertNotBanned(userId);

  const match = await db
    .selectFrom("matches")
    .selectAll()
    .where("id", "=", matchId)
    .executeTakeFirst();
  if (!match) throw Errors.notFound("Match");
  if (match.join_mode !== "OPEN") {
    throw Errors.badRequest("This match requires a join request, not a direct join");
  }

  const startsAt = await lowerBoundOf(matchId);
  const tryJoin = isBeforeJoinCutoff(startsAt);

  return db
    .transaction()
    .execute((trx) => takeSpotOrWaitlist(trx, matchId, userId, { tryJoin }));
}

async function lowerBoundOf(matchId: string): Promise<Date> {
  const row = await db
    .selectFrom("matches")
    .select(sql<string>`lower(during)`.as("starts_at"))
    .where("id", "=", matchId)
    .executeTakeFirstOrThrow();
  return new Date(row.starts_at);
}
