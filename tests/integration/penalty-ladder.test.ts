import { describe, expect, it } from "vitest";
import { decidePenalty } from "../../src/modules/discipline/ladder.js";
import { RULES } from "../../src/lib/time.js";

describe("penalty ladder", () => {
  const cases: Array<{
    name: string;
    lateCancelsInWindow: number;
    activeDemeritPoints: number;
    kind: "WARNING" | "DEMERIT" | "BAN";
    demeritPoints: number;
    banDays: number;
  }> = [
    {
      name: "first late cancel is only a warning",
      lateCancelsInWindow: 1,
      activeDemeritPoints: 0,
      kind: "WARNING",
      demeritPoints: 0,
      banDays: 0,
    },
    {
      name: "second late cancel costs a demerit point",
      lateCancelsInWindow: 2,
      activeDemeritPoints: 0,
      kind: "DEMERIT",
      demeritPoints: 1,
      banDays: 0,
    },
    {
      name: "third late cancel is a ban",
      lateCancelsInWindow: 3,
      activeDemeritPoints: 1,
      kind: "BAN",
      demeritPoints: 1,
      banDays: RULES.BAN_DAYS,
    },
    {
      name: "a fourth and beyond stays a ban",
      lateCancelsInWindow: 7,
      activeDemeritPoints: 2,
      kind: "BAN",
      demeritPoints: 1,
      banDays: RULES.BAN_DAYS,
    },
    {
      name: "a point from elsewhere brings the ban forward to the second cancel",
      lateCancelsInWindow: 2,
      activeDemeritPoints: 1,
      kind: "BAN",
      demeritPoints: 1,
      banDays: RULES.BAN_DAYS,
    },
    {
      name: "existing points do not punish a first offence",
      lateCancelsInWindow: 1,
      activeDemeritPoints: 1,
      kind: "WARNING",
      demeritPoints: 0,
      banDays: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        decidePenalty({
          lateCancelsInWindow: c.lateCancelsInWindow,
          activeDemeritPoints: c.activeDemeritPoints,
        })
      ).toEqual({
        kind: c.kind,
        demeritPoints: c.demeritPoints,
        banDays: c.banDays,
      });
    });
  }

  it("treats expired points as gone, so the ladder resets", () => {
    // Same player, same history, except their old points have aged out of
    // the 30-day window: the second cancel is a plain demerit again.
    expect(decidePenalty({ lateCancelsInWindow: 2, activeDemeritPoints: 1 }).kind).toBe("BAN");
    expect(decidePenalty({ lateCancelsInWindow: 2, activeDemeritPoints: 0 }).kind).toBe("DEMERIT");
  });
});
