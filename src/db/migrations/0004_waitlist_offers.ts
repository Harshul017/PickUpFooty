import { Kysely, sql } from "kysely";

/**
 * Adds the OFFERED state to match_players.
 *
 * When a player leaves, their spot is offered to the first player on the
 * waitlist for a fixed window instead of being thrown back into the open
 * pool. OFFERED means "this spot is held for this player, for now", so the
 * invariant the whole module relies on becomes:
 *
 *     matches.filled = count(JOINED) + count(OFFERED)
 *
 * The spot never looks free in between, so nobody can jump the queue while
 * the first player in line is deciding.
 *
 * An OFFERED row deliberately leaves `during` NULL, exactly like a
 * WAITLISTED one. The player-overlap exclusion constraint only covers
 * JOINED rows, so making an offer can never fail because of some third
 * party's clashing schedule — which matters, because offers are made
 * inside someone else's leave transaction. The clash is caught when the
 * offer is confirmed and the row becomes JOINED.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE match_players
    DROP CONSTRAINT match_players_status_check
  `.execute(db);

  await sql`
    ALTER TABLE match_players
    ADD CONSTRAINT match_players_status_check
    CHECK (status IN ('JOINED', 'OFFERED', 'WAITLISTED', 'CANCELLED', 'PLAYED', 'NO_SHOW'))
  `.execute(db);

  // An OFFERED row must carry a deadline, and nothing else may.
  await sql`
    ALTER TABLE match_players
    ADD CONSTRAINT match_players_offer_has_deadline
    CHECK ((status = 'OFFERED') = (offer_expires_at IS NOT NULL))
  `.execute(db);

  // The sweeper asks "which offers have run out?" across every match, so
  // it needs its own index rather than a scan of all participants.
  await db.schema
    .createIndex("match_players_live_offers")
    .on("match_players")
    .column("offer_expires_at")
    .where(sql.ref("status"), "=", "OFFERED")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("match_players_live_offers").ifExists().execute();

  await sql`
    ALTER TABLE match_players
    DROP CONSTRAINT IF EXISTS match_players_offer_has_deadline
  `.execute(db);

  // Outstanding offers have no meaning once the state is gone. Release the
  // spots they were holding first, or `filled` would be left overstated.
  await sql`
    UPDATE matches m
    SET filled = m.filled - held.count
    FROM (
      SELECT match_id, count(*) AS count
      FROM match_players
      WHERE status = 'OFFERED'
      GROUP BY match_id
    ) held
    WHERE m.id = held.match_id
  `.execute(db);

  await sql`
    UPDATE match_players
    SET status = 'CANCELLED', offer_expires_at = NULL
    WHERE status = 'OFFERED'
  `.execute(db);

  await sql`
    ALTER TABLE match_players
    DROP CONSTRAINT match_players_status_check
  `.execute(db);

  await sql`
    ALTER TABLE match_players
    ADD CONSTRAINT match_players_status_check
    CHECK (status IN ('JOINED', 'WAITLISTED', 'CANCELLED', 'PLAYED', 'NO_SHOW'))
  `.execute(db);
}
