/**
 * Every timeline rule from the design doc lives here as a pure function of
 * (now, starts_at), so it's testable without touching the database or the
 * clock, and every module applies the same numbers.
 */

export const MINUTES = 60_000;

export const RULES = {
  MIN_LEAD_TIME_MIN: 120, // can't create a match starting sooner than this
  MAX_LEAD_TIME_DAYS: 14,
  JOIN_REQUEST_CUTOFF_MIN: 90, // new requests/opens joins stop here
  FREE_CANCEL_CUTOFF_MIN: 60, // cancelling before this is free
  WAITLIST_FREEZE_MIN: 30, // waitlist stops promoting here
  REQUEST_MAX_LIFETIME_MIN: 45,
  WAITLIST_OFFER_WINDOW_MIN: 10,
  DEMERIT_LOOKBACK_DAYS: 30,
  DEMERIT_EXPIRY_DAYS: 30,
  BAN_DAYS: 7,
  DISPUTE_WINDOW_HOURS: 24,
  PEER_RATING_WINDOW_HOURS: 48,
};

export function now(): Date {
  return new Date();
}

export function minutesUntil(target: Date, from: Date = now()): number {
  return (target.getTime() - from.getTime()) / MINUTES;
}

export function isBeforeJoinCutoff(startsAt: Date, from: Date = now()): boolean {
  return minutesUntil(startsAt, from) > RULES.JOIN_REQUEST_CUTOFF_MIN;
}

export function isFreeCancelWindow(startsAt: Date, from: Date = now()): boolean {
  return minutesUntil(startsAt, from) > RULES.FREE_CANCEL_CUTOFF_MIN;
}

export function isWaitlistFrozen(startsAt: Date, from: Date = now()): boolean {
  return minutesUntil(startsAt, from) <= RULES.WAITLIST_FREEZE_MIN;
}

/**
 * expires_at = LEAST(requested_at + 45 min, starts_at - 60 min)
 * so a request is never accepted into a slot the player can no longer
 * leave for free.
 */
export function requestExpiryAt(requestedAt: Date, startsAt: Date): Date {
  const byLifetime = new Date(requestedAt.getTime() + RULES.REQUEST_MAX_LIFETIME_MIN * MINUTES);
  const byFreeCancelCutoff = new Date(startsAt.getTime() - RULES.FREE_CANCEL_CUTOFF_MIN * MINUTES);
  return byLifetime < byFreeCancelCutoff ? byLifetime : byFreeCancelCutoff;
}

export function validCreationWindow(startsAt: Date, from: Date = now()): boolean {
  const lead = minutesUntil(startsAt, from);
  return lead >= RULES.MIN_LEAD_TIME_MIN && lead <= RULES.MAX_LEAD_TIME_DAYS * 24 * 60;
}

/** Postgres tstzrange literal, half-open [start, end). */
export function toTsRange(startsAt: Date, endsAt: Date): string {
  return `[${startsAt.toISOString()},${endsAt.toISOString()})`;
}
