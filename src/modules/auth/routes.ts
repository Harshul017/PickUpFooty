import { Router } from "express";
import { z } from "zod";
import * as authService from "./service.js";

export const authRouter = Router();

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().min(6).max(20).optional(),
  password: z.string().min(8).max(72),
  skillLevel: z.enum(["BEGINNER", "CASUAL", "INTERMEDIATE", "COMPETITIVE"]),
});

authRouter.post("/signup", async (req, res, next) => {
  try {
    const input = signupSchema.parse(req.body);
    const tokens = await authService.signup(input);
    res.status(201).json(tokens);
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  identifier: z.string().min(1), // email or phone
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);
    const tokens = await authService.login(identifier, password);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRouter.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await authService.refresh(refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});
