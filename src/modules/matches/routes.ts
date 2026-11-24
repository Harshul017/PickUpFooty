import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import * as matchesService from "./service.js";
import { joinOpenMatch } from "./join.js";
import { leaveMatch } from "./leave.js";
import { waitlistOfferQueue, scheduleOnce } from "../../lib/queue.js";

export const matchesRouter = Router();

const createMatchSchema = z.object({
  pitchId: z.string().uuid(),
  formatId: z.string().uuid().optional(),
  playersPerSide: z.number().int().min(4).max(11),
  subsPerSide: z.number().int().min(0).max(3).optional(),
  startsAt: z.string().datetime(),
  durationMin: z.number().int().min(30).max(180),
  joinMode: z.enum(["OPEN", "APPROVAL"]),
  minRating: z.number().int().optional(),
  maxRating: z.number().int().optional(),
});

matchesRouter.post("/matches", requireAuth, async (req, res, next) => {
  try {
    const input = createMatchSchema.parse(req.body);
    const match = await matchesService.createMatch({
      hostId: req.user!.id,
      pitchId: input.pitchId,
      formatId: input.formatId,
      playersPerSide: input.playersPerSide,
      subsPerSide: input.subsPerSide,
      startsAt: new Date(input.startsAt),
      durationMin: input.durationMin,
      joinMode: input.joinMode,
      minRating: input.minRating,
      maxRating: input.maxRating,
    });
    res.status(201).json(match);
  } catch (err) {
    next(err);
  }
});

const listQuery = z.object({
  cursor: z.string().datetime().optional(),
  format: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

matchesRouter.get("/matches", async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    res.json(
      await matchesService.listUpcomingMatches({
        cursor: query.cursor,
        limit: query.limit,
        format: query.format,
      })
    );
  } catch (err) {
    next(err);
  }
});

matchesRouter.post("/matches/:id/join", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const result = await joinOpenMatch(matchId, req.user!.id);
    res.status(result.status === "JOINED" ? 200 : 202).json(result);
  } catch (err) {
    next(err);
  }
});

matchesRouter.post("/matches/:id/leave", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const result = await leaveMatch(matchId, req.user!.id);

    // Committed by now. The job only flips the offer to expired and tells
    // the next player; the offer's own deadline is already enforced by
    // every query that reads it, so a lost job costs a notification and a
    // little delay, never correctness.
    if (result.offer) {
      const { userId, expiresAt } = result.offer;
      try {
        await scheduleOnce(
          waitlistOfferQueue,
          "expire-offer",
          `${matchId}:${userId}:${expiresAt.getTime()}`,
          { matchId, userId },
          expiresAt.getTime() - Date.now()
        );
      } catch (err) {
        req.log.error({ err, matchId, userId }, "failed to schedule waitlist offer expiry");
      }
    }

    res.json({
      status: result.status,
      heldSpot: result.heldSpot,
      penalty: result.penalty,
      banEndsAt: result.banEndsAt,
      // Who got the spot is the organizer's business, not the leaver's.
      spotOffered: result.offer !== null,
    });
  } catch (err) {
    next(err);
  }
});
