import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { isBeforeJoinCutoff } from "../../lib/time.js";

const PG_EXCLUSION_VIOLATION = "23P01";
const PG_UNIQUE_VIOLATION = "23505";

export type JoinResult =
  | { status: "JOINED" }
  | { status: "WAITLISTED"; position: number };

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
  if (!isBeforeJoinCutoff(startsAt)) {
    return waitlist(matchId, userId);
  }

  const outcome = await db.transaction().execute(async (trx) => {
    try {
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

      if (!claimed) {
        return "FULL" as const;
      }

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

      return "JOINED" as const;
    } catch (err) {
      if (isPgError(err) && err.code === PG_EXCLUSION_VIOLATION) {
        throw Errors.playerOverlap();
      }
      if (isPgError(err) && err.code === PG_UNIQUE_VIOLATION) {
        throw Errors.conflict("Already joined this match");
      }
      throw err;
    }
  });

  if (outcome === "FULL") {
    return waitlist(matchId, userId);
  }
  return { status: "JOINED" };
}

async function waitlist(matchId: string, userId: string): Promise<JoinResult> {
  return db.transaction().execute(async (trx) => {
    // Counting and then inserting is a race: two requests can both count
    // 5 and both take position 6. Locking the match row makes concurrent
    // waitlist inserts for the same match run one at a time, so each one
    // sees the previous one's row. Other matches are unaffected.
    await trx
      .selectFrom("matches")
      .select("id")
      .where("id", "=", matchId)
      .forUpdate()
      .executeTakeFirstOrThrow();

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

    return { status: "WAITLISTED", position } satisfies JoinResult;
  });
}

async function lowerBoundOf(matchId: string): Promise<Date> {
  const row = await db
    .selectFrom("matches")
    .select(sql<string>`lower(during)`.as("starts_at"))
    .where("id", "=", matchId)
    .executeTakeFirstOrThrow();
  return new Date(row.starts_at);
}

async function assertNotBanned(userId: string): Promise<void> {
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

function isPgError(err: unknown): err is { code: string } {
  return typeof err === "object" && err !== null && "code" in err;
}
