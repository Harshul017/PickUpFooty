import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { RULES } from "../../lib/time.js";
import { decidePenalty, type PenaltyKind } from "./ladder.js";

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

/** What the ladder decided and recorded for one offence. */
export interface AppliedPenalty {
  kind: PenaltyKind;
  banEndsAt: Date | null;
}

/**
 * Record a late cancellation and apply the penalty ladder to it.
 *
 * Runs inside the caller's transaction, so the conduct event, the demerit
 * and the ban either all land or none do. The counting happens here and
 * the decision happens in ladder.ts, which keeps the rule itself free of
 * any database access.
 *
 * Every window is measured with the database clock. A client that lies
 * about the time cannot talk its way out of a penalty, and two API servers
 * with slightly different clocks still agree on the outcome.
 */
export async function recordLateCancel(
  trx: Kysely<DB>,
  userId: string,
  matchId: string
): Promise<AppliedPenalty> {
  const event = await trx
    .insertInto("conduct_events")
    .values({ user_id: userId, match_id: matchId, type: "LATE_CANCEL" })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Counted after the insert above, so the offence being judged is
  // included: a player's first ever late cancel arrives at the ladder as 1.
  const { count } = await trx
    .selectFrom("conduct_events")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("user_id", "=", userId)
    .where("type", "=", "LATE_CANCEL")
    .where(
      "created_at",
      ">",
      sql<Date>`now() - make_interval(days => ${RULES.DEMERIT_LOOKBACK_DAYS})`
    )
    .executeTakeFirstOrThrow();

  const { points } = await trx
    .selectFrom("demerits")
    .select(sql<string>`coalesce(sum(points), 0)`.as("points"))
    .where("user_id", "=", userId)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();

  const decision = decidePenalty({
    lateCancelsInWindow: Number(count),
    activeDemeritPoints: Number(points),
  });

  if (decision.demeritPoints > 0) {
    await trx
      .insertInto("demerits")
      .values({
        user_id: userId,
        conduct_event_id: event.id,
        points: decision.demeritPoints,
        expires_at: sql<Date>`now() + make_interval(days => ${RULES.DEMERIT_EXPIRY_DAYS})`,
      })
      .execute();
  }

  if (decision.banDays === 0) {
    return { kind: decision.kind, banEndsAt: null };
  }

  const ban = await trx
    .insertInto("bans")
    .values({
      user_id: userId,
      starts_at: sql<Date>`now()`,
      ends_at: sql<Date>`now() + make_interval(days => ${decision.banDays})`,
      reason: "Repeated late cancellations",
    })
    .returning("ends_at")
    .executeTakeFirstOrThrow();

  return { kind: decision.kind, banEndsAt: new Date(ban.ends_at as unknown as string) };
}

export interface DisciplineSummary {
  lateCancels30d: number;
  activeDemeritPoints: number;
  ban: { endsAt: Date; reason: string } | null;
  /** What a further late cancellation would cost, right now. */
  nextLateCancel: PenaltyKind;
  recentEvents: Array<{ type: string; matchId: string | null; at: Date }>;
}

/**
 * Everything a player is entitled to know about their own record.
 *
 * `nextLateCancel` runs the ladder without recording anything, so the app
 * can warn someone that this one costs them a ban before they tap the
 * button. A penalty system people can't see coming just feels arbitrary.
 */
export async function getDisciplineSummary(userId: string): Promise<DisciplineSummary> {
  const since = sql<Date>`now() - make_interval(days => ${RULES.DEMERIT_LOOKBACK_DAYS})`;

  const { count } = await db
    .selectFrom("conduct_events")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("user_id", "=", userId)
    .where("type", "=", "LATE_CANCEL")
    .where("created_at", ">", since)
    .executeTakeFirstOrThrow();

  const { points } = await db
    .selectFrom("demerits")
    .select(sql<string>`coalesce(sum(points), 0)`.as("points"))
    .where("user_id", "=", userId)
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();

  const ban = await db
    .selectFrom("bans")
    .select(["ends_at", "reason"])
    .where("user_id", "=", userId)
    .where("ends_at", ">", sql<Date>`now()`)
    .orderBy("ends_at", "desc")
    .executeTakeFirst();

  const recentEvents = await db
    .selectFrom("conduct_events")
    .select(["type", "match_id", "created_at"])
    .where("user_id", "=", userId)
    .where("created_at", ">", since)
    .orderBy("created_at", "desc")
    .limit(20)
    .execute();

  const lateCancels30d = Number(count);
  const activeDemeritPoints = Number(points);

  return {
    lateCancels30d,
    activeDemeritPoints,
    ban: ban
      ? { endsAt: new Date(ban.ends_at as unknown as string), reason: ban.reason }
      : null,
    nextLateCancel: decidePenalty({
      lateCancelsInWindow: lateCancels30d + 1,
      activeDemeritPoints,
    }).kind,
    recentEvents: recentEvents.map((e) => ({
      type: e.type,
      matchId: e.match_id,
      at: new Date(e.created_at as unknown as string),
    })),
  };
}
