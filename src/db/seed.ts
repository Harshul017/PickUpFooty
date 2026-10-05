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

async function seedFormations() {
  // A simple 7v7 "2-3-1" template as a starting point; more formations
  // can be added the same way once the pitch-view UI needs them.
  const template = await db
    .insertInto("formation_templates")
    .values({ players_per_side: 7, name: "2-3-1" })
    .returning("id")
    .executeTakeFirstOrThrow();

  const slots: Array<{ slot_code: string; role: "GK" | "DEF" | "MID" | "FWD"; x: number; y: number }> = [
    { slot_code: "GK", role: "GK", x: 50, y: 95 },
    { slot_code: "DEF1", role: "DEF", x: 25, y: 75 },
    { slot_code: "DEF2", role: "DEF", x: 75, y: 75 },
    { slot_code: "MID1", role: "MID", x: 20, y: 50 },
    { slot_code: "MID2", role: "MID", x: 50, y: 45 },
    { slot_code: "MID3", role: "MID", x: 80, y: 50 },
    { slot_code: "FWD1", role: "FWD", x: 50, y: 20 },
  ];

  for (const slot of slots) {
    await db
      .insertInto("formation_slots")
      .values({ template_id: template.id, ...slot })
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

async function main() {
  await seedFormats();
  await seedFormations();
  await seedVenues();
  console.log("Seed complete.");
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
