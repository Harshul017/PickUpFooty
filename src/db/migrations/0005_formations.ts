import { Kysely, sql } from "kysely";

type Role = "GK" | "DEF" | "MID" | "FWD";
interface Slot {
  slot_code: string;
  role: Role;
  x: number;
  y: number;
}

/**
 * Standard formations, as reference data rather than seed data.
 *
 * A lineup is meaningless without them, so every environment needs them,
 * tests included — and tests only ever run migrations. Keeping them here
 * means a test database is a working system rather than an empty shell.
 *
 * Coordinates are percentages of the player's own half-to-half view:
 * x across the pitch, y from the opposition goal (0) to their own (100).
 * The frontend mirrors team B rather than storing a second set.
 */
const FORMATIONS: Array<{ playersPerSide: number; name: string; slots: Slot[] }> = [
  {
    playersPerSide: 5,
    name: "1-2-1",
    slots: [
      { slot_code: "GK", role: "GK", x: 50, y: 92 },
      { slot_code: "DEF1", role: "DEF", x: 50, y: 72 },
      { slot_code: "MID1", role: "MID", x: 25, y: 48 },
      { slot_code: "MID2", role: "MID", x: 75, y: 48 },
      { slot_code: "FWD1", role: "FWD", x: 50, y: 22 },
    ],
  },
  {
    playersPerSide: 7,
    name: "2-3-1",
    slots: [
      { slot_code: "GK", role: "GK", x: 50, y: 95 },
      { slot_code: "DEF1", role: "DEF", x: 25, y: 75 },
      { slot_code: "DEF2", role: "DEF", x: 75, y: 75 },
      { slot_code: "MID1", role: "MID", x: 20, y: 50 },
      { slot_code: "MID2", role: "MID", x: 50, y: 45 },
      { slot_code: "MID3", role: "MID", x: 80, y: 50 },
      { slot_code: "FWD1", role: "FWD", x: 50, y: 20 },
    ],
  },
  {
    playersPerSide: 11,
    name: "4-4-2",
    slots: [
      { slot_code: "GK", role: "GK", x: 50, y: 95 },
      { slot_code: "DEF1", role: "DEF", x: 15, y: 78 },
      { slot_code: "DEF2", role: "DEF", x: 38, y: 80 },
      { slot_code: "DEF3", role: "DEF", x: 62, y: 80 },
      { slot_code: "DEF4", role: "DEF", x: 85, y: 78 },
      { slot_code: "MID1", role: "MID", x: 15, y: 52 },
      { slot_code: "MID2", role: "MID", x: 38, y: 54 },
      { slot_code: "MID3", role: "MID", x: 62, y: 54 },
      { slot_code: "MID4", role: "MID", x: 85, y: 52 },
      { slot_code: "FWD1", role: "FWD", x: 38, y: 22 },
      { slot_code: "FWD2", role: "FWD", x: 62, y: 22 },
    ],
  },
];

export async function up(db: Kysely<never>): Promise<void> {
  // One formation per name per size, so re-running a seed or adding a
  // formation twice can't quietly produce two of the same thing.
  await sql`
    ALTER TABLE formation_templates
    ADD CONSTRAINT formation_templates_name_per_size UNIQUE (players_per_side, name)
  `.execute(db);

  for (const formation of FORMATIONS) {
    await sql`
      INSERT INTO formation_templates (players_per_side, name)
      VALUES (${formation.playersPerSide}, ${formation.name})
      ON CONFLICT (players_per_side, name) DO NOTHING
    `.execute(db);

    const { rows } = await sql<{ id: string }>`
      SELECT id FROM formation_templates
      WHERE players_per_side = ${formation.playersPerSide} AND name = ${formation.name}
    `.execute(db);
    const templateId = rows[0]?.id;
    if (!templateId) throw new Error(`Could not resolve formation ${formation.name}`);

    for (const slot of formation.slots) {
      await sql`
        INSERT INTO formation_slots (template_id, slot_code, role, x, y)
        VALUES (${templateId}, ${slot.slot_code}, ${slot.role}, ${slot.x}, ${slot.y})
        ON CONFLICT (template_id, slot_code) DO NOTHING
      `.execute(db);
    }
  }
}

export async function down(db: Kysely<never>): Promise<void> {
  for (const formation of FORMATIONS) {
    await sql`
      DELETE FROM formation_templates
      WHERE players_per_side = ${formation.playersPerSide} AND name = ${formation.name}
    `.execute(db);
  }
  await sql`
    ALTER TABLE formation_templates
    DROP CONSTRAINT IF EXISTS formation_templates_name_per_size
  `.execute(db);
}
