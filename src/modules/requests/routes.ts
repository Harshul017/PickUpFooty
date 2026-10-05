import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { requestExpiryQueue, scheduleOnce } from "../../lib/queue.js";
import * as requestsService from "./service.js";

export const requestsRouter = Router();

const createRequestSchema = z.object({
  note: z.string().trim().max(280).optional(),
});

requestsRouter.post("/matches/:id/requests", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    const input = createRequestSchema.parse(req.body ?? {});
    const request = await requestsService.createRequest({
      matchId,
      userId: req.user!.id,
      note: input.note || undefined,
    });

    // The request is committed at this point. If scheduling fails, the
    // request still expires on time in every query (they all check
    // expires_at); only the status flip and notification are delayed.
    const expiresAt = new Date(request.expires_at);
    try {
      await scheduleOnce(
        requestExpiryQueue,
        "expire-request",
        request.id,
        { requestId: request.id },
        expiresAt.getTime() - Date.now()
      );
    } catch (err) {
      req.log.error({ err, requestId: request.id }, "failed to schedule request expiry");
    }

    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
});

requestsRouter.get("/matches/:id/requests", requireAuth, async (req, res, next) => {
  try {
    const matchId = z.string().uuid().parse(req.params.id);
    res.json(await requestsService.listPendingRequests(matchId, req.user!.id));
  } catch (err) {
    next(err);
  }
});

requestsRouter.post("/requests/:id/accept", requireAuth, async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.id);
    const result = await requestsService.acceptRequest(requestId, req.user!.id);
    res.status(result.status === "JOINED" ? 200 : 202).json(result);
  } catch (err) {
    next(err);
  }
});

requestsRouter.post("/requests/:id/reject", requireAuth, async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.id);
    res.json(await requestsService.rejectRequest(requestId, req.user!.id));
  } catch (err) {
    next(err);
  }
});

requestsRouter.post("/requests/:id/withdraw", requireAuth, async (req, res, next) => {
  try {
    const requestId = z.string().uuid().parse(req.params.id);
    res.json(await requestsService.withdrawRequest(requestId, req.user!.id));
  } catch (err) {
    next(err);
  }
});
