import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getDisciplineSummary } from "./service.js";

export const disciplineRouter = Router();

// Own record only: conduct is between a player and the platform, so there
// is deliberately no route for reading anyone else's.
disciplineRouter.get("/me/discipline", requireAuth, async (req, res, next) => {
  try {
    res.json(await getDisciplineSummary(req.user!.id));
  } catch (err) {
    next(err);
  }
});
