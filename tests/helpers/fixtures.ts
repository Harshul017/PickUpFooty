import { randomUUID } from "crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../src/db/types.js";
import { toTsRange } from "../../src/lib/time.js";

const MIN = 60_000;

export async function createUser(db: Kysely<DB>, opts: { rating?: number } = {}) {
  const user = await db
    .insertInto("users")
    .values({
      name: `Player ${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@test.local`,
      phone: null,
      password_hash: "not-a-real-hash",
      role: "PLAYER",
      area: null,
      preferred_position: null,
      preferred_foot: null,
    })
    .returning(["id", "name"])
    .executeTakeFirstOrThrow();

  await db
    .insertInto("player_ratings")
    .values({ user_id: user.id, rating: opts.rating ?? 1150 })
    .execute();

  return user;
}

/**
 * Insert a match the way createMatch does (host JOINED, filled = 1), but
 * with any start time, so tests can sit right at the timeline cutoffs.
 * Each match gets its own pitch, so tests never clash on pitches.
 */
export async function createMatch(
  db: Kysely<DB>,
  opts: {
    hostId: string;
    startsInMin?: number;
    startsAt?: Date;
    durationMin?: number;
    capacity?: number;
    joinMode?: "OPEN" | "APPROVAL";
  }
) {
  const venue = await db
    .insertInto("venues")
    .values({ name: "Test venue", address: null, lat: null, lng: null, status: "ACTIVE" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const pitch = await db
    .insertInto("pitches")
    .values({ venue_id: venue.id, name: "Pitch 1", max_players_per_side: 11, surface: "TURF" })
    .returning("id")
    .executeTakeFirstOrThrow();

  const startsAt = opts.startsAt ?? new Date(Date.now() + (opts.startsInMin ?? 180) * MIN);
  const endsAt = new Date(startsAt.getTime() + (opts.durationMin ?? 60) * MIN);
  const during = toTsRange(startsAt, endsAt);
  const capacity = opts.capacity ?? 10;

  const match = await db
    .insertInto("matches")
    .values({
      host_id: opts.hostId,
      pitch_id: pitch.id,
      format_id: null,
      formation_id: null,
      players_per_side: Math.floor(capacity / 2),
      capacity,
      filled: 1,
      join_mode: opts.joinMode ?? "APPROVAL",
      min_rating: null,
      max_rating: null,
      status: "OPEN",
      during: sql<string>`${during}::tstzrange`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("match_players")
    .values({
      match_id: match.id,
      user_id: opts.hostId,
      team: null,
      slot_code: null,
      status: "JOINED",
      during: sql<string>`${during}::tstzrange`,
      waitlist_position: null,
      offer_expires_at: null,
    })
    .execute();

  return { id: match.id, startsAt, endsAt };
}

/** Add JOINED filler players until only `spotsLeft` spots remain. */
export async function fillMatch(db: Kysely<DB>, matchId: string, spotsLeft: number) {
  const match = await db
    .selectFrom("matches")
    .select(["capacity", "filled"])
    .where("id", "=", matchId)
    .executeTakeFirstOrThrow();

  const toAdd = match.capacity - match.filled - spotsLeft;
  for (let i = 0; i < toAdd; i++) {
    const filler = await createUser(db);
    await db
      .insertInto("match_players")
      .values({
        match_id: matchId,
        user_id: filler.id,
        team: null,
        slot_code: null,
        status: "JOINED",
        during: sql<string>`(SELECT during FROM matches WHERE id = ${matchId})`,
        waitlist_position: null,
        offer_expires_at: null,
      })
      .execute();
  }
  await db
    .updateTable("matches")
    .set({ filled: (eb) => eb("filled", "+", toAdd) })
    .where("id", "=", matchId)
    .execute();
}

export async function getRequest(db: Kysely<DB>, requestId: string) {
  return db
    .selectFrom("join_requests")
    .selectAll()
    .where("id", "=", requestId)
    .executeTakeFirstOrThrow();
}

export async function getMatchState(db: Kysely<DB>, matchId: string) {
  const match = await db
    .selectFrom("matches")
    .select(["filled", "capacity"])
    .where("id", "=", matchId)
    .executeTakeFirstOrThrow();
  const players = await db
    .selectFrom("match_players")
    .select(["user_id", "status", "waitlist_position"])
    .where("match_id", "=", matchId)
    .execute();
  const joinedCount = players.filter((p) => p.status === "JOINED").length;
  return { ...match, players, joinedCount };
}

/** Push a request's expiry into the past, as if its 45 minutes ran out. */
export async function expireNow(db: Kysely<DB>, requestId: string) {
  await db
    .updateTable("join_requests")
    .set({ expires_at: sql<Date>`now() - interval '1 second'` })
    .where("id", "=", requestId)
    .execute();
}
