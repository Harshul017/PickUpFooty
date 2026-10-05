import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("match_results")
    .addColumn("match_id", "uuid", (c) => c.primaryKey().references("matches.id").onDelete("cascade"))
    .addColumn("score_a", "integer", (c) => c.notNull())
    .addColumn("score_b", "integer", (c) => c.notNull())
    .addColumn("submitted_by", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("submitted_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("dispute_deadline", "timestamptz", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("SUBMITTED"))
    .addColumn("finalized_at", "timestamptz")
    .addColumn("ratings_applied_at", "timestamptz")
    .addCheckConstraint(
      "match_results_status_check",
      sql`status IN ('SUBMITTED', 'DISPUTED', 'FINALIZED')`
    )
    .execute();

  await db.schema
    .createTable("player_match_stats")
    .addColumn("match_id", "uuid", (c) => c.notNull().references("matches.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("goals", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("assists", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("clean_sheet", "boolean", (c) => c.notNull().defaultTo(false))
    .addPrimaryKeyConstraint("player_match_stats_pk", ["match_id", "user_id"])
    .execute();

  await db.schema
    .createTable("disputes")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("match_id", "uuid", (c) => c.notNull().references("matches.id").onDelete("cascade"))
    .addColumn("raised_by", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("reason", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("resolved_by", "uuid", (c) => c.references("users.id"))
    .addColumn("resolved_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("peer_ratings")
    .addColumn("match_id", "uuid", (c) => c.notNull().references("matches.id").onDelete("cascade"))
    .addColumn("rater_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("ratee_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("score", "integer", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("peer_ratings_pk", ["match_id", "rater_id", "ratee_id"])
    .addCheckConstraint("peer_ratings_no_self", sql`rater_id <> ratee_id`)
    .addCheckConstraint("peer_ratings_score_range", sql`score BETWEEN 1 AND 5`)
    .execute();

  await db.schema
    .createTable("conduct_events")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("match_id", "uuid", (c) => c.references("matches.id"))
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      "conduct_events_type_check",
      sql`type IN ('LATE_CANCEL', 'NO_SHOW', 'LATE_ARRIVAL', 'ORGANIZER_LATE_CANCEL')`
    )
    .execute();

  await db.schema
    .createIndex("conduct_events_user_created_idx")
    .on("conduct_events")
    .columns(["user_id", "created_at"])
    .execute();

  await db.schema
    .createTable("demerits")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("conduct_event_id", "uuid", (c) => c.notNull().references("conduct_events.id"))
    .addColumn("points", "integer", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("bans")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("starts_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("ends_at", "timestamptz", (c) => c.notNull())
    .addColumn("reason", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createIndex("bans_user_ends_idx")
    .on("bans")
    .columns(["user_id", "ends_at"])
    .execute();

  await db.schema
    .createTable("weekly_standings")
    .addColumn("week_start", "date", (c) => c.notNull())
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("rating", "integer", (c) => c.notNull())
    .addColumn("rank", "integer", (c) => c.notNull())
    .addColumn("rank_change", "integer", (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("weekly_standings_pk", ["week_start", "user_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("weekly_standings").ifExists().execute();
  await db.schema.dropTable("bans").ifExists().execute();
  await db.schema.dropTable("demerits").ifExists().execute();
  await db.schema.dropTable("conduct_events").ifExists().execute();
  await db.schema.dropTable("peer_ratings").ifExists().execute();
  await db.schema.dropTable("disputes").ifExists().execute();
  await db.schema.dropTable("player_match_stats").ifExists().execute();
  await db.schema.dropTable("match_results").ifExists().execute();
}
