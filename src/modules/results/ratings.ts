import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { RULES } from "../../lib/time.js";

/** How many separate players must say so before lateness is recorded. */
export const LATE_REPORTS_NEEDED = 2;

export interface PeerRatingInput {
  userId: string;
  score: number;
  lateArrival?: boolean;
}

/**
 * Rate the people you just played with.
 *
 * Open for 48 hours after the final whistle, and only to players who were
 * on the pitch — a rating from someone who wasn't there is worth nothing,
 * and would be the obvious way to attack the system once ratings start
 * moving people up and down a leaderboard.
 *
 * Re-submitting replaces your earlier scores rather than adding to them,
 * so changing your mind inside the window is free and nobody can pad a
 * teammate's average by sending the same rating ten times.
 */
export async function submitPeerRatings(input: {
  matchId: string;
  raterId: string;
  ratings: PeerRatingInput[];
}) {
  const { matchId, raterId, ratings } = input;

  return db.transaction().execute(async (trx) => {
    const match = await trx
      .selectFrom("matches")
      .select(["id", sql<string>`upper(during)`.as("ends_at")])
      .where("id", "=", matchId)
      .executeTakeFirst();
    if (!match) throw Errors.notFound("Match");

    const endsAt = new Date(match.ends_at);
    const closesAt = new Date(
      endsAt.getTime() + RULES.PEER_RATING_WINDOW_HOURS * 60 * 60 * 1000
    );
    if (endsAt > new Date()) throw Errors.matchNotFinished();
    if (new Date() > closesAt) throw Errors.ratingWindowClosed(RULES.PEER_RATING_WINDOW_HOURS);

    const played = await trx
      .selectFrom("match_players")
      .select("user_id")
      .where("match_id", "=", matchId)
      .where("status", "=", "PLAYED")
      .execute();
    const onThePitch = new Set(played.map((p) => p.user_id));

    if (!onThePitch.has(raterId)) throw Errors.notInMatch();
    for (const rating of ratings) {
      if (rating.userId === raterId) throw Errors.cannotRateSelf();
      if (!onThePitch.has(rating.userId)) throw Errors.playerNotInMatch(rating.userId);
    }

    for (const rating of ratings) {
      await trx
        .insertInto("peer_ratings")
        .values({
          match_id: matchId,
          rater_id: raterId,
          ratee_id: rating.userId,
          score: rating.score,
          late_arrival: rating.lateArrival ?? false,
        })
        .onConflict((oc) =>
          oc.columns(["match_id", "rater_id", "ratee_id"]).doUpdateSet({
            score: rating.score,
            late_arrival: rating.lateArrival ?? false,
            created_at: sql<Date>`now()`,
          })
        )
        .execute();
    }

    const flagged = ratings.filter((r) => r.lateArrival).map((r) => r.userId);
    for (const userId of flagged) {
      await recordLatenessIfCorroborated(trx, matchId, userId);
    }

    return { matchId, submitted: ratings.length };
  });
}

/**
 * One player's word isn't enough to put a mark on someone's record, so
 * lateness is only written down once a second player independently says
 * the same thing. It stays a conduct event with no demerit attached:
 * turning up late is worth noting, not worth a ban.
 */
async function recordLatenessIfCorroborated(trx: Kysely<DB>, matchId: string, userId: string) {
  const { count } = await trx
    .selectFrom("peer_ratings")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("match_id", "=", matchId)
    .where("ratee_id", "=", userId)
    .where("late_arrival", "=", true)
    .executeTakeFirstOrThrow();

  if (Number(count) < LATE_REPORTS_NEEDED) return;

  // Recorded once per player per match, however many people report it.
  const existing = await trx
    .selectFrom("conduct_events")
    .select("id")
    .where("user_id", "=", userId)
    .where("match_id", "=", matchId)
    .where("type", "=", "LATE_ARRIVAL")
    .executeTakeFirst();
  if (existing) return;

  await trx
    .insertInto("conduct_events")
    .values({ user_id: userId, match_id: matchId, type: "LATE_ARRIVAL" })
    .execute();
}

/** A player's peer scores, trimmed, as the rating engine will want them. */
export async function peerRatingSummary(matchId: string, userId: string) {
  const rows = await db
    .selectFrom("peer_ratings")
    .select("score")
    .where("match_id", "=", matchId)
    .where("ratee_id", "=", userId)
    .orderBy("score")
    .execute();

  const scores = rows.map((r) => r.score);
  // Fewer than three opinions is noise, not a signal, so it is left for
  // the caller to ignore rather than averaged into something confident.
  const trimmed = scores.length >= 3 ? scores.slice(1, -1) : scores;
  const average =
    trimmed.length > 0 ? trimmed.reduce((sum, s) => sum + s, 0) / trimmed.length : null;

  return { count: scores.length, scores, average };
}
