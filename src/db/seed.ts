import "dotenv/config";
import { db, closeDb } from "../lib/db.js";

async function seedFormats() {
  const rows = [
    { name: "5v5", players_per_side: 5, default_duration_min: 60 },
    { name: "7v7", players_per_side: 7, default_duration_min: 75 },
    { name: "11v11", players_per_side: 11, default_duration_min: 90 },
  ];
  for (const row of rows) {
    await db
      .insertInto("formats")
      .values(row)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

async function seedVenues() {
  const venue = await db
    .insertInto("venues")
    .values({
      name: "Greenfield Turf, Vaishali Nagar",
      address: "Vaishali Nagar, Jaipur",
      lat: 26.9124,
      lng: 75.7 ,
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("pitches")
    .values([
      { venue_id: venue.id, name: "Pitch 1 (5v5)", max_players_per_side: 5, surface: "TURF" },
      { venue_id: venue.id, name: "Pitch 2 (7v7)", max_players_per_side: 7, surface: "TURF" },
    ])
    .execute();
}

// Formations live in migration 0005: a lineup is meaningless without
// them, so they ship with the schema rather than with sample data.
async function main() {
  await seedFormats();
  await seedVenues();
  console.log("Seed complete.");
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
