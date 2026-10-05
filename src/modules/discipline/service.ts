import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";

/** Throws BANNED if the user has a ban that hasn't ended yet. */
export async function assertNotBanned(userId: string): Promise<void> {
  const activeBan = await db
    .selectFrom("bans")
    .select("ends_at")
    .where("user_id", "=", userId)
    .where("ends_at", ">", new Date())
    .executeTakeFirst();
  if (activeBan) {
    throw Errors.banned(new Date(activeBan.ends_at as unknown as string));
  }
}
