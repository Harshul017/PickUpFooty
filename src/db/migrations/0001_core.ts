import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "btree_gist"`.execute(db);

  await db.schema
    .createTable("users")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("email", "text", (c) => c.unique())
    .addColumn("phone", "text", (c) => c.unique())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("role", "text", (c) => c.notNull().defaultTo("PLAYER"))
    .addColumn("area", "text")
    .addColumn("preferred_position", "text")
    .addColumn("preferred_foot", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("users_email_or_phone", sql`email IS NOT NULL OR phone IS NOT NULL`)
    .addCheckConstraint("users_role_check", sql`role IN ('PLAYER', 'ADMIN')`)
    .execute();

  await db.schema
    .createTable("player_ratings")
    .addColumn("user_id", "uuid", (c) => c.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("rating", "integer", (c) => c.notNull())
    .addColumn("matches_played", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("is_provisional", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("rating_history")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("match_id", "uuid")
    .addColumn("old_rating", "integer", (c) => c.notNull())
    .addColumn("new_rating", "integer", (c) => c.notNull())
    .addColumn("breakdown", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("formats")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("players_per_side", "integer", (c) => c.notNull())
    .addColumn("default_duration_min", "integer", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("venues")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("address", "text")
    .addColumn("lat", "double precision")
    .addColumn("lng", "double precision")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("ACTIVE"))
    .execute();

  await db.schema
    .createTable("pitches")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("venue_id", "uuid", (c) => c.notNull().references("venues.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("max_players_per_side", "integer", (c) => c.notNull())
    .addColumn("surface", "text")
    .execute();

  await db.schema
    .createTable("formation_templates")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("players_per_side", "integer", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("formation_slots")
    .addColumn("template_id", "uuid", (c) =>
      c.notNull().references("formation_templates.id").onDelete("cascade")
    )
    .addColumn("slot_code", "text", (c) => c.notNull())
    .addColumn("role", "text", (c) => c.notNull())
    .addColumn("x", "real", (c) => c.notNull())
    .addColumn("y", "real", (c) => c.notNull())
    .addPrimaryKeyConstraint("formation_slots_pk", ["template_id", "slot_code"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("formation_slots").ifExists().execute();
  await db.schema.dropTable("formation_templates").ifExists().execute();
  await db.schema.dropTable("pitches").ifExists().execute();
  await db.schema.dropTable("venues").ifExists().execute();
  await db.schema.dropTable("formats").ifExists().execute();
  await db.schema.dropTable("rating_history").ifExists().execute();
  await db.schema.dropTable("player_ratings").ifExists().execute();
  await db.schema.dropTable("users").ifExists().execute();
}
