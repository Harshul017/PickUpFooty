import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";

/** End of the user's active ban, or null if they aren't banned right now. */
export async function findActiveBan(
  userId: string,
  executor: Kysely<DB> = db
): Promise<Date | null> {
  const activeBan = await executor
    .selectFrom("bans")
    .select("ends_at")
    .where("user_id", "=", userId)
    .where("ends_at", ">", sql<Date>`now()`)
    .orderBy("ends_at", "desc")
    .executeTakeFirst();
  return activeBan ? new Date(activeBan.ends_at as unknown as string) : null;
}

/** Throws BANNED if the user has a ban that hasn't ended yet. */
export async function assertNotBanned(userId: string): Promise<void> {
  const until = await findActiveBan(userId);
  if (until) throw Errors.banned(until);
}
