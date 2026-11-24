import { Kysely, sql } from "kysely";

/**
 * Lets a peer rating also say "they turned up late".
 *
 * Kept on the rating rather than in its own table because it is the same
 * act of feedback, from the same person, about the same match, inside the
 * same window — splitting it would mean two writes that must agree.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("peer_ratings")
    .addColumn("late_arrival", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();

  // "How many people said this player was late?" is the only question
  // asked of this column, and always for one match at a time.
  await db.schema
    .createIndex("peer_ratings_late_reports")
    .on("peer_ratings")
    .columns(["match_id", "ratee_id"])
    .where(sql.ref("late_arrival"), "=", true)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("peer_ratings_late_reports").ifExists().execute();
  await db.schema.alterTable("peer_ratings").dropColumn("late_arrival").execute();
}
