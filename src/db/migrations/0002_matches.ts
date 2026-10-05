import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("matches")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("host_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("pitch_id", "uuid", (c) => c.notNull().references("pitches.id"))
    .addColumn("format_id", "uuid", (c) => c.references("formats.id"))
    .addColumn("formation_id", "uuid", (c) => c.references("formation_templates.id"))
    .addColumn("players_per_side", "integer", (c) => c.notNull())
    .addColumn("subs_per_side", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("capacity", "integer", (c) => c.notNull())
    .addColumn("filled", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("join_mode", "text", (c) => c.notNull())
    .addColumn("min_rating", "integer")
    .addColumn("max_rating", "integer")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("during", sql`tstzrange`, (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("matches_filled_within_capacity", sql`filled <= capacity`)
    .addCheckConstraint(
      "matches_join_mode_check",
      sql`join_mode IN ('OPEN', 'APPROVAL')`
    )
    .addCheckConstraint(
      "matches_status_check",
      sql`status IN ('OPEN', 'FULL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')`
    )
    .execute();

  // A pitch can't host two non-cancelled matches at overlapping times.
  await sql`
    ALTER TABLE matches
    ADD CONSTRAINT matches_no_pitch_clash
    EXCLUDE USING gist (pitch_id WITH =, during WITH &&)
    WHERE (status <> 'CANCELLED')
  `.execute(db);

  await db.schema
    .createTable("match_players")
    .addColumn("match_id", "uuid", (c) => c.notNull().references("matches.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("team", "text")
    .addColumn("slot_code", "text")
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("during", sql`tstzrange`)
    .addColumn("waitlist_position", "integer")
    .addColumn("offer_expires_at", "timestamptz")
    .addColumn("joined_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("match_players_pk", ["match_id", "user_id"])
    .addCheckConstraint(
      "match_players_status_check",
      sql`status IN ('JOINED', 'WAITLISTED', 'CANCELLED', 'PLAYED', 'NO_SHOW')`
    )
    .execute();

  // A player can't be JOINED in two matches whose time ranges overlap.
  // `during` is copied here from matches.during at join time.
  await sql`
    ALTER TABLE match_players
    ADD CONSTRAINT match_players_no_overlap
    EXCLUDE USING gist (user_id WITH =, during WITH &&)
    WHERE (status = 'JOINED')
  `.execute(db);

  // One player per slot per team, while joined.
  await db.schema
    .createIndex("match_players_one_per_slot")
    .on("match_players")
    .columns(["match_id", "team", "slot_code"])
    .unique()
    .where(sql.ref("status"), "=", "JOINED")
    .where(sql.ref("slot_code"), "is not", null)
    .execute();

  // Two waitlisted players can never share a place in line.
  await db.schema
    .createIndex("match_players_unique_waitlist_position")
    .on("match_players")
    .columns(["match_id", "waitlist_position"])
    .unique()
    .where(sql.ref("status"), "=", "WAITLISTED")
    .execute();

  await db.schema
    .createIndex("match_players_user_status_idx")
    .on("match_players")
    .columns(["user_id", "status"])
    .execute();

  await db.schema
    .createTable("join_requests")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("match_id", "uuid", (c) => c.notNull().references("matches.id").onDelete("cascade"))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id"))
    .addColumn("note", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("requested_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("decided_at", "timestamptz")
    .addCheckConstraint(
      "join_requests_status_check",
      sql`status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')`
    )
    .execute();

  // Only one active (PENDING) request per player per match.
  await db.schema
    .createIndex("join_requests_one_pending")
    .on("join_requests")
    .columns(["match_id", "user_id"])
    .unique()
    .where(sql.ref("status"), "=", "PENDING")
    .execute();

  await db.schema
    .createIndex("join_requests_pending_by_match")
    .on("join_requests")
    .column("match_id")
    .where(sql.ref("status"), "=", "PENDING")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("join_requests").ifExists().execute();
  await db.schema.dropTable("match_players").ifExists().execute();
  await db.schema.dropTable("matches").ifExists().execute();
}
