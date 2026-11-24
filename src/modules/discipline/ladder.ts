import { RULES } from "../../lib/time.js";

export type PenaltyKind = "WARNING" | "DEMERIT" | "BAN";

export interface PenaltyDecision {
  kind: PenaltyKind;
  /** Demerit points to record for this offence (0 or 1). */
  demeritPoints: number;
  /** Length of the ban to issue, in days. 0 means no ban. */
  banDays: number;
}

export interface LadderInput {
  /**
   * Late cancellations in the lookback window, including the one being
   * recorded right now. So the first ever late cancel arrives here as 1.
   */
  lateCancelsInWindow: number;
  /**
   * Demerit points the player already holds that haven't expired yet.
   * These can come from other offences too, such as no-shows, which is
   * why the ban can't be decided from the late-cancel count alone.
   */
  activeDemeritPoints: number;
}

/**
 * The escalation ladder for a late cancellation.
 *
 * Pure on purpose: it takes two counts and returns what to record. All the
 * reading and writing lives in the service, so the rule itself can be
 * unit-tested without a database, a clock, or a running server.
 *
 *   1st late cancel          -> warning, nothing recorded against them
 *   2nd                      -> 1 demerit point
 *   3rd or more              -> 1 demerit point and a 7-day ban
 *   points reaching 2        -> 1 demerit point and a 7-day ban
 *
 * The last line is what makes demerits from other sources count: a player
 * who already holds a point for a no-show is banned on their next late
 * cancel rather than on their third.
 */
export function decidePenalty(input: LadderInput): PenaltyDecision {
  const { lateCancelsInWindow, activeDemeritPoints } = input;

  if (lateCancelsInWindow <= 1) {
    return { kind: "WARNING", demeritPoints: 0, banDays: 0 };
  }

  // From the second offence on, the player earns a point.
  const pointsAfter = activeDemeritPoints + 1;
  const banned = lateCancelsInWindow >= 3 || pointsAfter >= 2;

  return banned
    ? { kind: "BAN", demeritPoints: 1, banDays: RULES.BAN_DAYS }
    : { kind: "DEMERIT", demeritPoints: 1, banDays: 0 };
}
