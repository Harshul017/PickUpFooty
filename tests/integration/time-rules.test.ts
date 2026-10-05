import { describe, expect, it } from "vitest";
import {
  isBeforeJoinCutoff,
  isFreeCancelWindow,
  isWaitlistFrozen,
  requestExpiryAt,
  validCreationWindow,
} from "../../src/lib/time.js";

const MIN = 60_000;

describe("timeline rules", () => {
  const now = new Date("2026-10-01T10:00:00.000Z");

  it("closes joining at the 90 minute cutoff", () => {
    const in91 = new Date(now.getTime() + 91 * MIN);
    const in89 = new Date(now.getTime() + 89 * MIN);
    expect(isBeforeJoinCutoff(in91, now)).toBe(true);
    expect(isBeforeJoinCutoff(in89, now)).toBe(false);
  });

  it("allows free cancellation only outside 60 minutes", () => {
    const in61 = new Date(now.getTime() + 61 * MIN);
    const in59 = new Date(now.getTime() + 59 * MIN);
    expect(isFreeCancelWindow(in61, now)).toBe(true);
    expect(isFreeCancelWindow(in59, now)).toBe(false);
  });

  it("freezes the waitlist inside 30 minutes", () => {
    const in31 = new Date(now.getTime() + 31 * MIN);
    const in29 = new Date(now.getTime() + 29 * MIN);
    expect(isWaitlistFrozen(in31, now)).toBe(false);
    expect(isWaitlistFrozen(in29, now)).toBe(true);
  });

  it("caps a request's expiry at 60 minutes before kickoff, even if 45 min would run later", () => {
    // Match starts in 80 minutes: the free-cancel cutoff (T-60) is 20
    // minutes away, which is earlier than the 45-minute lifetime.
    const startsAt = new Date(now.getTime() + 80 * MIN);
    const expiry = requestExpiryAt(now, startsAt);
    expect(expiry.getTime()).toBe(startsAt.getTime() - 60 * MIN);
  });

  it("uses the 45 minute lifetime when kickoff is far away", () => {
    const startsAt = new Date(now.getTime() + 10 * 24 * 60 * MIN); // 10 days out
    const expiry = requestExpiryAt(now, startsAt);
    expect(expiry.getTime()).toBe(now.getTime() + 45 * MIN);
  });

  it("rejects matches created too soon or too far out", () => {
    expect(validCreationWindow(new Date(now.getTime() + 119 * MIN), now)).toBe(false);
    expect(validCreationWindow(new Date(now.getTime() + 121 * MIN), now)).toBe(true);
    expect(validCreationWindow(new Date(now.getTime() + 15 * 24 * 60 * MIN), now)).toBe(false);
  });
});
