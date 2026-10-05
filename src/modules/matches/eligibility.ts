import type { Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { Errors } from "../../lib/errors.js";

export interface RatingRange {
  min_rating: number | null;
  max_rating: number | null;
}

/**
 * Throws RATING_OUT_OF_RANGE if the match has a rating range and the
 * player's current rating is outside it. `who` picks the wording: "self"
 * when the player is joining, "player" when the host is accepting them.
 * A player with no rating row can't be checked, so they fail any range.
 */
export async function assertRatingInRange(
  executor: Kysely<DB>,
  range: RatingRange,
  userId: string,
  who: "self" | "player"
): Promise<void> {
  const { min_rating: min, max_rating: max } = range;
  if (min === null && max === null) return;

  const row = await executor
    .selectFrom("player_ratings")
    .select("rating")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const rating = row?.rating ?? null;

  const tooLow = min !== null && (rating === null || rating < min);
  const tooHigh = max !== null && (rating === null || rating > max);
  if (!tooLow && !tooHigh) return;

  const allowed =
    min !== null && max !== null
      ? `${min}–${max}`
      : min !== null
        ? `${min} or higher`
        : `${max} or lower`;
  const subject = who === "self" ? "Your rating" : "This player's rating";
  throw Errors.ratingOutOfRange(
    `${subject} (${rating ?? "unrated"}) is outside this match's range (${allowed})`
  );
}
