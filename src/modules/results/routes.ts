import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../auth/middleware.js";
import { getResult, submitResult } from "./service.js";
import { listDisputes, raiseDispute, resolveDispute } from "./disputes.js";
import { submitPeerRatings } from "./ratings.js";
import { matchLifecycleQueue, scheduleOnce } from "../../lib/queue.js";

export const resultsRouter = Router();

const submitSchema = z.object({
  scoreA: z.number().int().min(0).max(99),
  scoreB: z.number().int().min(0).max(99),
  players: z
    .array(
      z.object({
        userId: z.string().uuid(),
        goals: z.number().int().min(0).max(99).optional(),
        assists: z.number().int().min(0).max(99).optional(),
      })
    )
    .max(60)
    .default([]),
  noShows: z.array(z.string().uuid()).max(60).default([]),
});

resultsRouter.post("/matches/:id/result", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const input = submitSchema.parse(req.body ?? {});
    const result = await submitResult({
      matchId,
      hostId: req.user!.id,
      scoreA: input.scoreA,
      scoreB: input.scoreB,
      players: input.players,
      noShows: input.noShows,
    });
    // Committed. The job only flips a result nobody argued with; the
    // deadline itself is enforced in the query, so a lost job leaves the
    // result unfinalised rather than wrongly finalised.
    try {
      await scheduleOnce(
        matchLifecycleQueue,
        "finalize-result",
        `finalize:${matchId}`,
        { matchId },
        result.disputeDeadline.getTime() - Date.now()
      );
    } catch (err) {
      req.log.error({ err, matchId }, "failed to schedule result finalisation");
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

resultsRouter.get("/matches/:id/result", async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    res.json(await getResult(matchId));
  } catch (err) {
    next(err);
  }
});

const disputeSchema = z.object({ reason: z.string().trim().min(3).max(500) });

resultsRouter.post("/matches/:id/disputes", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const { reason } = disputeSchema.parse(req.body ?? {});
    res.status(201).json(await raiseDispute(matchId, req.user!.id, reason));
  } catch (err) {
    next(err);
  }
});

resultsRouter.get("/matches/:id/disputes", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    res.json(await listDisputes(matchId));
  } catch (err) {
    next(err);
  }
});

const resolveSchema = z.object({ outcome: z.enum(["DISMISSED", "UPHELD"]) });

// Admin only: the host submitted the result under argument, so they are
// not the one who gets to decide whether the argument has merit.
resultsRouter.patch(
  "/admin/matches/:id/dispute",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const matchId = z.string().uuid().parse(req.params.id);
      const { outcome } = resolveSchema.parse(req.body ?? {});
      res.json(await resolveDispute({ matchId, adminId: req.user!.id, outcome }));
    } catch (err) {
      next(err);
    }
  }
);

const peerRatingsSchema = z.object({
  ratings: z
    .array(
      z.object({
        userId: z.string().uuid(),
        score: z.number().int().min(1).max(5),
        lateArrival: z.boolean().optional(),
      })
    )
    .min(1)
    .max(60),
});

resultsRouter.post("/matches/:id/ratings", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const { ratings } = peerRatingsSchema.parse(req.body ?? {});
    res.status(201).json(await submitPeerRatings({ matchId, raterId: req.user!.id, ratings }));
  } catch (err) {
    next(err);
  }
});
