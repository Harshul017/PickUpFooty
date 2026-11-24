import { sql } from "kysely";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { RULES } from "../../lib/time.js";

export interface PlayerStatInput {
  userId: string;
  goals?: number;
  assists?: number;
}

export interface SubmitResultInput {
  matchId: string;
  hostId: string;
  scoreA: number;
  scoreB: number;
  players: PlayerStatInput[];
  noShows?: string[];
}

export interface SubmittedResult {
  matchId: string;
  scoreA: number;
  scoreB: number;
  disputeDeadline: Date;
}

/**
 * Record how a match actually went.
 *
 * Only the host can submit, and only once: a second submission is a
 * dispute, not an edit. Everything written here is provisional until the
 * dispute window closes, which is why no rating or penalty is applied yet.
 */
export async function submitResult(input: SubmitResultInput): Promise<SubmittedResult> {
  const { matchId, hostId, scoreA, scoreB } = input;
  const noShows = new Set(input.noShows ?? []);

  return db.transaction().execute(async (trx) => {
    const match = await trx
      .selectFrom("matches")
      .select(["id", "host_id", "status", sql<string>`upper(during)`.as("ends_at")])
      .where("id", "=", matchId)
      .forUpdate()
      .executeTakeFirst();

    if (!match) throw Errors.notFound("Match");
    if (match.host_id !== hostId) {
      throw Errors.forbidden("Only the organizer can submit the result");
    }
    if (match.status === "CANCELLED") throw Errors.matchNotOpen();
    if (new Date(match.ends_at) > new Date()) throw Errors.matchNotFinished();

    const existing = await trx
      .selectFrom("match_results")
      .select("match_id")
      .where("match_id", "=", matchId)
      .executeTakeFirst();
    if (existing) throw Errors.resultAlreadySubmitted();

    const participants = await trx
      .selectFrom("match_players")
      .select(["user_id", "team"])
      .where("match_id", "=", matchId)
      .where("status", "=", "JOINED")
      .execute();

    const teamOf = new Map(participants.map((p) => [p.user_id, p.team]));
    for (const userId of [...input.players.map((p) => p.userId), ...noShows]) {
      if (!teamOf.has(userId)) throw Errors.playerNotInMatch(userId);
    }

    // Goals have to reconcile with the scoreline, which is the one check
    // that makes the stats worth anything: without it a host could hand
    // out goals that never happened.
    const goalsByTeam: Record<string, number> = { A: 0, B: 0 };
    for (const entry of input.players) {
      const goals = entry.goals ?? 0;
      if (goals === 0) continue;
      const team = teamOf.get(entry.userId);
      if (!team) throw Errors.scorerHasNoTeam(entry.userId);
      goalsByTeam[team] = (goalsByTeam[team] ?? 0) + goals;
    }
    if (goalsByTeam.A !== scoreA) throw Errors.goalsDoNotMatchScore("A", goalsByTeam.A ?? 0, scoreA);
    if (goalsByTeam.B !== scoreB) throw Errors.goalsDoNotMatchScore("B", goalsByTeam.B ?? 0, scoreB);

    const result = await trx
      .insertInto("match_results")
      .values({
        match_id: matchId,
        score_a: scoreA,
        score_b: scoreB,
        submitted_by: hostId,
        dispute_deadline: sql<Date>`now() + make_interval(hours => ${RULES.DISPUTE_WINDOW_HOURS})`,
        status: "SUBMITTED",
      })
      .returning("dispute_deadline")
      .executeTakeFirstOrThrow();

    const submitted = new Map(input.players.map((p) => [p.userId, p]));
    const played = participants.filter((p) => !noShows.has(p.user_id));

    if (played.length > 0) {
      await trx
        .insertInto("player_match_stats")
        .values(
          played.map((p) => ({
            match_id: matchId,
            user_id: p.user_id,
            goals: submitted.get(p.user_id)?.goals ?? 0,
            assists: submitted.get(p.user_id)?.assists ?? 0,
            // Derived, never submitted: a clean sheet is a fact about the
            // scoreline, so the host cannot claim one that contradicts it.
            clean_sheet: p.team === "A" ? scoreB === 0 : p.team === "B" ? scoreA === 0 : false,
          }))
        )
        .execute();
    }

    await trx
      .updateTable("match_players")
      .set({ status: "PLAYED" })
      .where("match_id", "=", matchId)
      .where("status", "=", "JOINED")
      .execute();

    if (noShows.size > 0) {
      await trx
        .updateTable("match_players")
        .set({ status: "NO_SHOW" })
        .where("match_id", "=", matchId)
        .where("user_id", "in", [...noShows])
        .execute();
    }

    await trx
      .updateTable("matches")
      .set({ status: "COMPLETED" })
      .where("id", "=", matchId)
      .execute();

    return {
      matchId,
      scoreA,
      scoreB,
      disputeDeadline: new Date(result.dispute_deadline as unknown as string),
    };
  });
}

/** The result and per-player stats, for anyone who wants to look. */
export async function getResult(matchId: string) {
  const result = await db
    .selectFrom("match_results")
    .selectAll()
    .where("match_id", "=", matchId)
    .executeTakeFirst();
  if (!result) throw Errors.notFound("Result");

  const stats = await db
    .selectFrom("player_match_stats")
    .innerJoin("users", "users.id", "player_match_stats.user_id")
    .leftJoin("match_players", (join) =>
      join
        .onRef("match_players.user_id", "=", "player_match_stats.user_id")
        .onRef("match_players.match_id", "=", "player_match_stats.match_id")
    )
    .select([
      "player_match_stats.user_id as userId",
      "users.name as name",
      "match_players.team as team",
      "player_match_stats.goals as goals",
      "player_match_stats.assists as assists",
      "player_match_stats.clean_sheet as cleanSheet",
    ])
    .where("player_match_stats.match_id", "=", matchId)
    .execute();

  return { ...result, players: stats };
}
