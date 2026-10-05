import { sql, type Kysely } from "kysely";
import type { DB } from "../../db/types.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { isPgError, PG_UNIQUE_VIOLATION } from "../../lib/pg.js";
import { isBeforeJoinCutoff, now, requestExpiryAt } from "../../lib/time.js";
import { assertNotBanned, findActiveBan } from "../discipline/service.js";
import { assertRatingInRange } from "../matches/eligibility.js";
import { takeSpotOrWaitlist, type JoinResult } from "../matches/spots.js";

/**
 * Join requests for APPROVAL matches. Every state change is a conditional
 * UPDATE guarded by `status = 'PENDING' AND expires_at > now()`, so accept,
 * reject, withdraw and the expiry job can race freely: exactly one of them
 * moves a request out of PENDING. Time checks use the database clock.
 *
 * Nothing here schedules jobs; the route does that after the service
 * returns (i.e. after commit), so these functions are testable without Redis.
 */

export async function createRequest(input: { matchId: string; userId: string; note?: string }) {
  await assertNotBanned(input.userId);

  const match = await db
    .selectFrom("matches")
    .select(["id", "join_mode", "status", sql<string>`lower(during)`.as("starts_at")])
    .where("id", "=", input.matchId)
    .executeTakeFirst();
  if (!match) throw Errors.notFound("Match");
  if (match.join_mode !== "APPROVAL") {
    throw Errors.badRequest("This match is open to join directly; use /join instead");
  }
  if (match.status !== "OPEN") throw Errors.matchNotOpen();

  const requestedAt = now();
  const startsAt = new Date(match.starts_at);
  if (!isBeforeJoinCutoff(startsAt, requestedAt)) throw Errors.requestsClosed();

  // The organizer is already JOINED, so this also stops a host requesting
  // to join their own match.
  const membership = await db
    .selectFrom("match_players")
    .select("status")
    .where("match_id", "=", input.matchId)
    .where("user_id", "=", input.userId)
    .where("status", "in", ["JOINED", "WAITLISTED"])
    .executeTakeFirst();
  if (membership) throw Errors.alreadyInMatch();

  try {
    // A single INSERT, so it commits on its own; the partial unique index
    // join_requests_one_pending is what stops a second PENDING request,
    // even when two arrive at once.
    return await db
      .insertInto("join_requests")
      .values({
        match_id: input.matchId,
        user_id: input.userId,
        note: input.note ?? null,
        status: "PENDING",
        requested_at: requestedAt,
        expires_at: requestExpiryAt(requestedAt, startsAt),
      })
      .returning(["id", "match_id", "user_id", "note", "status", "requested_at", "expires_at"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (
      isPgError(err) &&
      err.code === PG_UNIQUE_VIOLATION &&
      err.constraint === "join_requests_one_pending"
    ) {
      throw Errors.requestAlreadyPending();
    }
    throw err;
  }
}

/** The organizer's queue: live PENDING requests, oldest first. */
export async function listPendingRequests(matchId: string, hostId: string) {
  const match = await db
    .selectFrom("matches")
    .select("host_id")
    .where("id", "=", matchId)
    .executeTakeFirst();
  if (!match) throw Errors.notFound("Match");
  if (match.host_id !== hostId) throw Errors.forbidden("Only the host can view requests");

  return db
    .selectFrom("join_requests as jr")
    .innerJoin("users as u", "u.id", "jr.user_id")
    .leftJoin("player_ratings as pr", "pr.user_id", "jr.user_id")
    .select([
      "jr.id",
      "jr.user_id",
      "u.name",
      "pr.rating",
      "jr.note",
      "jr.requested_at",
      "jr.expires_at",
    ])
    .where("jr.match_id", "=", matchId)
    .where("jr.status", "=", "PENDING")
    .where("jr.expires_at", ">", sql<Date>`now()`)
    .orderBy("jr.requested_at", "asc")
    .orderBy("jr.id", "asc")
    .execute();
}

/**
 * Accept a request and seat the player in one transaction: the request
 * becomes ACCEPTED, the player takes a spot (or the waitlist if the match
 * filled meanwhile), and, if they got a spot, their other PENDING requests
 * for overlapping times are withdrawn. Any failure rolls all of it back.
 */
export async function acceptRequest(requestId: string, hostId: string): Promise<JoinResult> {
  return db.transaction().execute(async (trx) => {
    const request = await findRequestWithHost(trx, requestId);
    if (request.host_id !== hostId) throw Errors.forbidden("Only the host can accept requests");

    // Lock all of this player's pending requests in a fixed order first.
    // Without this, two hosts accepting the same player into overlapping
    // matches at once could deadlock: each holds its own request and waits
    // on the other's (via the overlap constraint, then the withdraw step).
    // With it, the second accept waits, then finds its request WITHDRAWN.
    await trx
      .selectFrom("join_requests")
      .select("id")
      .where("user_id", "=", request.user_id)
      .where("status", "=", "PENDING")
      .orderBy("id")
      .forUpdate()
      .execute();

    const accepted = await trx
      .updateTable("join_requests")
      .set({ status: "ACCEPTED", decided_at: sql<Date>`now()` })
      .where("id", "=", requestId)
      .where("status", "=", "PENDING")
      .where("expires_at", ">", sql<Date>`now()`)
      .returning(["match_id", "user_id"])
      .executeTakeFirst();
    if (!accepted) throw Errors.requestNotPending();

    // The player was eligible when they asked, but a ban or a rating change
    // since then still blocks them. Throwing rolls back the ACCEPTED status,
    // so the request stays PENDING and the host can reject it.
    const bannedUntil = await findActiveBan(accepted.user_id, trx);
    if (bannedUntil) throw Errors.playerBanned(bannedUntil);
    await assertRatingInRange(trx, request, accepted.user_id, "player");

    let result: JoinResult;
    try {
      result = await takeSpotOrWaitlist(trx, accepted.match_id, accepted.user_id, {
        tryJoin: true,
      });
    } catch (err) {
      // Same rule, but the host is the one reading this message.
      if (err instanceof AppError && err.code === "PLAYER_OVERLAP") {
        throw Errors.playerOverlap("This player is already in another match at an overlapping time");
      }
      throw err;
    }

    // A player can't hold overlapping matches, so once they hold this one
    // their other pending requests for overlapping times go away. A
    // waitlisted player holds nothing yet, so their other requests stay.
    if (result.status === "JOINED") {
      await trx
        .updateTable("join_requests")
        .set({ status: "WITHDRAWN", decided_at: sql<Date>`now()` })
        .where("user_id", "=", accepted.user_id)
        .where("status", "=", "PENDING")
        .where("id", "<>", requestId)
        .where("match_id", "in", (eb) =>
          eb
            .selectFrom("matches")
            .select("id")
            .where(
              sql<boolean>`during && (SELECT during FROM matches WHERE id = ${accepted.match_id})`
            )
        )
        .execute();

    }

    return result;
  });
}

export async function rejectRequest(requestId: string, hostId: string) {
  const request = await findRequestWithHost(db, requestId);
  if (request.host_id !== hostId) throw Errors.forbidden("Only the host can reject requests");
  return decide(requestId, "REJECTED");
}

export async function withdrawRequest(requestId: string, userId: string) {
  const request = await findRequestWithHost(db, requestId);
  if (request.user_id !== userId) {
    throw Errors.forbidden("Only the player who sent a request can withdraw it");
  }
  return decide(requestId, "WITHDRAWN");
}

/**
 * The expiry job's update: PENDING -> EXPIRED once expires_at has passed by
 * the database clock. Returns false when there was nothing to do (already
 * decided, or not due yet), so retries and duplicate jobs are harmless.
 */
export async function expireRequest(requestId: string): Promise<boolean> {
  const updated = await db
    .updateTable("join_requests")
    .set({ status: "EXPIRED", decided_at: sql<Date>`now()` })
    .where("id", "=", requestId)
    .where("status", "=", "PENDING")
    .where("expires_at", "<=", sql<Date>`now()`)
    .returning("id")
    .executeTakeFirst();
  return updated !== undefined;
}

async function decide(requestId: string, status: "REJECTED" | "WITHDRAWN") {
  const updated = await db
    .updateTable("join_requests")
    .set({ status, decided_at: sql<Date>`now()` })
    .where("id", "=", requestId)
    .where("status", "=", "PENDING")
    .where("expires_at", ">", sql<Date>`now()`)
    .returning(["id", "status", "decided_at"])
    .executeTakeFirst();
  if (!updated) throw Errors.requestNotPending();
  return updated;
}

async function findRequestWithHost(executor: Kysely<DB>, requestId: string) {
  const request = await executor
    .selectFrom("join_requests as jr")
    .innerJoin("matches as m", "m.id", "jr.match_id")
    .select([
      "jr.id",
      "jr.user_id",
      "jr.match_id",
      "m.host_id",
      "m.min_rating",
      "m.max_rating",
    ])
    .where("jr.id", "=", requestId)
    .executeTakeFirst();
  if (!request) throw Errors.notFound("Request");
  return request;
}
