import { Router } from "express";
import { z } from "zod";
import * as venuesService from "./service.js";

export const venuesRouter = Router();

venuesRouter.get("/formats", async (_req, res, next) => {
  try {
    res.json(await venuesService.listFormats());
  } catch (err) {
    next(err);
  }
});

venuesRouter.get("/venues", async (_req, res, next) => {
  try {
    res.json(await venuesService.listVenues());
  } catch (err) {
    next(err);
  }
});

venuesRouter.get("/venues/:id/pitches", async (req, res, next) => {
  try {
    res.json(await venuesService.listPitches(req.params.id));
  } catch (err) {
    next(err);
  }
});

const availabilityQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

venuesRouter.get("/pitches/:id/availability", async (req, res, next) => {
  try {
    const { date } = availabilityQuery.parse(req.query);
    res.json(await venuesService.pitchAvailability(req.params.id, date));
  } catch (err) {
    next(err);
  }
});
