import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { getResult, submitResult } from "./service.js";

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
