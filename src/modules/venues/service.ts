import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";

export async function listFormats() {
  return db.selectFrom("formats").selectAll().orderBy("players_per_side").execute();
}

export async function listVenues() {
  return db
    .selectFrom("venues")
    .selectAll()
    .where("status", "=", "ACTIVE")
    .orderBy("name")
    .execute();
}

export async function listPitches(venueId: string) {
  const venue = await db
    .selectFrom("venues")
    .selectAll()
    .where("id", "=", venueId)
    .executeTakeFirst();
  if (!venue) throw Errors.notFound("Venue");

  return db.selectFrom("pitches").selectAll().where("venue_id", "=", venueId).execute();
}

/**
 * Free windows on a pitch for a given date, derived from existing matches
 * rather than a separate table — a pitch is free wherever no non-cancelled
 * match's `during` range overlaps.
 */
export async function pitchAvailability(pitchId: string, date: string) {
  const pitch = await db
    .selectFrom("pitches")
    .selectAll()
    .where("id", "=", pitchId)
    .executeTakeFirst();
  if (!pitch) throw Errors.notFound("Pitch");

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  const dayRange = `[${dayStart.toISOString()},${dayEnd.toISOString()})`;

  const booked = await db
    .selectFrom("matches")
    .select(["during"])
    .where("pitch_id", "=", pitchId)
    .where("status", "!=", "CANCELLED")
    .where(sql<boolean>`during && ${dayRange}::tstzrange`)
    .execute();

  return { pitch, bookedRanges: booked.map((b) => b.during) };
}
